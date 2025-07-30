export interface QuoteRequest {
    src: string // token address
    dst: string // token address
    amount: string // amount in wei
    from?: string // address of wallet
    protocols?: string // routing protocols
    fee?: string // fee in percentage
    gasPrice?: string // gas price in wei
    complexityLevel?: string // max number of splits
    parts?: string // max number of parts
    mainRouteParts?: string // main route parts
    gasLimit?: string // gas limit
    includeTokensInfo?: boolean
    includeProtocols?: boolean
    includeGas?: boolean
}

export interface QuoteResponse {
    fromToken: {
        symbol: string
        name: string
        decimals: number
        address: string
        logoURI: string
    }
    toToken: {
        symbol: string
        name: string
        decimals: number
        address: string
        logoURI: string
    }
    toAmount: string
    fromAmount: string
    protocols: any[]
    estimatedGas: number
}

export interface SwapParamsRequest extends QuoteRequest {
    from: string // required for swap
    slippage: number // slippage percentage 0.5-50
    disableEstimate?: boolean
    allowPartialFill?: boolean
    referrer?: string
    fee?: string
}

export interface SwapParamsResponse {
    params: {
        amountIn: string
        amountOutMin: string
        to: string
        deadline: string
        params: string
        tokens: Array<{
            tokenAddress: string
            isNative: boolean
        }>
        steps: Array<{
            routerAddress: string
            packedData: string
        }>
        referrerInfo: {
            referrer: string
            feeAmount: string
        }
        gas?: string | null
        gasPrice?: string | null
        fromAddress?: string | null
        nonce?: string | null
        maxFeePerGas?: string | null
        maxPriorityFeePerGas?: string | null
        transactionType?: string | null
        accessList?: any | null
    }
    router: string
    dstAmount: string
    gas: number
}

export class AggregatorApiClient {
    private readonly baseUrl: string

    constructor(baseUrl: string) {
        this.baseUrl = baseUrl.replace(/\/$/, '') // remove trailing slash
    }

    async quote(request: QuoteRequest): Promise<QuoteResponse> {
        const params = new URLSearchParams()

        params.append('src', request.src)
        params.append('dst', request.dst)
        params.append('amount', request.amount)

        if (request.from) params.append('from', request.from)

        if (request.protocols) params.append('protocols', request.protocols)

        if (request.fee) params.append('fee', request.fee)

        if (request.gasPrice) params.append('gasPrice', request.gasPrice)

        if (request.complexityLevel) params.append('complexityLevel', request.complexityLevel)

        if (request.parts) params.append('parts', request.parts)

        if (request.mainRouteParts) params.append('mainRouteParts', request.mainRouteParts)

        if (request.gasLimit) params.append('gasLimit', request.gasLimit)

        if (request.includeTokensInfo) params.append('includeTokensInfo', 'true')

        if (request.includeProtocols) params.append('includeProtocols', 'true')

        if (request.includeGas) params.append('includeGas', 'true')

        const response = await fetch(`${this.baseUrl}/quote?${params}`)

        if (!response.ok) {
            const errorText = await response.text()
            throw new Error(`Quote API error: ${response.status} ${response.statusText} - ${errorText}`)
        }

        return response.json() as Promise<QuoteResponse>
    }

    async getSwapParams(request: SwapParamsRequest): Promise<SwapParamsResponse> {
        const params = new URLSearchParams()

        params.append('src', request.src)
        params.append('dst', request.dst)
        params.append('amount', request.amount)
        params.append('from', request.from)
        params.append('slippage', request.slippage.toString())

        if (request.protocols) params.append('protocols', request.protocols)

        if (request.fee) params.append('fee', request.fee)

        if (request.gasPrice) params.append('gasPrice', request.gasPrice)

        if (request.complexityLevel) params.append('complexityLevel', request.complexityLevel)

        if (request.parts) params.append('parts', request.parts)

        if (request.mainRouteParts) params.append('mainRouteParts', request.mainRouteParts)

        if (request.gasLimit) params.append('gasLimit', request.gasLimit)

        if (request.disableEstimate) params.append('disableEstimate', 'true')

        if (request.allowPartialFill) params.append('allowPartialFill', 'true')

        if (request.referrer) params.append('referrer', request.referrer)

        const response = await fetch(`${this.baseUrl}/swap_params?${params}`)

        if (!response.ok) {
            const errorText = await response.text()
            throw new Error(`SwapParams API error: ${response.status} ${response.statusText} - ${errorText}`)
        }

        return response.json() as Promise<SwapParamsResponse>
    }

    convertSwapParamsToResolverFormat(apiResponse: SwapParamsResponse): {
        amountIn: bigint
        amountOutMin: bigint
        to: string
        deadline: bigint
        params: bigint
        tokens: Array<{
            tokenAddress: string
            isNative: boolean
        }>
        steps: Array<{
            routerAddress: string
            packedData: bigint
        }>
        referrerInfo: {
            referrer: string
            feeAmount: bigint
        }
    } {
        return {
            amountIn: BigInt(apiResponse.params.amountIn),
            amountOutMin: BigInt(apiResponse.params.amountOutMin),
            to: apiResponse.params.to,
            deadline: BigInt(apiResponse.params.deadline),
            params: BigInt(apiResponse.params.params),
            tokens: apiResponse.params.tokens,
            steps: apiResponse.params.steps.map((step) => ({
                routerAddress: step.routerAddress,
                packedData: BigInt(step.packedData)
            })),
            referrerInfo: {
                referrer: apiResponse.params.referrerInfo.referrer,
                feeAmount: BigInt(apiResponse.params.referrerInfo.feeAmount)
            }
        }
    }
}
