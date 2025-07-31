import {z} from 'zod'
import Sdk from '@1inch/cross-chain-sdk'
import * as process from 'node:process'

const bool = z
    .string()
    .transform((v) => v.toLowerCase() === 'true')
    .pipe(z.boolean())

const ConfigSchema = z.object({
    // Ethereum
    ETH_CHAIN_RPC: z.string().url(),
    ETH_CHAIN_CREATE_FORK: bool.default('true'),

    // BSC (for original tests)
    BSC_CHAIN_RPC: z.string().default(''),
    BSC_CHAIN_CREATE_FORK: bool.default('true'),

    // Etherlink
    ETHERLINK_CHAIN_RPC: z.string().url(),
    ETHERLINK_CHAIN_CREATE_FORK: bool.default('true'),
    ETHERLINK_ROUTER_ADDRESS: z.string().default('0x0000000000000000000000000000000000000000'),
    ETHERLINK_API_URL: z.string().default('https://api.etherlink.your-domain.com'),
    ETHERLINK_API_KEY: z.string().default('')
})

const fromEnv = ConfigSchema.parse(process.env)

export interface TokenInfo {
    address: string
    isNative?: boolean
    donor: string
    decimals: number
}

export interface ChainConfig {
    chainId: number
    orderChainId: number
    name: string
    url: string
    createFork: boolean
    limitOrderProtocol: string
    wrappedNative: string
    ownerPrivateKey: string

    // Etherlink specific (optional)
    etherlinkRouter?: string
    etherlinkApiUrl?: string
    etherlinkApiKey?: string

    tokens: {
        [symbol: string]: TokenInfo
    }
}

export const config: Record<number, ChainConfig> = {
    // Ethereum Mainnet
    [Sdk.NetworkEnum.ETHEREUM]: {
        chainId: Sdk.NetworkEnum.ETHEREUM,
        orderChainId: Sdk.NetworkEnum.ETHEREUM,
        name: 'Ethereum',
        url: fromEnv.ETH_CHAIN_RPC,
        createFork: fromEnv.ETH_CHAIN_CREATE_FORK,
        limitOrderProtocol: '0x111111125421ca6dc452d289314280a0f8842a65',
        wrappedNative: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
        ownerPrivateKey: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
        tokens: {
            USDC: {
                address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
                donor: '0xd54F23BE482D9A58676590fCa79c8E43087f92fB',
                decimals: 6
            },
            WETH: {
                address: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
                donor: '0x8EB8a3b98659Cce290402893d0123abb75E3ab28',
                decimals: 18
            }
        }
    },

    // BSC (for backward compatibility with existing tests)
    [Sdk.NetworkEnum.BINANCE]: {
        chainId: Sdk.NetworkEnum.BINANCE,
        orderChainId: Sdk.NetworkEnum.BINANCE,
        name: 'BSC',
        url: fromEnv.BSC_CHAIN_RPC,
        createFork: fromEnv.BSC_CHAIN_CREATE_FORK,
        limitOrderProtocol: '0x111111125421ca6dc452d289314280a0f8842a65',
        wrappedNative: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c',
        ownerPrivateKey: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
        tokens: {
            USDC: {
                address: '0x8965349fb649a33a30cbfda057d8ec2c48abe2a2',
                donor: '0x4188663a85C92EEa35b5AD3AA5cA7CeB237C6fe9',
                decimals: 6
            }
        }
    },

    // Etherlink Testnet (Ghostnet)
    [128123]: {
        chainId: 128123,
        orderChainId: Sdk.NetworkEnum.BINANCE, //because Sdk.CrossChainOrder.new throws: Not supported chain 128123
        name: 'Etherlink Testnet',
        url: fromEnv.ETHERLINK_CHAIN_RPC,
        createFork: fromEnv.ETHERLINK_CHAIN_CREATE_FORK,
        limitOrderProtocol: '0x111111125421ca6dc452d289314280a0f8842a65',
        wrappedNative: '0xB1Ea698633d57705e93b0E40c1077d46CD6A51d8',
        ownerPrivateKey: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',

        // Etherlink specific
        etherlinkRouter: fromEnv.ETHERLINK_ROUTER_ADDRESS,
        etherlinkApiUrl: fromEnv.ETHERLINK_API_URL,
        etherlinkApiKey: fromEnv.ETHERLINK_API_KEY,

        tokens: {
            // Native XTZ on Etherlink
            XTZ: {
                address: '0x0000000000000000000000000000000000000000',
                isNative: true,
                donor: '0xA122c1Bf16fd52B7ff38DB0370A5915dB114dd60',
                decimals: 18
            },
            // USDC on Etherlink
            USDC: {
                address: '0x4C2AA252BEe766D3399850569713b55178934849',
                isNative: false,
                donor: '0x4222E6E7714B26eaaE3903FDb2Cf87D609B2Db6f',
                decimals: 6
            },
            // WETH on Etherlink
            WETH: {
                address: '0x86932ff467A7e055d679F7578A0A4F96Be287861',
                isNative: false,
                donor: '0x4222E6E7714B26eaaE3903FDb2Cf87D609B2Db6f',
                decimals: 18
            },
            // WBTC on Etherlink
            WBTC: {
                address: '0x92d81a25F6f46CD52B8230ef6ceA5747Bc3826Db',
                isNative: false,
                donor: '0x8a3CF0e82FdF5E47Ad42374D1C21067C039c4F13',
                decimals: 18
            }
        }
    }
} as const

// Helper functions
export function getChainConfig(chainId: number): ChainConfig {
    const chainConfig = config[chainId]

    if (!chainConfig) {
        throw new Error(`Chain ${chainId} not configured`)
    }

    return chainConfig
}

export function getToken(chainId: number, symbol: string): TokenInfo {
    const chainConfig = getChainConfig(chainId)
    const token = chainConfig.tokens[symbol]

    if (!token) {
        throw new Error(`Token ${symbol} not found on chain ${chainId}`)
    }

    return token
}

export function getSupportedChains(): number[] {
    return Object.keys(config).map(Number)
}

export function getEtherlinkChains(): number[] {
    return Object.entries(config)
        .filter(([_, cfg]) => cfg.etherlinkRouter)
        .map(([chainId]) => Number(chainId))
}

// Backward compatibility exports
export const legacyConfig = {
    chain: {
        source: config[Sdk.NetworkEnum.ETHEREUM],
        destination: config[Sdk.NetworkEnum.BINANCE]
    }
}
