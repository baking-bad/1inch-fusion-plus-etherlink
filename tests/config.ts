import {z} from 'zod'
import Sdk from '@1inch/cross-chain-sdk'
import * as process from 'node:process'

const bool = z
    .string()
    .transform((v) => v.toLowerCase() === 'true')
    .pipe(z.boolean())

const ConfigSchema = z.object({
    SRC_CHAIN_RPC: z.string().url(),
    DST_CHAIN_RPC: z.string().url(),
    SRC_CHAIN_CREATE_FORK: bool.default('true'),
    DST_CHAIN_CREATE_FORK: bool.default('true'),
    // Etherlink specific environment variables
    ETHERLINK_ROUTER_ADDRESS: z.string().optional(),
    ETHERLINK_API_URL: z.string().url().optional(),
    ETHERLINK_API_KEY: z.string().optional()
})

const fromEnv = ConfigSchema.parse(process.env)

export const config = {
    chain: {
        source: {
            chainId: Sdk.NetworkEnum.ETHEREUM,
            url: fromEnv.SRC_CHAIN_RPC,
            createFork: fromEnv.SRC_CHAIN_CREATE_FORK,
            limitOrderProtocol: '0x111111125421ca6dc452d289314280a0f8842a65',
            wrappedNative: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
            ownerPrivateKey: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
            tokens: {
                USDC: {
                    address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
                    donor: '0xd54F23BE482D9A58676590fCa79c8E43087f92fB'
                },
                WETH: {
                    address: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
                    donor: '0x8EB8a3b98659Cce290402893d0123abb75E3ab28'
                }
            }
        },
        destination: {
            // Etherlink Testnet (Ghostnet)
            // chainId: 128123,
            chainId: Sdk.NetworkEnum.BINANCE,
            url: fromEnv.DST_CHAIN_RPC || 'https://node.ghostnet.etherlink.com',
            createFork: fromEnv.DST_CHAIN_CREATE_FORK,
            limitOrderProtocol: '0x111111125421ca6dc452d289314280a0f8842a65', // Deploy 1inch LOP on Etherlink or use mock
            wrappedNative: '0xB1Ea698633d57705e93b0E40c1077d46CD6A51d8', // WETH equivalent on Etherlink
            ownerPrivateKey: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',

            // Etherlink specific contracts
            etherlinkRouter: fromEnv.ETHERLINK_ROUTER_ADDRESS || '0x0000000000000000000000000000000000000000', // Your deployed router
            etherlinkApiUrl: fromEnv.ETHERLINK_API_URL || 'https://api.etherlink.your-domain.com',
            etherlinkApiKey: fromEnv.ETHERLINK_API_KEY || '',

            tokens: {
                // Native ETH on Etherlink
                XTZ: {
                    address: '0x0000000000000000000000000000000000000000',
                    isNative: true,
                    donor: '0xA122c1Bf16fd52B7ff38DB0370A5915dB114dd60'
                },
                // USDC on Etherlink (if exists)
                USDC: {
                    address: '0x4C2AA252BEe766D3399850569713b55178934849', // Replace with actual USDC on Etherlink
                    isNative: false,
                    donor: '0x4222E6E7714B26eaaE3903FDb2Cf87D609B2Db6f', // USDC whale on Etherlink
                    decimals: 6
                },
                // WETH on Etherlink (if exists)
                WETH: {
                    address: '0x86932ff467A7e055d679F7578A0A4F96Be287861', // Replace with actual WETH on Etherlink
                    isNative: false,
                    donor: '0x4222E6E7714B26eaaE3903FDb2Cf87D609B2Db6f',
                    decimals: 18
                },
                // Add other tokens supported by your DEX aggregator
                WBTC: {
                    address: '0x92d81a25F6f46CD52B8230ef6ceA5747Bc3826Db',
                    isNative: false,
                    donor: '0x8a3CF0e82FdF5E47Ad42374D1C21067C039c4F13',
                    decimals: 18
                }
            },

            // DEX protocols available on Etherlink through your aggregator
            supportedDexes: [
                'uniswap-v2',
                'uniswap-v3',
                'sushiswap'
                // Add other DEXes your aggregator supports on Etherlink
            ],

            // Bridge fee configuration (no actual bridge operations in tests)
            bridgeFees: {
                // Estimated bridge fees for cost calculations
                ethToEtherlink: '2000000000000000', // 0.002 ETH base fee
                etherlinkToEth: '1000000000000000', // 0.001 ETH base fee

                // Fee buffer for price fluctuations
                feeBuffer: 100, // 1% in basis points

                // Fee calculation method
                feeType: 'fixed', // 'fixed' or 'percentage'

                // For percentage-based fees
                percentageFee: 50 // 0.5% in basis points
            }
        }
    },

    // Test configuration
    test: {
        // Timeout for operations
        operationTimeout: 30000, // 30 seconds

        // Default amounts for testing
        defaultTestAmounts: {
            eth: '1000000000000000000', // 1 ETH
            usdc: '100000000', // 100 USDC (6 decimals)
            dai: '100000000000000000000' // 100 DAI (18 decimals)
        },

        // Slippage tolerance for swaps
        defaultSlippage: 300, // 3% in basis points

        // Max gas price for tests
        maxGasPrice: '50000000000', // 50 gwei

        // Safety deposits for escrows
        safetyDeposit: {
            src: '1000000000000000', // 0.001 ETH
            dst: '1000000000000000'
        },

        // Test scenarios configuration
        scenarios: {
            // Simple ETH -> Token swap on Etherlink
            ethToToken: {
                enabled: true,
                srcToken: 'ETH',
                dstToken: 'USDC',
                amount: '500000000000000000' // 0.5 ETH
            },

            // Token -> ETH swap on Etherlink
            tokenToEth: {
                enabled: true,
                srcToken: 'USDC',
                dstToken: 'ETH',
                amount: '100000000' // 100 USDC
            },

            // Token -> Token swap on Etherlink
            tokenToToken: {
                enabled: true,
                srcToken: 'USDC',
                dstToken: 'DAI',
                amount: '50000000' // 50 USDC
            }
        }
    }
} as const

