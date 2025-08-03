import 'dotenv/config'
import {expect, jest} from '@jest/globals'
import Sdk from '@1inch/cross-chain-sdk'

import {getChainConfig, getToken, testConfig} from './config'
import {TestEnvironment, increaseTime} from './test-utils/chain-utils'

jest.setTimeout(testConfig.timeoutMs)
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms * 1000))
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
        env.createEtherlinkResolver(
            dstChainId,
            ['USDC', 'WXTZ'],
            dstChainConfig.etherlinkApiUrl,
            dstChainConfig.etherlinkApiKey
        )
    })

    afterAll(async () => {
        await env.cleanup()
    })

    describe('Scenario 1: ETH USDC -> Etherlink USDC (no swap)', () => {
        it('should transfer USDC to USDC without API calls and complete withdraw', async () => {
            await env.setupUserBalances(srcChainId, [{token: 'USDC', amount: 0.1}])
            await env.setupResolverBalances(dstChainId, [{token: 'USDC', amount: 0.1}])
            await env.setupResolverContractBalances(dstChainId, [{token: 'USDC', amount: 0.1}])

            const dstChain = env.getChain(dstChainId)
            const etherlinkResolver = env.getEtherlinkResolver()
            const dstChainResolver = env.getResolverWallet(dstChainId)
            const dstUSDC = getToken(dstChainId, 'USDC')

            // Record initial balances (check resolver CONTRACT balances, not wallet)
            const initialBalances = {
                srcUser: await env.getUserWallet(srcChainId).tokenBalance(getToken(srcChainId, 'USDC').address),
                srcResolverContract: await env.getUserWallet(srcChainId).tokenBalanceOf(
                    getToken(srcChainId, 'USDC').address,
                    env.getEtherlinkResolver().getAddress(srcChainId) // Resolver contract address
                ),
                dstUser: await env.getUserWallet(dstChainId).tokenBalance(dstUSDC.address),
                dstResolverContract: await env.getUserWallet(dstChainId).tokenBalanceOf(
                    dstUSDC.address,
                    env.getEtherlinkResolver().getAddress(dstChainId) // Resolver contract address
                )
            }

            // Create order USDC -> USDC (same token, no swap needed)
            const {order, secret} = await env.createOrder({
                makingToken: 'USDC',
                takingToken: 'USDC', // Same token
                makingAmount: 0.1,
                takingAmount: 0.098
            })

            console.log('Created USDC -> USDC cross-chain order')

            // Execute deploySrc flow
            const {dstImmutables} = await env.executeDeploySrc(order)

            // Execute deployDst on Etherlink (no swap needed)
            console.log(`[${dstChainId}] Deploying destination escrow for USDC`)
            const deployDstTx = await etherlinkResolver.deployDstWithSwap(
                dstChain.escrowFactory,
                order,
                dstImmutables,
                dstUSDC.address, // resolver has USDC
                1 // slippage (won't be used)
            )

            const {txHash: dstDepositHash, blockTimestamp: dstDeployedAt} = await dstChainResolver.send(deployDstTx)
            console.log(`[${dstChainId}] Destination escrow deployed in tx ${dstDepositHash}`)

            // Wait for finality lock to pass
            await increaseTime(env.getProviders(), 15)

            // Execute withdraws
            // 1. Withdraw on destination (user gets USDC on Etherlink)
            const {txHash: dstWithdrawHash} = await env.withdrawDst(
                secret,
                dstDeployedAt
                // No swap config - same token
            )
            console.log(`[${dstChainId}] User withdrew USDC in tx ${dstWithdrawHash}`)

            // 2. Withdraw on source (resolver gets USDC on Ethereum)
            const {txHash: srcWithdrawHash} = await env.withdrawSrc(
                secret,
                dstDeployedAt
                // No swap config - same token
            )
            console.log(`[${srcChainId}] Resolver withdrew USDC in tx ${srcWithdrawHash}`)

            // Verify final balances (check resolver CONTRACT balances)
            const finalBalances = {
                srcUser: await env.getUserWallet(srcChainId).tokenBalance(getToken(srcChainId, 'USDC').address),
                srcResolverContract: await env
                    .getUserWallet(srcChainId)
                    .tokenBalanceOf(
                        getToken(srcChainId, 'USDC').address,
                        env.getEtherlinkResolver().getAddress(srcChainId)
                    ),
                dstUser: await env.getUserWallet(dstChainId).tokenBalance(dstUSDC.address),
                dstResolverContract: await env
                    .getUserWallet(dstChainId)
                    .tokenBalanceOf(dstUSDC.address, env.getEtherlinkResolver().getAddress(dstChainId))
            }

            // User transferred USDC from src to dst
            expect(initialBalances.srcUser - finalBalances.srcUser).toBe(order.makingAmount)
            expect(finalBalances.dstUser - initialBalances.dstUser).toBe(order.takingAmount)

            // Resolver CONTRACT gained USDC on src, lost USDC on dst
            expect(finalBalances.srcResolverContract - initialBalances.srcResolverContract).toBe(order.makingAmount)
            expect(initialBalances.dstResolverContract - finalBalances.dstResolverContract).toBe(order.takingAmount)

            console.log('USDC -> USDC transfer completed without swap')
        })
    })

    describe('Scenario 2: ETH USDC -> Etherlink WXTZ (with swap)', () => {
        it('should swap USDC to WXTZ using API integration and complete withdraw', async () => {
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
            const dstWXTZ = getToken(dstChainId, 'WXTZ')

            // Record initial balances (check resolver CONTRACT balances)
            const initialBalances = {
                srcUser: await env.getUserWallet(srcChainId).tokenBalance(getToken(srcChainId, 'USDC').address),
                srcResolverContract: await env
                    .getUserWallet(srcChainId)
                    .tokenBalanceOf(
                        getToken(srcChainId, 'USDC').address,
                        env.getEtherlinkResolver().getAddress(srcChainId)
                    ),
                dstUser: await env.getUserWallet(dstChainId).tokenBalance(dstWXTZ.address),
                dstResolverContractUSDC: await env
                    .getUserWallet(dstChainId)
                    .tokenBalanceOf(dstUSDC.address, env.getEtherlinkResolver().getAddress(dstChainId)),
                dstResolverContractWXTZ: await env
                    .getUserWallet(dstChainId)
                    .tokenBalanceOf(dstWXTZ.address, env.getEtherlinkResolver().getAddress(dstChainId))
            }

            // Create order USDC -> WXTZ (different tokens, swap needed)
            const {order, secret} = await env.createOrder({
                makingToken: 'USDC',
                takingToken: 'WXTZ', // Different token
                makingAmount: 1,
                takingAmount: 0.05
            })

            console.log('Created USDC -> WXTZ cross-chain order with swap')

            // Execute deploySrc flow
            const {dstImmutables} = await env.executeDeploySrc(order)

            // Execute deployDst on Etherlink with USDC -> WXTZ swap
            console.log(`[${dstChainId}] Deploying destination escrow with USDC -> WXTZ swap`)
            const deployDstTx = await etherlinkResolver.deployDstWithSwap(
                dstChain.escrowFactory,
                order,
                dstImmutables,
                dstUSDC.address, // resolver has USDC, needs WXTZ
                2 // 2% slippage for swap
            )

            const {txHash: dstDepositHash, blockTimestamp: dstDeployedAt} = await dstChainResolver.send(deployDstTx)
            console.log(`[${dstChainId}] Destination escrow with swap deployed in tx ${dstDepositHash}`)

            // Verify transaction contains multiple calls (approve + swap + deployDst)
            expect(deployDstTx.data).toBeDefined()
            expect(deployDstTx.data?.length).toBeGreaterThan(200) // Complex transaction with multiple calls

            // Wait for finality lock to pass
            await increaseTime(env.getProviders(), 15)
            // await delay(15)
            // Execute withdraws
            // 1. Withdraw on destination (user gets WXTZ on Etherlink - no additional swap)
            const {txHash: dstWithdrawHash} = await env.withdrawDst(
                secret,
                dstDeployedAt
                // No swap config - user wants WXTZ as ordered
            )
            console.log(`[${dstChainId}] User withdrew WXTZ in tx ${dstWithdrawHash}`)

            // 2. Withdraw on source with reverse swap (resolver gets USDC back)
            const {txHash: srcWithdrawHash} = await env.withdrawSrc(secret, dstDeployedAt, {
                fromToken: dstWXTZ.address, // Resolver received WXTZ from escrow
                toToken: dstUSDC.address, // But wants USDC back
                amount: order.takingAmount,
                slippage: 3 // 3% slippage for reverse swap
            })
            console.log(`[${srcChainId}] Resolver withdrew with WXTZ -> USDC reverse swap in tx ${srcWithdrawHash}`)

            // Verify final balances (check resolver CONTRACT balances)
            const finalBalances = {
                srcUser: await env.getUserWallet(srcChainId).tokenBalance(getToken(srcChainId, 'USDC').address),
                srcResolverContract: await env
                    .getUserWallet(srcChainId)
                    .tokenBalanceOf(
                        getToken(srcChainId, 'USDC').address,
                        env.getEtherlinkResolver().getAddress(srcChainId)
                    ),
                dstUser: await env.getUserWallet(dstChainId).tokenBalance(dstWXTZ.address),
                dstResolverContractUSDC: await env
                    .getUserWallet(dstChainId)
                    .tokenBalanceOf(dstUSDC.address, env.getEtherlinkResolver().getAddress(dstChainId)),
                dstResolverContractWXTZ: await env
                    .getUserWallet(dstChainId)
                    .tokenBalanceOf(dstWXTZ.address, env.getEtherlinkResolver().getAddress(dstChainId))
            }

            // User transferred USDC from src, received WXTZ on dst
            expect(initialBalances.srcUser - finalBalances.srcUser).toBe(order.makingAmount)
            expect(finalBalances.dstUser - initialBalances.dstUser).toBe(order.takingAmount)

            // Resolver CONTRACT gained USDC on src
            expect(finalBalances.srcResolverContract - initialBalances.srcResolverContract).toBe(order.makingAmount)

            // Resolver CONTRACT should have approximately same USDC on dst (allowing for slippage)
            const resolverUSDCDiff = finalBalances.dstResolverContractUSDC - initialBalances.dstResolverContractUSDC
            const maxSlippageLoss = (BigInt(order.takingAmount) * 5n) / 100n // 5% max loss
            expect(resolverUSDCDiff).toBeGreaterThan(-maxSlippageLoss)

            console.log('USDC -> WXTZ swap completed with API integration')
        })
    })

    describe('Cancel Scenarios', () => {
        describe('Cancel without swap: ETH USDC -> Etherlink USDC', () => {
            it.skip('should cancel cross-chain order without token swaps', async () => {
                await env.setupUserBalances(srcChainId, [{token: 'USDC', amount: 1}])
                await env.setupResolverBalances(dstChainId, [{token: 'USDC', amount: 0.5}])
                await env.setupResolverContractBalances(dstChainId, [{token: 'USDC', amount: 0.5}])

                const etherlinkResolver = env.getEtherlinkResolver()
                const dstUSDC = getToken(dstChainId, 'USDC')

                // Record initial balances (check resolver CONTRACT balances)
                const initialBalances = {
                    srcUser: await env.getUserWallet(srcChainId).tokenBalance(getToken(srcChainId, 'USDC').address),
                    dstResolverContract: await env
                        .getUserWallet(dstChainId)
                        .tokenBalanceOf(dstUSDC.address, env.getEtherlinkResolver().getAddress(dstChainId))
                }

                // Create order: USDC -> USDC
                const {order, secret} = await env.createOrder({
                    makingToken: 'USDC',
                    takingToken: 'USDC',
                    makingAmount: 0.5,
                    takingAmount: 0.48
                })

                console.log('Created USDC -> USDC order for cancel test')

                // Execute deploySrc
                const {dstImmutables} = await env.executeDeploySrc(order)

                // Execute deployDst (no swap needed)
                const dstResolverWallet = env.getResolverWallet(dstChainId)
                const deployDstTx = etherlinkResolver.deployDst(order, dstImmutables, [])

                const {blockTimestamp: dstDeployedAt} = await dstResolverWallet.send(deployDstTx)
                console.log(`[${dstChainId}] Destination escrow deployed`)

                // Calculate escrow addresses
                const {srcEscrowAddress, dstEscrowAddress} = await env.calculateEscrowAddresses(dstDeployedAt)

                // Simulate timeout
                await env.increaseTime(125)
                console.log('Timeout reached - proceeding with cancellation')

                // Cancel destination escrow (no swap needed)
                console.log(`[${dstChainId}] Cancelling dst escrow ${dstEscrowAddress}`)
                const cancelDstTx = etherlinkResolver.cancel(
                    dstChainId,
                    new Sdk.Address(dstEscrowAddress),
                    dstImmutables.withDeployedAt(dstDeployedAt),
                    []
                )
                await dstResolverWallet.send(cancelDstTx)

                // Cancel source escrow
                console.log(`[${srcChainId}] Cancelling src escrow ${srcEscrowAddress}`)
                const srcResolverWallet = env.getResolverWallet(srcChainId)
                const cancelSrcTx = etherlinkResolver.cancel(
                    srcChainId,
                    new Sdk.Address(srcEscrowAddress),
                    dstImmutables,
                    []
                )
                const {txHash: cancelSrcHash} = await srcResolverWallet.send(cancelSrcTx)
                console.log(`[${srcChainId}] Cancelled src escrow in tx ${cancelSrcHash}`)

                // Verify balances are restored (check resolver CONTRACT balances)
                const finalBalances = {
                    srcUser: await env.getUserWallet(srcChainId).tokenBalance(getToken(srcChainId, 'USDC').address),
                    dstResolverContract: await env
                        .getUserWallet(dstChainId)
                        .tokenBalanceOf(dstUSDC.address, env.getEtherlinkResolver().getAddress(dstChainId))
                }

                expect(finalBalances.srcUser).toBe(initialBalances.srcUser)
                expect(finalBalances.dstResolverContract).toBe(initialBalances.dstResolverContract)

                console.log('USDC -> USDC cancel completed successfully without swaps')
            })
        })

        describe('Cancel with reverse swap: ETH USDC -> Etherlink WXTZ', () => {
            it.skip('should cancel order with reverse swap WXTZ -> USDC', async () => {
                await env.setupUserBalances(srcChainId, [{token: 'USDC', amount: 5}])
                await env.setupResolverBalances(dstChainId, [
                    {token: 'XTZ', amount: 3},
                    {token: 'USDC', amount: 1},
                    {token: 'WXTZ', amount: 0.1}
                ])
                await env.setupResolverContractBalances(dstChainId, [
                    {token: 'USDC', amount: 1},
                    {token: 'WXTZ', amount: 0.1}
                ])

                const etherlinkResolver = env.getEtherlinkResolver()
                const dstUSDC = getToken(dstChainId, 'USDC')
                const dstWXTZ = getToken(dstChainId, 'WXTZ')

                // Record initial balances (check resolver CONTRACT balances)
                const initialBalances = {
                    srcUser: await env.getUserWallet(srcChainId).tokenBalance(getToken(srcChainId, 'USDC').address),
                    dstResolverContractUSDC: await env
                        .getUserWallet(dstChainId)
                        .tokenBalanceOf(dstUSDC.address, env.getEtherlinkResolver().getAddress(dstChainId)),
                    dstResolverContractWXTZ: await env
                        .getUserWallet(dstChainId)
                        .tokenBalanceOf(dstWXTZ.address, env.getEtherlinkResolver().getAddress(dstChainId))
                }

                // Create order: USDC -> WXTZ
                const {order, secret} = await env.createOrder({
                    makingToken: 'USDC',
                    takingToken: 'WXTZ',
                    makingAmount: 2,
                    takingAmount: 0.08
                })

                console.log('Created USDC -> WXTZ order for cancel with reverse swap test')

                // Execute deploySrc
                const {dstImmutables} = await env.executeDeploySrc(order)

                // Execute deployDst WITH SWAP (USDC -> WXTZ)
                console.log(`[${dstChainId}] Deploying destination escrow with USDC -> WXTZ swap`)
                const dstResolverWallet = env.getResolverWallet(dstChainId)

                const deployDstTx = await etherlinkResolver.deployDstWithSwap(
                    env.getDstChain().escrowFactory,
                    order,
                    dstImmutables,
                    dstUSDC.address,
                    2
                )

                const {blockTimestamp: dstDeployedAt} = await dstResolverWallet.send(deployDstTx)
                console.log(`[${dstChainId}] Destination escrow with swap deployed`)

                // Calculate escrow addresses
                const {srcEscrowAddress, dstEscrowAddress} = await env.calculateEscrowAddresses(dstDeployedAt)

                // Simulate timeout
                await env.increaseTime(125)
                console.log('Timeout reached - proceeding with cancellation and reverse swap')

                // Cancel destination escrow WITH REVERSE SWAP (WXTZ -> USDC)
                console.log(`[${dstChainId}] Cancelling dst escrow with WXTZ -> USDC reverse swap`)

                const cancelDstTx = await etherlinkResolver.cancelWithSwap(
                    dstChainId,
                    new Sdk.Address(dstEscrowAddress),
                    dstImmutables.withDeployedAt(dstDeployedAt),
                    dstWXTZ.address, // From WXTZ
                    dstUSDC.address, // To USDC
                    order.takingAmount.toString(),
                    3 // 3% slippage
                )

                await dstResolverWallet.send(cancelDstTx)
                console.log('Destination cancellation with reverse swap completed')

                // Cancel source escrow
                console.log(`[${srcChainId}] Cancelling src escrow`)
                const srcResolverWallet = env.getResolverWallet(srcChainId)

                const cancelSrcTx = etherlinkResolver.cancel(
                    srcChainId,
                    new Sdk.Address(srcEscrowAddress),
                    dstImmutables,
                    []
                )

                const {txHash: cancelSrcHash} = await srcResolverWallet.send(cancelSrcTx)
                console.log(`[${srcChainId}] Cancelled src escrow in tx ${cancelSrcHash}`)

                // Verify final balances (check resolver CONTRACT balances)
                const finalBalances = {
                    srcUser: await env.getUserWallet(srcChainId).tokenBalance(getToken(srcChainId, 'USDC').address),
                    dstResolverContractUSDC: await env
                        .getUserWallet(dstChainId)
                        .tokenBalanceOf(dstUSDC.address, env.getEtherlinkResolver().getAddress(dstChainId)),
                    dstResolverContractWXTZ: await env
                        .getUserWallet(dstChainId)
                        .tokenBalanceOf(dstWXTZ.address, env.getEtherlinkResolver().getAddress(dstChainId))
                }

                // User should get their USDC back
                expect(finalBalances.srcUser).toBe(initialBalances.srcUser)

                // Resolver CONTRACT should have approximately the same USDC (allowing for slippage)
                const resolverUSDCDiff = finalBalances.dstResolverContractUSDC - initialBalances.dstResolverContractUSDC
                const maxSlippageLoss = (BigInt(order.takingAmount) * 5n) / 100n

                expect(resolverUSDCDiff).toBeGreaterThan(-maxSlippageLoss)
                console.log(
                    `Resolver CONTRACT USDC difference: ${resolverUSDCDiff.toString()} (within acceptable slippage)`
                )

                // Verify transaction contained swap calls
                expect(cancelDstTx.data).toBeDefined()
                expect(cancelDstTx.data?.length).toBeGreaterThan(200)

                console.log('USDC -> WXTZ cancel with reverse swap completed successfully')
            })
        })
    })

    describe('Integration verification', () => {
        it('should verify EtherlinkResolver swap detection and token support', async () => {
            const etherlinkResolver = env.getEtherlinkResolver()
            const usdcToken = getToken(dstChainId, 'USDC')
            const wxtzToken = getToken(dstChainId, 'WXTZ')

            // Test swap detection
            expect(etherlinkResolver.needsSwap(usdcToken.address, usdcToken.address)).toBe(false)
            expect(etherlinkResolver.needsSwap(usdcToken.address, wxtzToken.address)).toBe(true)
            expect(etherlinkResolver.needsSwap(wxtzToken.address, usdcToken.address)).toBe(true)

            console.log('Swap detection logic verified')

            // Test token support
            expect(etherlinkResolver.isTokenSupported(usdcToken.address)).toBe(true)
            expect(etherlinkResolver.isTokenSupported(wxtzToken.address)).toBe(true)
            expect(etherlinkResolver.isTokenSupported('0x0000000000000000000000000000000000000000')).toBe(false)

            console.log('Token support verification completed')
        })
    })
})
