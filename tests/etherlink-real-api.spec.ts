import 'dotenv/config'
import {expect, jest} from '@jest/globals'

import {createServer, CreateServerReturnType} from 'prool'
import {anvil} from 'prool/instances'

import Sdk from '@1inch/cross-chain-sdk'
import {
    computeAddress,
    ContractFactory,
    Interface,
    JsonRpcProvider,
    MaxUint256,
    parseEther,
    parseUnits,
    randomBytes,
    Wallet as SignerWallet
} from 'ethers'
import {uint8ArrayToHex, UINT_40_MAX} from '@1inch/byte-utils'
import assert from 'node:assert'
import {getChainConfig, getToken, ChainConfig} from './config'
import {Wallet} from './wallet'
import {EtherlinkResolver} from './etherlink-resolver'
import {EscrowFactory} from './escrow-factory'
import {createCustomCrossChainOrder} from './custom-cross-chain-order'
import factoryContract from '../dist/contracts/TestEscrowFactory.sol/TestEscrowFactory.json'
import ResolverContract from '../dist/contracts/Resolver.sol/Resolver.json'

// Mock router interface - we don't need the real one since API gives us calldata
const routerAbi = ['function name() view returns (string)']

const {Address} = Sdk

jest.setTimeout(1000 * 60 * 5) // 5 minutes for real API calls

const userPk = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
const resolverPk = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a'

// Test configuration
const srcChainId = Sdk.NetworkEnum.ETHEREUM
const dstChainId = 128123 // Etherlink Testnet

const srcChainConfig = getChainConfig(srcChainId)
const dstChainConfig = getChainConfig(dstChainId)

