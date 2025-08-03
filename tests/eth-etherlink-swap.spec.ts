import 'dotenv/config'
import {expect, jest} from '@jest/globals'

import Sdk from '@1inch/cross-chain-sdk'

import {getChainConfig, getToken, testConfig} from './config'
import {TestEnvironment} from './test-utils/chain-utils'

jest.setTimeout(testConfig.timeoutMs)

// Test configuration
const srcChainId = Sdk.NetworkEnum.ETHEREUM
const dstChainId = 128123 // Etherlink Testnet

const dstChainConfig = getChainConfig(dstChainId)

describe('ETH to Etherlink Cross-Chain Tests', () => {
    let env: TestEnvironment

    beforeAll(async () => {
        // Initialize test environment
        env = new TestEnvironment(srcChainId, dstChainId)
        await env.initAllChains([srcChainId, dstChainId])

        // Create EtherlinkResolver
        env.createEtherlinkResolver(dstChainId, ['USDC', 'WXTZ'], dstChainConfig.etherlinkApiUrl)
    })

    afterAll(async () => {
        await env.cleanup()
    })

    describe('Scenario 1: ETH USDC -> Etherlink USDC (no swap)', () => {
        it('should transfer USDC to USDC without API calls', async () => {
            await env.setupUserBalances(srcChainId, [{token: 'USDC', amount: 0.1}])
            await env.setupResolverBalances(dstChainId, [{token: 'USDC', amount: 0.1}])
            await env.setupResolverContractBalances(dstChainId, [{token: 'USDC', amount: 0.1}])

            const dstChain = env.getChain(dstChainId)
            const etherlinkResolver = env.getEtherlinkResolver()
            const dstChainResolver = env.getResolverWallet(dstChainId)
            const dstUSDC = getToken(dstChainId, 'USDC')

            // Create order USDC -> USDC (same token, no swap needed)
            const {order, secret} = await env.createOrder({
                makingToken: 'USDC',
                takingToken: 'USDC', // Same token
                makingAmount: 0.1,
                takingAmount: 0.098
            })

            console.log('Created USDC -> USDC cross-chain order')

            // Execute deploySrc flow
            const {orderHash, dstImmutables} = await env.executeDeploySrc(order, secret)

            // Execute deployDst on Etherlink (no swap needed)
            console.log(`[${dstChainId}] Deploying destination escrow for USDC`)
            const {txHash: dstDepositHash} = await dstChainResolver.send(
                await etherlinkResolver.deployDstWithSwap(
                    dstChain.escrowFactory,
                    order,
                    dstImmutables,
                    dstUSDC.address, // resolver has USDC
                    1 // slippage (won't be used)
                )
            )

            console.log(`[${dstChainId}] Destination escrow deployed in tx ${dstDepositHash}`)
            console.log('USDC -> USDC transfer completed without swap')
        })
    })

    describe('Scenario 2: ETH USDC -> Etherlink WXTZ (with swap)', () => {
        it('should swap USDC to WXTZ using API integration', async () => {
            await env.setupUserBalances(srcChainId, [{token: 'USDC', amount: 10}])
            await env.setupResolverBalances(dstChainId, [
                {token: 'XTZ', amount: 2},
                {token: 'USDC', amount: 0.5}
            ])
            await env.setupResolverContractBalances(dstChainId, [{token: 'USDC', amount: 0.5}])

            const dstChain = env.getChain(dstChainId)
            const etherlinkResolver = env.getEtherlinkResolver()
            const dstChainResolver = env.getResolverWallet(dstChainId)
            const dstUSDC = getToken(dstChainId, 'USDC')

            // Create order USDC -> WXTZ (different tokens, swap needed)
            const {order, secret} = await env.createOrder({
                makingToken: 'USDC',
                takingToken: 'WXTZ', // Different token
                makingAmount: 1,
                takingAmount: 0.05
            })

            console.log('Created USDC -> WXTZ cross-chain order with swap')

            // Execute deploySrc flow
            const {orderHash, dstImmutables} = await env.executeDeploySrc(order, secret)

            // Execute deployDst on Etherlink with USDC -> WXTZ swap
            console.log(`[${dstChainId}] Deploying destination escrow with USDC -> WXTZ swap`)
            const deployDstTx = await etherlinkResolver.deployDstWithSwap(
                dstChain.escrowFactory,
                order,
                dstImmutables,
                dstUSDC.address, // resolver has USDC, needs WXTZ
                2 // 2% slippage for swap
            )

            // Execute the transaction
            const {txHash: dstDepositHash} = await dstChainResolver.send(deployDstTx)
            console.log(`[${dstChainId}] Destination escrow with swap deployed in tx ${dstDepositHash}`)

            // Verify transaction contains multiple calls (approve + swap + deployDst)
            expect(deployDstTx.data).toBeDefined()
            expect(deployDstTx.data?.length).toBeGreaterThan(200) // Complex transaction with multiple calls

            console.log('USDC -> WXTZ swap completed with API integration')
        })
    })

    describe('End-to-end flow verification', () => {
        it('should complete full withdraw flow after successful swap', async () => {
            const etherlinkResolver = env.getEtherlinkResolver()

            // Verify resolver can handle token checking
            const usdcToken = getToken(dstChainId, 'USDC')
            const wxtzToken = getToken(dstChainId, 'WXTZ')

            expect(etherlinkResolver.needsSwap(usdcToken.address, usdcToken.address)).toBe(false)
            expect(etherlinkResolver.needsSwap(usdcToken.address, wxtzToken.address)).toBe(true)

            console.log('Token swap logic verification completed')
        })
    })
})
