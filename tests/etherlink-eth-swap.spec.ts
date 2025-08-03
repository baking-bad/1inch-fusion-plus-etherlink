import 'dotenv/config'
import {jest} from '@jest/globals'

import Sdk from '@1inch/cross-chain-sdk'
import {parseUnits} from 'ethers'

import {getChainConfig, getToken, testConfig} from './config'
import {TestEnvironment, increaseTime} from './test-utils/chain-utils'

jest.setTimeout(testConfig.timeoutMs)

// Test configuration - REVERSE: Etherlink -> Ethereum
const srcChainId = 128123 // Etherlink Testnet
const dstChainId = Sdk.NetworkEnum.ETHEREUM

const srcChainConfig = getChainConfig(srcChainId)
const dstChainConfig = getChainConfig(dstChainId)

//There is no LOP contract at Etherlink testnet
describe.skip('Etherlink to ETH Cross-Chain Tests', () => {
    let env: TestEnvironment

    beforeAll(async () => {
        // Initialize test environment with known src/dst chains
        env = new TestEnvironment(srcChainId, dstChainId)
        await env.initChains()

        // Create EtherlinkResolver with real API
        env.createEtherlinkResolver(srcChainId, ['WETH', 'WXTZ'], srcChainConfig.etherlinkApiUrl)
    })

    afterAll(async () => {
        await env.cleanup()
    })

    describe('Scenario 1: Etherlink WETH -> ETH WETH (no swap)', () => {
        it.skip('should transfer WETH to WETH without API calls and complete withdraw', async () => {
            // Setup balances
            await env.setupUserBalances(srcChainId, [
                {token: 'WETH', amount: 5}, // For WETH -> ETH test
                {token: 'WXTZ', amount: 10} // For WXTZ -> ETH test
            ])
            await env.setupResolverBalances(dstChainId, [{token: 'WETH', amount: 10}])
            await env.setupResolverContractBalances(dstChainId, [{token: 'WETH', amount: 5}])

            const dstChain = env.getDstChain()
            const etherlinkResolver = env.getEtherlinkResolver()
            const dstChainResolver = env.getResolverWallet(dstChainId)
            const dstWETH = getToken(dstChainId, 'WETH')

            // Create order WETH -> WETH (same token, no swap needed)
            const {order, secret} = await env.createOrder({
                makingToken: 'WETH',
                takingToken: 'WETH', // Same token
                makingAmount: 1,
                takingAmount: 0.98
            })

            console.log('Created Etherlink WETH -> ETH WETH cross-chain order')

            // Execute deploySrc flow on Etherlink
            const {orderHash, dstImmutables, deployedAt} = await env.executeDeploySrc(order, secret)

            // Execute deployDst on Ethereum (no swap needed)
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

            // Wait for finality lock to pass
            await increaseTime(env.getProviders(), 15)

            // Complete the flow: withdraw on destination, then source
            console.log('Executing withdraw flow...')

            // User withdraws on destination (no swap needed)
            await env.withdrawDst(dstImmutables, secret, deployedAt)

            // Resolver withdraws on source (no swap needed)
            const srcImmutables = dstImmutables // For this case, we can use the same immutables
            await env.withdrawSrc(srcImmutables, secret, deployedAt)

            console.log('WETH -> WETH transfer and withdraw completed without swap')
        })
    })

    describe('Scenario 2: Etherlink USDC -> ETH WETH (with swap)', () => {
        it('should get USDC->WETH quote, create order, and complete withdraw with swap', async () => {
            // Constants
            const USDC_AMOUNT = 1 // 2 USDC for the quote and order
            const FEE_PERCENTAGE = 0.98 // 2% fee

            await env.setupUserBalances(srcChainId, [{token: 'USDC', amount: USDC_AMOUNT}])
            await env.setupResolverBalances(dstChainId, [{token: 'WETH', amount: 10}])
            await env.setupResolverContractBalances(dstChainId, [{token: 'WETH', amount: 5}])
            const dstChain = env.getDstChain()
            const etherlinkResolver = env.getEtherlinkResolver()
            const dstChainResolver = env.getResolverWallet(dstChainId)
            const dstWETH = getToken(dstChainId, 'WETH')

            const srcUSDC = getToken(srcChainId, 'USDC')
            const srcWETH = getToken(srcChainId, 'WETH')

            console.log('Getting USDC -> WETH quote from real API...')

            // Step 1: Get quote to determine correct price ratio
            const quoteAmount = parseUnits(USDC_AMOUNT.toString(), srcUSDC.decimals)
            const quote = await etherlinkResolver.getQuote(srcUSDC.address, srcWETH.address, quoteAmount.toString())

            console.log('API Quote received:', {
                fromToken: quote.srcToken.symbol,
                toToken: quote.dstToken.symbol,
                fromAmount: `${USDC_AMOUNT} USDC`,
                toAmount: quote.dstAmount,
                estimatedGas: quote.gas
            })

            const expectedWETH = BigInt(quote.dstAmount)
            // Use proper decimals and avoid precision issues
            const divisor = BigInt(10 ** srcWETH.decimals)
            const expectedWETHReadable = Number(expectedWETH) / Number(divisor)

            console.log(`Expected output: ${expectedWETHReadable} WETH for ${USDC_AMOUNT} USDC`)

            // Calculate taking amount with fee, ensuring proper precision
            const takingAmountBigInt = (expectedWETH * BigInt(Math.floor(FEE_PERCENTAGE * 10000))) / BigInt(10000)
            const takingAmountReadable = Number(takingAmountBigInt) / Number(divisor)

            // Step 2: Create order with API-derived amounts
            const {order, secret} = await env.createOrder({
                makingToken: 'USDC',
                takingToken: 'WETH',
                makingAmount: USDC_AMOUNT,
                takingAmount: takingAmountReadable
            })

            console.log('Created Etherlink USDC -> ETH WETH cross-chain order with real API pricing')

            // Step 3: Execute deploySrc flow on Etherlink
            const {orderHash, dstImmutables, deployedAt} = await env.executeDeploySrc(order, secret)

            // Step 4: Execute deployDst on Ethereum (no swap needed - resolver has WETH)
            console.log(`[${dstChainId}] Deploying destination escrow for WETH`)
            const {txHash: dstDepositHash} = await dstChainResolver.send(
                await etherlinkResolver.deployDstWithSwap(
                    dstChain.escrowFactory,
                    order,
                    dstImmutables,
                    dstWETH.address, // resolver has WETH
                    1 // slippage (won't be used since no swap on dst)
                )
            )

            console.log(`[${dstChainId}] Destination escrow deployed in tx ${dstDepositHash}`)

            // Wait for finality lock to pass
            await increaseTime(env.getProviders(), 15)

            // User withdraws WETH on destination (no swap needed)
            await env.withdrawDst(dstImmutables, secret, deployedAt)

            // Resolver withdraws USDC on source and swaps to preferred token (WETH)
            const srcImmutables = dstImmutables // We'll need to reconstruct the source immutables properly
            const {txHash} = await env.withdrawSrc(srcImmutables, secret, deployedAt, {
                fromToken: srcUSDC.address, // received USDC from escrow
                toToken: srcWETH.address, // resolver prefers WETH
                amount: order.makingAmount, // amount of USDC to swap
                slippage: 2 // 2% slippage
            })

            console.log(`Source withdraw with swap completed in tx: ${txHash}`)
            console.log('USDC -> WETH swap completed with API integration and withdrawWithSwap')
            console.log('User received WETH on Ethereum, Resolver swapped USDC to WETH on Etherlink')
        })
    })
})