describe('EtherlinkResolver Real API Tests', () => {
    const realApiUrl = dstChainConfig.etherlinkApiUrl || 'https://api.etherlink.your-domain.com'
    const mockRouterAddress = dstChainConfig.etherlinkRouter || '0x6785F736b1646ACbA1233BA952C0f35fFC6F0d4B'

    type Chain = {
        node?: CreateServerReturnType | undefined
        provider: JsonRpcProvider
        escrowFactory: string
        resolver: string
    }

    let src: Chain
    let dst: Chain

    let srcChainUser: Wallet
    let dstChainUser: Wallet
    let srcChainResolver: Wallet
    let dstChainResolver: Wallet

    let srcFactory: EscrowFactory
    let dstFactory: EscrowFactory
    let srcResolverContract: Wallet
    let dstResolverContract: Wallet

    let etherlinkResolver: EtherlinkResolver
    let srcTimestamp: bigint

    async function increaseTime(t: number): Promise<void> {
        await Promise.all([src, dst].map((chain) => chain.provider.send('evm_increaseTime', [t])))
    }

    beforeAll(async () => {
        ;[src, dst] = await Promise.all([initChain(srcChainConfig), initChain(dstChainConfig)])

        srcChainUser = new Wallet(userPk, src.provider)
        dstChainUser = new Wallet(userPk, dst.provider)
        srcChainResolver = new Wallet(resolverPk, src.provider)
        dstChainResolver = new Wallet(resolverPk, dst.provider)

        srcFactory = new EscrowFactory(src.provider, src.escrowFactory)
        dstFactory = new EscrowFactory(dst.provider, dst.escrowFactory)

        // Setup EtherlinkResolver with real API URL
        etherlinkResolver = new EtherlinkResolver(
            {
                [srcChainId]: src.resolver,
                [dstChainId]: dst.resolver
            },
            {
                address: mockRouterAddress,
                interface: new Interface(routerAbi)
            },
            {
                [getToken(dstChainId, 'USDC').address.toLowerCase()]: {
                    symbol: 'USDC',
                    decimals: 6
                },
                [getToken(dstChainId, 'WETH').address.toLowerCase()]: {
                    symbol: 'WETH',
                    decimals: 18
                },
                [getToken(dstChainId, 'WETH').address.toLowerCase()]: {
                    symbol: 'WETH',
                    decimals: 18
                }
            },
            realApiUrl
        )

        // Setup balances
        const srcUSDC = getToken(srcChainId, 'USDC')
        await srcChainUser.topUpFromDonor(srcUSDC.address, srcUSDC.donor, parseUnits('1000', srcUSDC.decimals))
        await srcChainUser.approveToken(srcUSDC.address, srcChainConfig.limitOrderProtocol, MaxUint256)

        srcResolverContract = await Wallet.fromAddress(src.resolver, src.provider)
        dstResolverContract = await Wallet.fromAddress(dst.resolver, dst.provider)

        const dstUSDC = getToken(dstChainId, 'USDC')
        await dstResolverContract.topUpFromDonor(dstUSDC.address, dstUSDC.donor, parseUnits('2000', dstUSDC.decimals))

        await dstChainResolver.transfer(dst.resolver, parseEther('1'))
        await dstResolverContract.unlimitedApprove(dstUSDC.address, dst.escrowFactory)

        srcTimestamp = BigInt((await src.provider.getBlock('latest'))!.timestamp)
    })

    afterAll(async () => {
        src.provider.destroy()
        dst.provider.destroy()
        await Promise.all([src.node?.stop(), dst.node?.stop()])
    })

    describe('Real API Integration Tests', () => {
        it('should get quote from real API', async () => {
            const srcUSDC = getToken(dstChainId, 'USDC')
            const dstWETH = getToken(dstChainId, 'WETH')

            try {
                const quote = await etherlinkResolver.getQuote(
                    srcUSDC.address,
                    dstWETH.address,
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

                // Skip test if real API is not available - this should pass the test
                throw error
            }
        })

        it('should get swap params from real API', async () => {
            const srcUSDC = getToken(dstChainId, 'USDC')
            const dstWETH = getToken(dstChainId, 'WETH')
            const amount = parseUnits('100', srcUSDC.decimals).toString()
            const resolverAddress = etherlinkResolver.getAddress(dstChainId)

            try {
                const swapData = await etherlinkResolver.prepareSwapFromApi(
                    srcUSDC.address,
                    dstWETH.address,
                    amount,
                    resolverAddress,
                    1 // 1% slippage
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
            const srcUSDC = getToken(srcChainId, 'USDC')
            const dstUSDC = getToken(dstChainId, 'USDC')
            const dstWETH = getToken(dstChainId, 'WETH')

            // Create order USDC -> WETH (needs swap on destination)
            const secret = uint8ArrayToHex(randomBytes(32))
            const order = createCustomCrossChainOrder(
                new Sdk.Address(src.escrowFactory),
                {
                    salt: Sdk.randBigInt(1000n),
                    maker: new Sdk.Address(await srcChainUser.getAddress()),
                    makingAmount: parseUnits('100', srcUSDC.decimals),
                    takingAmount: parseUnits('1', dstWETH.decimals), // 1 WETH
                    makerAsset: new Sdk.Address(srcUSDC.address),
                    takerAsset: new Sdk.Address(dstWETH.address)
                },
                {
                    hashLock: Sdk.HashLock.forSingleFill(secret),
                    timeLocks: Sdk.TimeLocks.new({
                        srcWithdrawal: 10n,
                        srcPublicWithdrawal: 120n,
                        srcCancellation: 121n,
                        srcPublicCancellation: 122n,
                        dstWithdrawal: 10n,
                        dstPublicWithdrawal: 100n,
                        dstCancellation: 101n
                    }),
                    srcChainId,
                    dstChainId,
                    srcSafetyDeposit: parseEther('0.001'),
                    dstSafetyDeposit: parseEther('0.001')
                },
                {
                    auction: new Sdk.AuctionDetails({
                        initialRateBump: 0,
                        points: [],
                        duration: 120n,
                        startTime: srcTimestamp
                    }),
                    whitelist: [
                        {
                            address: new Sdk.Address(src.resolver),
                            allowFrom: 0n
                        }
                    ],
                    resolvingStartTime: 0n
                },
                {
                    nonce: Sdk.randBigInt(UINT_40_MAX),
                    allowPartialFills: false,
                    allowMultipleFills: false
                }
            )

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
                    token: new Sdk.Address(dstWETH.address),
                    safetyDeposit: order.escrowExtension.dstSafetyDeposit
                })
                .withTaker(new Sdk.Address(etherlinkResolver.getAddress(dstChainId)))
                .withDeployedAt(BigInt(Math.floor(Date.now() / 1000))) // Add current timestamp

            try {
                // This should make real API call and prepare transaction
                const deployDstTx = await etherlinkResolver.deployDstWithSwap(
                    order,
                    dstImmutables,
                    dstUSDC.address, // we receive USDC from src chain
                    dstWETH.address, // but need to deliver WETH to user
                    dstImmutables.amount.toString(),
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

                console.log('Real API integration test completed successfully!')
            } catch (error) {
                console.log('Real API not available or error occurred:', error.message)

                throw error
            }
        })
    })

    describe('Error Handling Tests', () => {
        it('should handle API errors gracefully', async () => {
            // Create resolver with invalid API URL
            const invalidResolver = new EtherlinkResolver(
                {[dstChainId]: dst.resolver},
                {address: mockRouterAddress, interface: new Interface(routerAbi)},
                {},
                'https://invalid-api-url-that-does-not-exist.com'
            )

            const srcUSDC = getToken(dstChainId, 'USDC')
            const dstWETH = getToken(dstChainId, 'WETH')

            await expect(invalidResolver.getQuote(srcUSDC.address, dstWETH.address, '1000000')).rejects.toThrow()

            console.log('Error handling test completed')
        })
    })
})

async function initChain(
    cnf: ChainConfig
): Promise<{node?: CreateServerReturnType; provider: JsonRpcProvider; escrowFactory: string; resolver: string}> {
    const {node, provider} = await getProvider(cnf)
    const deployer = new SignerWallet(cnf.ownerPrivateKey, provider)

    // deploy EscrowFactory
    const escrowFactory = await deploy(
        factoryContract,
        [
            cnf.limitOrderProtocol,
            cnf.wrappedNative,
            Sdk.Address.fromBigInt(0n).toString(),
            deployer.address,
            60 * 30,
            60 * 30
        ],
        provider,
        deployer
    )
    console.log(`[${cnf.chainId}]`, `Escrow factory contract deployed to`, escrowFactory)

    // deploy Enhanced Resolver contract
    const resolver = await deploy(
        ResolverContract,
        [escrowFactory, cnf.limitOrderProtocol, computeAddress(resolverPk)],
        provider,
        deployer
    )
    console.log(`[${cnf.chainId}]`, `Enhanced Resolver contract deployed to`, resolver)

    return {node: node, provider, resolver, escrowFactory}
}

async function getProvider(cnf: ChainConfig): Promise<{node?: CreateServerReturnType; provider: JsonRpcProvider}> {
    if (!cnf.createFork) {
        return {
            provider: new JsonRpcProvider(cnf.url, cnf.chainId, {
                cacheTimeout: -1,
                staticNetwork: true
            })
        }
    }

    const node = createServer({
        instance: anvil({forkUrl: cnf.url, chainId: cnf.chainId}),
        limit: 1
    })
    await node.start()

    const address = node.address()
    assert(address)

    const provider = new JsonRpcProvider(`http://[${address.address}]:${address.port}/1`, cnf.chainId, {
        cacheTimeout: -1,
        staticNetwork: true
    })

    return {
        provider,
        node
    }
}

async function deploy(
    json: {abi: any; bytecode: any},
    params: unknown[],
    provider: JsonRpcProvider,
    deployer: SignerWallet
): Promise<string> {
    const deployed = await new ContractFactory(json.abi, json.bytecode, deployer).deploy(...params)
    await deployed.waitForDeployment()

    return await deployed.getAddress()
}
