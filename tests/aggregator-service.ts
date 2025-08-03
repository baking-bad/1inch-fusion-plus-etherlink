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
    srcToken: {
        symbol: string
        name: string
        decimals: number
        address: string
        logoURI: string
    }
    dstToken: {
        symbol: string
        name: string
        decimals: number
        address: string
        logoURI: string
    }
    dstAmount: string
    protocols: any[]
    gas: number
}

export interface SwapParamsRequest extends QuoteRequest {
    from: string // required for swap
    slippage: number // slippage percentage 0.5-50
    disableEstimate?: boolean
    allowPartialFill?: boolean
    referrer?: string
    fee?: string
    isExactOutput: boolean
}

export interface SwapParamsResponse {
    params: string // encoded calldata for swap
    router: string // router address
    srcAmount: string // expected input amount
    dstAmount: string // expected output amount
    gas: number // gas limit
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

        if (request.isExactOutput) params.append('isExactOutput', request.isExactOutput ? 'true' : 'false')

        const url = `${this.baseUrl}/swap_params?${params}`
        console.log('Requested url', url)

        const response = await fetch(url)

        if (!response.ok) {
            const errorText = await response.text()
            throw new Error(`SwapParams API error: ${response.status} ${response.statusText} - ${errorText}`)
        }

        return response.json() as Promise<SwapParamsResponse>
    }
}
