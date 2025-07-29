import {Interface, TransactionRequest} from 'ethers'
import Sdk from '@1inch/cross-chain-sdk'
import {EtherlinkApiClient, QuoteResponse, ConversionParams} from './etherlink-api-client'
import {calculateTotalCost, TotalCostCalculation} from './config'

// Import contract ABIs
import EtherlinkOrderManagerContract from '../dist/contracts/EtherlinkOrderManager.sol/EtherlinkOrderManager.json'
import ResolverContract from '../dist/contracts/Resolver.sol/Resolver.json'

interface OrderExecutionParams {
    dstImmutables: any // Sdk.Immutables type
    srcCancellationTimestamp: bigint
    conversionParams: ConversionParams
    orderHash: string
}

interface WithdrawParams {
    escrowAddress: string
    secret: string
    immutables: any // Sdk.Immutables type
    conversionParams?: ConversionParams
    orderHash: string
}

interface CancelParams {
    escrowAddress: string
    immutables: any // Sdk.Immutables type
    conversionParams?: ConversionParams
    orderHash: string
}

/**
 * Wrapper class for EtherlinkOrderManager that provides Resolver-compatible interface
 * Integrates with Etherlink DEX aggregator for token conversions
 */
export class EtherlinkOrderManager {
    private orderManagerInterface: Interface

    private resolverInterface: Interface

    private apiClient: EtherlinkApiClient

    constructor(
        public readonly orderManagerAddress: string,
        public readonly resolverAddress: string,
        apiClient?: EtherlinkApiClient
    ) {
        this.orderManagerInterface = new Interface(EtherlinkOrderManagerContract.abi)
        this.resolverInterface = new Interface(ResolverContract.abi)
        this.apiClient = apiClient || new EtherlinkApiClient()
    }

    /**
     * Deploy destination escrow with optional token conversion
     * This replaces the standard Resolver.deployDst() with conversion logic
     */
    async deployDst(
        dstImmutables: Sdk.Immutables,
        srcCancellationTimestamp?: bigint,
        conversionConfig?: {
            needsConversion: boolean
            tokenIn?: string
            tokenOut?: string
            referrer?: string
        }
    ): Promise<TransactionRequest> {
        const cancellationTime =
            srcCancellationTimestamp || dstImmutables.timeLocks.toSrcTimeLocks().privateCancellation

        let conversionParams: ConversionParams

        if (conversionConfig?.needsConversion) {
            // Get quote from API for conversion
            const quote = await this.apiClient.getQuoteWithBridgeFee({
                tokenIn: conversionConfig.tokenIn || '0x0000000000000000000000000000000000000000',
                tokenOut: conversionConfig.tokenOut || dstImmutables.token.toString(),
                amount: dstImmutables.amount.toString(),
                from: this.orderManagerAddress,
                recipient: this.orderManagerAddress
            })

            conversionParams = this.apiClient.convertToConversionParams(
                quote,
                this.orderManagerAddress,
                conversionConfig.referrer
            )
        } else {
            // No conversion needed
            conversionParams = {
                needsConversion: false,
                tokenIn: '0x0000000000000000000000000000000000000000',
                tokenOut: '0x0000000000000000000000000000000000000000',
                amountOutMin: '0',
                deadline: Math.floor(Date.now() / 1000) + 1800,
                routerParams: '0x0000000000000000000000000000000000000000000000000000000000000000',
                tokens: [],
                steps: [],
                referrerInfo: {
                    referrer: '0x0000000000000000000000000000000000000000',
                    feeAmount: '0'
                }
            }
        }

        const orderExecution: OrderExecutionParams = {
            dstImmutables: dstImmutables.build(),
            srcCancellationTimestamp: cancellationTime,
            conversionParams,
            orderHash: dstImmutables.orderHash
        }

        return {
            to: this.orderManagerAddress,
            data: this.orderManagerInterface.encodeFunctionData('executeOrder', [orderExecution]),
            value: dstImmutables.safetyDeposit.toString()
        }
    }

