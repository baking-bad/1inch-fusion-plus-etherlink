import {config, calculateTotalCost} from './config'

interface QuoteParams {
    tokenIn: string
    tokenOut: string
    amount: string
    slippage?: number
    from: string
    recipient?: string
}

interface SwapParams extends QuoteParams {
    referrer?: string
}

interface QuoteResponse {
    tokenIn: string
    tokenOut: string
    amountIn: string
    amountOut: string
    minAmountOut: string
    estimatedGas: string
    protocols: string[]
    routerCalldata?: string
    routerAddress?: string
    apiResponse: any
}

interface SwapTxResponse {
    to: string
    data: string
    value: string
    gasLimit: string
    amountOut: string
    protocols: string[]
}

interface TokenInfo {
    tokenAddress: string
    isNative: boolean
}

interface SwapStep {
    routerAddress: string
    packedData: string
}

interface ReferrerInfo {
    referrer: string
    feeAmount: string
}

interface ConversionParams {
    needsConversion: boolean
    tokenIn: string
    tokenOut: string
    amountOutMin: string
    deadline: number
    routerParams: string
    tokens: TokenInfo[]
    steps: SwapStep[]
    referrerInfo: ReferrerInfo
}

interface BridgeCalculation {
    swapAmount: bigint
    bridgeFee: bigint
    feeBuffer: bigint
    totalCost: bigint
}

interface QuoteWithBridgeFee extends QuoteResponse {
    bridgeCalculation: BridgeCalculation
    originalAmount: string
    availableForSwap: string
    bridgeFeeIncluded: boolean
}

/**
 * Client for Etherlink DEX aggregator API (1inch-compatible)
 * Handles quote requests and route data preparation for swaps
 */
export class EtherlinkApiClient {
    private apiUrl: string

    private apiKey: string

    private chainId: number

    private defaultSlippage: number

    constructor(apiUrl: string | null = null, apiKey: string | null = null) {
        this.apiUrl = apiUrl || config.chain.destination.etherlinkApiUrl
        this.apiKey = apiKey || config.chain.destination.etherlinkApiKey
        this.chainId = config.chain.destination.chainId
        this.defaultSlippage = config.test.defaultSlippage
    }

    /**
     * Get swap quote from Etherlink aggregator API
     */
    async getQuote({
        tokenIn,
        tokenOut,
        amount,
        slippage = 0,
        from,
        recipient = null
    }: QuoteParams): Promise<QuoteResponse> {
        try {
            const slippageBps = slippage || this.defaultSlippage
            const params = new URLSearchParams({
                src: tokenIn,
                dst: tokenOut,
                amount: amount.toString(),
                from: from,
                slippage: (slippageBps / 100).toString(), // Convert basis points to percentage
                disableEstimate: 'true',
                allowPartialFill: 'false'
            })

            if (recipient) {
                params.append('to', recipient)
            }

            if (this.apiKey) {
                params.append('apikey', this.apiKey)
            }

            const url = `${this.apiUrl}/api/v6.1/128123/quote?${params}`
            console.log(url)

            const response = await globalThis.fetch(url, {
                method: 'GET',
                headers: {
                    Accept: 'application/json',
                    'Content-Type': 'application/json'
                }
            })

            if (!response.ok) {
                throw new Error(`API request failed: ${response.status} ${response.statusText}`)
            }

            const data = await response.json()

            return this._formatQuoteResponse(data, {tokenIn, tokenOut, amount, slippageBps})
        } catch (error: any) {
            console.error('Failed to get quote from Etherlink API:', error)
            throw new Error(`Quote request failed: ${error.message}`)
        }
    }

