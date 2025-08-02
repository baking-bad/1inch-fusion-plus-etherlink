import 'dotenv/config'
import {expect, jest} from '@jest/globals'

import Sdk from '@1inch/cross-chain-sdk'
import {parseUnits} from 'ethers'

import {getChainConfig, getToken, testConfig} from './config'
import {TestEnvironment} from './test-utils/chain-utils'

jest.setTimeout(testConfig.timeoutMs)

// Test configuration
const srcChainId = Sdk.NetworkEnum.ETHEREUM
const dstChainId = 128123 // Etherlink Testnet

getChainConfig(srcChainId)
const dstChainConfig = getChainConfig(dstChainId)

describe('EtherlinkResolver Real API Tests', () => {
    const realApiUrl = dstChainConfig.etherlinkApiUrl

    let env: TestEnvironment

    beforeAll(async () => {
        // Initialize test environment
        env = new TestEnvironment()
        await env.initAllChains([srcChainId, dstChainId])

        // Create EtherlinkResolver
        env.createEtherlinkResolver(dstChainId, ['USDC', 'WXTZ', 'WETH'], realApiUrl)

        // Setup balances
        await env.setupUserBalances(srcChainId, [{token: 'USDC', amount: 1000}])
        await env.setupResolverBalances(dstChainId, [{token: 'XTZ', amount: 1}]) // Native token for gas
        await env.setupResolverContractBalances(dstChainId, [{token: 'USDC', amount: 1}])
    })

    afterAll(async () => {
        await env.cleanup()
    })

    describe('Real API Integration Tests', () => {
        it.skip('should get quote from real API', async () => {
            const srcUSDC = getToken(dstChainId, 'USDC')
            const dstWXTZ = getToken(dstChainId, 'WXTZ')
            const etherlinkResolver = env.getEtherlinkResolver()

            try {
                const quote = await etherlinkResolver.getQuote(
                    srcUSDC.address,
                    dstWXTZ.address,
                    parseUnits('100', srcUSDC.decimals).toString()
                )

                console.log('Real API Quote received:', {
                    fromToken: quote.srcToken.symbol,
                    toToken: quote.dstToken.symbol,
                    toAmount: quote.dstAmount,
                    estimatedGas: quote.gas
                })

                expect(BigInt(quote.dstAmount)).toBeGreaterThan(0n)
                expect(quote.gas).toBeGreaterThan(0)
            } catch (error) {
                console.log('Real API not available, skipping test:', error.message)
                throw error
            }
        })

        it.skip('should get swap params from real API', async () => {
            const srcUSDC = getToken(dstChainId, 'USDC')
            const dstWXTZ = getToken(dstChainId, 'WXTZ')
            const amount = parseUnits('100', srcUSDC.decimals).toString()
            const etherlinkResolver = env.getEtherlinkResolver()
            const resolverAddress = etherlinkResolver.getAddress(dstChainId)

            try {
                const swapData = await etherlinkResolver.prepareSwapFromApi(
                    srcUSDC.address,
                    dstWXTZ.address,
                    amount,
                    resolverAddress,
                    1,
                    true
                )

                console.log('Real API Swap Params received:', {
                    routerAddress: swapData.routerAddress,
                    approveCallData: swapData.approveCall.data.slice(0, 20) + '...',
                    swapCallData: swapData.swapCall.data.slice(0, 20) + '...',
                    expectedOutput: swapData.expectedOutput.toString(),
                    gasEstimate: swapData.gasEstimate
                })

                expect(swapData.routerAddress).toMatch(/^0x[a-fA-F0-9]{40}$/)
                expect(swapData.approveCall.data).toMatch(/^0x095ea7b3/) // approve signature
                expect(swapData.swapCall.data).toMatch(/^0x[a-fA-F0-9]+/) // valid hex
                expect(swapData.expectedOutput).toBeGreaterThan(0n)
                expect(swapData.gasEstimate).toBeGreaterThan(0)

                // Verify approve call structure
                expect(swapData.approveCall.target).toBe(srcUSDC.address)
                expect(swapData.swapCall.target).toBe(swapData.routerAddress)
            } catch (error) {
                console.log('Real API not available, skipping test:', error.message)
                throw error
            }
        })

        it('should prepare deployDst transaction with real swap data', async () => {
            const dstUSDC = getToken(dstChainId, 'USDC')
            env.getChain(srcChainId)
            const dstChain = env.getChain(dstChainId)
            const etherlinkResolver = env.getEtherlinkResolver()
            const dstChainUser = env.getUserWallet(dstChainId)
            const dstChainResolver = env.getResolverWallet(dstChainId)

            // Create order USDC -> WXTZ (needs swap on destination)
            const {order, secret} = await env.createOrder({
                srcChainId,
                dstChainId,
                makingToken: 'USDC',
                takingToken: 'WXTZ',
                makingAmount: 10,
                takingAmount: 0.1
            })

            // Mock immutables (in real test this would come from deploySrc)
            const mockImmutables = order.toSrcImmutables(
                srcChainId,
                new Sdk.Address(etherlinkResolver.getAddress(srcChainId)),
                order.makingAmount
            )

            // Create dst immutables with complement and deployedAt timestamp
            const dstImmutables = mockImmutables
                .withComplement({
                    maker: new Sdk.Address(await dstChainUser.getAddress()),
                    amount: order.takingAmount,
                    token: new Sdk.Address(getToken(dstChainId, 'WXTZ').address),
                    safetyDeposit: order.escrowExtension.dstSafetyDeposit
                })
                .withTaker(new Sdk.Address(etherlinkResolver.getAddress(dstChainId)))
                .withDeployedAt(BigInt(Math.floor(Date.now() / 1000))) // Add current timestamp

            try {
                // This should make real API call and prepare transaction
                const deployDstTx = await etherlinkResolver.deployDstWithSwap(
                    dstChain.escrowFactory,
                    order,
                    dstImmutables,
                    dstUSDC.address, // we receive USDC from src chain
                    1 // 1% slippage
                )

                console.log('DeployDst transaction prepared with real API data:', {
                    to: deployDstTx.to,
                    dataLength: deployDstTx.data?.length,
                    value: deployDstTx.value?.toString()
                })

                expect(deployDstTx.to).toBe(etherlinkResolver.getAddress(dstChainId))
                expect(deployDstTx.data).toBeDefined()
                expect(deployDstTx.data?.length).toBeGreaterThan(100) // Should have approve + swap + deployDst calls

                await dstChainResolver.send(deployDstTx)

                console.log('Real API integration test completed successfully!')
            } catch (error) {
                console.log('Real API not available or error occurred:', error.message)
                throw error
            }
        })
    })
})