    /**
     * Withdraw funds with optional conversion back to desired token
     */
    async withdraw(
        side: 'src' | 'dst',
        escrowAddress: Sdk.Address,
        secret: string,
        immutables: Sdk.Immutables,
        conversionConfig?: {
            needsConversion: boolean
            tokenOut?: string
            referrer?: string
        }
    ): Promise<TransactionRequest> {
        if (side === 'src') {
            // Source side uses standard resolver
            return {
                to: this.resolverAddress,
                data: this.resolverInterface.encodeFunctionData('withdraw', [
                    escrowAddress.toString(),
                    secret,
                    immutables.build()
                ])
            }
        }

        // Destination side with potential conversion
        let conversionParams: ConversionParams

        if (conversionConfig?.needsConversion) {
            // Get quote for reverse conversion
            const quote = await this.apiClient.getQuote({
                tokenIn: immutables.token.toString(),
                tokenOut: conversionConfig.tokenOut || '0x0000000000000000000000000000000000000000',
                amount: immutables.amount.toString(),
                from: this.orderManagerAddress,
                recipient: immutables.taker.toString()
            })

            conversionParams = this.apiClient.convertToConversionParams(
                quote,
                immutables.taker.toString(),
                conversionConfig.referrer
            )
        } else {
            // No conversion needed
            conversionParams = {
                needsConversion: false,
                tokenIn: immutables.token.toString(),
                tokenOut: immutables.token.toString(),
                amountOutMin: immutables.amount.toString(),
                deadline: Math.floor(Date.now() / 1000) + 1800,
                routerParams: '0x0000000000000000000000000000000000000000000000000000000000000000',
                tokens: [],
                steps: [],
                referrerInfo: {
                    referrer: '0x0000000000000000000000000000000000000000',
                    feeAmount: '0'
                }
            }
        }

        const withdrawParams: WithdrawParams = {
            escrowAddress: escrowAddress.toString(),
            secret,
            immutables: immutables.build(),
            conversionParams,
            orderHash: immutables.orderHash
        }

        return {
            to: this.orderManagerAddress,
            data: this.orderManagerInterface.encodeFunctionData('withdrawForUser', [
                withdrawParams.escrowAddress,
                withdrawParams.secret,
                withdrawParams.immutables,
                withdrawParams.conversionParams,
                withdrawParams.orderHash
            ])
        }
    }

    /**
     * Cancel escrow with optional conversion back to original token
     */
    async cancel(
        side: 'src' | 'dst',
        escrowAddress: Sdk.Address,
        immutables: Sdk.Immutables,
        conversionConfig?: {
            needsConversion: boolean
            tokenOut?: string
            referrer?: string
        }
    ): Promise<TransactionRequest> {
        if (side === 'src') {
            // Source side uses standard resolver
            return {
                to: this.resolverAddress,
                data: this.resolverInterface.encodeFunctionData('cancel', [
                    escrowAddress.toString(),
                    immutables.build()
                ])
            }
        }

        // Destination side with potential conversion
        let conversionParams: ConversionParams

        if (conversionConfig?.needsConversion) {
            // Get quote for reverse conversion to original token
            const quote = await this.apiClient.getQuote({
                tokenIn: immutables.token.toString(),
                tokenOut: conversionConfig.tokenOut || '0x0000000000000000000000000000000000000000',
                amount: immutables.amount.toString(),
                from: this.orderManagerAddress,
                recipient: immutables.maker.toString()
            })

            conversionParams = this.apiClient.convertToConversionParams(
                quote,
                immutables.maker.toString(),
                conversionConfig.referrer
            )
        } else {
            // No conversion needed
            conversionParams = {
                needsConversion: false,
                tokenIn: immutables.token.toString(),
                tokenOut: immutables.token.toString(),
                amountOutMin: immutables.amount.toString(),
                deadline: Math.floor(Date.now() / 1000) + 1800,
                routerParams: '0x0000000000000000000000000000000000000000000000000000000000000000',
                tokens: [],
                steps: [],
                referrerInfo: {
                    referrer: '0x0000000000000000000000000000000000000000',
                    feeAmount: '0'
                }
            }
        }

        const cancelParams: CancelParams = {
            escrowAddress: escrowAddress.toString(),
            immutables: immutables.build(),
            conversionParams,
            orderHash: immutables.orderHash
        }

        return {
            to: this.orderManagerAddress,
            data: this.orderManagerInterface.encodeFunctionData('cancelOrder', [
                cancelParams.escrowAddress,
                cancelParams.immutables,
                cancelParams.conversionParams,
                cancelParams.orderHash
            ])
        }
    }