    /**
     * Get swap transaction data from Etherlink aggregator API
     */
    async getSwapTx({
        tokenIn,
        tokenOut,
        amount,
        slippage = null,
        from,
        recipient = null,
        referrer = null
    }: SwapParams): Promise<SwapTxResponse> {
        try {
            const slippageBps = slippage || this.defaultSlippage
            const params = new URLSearchParams({
                src: tokenIn,
                dst: tokenOut,
                amount: amount.toString(),
                from: from,
                slippage: (slippageBps / 100).toString(),
                disableEstimate: 'true',
                allowPartialFill: 'false'
            })

            if (recipient) {
                params.append('to', recipient)
            }

            if (referrer) {
                params.append('referrer', referrer)
            }

            if (this.apiKey) {
                params.append('apikey', this.apiKey)
            }

            const url = `${this.apiUrl}/v6.1/128123/swap?${params}`

            const response = await globalThis.fetch(url, {
                method: 'GET',
                headers: {
                    Accept: 'application/json',
                    'Content-Type': 'application/json'
                }
            })

            if (!response.ok) {
                throw new Error(`API request failed: ${response.status} ${response.statusText}`)
            }

            const data = await response.json()

            return this._formatSwapResponse(data)
        } catch (error: any) {
            console.error('Failed to get swap transaction from Etherlink API:', error)
            throw new Error(`Swap transaction request failed: ${error.message}`)
        }
    }

    /**
     * Get quote with bridge fee calculation for cross-chain scenarios
     */
    async getQuoteWithBridgeFee({
        tokenIn,
        tokenOut,
        amount,
        slippage = null,
        from,
        recipient = null,
        includeBridgeFee = true
    }: QuoteParams & {includeBridgeFee?: boolean}): Promise<QuoteWithBridgeFee> {
        const quote = await this.getQuote({tokenIn, tokenOut, amount, slippage, from, recipient})

        if (!includeBridgeFee) {
            return quote as QuoteWithBridgeFee
        }

        // Calculate bridge fees (assuming ETH bridging from Ethereum)
        const bridgeCalculation = calculateTotalCost(amount)

        // Adjust quote for bridge fees
        const availableForSwap = BigInt(amount) - bridgeCalculation.bridgeFee - bridgeCalculation.feeBuffer

        if (availableForSwap <= 0n) {
            throw new Error('Amount too small to cover bridge fees')
        }

        // Get adjusted quote for available amount after bridge fees
        const adjustedQuote = await this.getQuote({
            tokenIn,
            tokenOut,
            amount: availableForSwap.toString(),
            slippage,
            from,
            recipient
        })

        return {
            ...adjustedQuote,
            bridgeCalculation,
            originalAmount: amount,
            availableForSwap: availableForSwap.toString(),
            bridgeFeeIncluded: true
        }
    }

    /**
     * Convert API response to EtherlinkOrderManager ConversionParams format
     */
    convertToConversionParams(
        quoteData: QuoteResponse,
        recipient: string,
        referrer: string | null = null
    ): ConversionParams {
        if (!quoteData.routerCalldata) {
            throw new Error('No router calldata in quote response')
        }

        // Parse router calldata to extract our router format
        const {tokens, steps, params, referrerInfo} = this._parseRouterCalldata(quoteData, referrer)

        return {
            needsConversion: true,
            tokenIn: quoteData.tokenIn,
            tokenOut: quoteData.tokenOut,
            amountOutMin: quoteData.minAmountOut,
            deadline: Math.floor(Date.now() / 1000) + 1800, // 30 minutes from now
            routerParams: params,
            tokens,
            steps,
            referrerInfo
        }
    }

    /**
     * Check if token pair is supported
     */
    async isPairSupported(tokenIn: string, tokenOut: string): Promise<boolean> {
        try {
            // Try to get a small quote to check if pair is supported
            await this.getQuote({
                tokenIn,
                tokenOut,
                amount: '1000000000000000', // 0.001 ETH equivalent
                from: '0x0000000000000000000000000000000000000001' // Dummy address
            })

            return true
        } catch (error) {
            return false
        }
    }

    /**
     * Get supported tokens list
     */
    async getSupportedTokens(): Promise<any[]> {
        try {
            const url = `${this.apiUrl}/v6.1/128123/tokens`

            const response = await globalThis.fetch(url, {
                method: 'GET',
                headers: {
                    Accept: 'application/json'
                }
            })

            if (!response.ok) {
                throw new Error(`Failed to get tokens: ${response.status}`)
            }

            const data = await response.json()

            return data.tokens || []
        } catch (error: any) {
            console.warn('Failed to get supported tokens:', error.message)

            return []
        }
    }