export type ChainConfig = (typeof config.chain)['source' | 'destination']

// Helper function to get token config by symbol
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export const getTokenConfig = (chain: 'source' | 'destination', symbol: string) => {
    const tokens = config.chain[chain].tokens
    const token = tokens[symbol as keyof typeof tokens]

    if (!token) {
        throw new Error(`Token ${symbol} not found in ${chain} chain config`)
    }

    return token
}
// Helper function to calculate bridge fees
export const calculateBridgeFee = (
    amount: string | bigint,
    direction: 'ethToEtherlink' | 'etherlinkToEth' = 'ethToEtherlink'
): bigint => {
    const fees = config.chain.destination.bridgeFees
    const baseFee = BigInt(fees[direction])

    if (fees.feeType === 'percentage') {
        const percentageFee = (BigInt(amount) * BigInt(fees.percentageFee)) / 10000n

        return baseFee + percentageFee
    }

    return baseFee
}

interface TotalCostCalculation {
    swapAmount: bigint
    bridgeFee: bigint
    feeBuffer: bigint
    totalCost: bigint
}

// Helper function to calculate total cost including bridge fees
export function calculateTotalCost(
    swapAmount: string | bigint,
    bridgeDirection: 'ethToEtherlink' | 'etherlinkToEth' = 'ethToEtherlink'
): TotalCostCalculation {
    const bridgeFee = calculateBridgeFee(swapAmount, bridgeDirection)
    const fees = config.chain.destination.bridgeFees
    const buffer = (bridgeFee * BigInt(fees.feeBuffer)) / 10000n

    return {
        swapAmount: BigInt(swapAmount),
        bridgeFee,
        feeBuffer: buffer,
        totalCost: BigInt(swapAmount) + bridgeFee + buffer
    }
}

interface ConfigurationChecks {
    routerConfigured: boolean
    apiConfigured: boolean
    tokensConfigured: boolean
    bridgeFeesConfigured: boolean
}

// Helper function to validate Etherlink configuration
export function validateEtherlinkConfig(): ConfigurationChecks {
    const dst = config.chain.destination

    const checks: ConfigurationChecks = {
        routerConfigured: dst.etherlinkRouter !== '0x0000000000000000000000000000000000000000',
        apiConfigured: Boolean(dst.etherlinkApiUrl && !dst.etherlinkApiUrl.includes('your-domain.com')),
        tokensConfigured: Object.values(dst.tokens).some(
            (token) => token.address !== '0x0000000000000000000000000000000000000000'
        ),
        bridgeFeesConfigured: dst.bridgeFees.ethToEtherlink !== '0'
    }

    // Log warnings for missing configuration
    if (!checks.routerConfigured) {
        console.warn('Warning: Etherlink router address not configured')
    }

    if (!checks.apiConfigured) {
        console.warn('Warning: Etherlink API URL not properly configured')
    }

    if (!checks.tokensConfigured) {
        console.warn('Warning: No real token addresses configured for Etherlink')
    }

    return checks
}

// Export types
export type {TotalCostCalculation, ConfigurationChecks}