    /**
     * Get quote for potential conversion with bridge fees included
     */
    async getConversionQuote(
        tokenIn: string,
        tokenOut: string,
        amount: string,
        includeBridgeFee: boolean = true
    ): Promise<{
        quote: QuoteResponse
        bridgeCalculation?: TotalCostCalculation
        totalCostWithBridge?: string
    }> {
        if (includeBridgeFee) {
            const quoteWithBridge = await this.apiClient.getQuoteWithBridgeFee({
                tokenIn,
                tokenOut,
                amount,
                from: this.orderManagerAddress,
                includeBridgeFee: true
            })

            return {
                quote: quoteWithBridge,
                bridgeCalculation: quoteWithBridge.bridgeCalculation,
                totalCostWithBridge: quoteWithBridge.bridgeCalculation.totalCost.toString()
            }
        }

        const quote = await this.apiClient.getQuote({
            tokenIn,
            tokenOut,
            amount,
            from: this.orderManagerAddress
        })

        return {quote}
    }

    /**
     * Check if token pair is supported for conversion
     */
    async isPairSupported(tokenIn: string, tokenOut: string): Promise<boolean> {
        return this.apiClient.isPairSupported(tokenIn, tokenOut)
    }

    /**
     * Calculate total cost including bridge fees for planning
     */
    calculateBridgeCost(amount: string): TotalCostCalculation {
        return calculateTotalCost(amount)
    }

    /**
     * Helper method to determine if conversion is needed
     */
    needsConversion(srcToken: string, dstToken: string): boolean {
        // If tokens are different, conversion is needed
        if (srcToken.toLowerCase() !== dstToken.toLowerCase()) {
            return true
        }

        // Additional logic can be added here
        // e.g., if bridging from ETH to wrapped ETH on Etherlink
        return false
    }

    /**
     * Create conversion configuration for common scenarios
     */
    createConversionConfig(
        scenario: 'ethToToken' | 'tokenToEth' | 'tokenToToken',
        tokenAddress?: string,
        referrer?: string
    ): {
        needsConversion: boolean
        tokenIn?: string
        tokenOut?: string
        referrer?: string
    } {
        const ethAddress = '0x0000000000000000000000000000000000000000'

        switch (scenario) {
            case 'ethToToken':
                return {
                    needsConversion: true,
                    tokenIn: ethAddress,
                    tokenOut: tokenAddress,
                    referrer
                }
            case 'tokenToEth':
                return {
                    needsConversion: true,
                    tokenIn: tokenAddress,
                    tokenOut: ethAddress,
                    referrer
                }
            case 'tokenToToken':
                return {
                    needsConversion: !!tokenAddress,
                    tokenIn: tokenAddress,
                    tokenOut: tokenAddress, // This would be different in real usage
                    referrer
                }
            default:
                return {
                    needsConversion: false
                }
        }
    }

    /**
     * Get contract addresses for reference
     */
    getAddresses(): {
        orderManager: string
        resolver: string
    } {
        return {
            orderManager: this.orderManagerAddress,
            resolver: this.resolverAddress
        }
    }
}

/**
 * Factory function to create EtherlinkOrderManager instance
 */
export function createEtherlinkOrderManager(
    orderManagerAddress: string,
    resolverAddress: string,
    apiClient?: EtherlinkApiClient
): EtherlinkOrderManager {
    return new EtherlinkOrderManager(orderManagerAddress, resolverAddress, apiClient)
}

// Export types for use in tests
export type {OrderExecutionParams, WithdrawParams, CancelParams}
