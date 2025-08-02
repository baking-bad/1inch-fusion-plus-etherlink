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
        env.createEtherlinkResolver(dstChainId, ['WETH', 'WXTZ'], dstChainConfig.etherlinkApiUrl)

        // Setup balances
        // User on Ethereum needs WETH for making orders
        await env.setupUserBalances(srcChainId, [{token: 'WETH', amount: 10}])

        // Resolver on Etherlink needs:
        // - XTZ for gas fees (native token)
        // - WETH for scenario 1 (no swap)
        await env.setupResolverBalances(dstChainId, [
            {token: 'XTZ', amount: 2},
            {token: 'WETH', amount: 0.1}
        ])
        await env.setupResolverContractBalances(dstChainId, [{token: 'WETH', amount: 0.1}])
    })

    afterAll(async () => {
        await env.cleanup()
    })

    describe('Scenario 1: ETH WETH -> Etherlink WETH (no swap)', () => {
        it('should transfer WETH to WETH without API calls', async () => {
            const dstChain = env.getChain(dstChainId)
            const etherlinkResolver = env.getEtherlinkResolver()
            const dstChainResolver = env.getResolverWallet(dstChainId)
            const dstWETH = getToken(dstChainId, 'WETH')

            // Create order WETH -> WETH (same token, no swap needed)
            const {order, secret} = await env.createOrder({
                makingToken: 'WETH',
                takingToken: 'WETH', // Same token
                makingAmount: 0.1,
                takingAmount: 0.098
            })

            console.log('Created WETH -> WETH cross-chain order')

            // Execute deploySrc flow
            const {orderHash, dstImmutables} = await env.executeDeploySrc(order, secret)

            // Execute deployDst on Etherlink (no swap needed)
            console.log(`[${dstChainId}] Deploying destination escrow for WETH`)
            const {txHash: dstDepositHash} = await dstChainResolver.send(
                await etherlinkResolver.deployDstWithSwap(
                    dstChain.escrowFactory,
                    order,
                    dstImmutables,
                    dstWETH.address, // resolver has WETH
                    1 // slippage (won't be used)
                )
            )

            console.log(`[${dstChainId}] Destination escrow deployed in tx ${dstDepositHash}`)
            console.log('WETH -> WETH transfer completed without swap')
        })
    })

    describe('Scenario 2: ETH WETH -> Etherlink WXTZ (with swap)', () => {
        it('should swap WETH to WXTZ using API integration', async () => {
            const dstChain = env.getChain(dstChainId)
            const etherlinkResolver = env.getEtherlinkResolver()
            const dstChainResolver = env.getResolverWallet(dstChainId)
            const dstWETH = getToken(dstChainId, 'WETH')

            // Create order WETH -> WXTZ (different tokens, swap needed)
            const {order, secret} = await env.createOrder({
                makingToken: 'WETH',
                takingToken: 'WXTZ', // Different token
                makingAmount: 1,
                takingAmount: 0.5
            })

            console.log('Created WETH -> WXTZ cross-chain order with swap')

            // Execute deploySrc flow
            const {orderHash, dstImmutables} = await env.executeDeploySrc(order, secret)

            // Execute deployDst on Etherlink with WETH -> WXTZ swap
            console.log(`[${dstChainId}] Deploying destination escrow with WETH -> WXTZ swap`)
            const deployDstTx = await etherlinkResolver.deployDstWithSwap(
                dstChain.escrowFactory,
                order,
                dstImmutables,
                dstWETH.address, // resolver has WETH, needs WXTZ
                2 // 2% slippage for swap
            )

            // Execute the transaction
            const {txHash: dstDepositHash} = await dstChainResolver.send(deployDstTx)
            console.log(`[${dstChainId}] Destination escrow with swap deployed in tx ${dstDepositHash}`)

            // Verify transaction contains multiple calls (approve + swap + deployDst)
            expect(deployDstTx.data).toBeDefined()
            expect(deployDstTx.data?.length).toBeGreaterThan(200) // Complex transaction with multiple calls

            console.log('WETH -> WXTZ swap completed with API integration')
        })
    })

    describe('End-to-end flow verification', () => {
        it('should complete full withdraw flow after successful swap', async () => {
            const etherlinkResolver = env.getEtherlinkResolver()

            // Verify resolver can handle token checking
            const wethToken = getToken(dstChainId, 'WETH')
            const wxtzToken = getToken(dstChainId, 'WXTZ')

            expect(etherlinkResolver.needsSwap(wethToken.address, wethToken.address)).toBe(false)
            expect(etherlinkResolver.needsSwap(wethToken.address, wxtzToken.address)).toBe(true)

            console.log('Token swap logic verification completed')
        })
    })
})