    /**
     * Format quote response to standardized format
     */
    private _formatQuoteResponse(
        data: any,
        originalParams: {
            tokenIn: string
            tokenOut: string
            amount: string
            slippageBps: number
        }
    ): QuoteResponse {
        return {
            tokenIn: originalParams.tokenIn,
            tokenOut: originalParams.tokenOut,
            amountIn: originalParams.amount,
            amountOut: data.dstAmount || data.toAmount,
            minAmountOut: this._calculateMinAmountOut(data.dstAmount || data.toAmount, originalParams.slippageBps),
            estimatedGas: data.estimatedGas || '300000',
            protocols: data.protocols || [],
            routerCalldata: data.tx?.data,
            routerAddress: data.tx?.to,
            apiResponse: data
        }
    }

    /**
     * Format swap response to standardized format
     */
    private _formatSwapResponse(data: any): SwapTxResponse {
        return {
            to: data.tx.to,
            data: data.tx.data,
            value: data.tx.value || '0',
            gasLimit: data.tx.gas || '300000',
            amountOut: data.dstAmount || data.toAmount,
            protocols: data.protocols || []
        }
    }

    /**
     * Parse router calldata to extract parameters for our router format
     */
    private _parseRouterCalldata(
        quoteData: QuoteResponse,
        referrer: string | null
    ): {
        tokens: TokenInfo[]
        steps: SwapStep[]
        params: string
        referrerInfo: ReferrerInfo
    } {
        // This would need to be implemented based on your actual API response format
        // For now, return mock data structure
        const tokenIn = quoteData.tokenIn
        const tokenOut = quoteData.tokenOut

        return {
            tokens: [
                {
                    tokenAddress: tokenIn,
                    isNative: tokenIn === '0x0000000000000000000000000000000000000000'
                },
                {
                    tokenAddress: tokenOut,
                    isNative: tokenOut === '0x0000000000000000000000000000000000000000'
                }
            ],
            steps: [
                {
                    routerAddress: quoteData.routerAddress || config.chain.destination.etherlinkRouter,
                    packedData: '0x0000000000000000000000000000000000000000000000000000000000000000' // Mock packed data
                }
            ],
            params: '0x0000000000000000000000000000000000000000000000000000000000000000', // Mock params
            referrerInfo: {
                referrer: referrer || '0x0000000000000000000000000000000000000000',
                feeAmount: '0'
            }
        }
    }

    /**
     * Calculate minimum amount out with slippage
     */
    private _calculateMinAmountOut(amountOut: string, slippageBps: number): string {
        const amount = BigInt(amountOut)
        const slippage = BigInt(slippageBps)
        const minAmount = amount - (amount * slippage) / 10000n

        return minAmount.toString()
    }
}

/**
 * Helper function to create API client instance
 */
export function createEtherlinkApiClient(
    apiUrl: string | null = null,
    apiKey: string | null = null
): EtherlinkApiClient {
    return new EtherlinkApiClient(apiUrl, apiKey)
}

/**
 * Helper function for testing - creates mock quote response
 */
export function createMockQuote({
    tokenIn,
    tokenOut,
    amountIn,
    amountOut
}: {
    tokenIn: string
    tokenOut: string
    amountIn: string
    amountOut: string
}): QuoteResponse {
    return {
        tokenIn,
        tokenOut,
        amountIn,
        amountOut,
        minAmountOut: ((BigInt(amountOut) * 97n) / 100n).toString(), // 3% slippage
        estimatedGas: '300000',
        protocols: ['mock-dex'],
        routerCalldata: '0x',
        routerAddress: config.chain.destination.etherlinkRouter,
        apiResponse: {}
    }
}

// Export types
export type {
    QuoteParams,
    SwapParams,
    QuoteResponse,
    SwapTxResponse,
    ConversionParams,
    BridgeCalculation,
    QuoteWithBridgeFee,
    TokenInfo,
    SwapStep,
    ReferrerInfo
}
