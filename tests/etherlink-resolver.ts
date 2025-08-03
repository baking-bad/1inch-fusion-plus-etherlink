import {TransactionRequest} from 'ethers'
import Sdk from '@1inch/cross-chain-sdk'
import {Resolver, ResolverAddresses, ArbitraryCall} from './resolver'
import {AggregatorApiClient, SwapParamsRequest} from './aggregator-service'

export interface TokenConfig {
    [address: string]: {
        symbol: string
        decimals: number
    }
}

export class EtherlinkResolver extends Resolver {
    private readonly supportedTokens: TokenConfig

    private readonly apiClient: AggregatorApiClient

    constructor(addresses: ResolverAddresses, supportedTokens: TokenConfig, aggregatorApiUrl: string) {
        super(addresses)
        this.supportedTokens = supportedTokens
        this.apiClient = new AggregatorApiClient(aggregatorApiUrl)
    }

    public needsSwap(tokenIn: string, tokenOut: string): boolean {
        return tokenIn.toLowerCase() !== tokenOut.toLowerCase()
    }

    public async getQuote(src: string, dst: string, amount: string) {
        return this.apiClient.quote({
            src,
            dst,
            amount,
            includeTokensInfo: true,
            includeGas: true
        })
    }

    public async getSwapParams(request: SwapParamsRequest): Promise<{
        routerAddress: string
        swapCalldata: string
        expectedInput: bigint
        expectedOutput: bigint
        gasEstimate: number
    }> {
        const apiResponse = await this.apiClient.getSwapParams(request)

        return {
            routerAddress: apiResponse.router,
            swapCalldata: apiResponse.params,
            expectedInput: BigInt(apiResponse.srcAmount),
            expectedOutput: BigInt(apiResponse.dstAmount),
            gasEstimate: apiResponse.gas
        }
    }

    public async prepareApproveCall(token: string, spender: string, amount: bigint): Promise<ArbitraryCall> {
        const approveCalldata =
            '0x095ea7b3' + // approve(address,uint256)
            spender.slice(2).padStart(64, '0') +
            amount.toString(16).padStart(64, '0')

        return {
            target: token,
            data: approveCalldata
        }
    }

    public async prepareSwapFromApi(
        src: string,
        dst: string,
        amount: string,
        from: string,
        slippage: number = 1,
        isExactOutput: boolean = false
    ): Promise<{
        approveCall: ArbitraryCall
        swapCall: ArbitraryCall
        expectedInput: bigint
        expectedOutput: bigint
        gasEstimate: number
        routerAddress: string
    }> {
        const request: SwapParamsRequest = {
            src,
            dst,
            amount,
            from,
            slippage,
            isExactOutput
        }

        const {routerAddress, swapCalldata, expectedInput, expectedOutput, gasEstimate} =
            await this.getSwapParams(request)

        const approveCall = await this.prepareApproveCall(src, routerAddress, BigInt(expectedInput))
        const swapCall: ArbitraryCall = {
            target: routerAddress,
            data: swapCalldata
        }

        return {
            approveCall,
            swapCall,
            expectedInput,
            expectedOutput,
            gasEstimate,
            routerAddress
        }
    }

    public async deployDstWithSwap(
        dstEscrowFactory: string,
        order: Sdk.CrossChainOrder,
        immutables: Sdk.Immutables,
        srcToken: string,
        slippage: number = 1
    ): Promise<TransactionRequest> {
        const calls: ArbitraryCall[] = []
        const dstToken = order.escrowExtension.dstToken.toString()
        const amount = order.takingAmount

        if (this.needsSwap(srcToken, dstToken)) {
            const from = this.getAddress(order.escrowExtension.dstChainId)
            const {approveCall, swapCall} = await this.prepareSwapFromApi(
                srcToken,
                dstToken,
                amount.toString(),
                from,
                slippage,
                true
            )
            calls.push(approveCall, swapCall)
        }

        const escrowApproveCall = await this.prepareApproveCall(
            dstToken,
            dstEscrowFactory,
            BigInt(amount)
        )
        calls.push(escrowApproveCall)

        return this.deployDst(order, immutables, calls)
    }

    public async withdrawWithSwap(
        chainId: number,
        escrow: Sdk.Address,
        secret: string,
        immutables: Sdk.Immutables,
        src: string,
        dst: string,
        amount: string,
        slippage: number = 1
    ): Promise<TransactionRequest> {
        const calls: ArbitraryCall[] = []

        if (this.needsSwap(src, dst)) {
            const from = this.getAddress(chainId)
            const {approveCall, swapCall} = await this.prepareSwapFromApi(src, dst, amount, from, slippage, false)

            calls.push(approveCall, swapCall)
        }

        return this.withdraw(chainId, escrow, secret, immutables, calls)
    }

    public async cancelWithSwap(
        chainId: number,
        escrow: Sdk.Address,
        immutables: Sdk.Immutables,
        src: string,
        dst: string,
        amount: string,
        slippage: number = 1
    ): Promise<TransactionRequest> {
        const calls: ArbitraryCall[] = []

        if (this.needsSwap(src, dst)) {
            const from = this.getAddress(chainId)
            const {approveCall, swapCall} = await this.prepareSwapFromApi(src, dst, amount, from, slippage, false)

            calls.push(approveCall, swapCall)
        }

        return this.cancel(chainId, escrow, immutables, calls)
    }

    public isTokenSupported(tokenAddress: string): boolean {
        return tokenAddress.toLowerCase() in this.supportedTokens
    }

    public getTokenInfo(tokenAddress: string) {
        return this.supportedTokens[tokenAddress.toLowerCase()]
    }
}
