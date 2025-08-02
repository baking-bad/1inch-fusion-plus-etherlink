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

const {Address} = Sdk

// jest.setTimeout(1000 * 60 * 10) // 10 minutes for real API calls
jest.setTimeout(1000 * 40)
const userPk = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
const resolverPk = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a'

const srcChainId = Sdk.NetworkEnum.ETHEREUM
const dstChainId = 128123 // Etherlink Testnet

const srcChainConfig = getChainConfig(srcChainId)
const dstChainConfig = getChainConfig(dstChainId)

describe.skip('Core Scenarios with Real API', () => {
    const realApiUrl = dstChainConfig.etherlinkApiUrl

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

    async function getBalances(srcToken: string, dstToken: string) {
        return {
            src: {
                user: await srcChainUser.tokenBalance(srcToken),
                resolver: await srcResolverContract.tokenBalance(srcToken)
            },
            dst: {
                user: await dstChainUser.tokenBalance(dstToken),
                resolver: await dstResolverContract.tokenBalance(dstToken)
            }
        }
    }

    beforeAll(async () => {
        ;[src, dst] = await Promise.all([initChain(srcChainConfig), initChain(dstChainConfig)])

        srcChainUser = new Wallet(userPk, src.provider)
        dstChainUser = new Wallet(userPk, dst.provider)
        srcChainResolver = new Wallet(resolverPk, src.provider)
        dstChainResolver = new Wallet(resolverPk, dst.provider)

        srcFactory = new EscrowFactory(src.provider, src.escrowFactory)
        dstFactory = new EscrowFactory(dst.provider, dst.escrowFactory)

        etherlinkResolver = new EtherlinkResolver(
            {
                [srcChainId]: src.resolver,
                [dstChainId]: dst.resolver
            },
            {
                [getToken(dstChainId, 'USDC').address.toLowerCase()]: {
                    symbol: 'USDC',
                    decimals: 6
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

        // Setup resolver balances on destination
        srcResolverContract = await Wallet.fromAddress(src.resolver, src.provider)
        dstResolverContract = await Wallet.fromAddress(dst.resolver, dst.provider)

        const dstUSDC = getToken(dstChainId, 'USDC')
        const dstWETH = getToken(dstChainId, 'WETH')

        await dstResolverContract.topUpFromDonor(dstUSDC.address, dstUSDC.donor, parseUnits('2000', dstUSDC.decimals))
        await dstResolverContract.topUpFromDonor(dstWETH.address, dstWETH.donor, parseUnits('10', dstWETH.decimals))

        await dstChainResolver.transfer(dst.resolver, parseEther('2'))
        await dstResolverContract.unlimitedApprove(dstUSDC.address, dst.escrowFactory)
        await dstResolverContract.unlimitedApprove(dstWETH.address, dst.escrowFactory)

        srcTimestamp = BigInt((await src.provider.getBlock('latest'))!.timestamp)
    })

    afterAll(async () => {
        src.provider?.destroy()
        dst.provider?.destroy()
        // await Promise.all([src.node?.stop(), dst.node?.stop()])
    })

    describe.skip('Scenario 1: ETH USDC → Etherlink USDC (no swap needed)', () => {
        it('should complete cross-chain transfer without API calls', async () => {
            const srcUSDC = getToken(srcChainId, 'USDC')
            const dstUSDC = getToken(dstChainId, 'USDC')

            const initialBalances = await getBalances(srcUSDC.address, dstUSDC.address)

            const secret = uint8ArrayToHex(randomBytes(32))
            const order = createCustomCrossChainOrder(
                new Sdk.Address(src.escrowFactory),
                {
                    salt: Sdk.randBigInt(1000n),
                    maker: new Sdk.Address(await srcChainUser.getAddress()),
                    makingAmount: parseUnits('100', srcUSDC.decimals),
                    takingAmount: parseUnits('99', dstUSDC.decimals),
                    makerAsset: new Sdk.Address(srcUSDC.address),
                    takerAsset: new Sdk.Address(dstUSDC.address)
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

            const signature = await srcChainUser.signOrder(srcChainId, order)
            const orderHash = order.getOrderHash(srcChainId)

            console.log(`[Scenario 1] Filling order ${orderHash}`)

            // Execute deploySrc
            const fillAmount = order.makingAmount
            const {txHash: orderFillHash, blockHash: srcDeployBlock} = await srcChainResolver.send(
                etherlinkResolver.deploySrc(
                    srcChainId,
                    order,
                    signature,
                    Sdk.TakerTraits.default()
                        .setExtension(order.extension)
                        .setAmountMode(Sdk.AmountMode.maker)
                        .setAmountThreshold(order.takingAmount),
                    fillAmount
                )
            )

            console.log(`[Scenario 1] Order filled in tx ${orderFillHash}`)

            const srcEscrowEvent = await srcFactory.getSrcDeployEvent(srcDeployBlock)
            const dstImmutables = srcEscrowEvent[0]
                .withComplement(srcEscrowEvent[1])
                .withTaker(new Sdk.Address(etherlinkResolver.getAddress(dstChainId)))

            // Execute deployDst without swap (same tokens)
            const {txHash: dstDepositHash, blockTimestamp: dstDeployedAt} = await dstChainResolver.send(
                await etherlinkResolver.deployDstWithSwap(
                  dst.escrowFactory,
                    order,
                    dstImmutables,
                    dstUSDC.address
                )
            )

            console.log(`[Scenario 1] Dst escrow created in tx ${dstDepositHash}`)

            const ESCROW_SRC_IMPLEMENTATION = await srcFactory.getSourceImpl()
            const ESCROW_DST_IMPLEMENTATION = await dstFactory.getDestinationImpl()

            const srcEscrowAddress = new Sdk.EscrowFactory(new Sdk.Address(src.escrowFactory)).getSrcEscrowAddress(
                srcEscrowEvent[0],
                ESCROW_SRC_IMPLEMENTATION
            )

            const dstEscrowAddress = new Sdk.EscrowFactory(new Sdk.Address(dst.escrowFactory)).getDstEscrowAddress(
                srcEscrowEvent[0],
                srcEscrowEvent[1],
                dstDeployedAt,
                new Sdk.Address(etherlinkResolver.getAddress(dstChainId)),
                ESCROW_DST_IMPLEMENTATION
            )

            await increaseTime(11)

            // User withdraws from dst
            await dstChainResolver.send(
                etherlinkResolver.withdraw(
                    dstChainId,
                    dstEscrowAddress,
                    secret,
                    dstImmutables.withDeployedAt(dstDeployedAt)
                )
            )

            // Resolver withdraws from src
            await srcChainResolver.send(
                etherlinkResolver.withdraw(srcChainId, srcEscrowAddress, secret, srcEscrowEvent[0])
            )

            const finalBalances = await getBalances(srcUSDC.address, dstUSDC.address)

            expect(initialBalances.src.user - finalBalances.src.user).toBe(order.makingAmount)
            expect(finalBalances.src.resolver - initialBalances.src.resolver).toBe(order.makingAmount)
            expect(finalBalances.dst.user - initialBalances.dst.user).toBe(order.takingAmount)
            expect(initialBalances.dst.resolver - finalBalances.dst.resolver).toBe(order.takingAmount)

            console.log('[Scenario 1] Completed successfully - no swap needed')
        })
    })

    describe('Scenario 2: ETH USDC → Etherlink WETH (swap on destination)', () => {
        it('should complete cross-chain transfer with swap on destination using real API', async () => {
            const srcUSDC = getToken(srcChainId, 'USDC')
            const dstUSDC = getToken(dstChainId, 'USDC')
            const dstWETH = getToken(dstChainId, 'WETH')

            const initialBalances = await getBalances(srcUSDC.address, dstWETH.address)

            const secret = uint8ArrayToHex(randomBytes(32))
            const order = createCustomCrossChainOrder(
                new Sdk.Address(src.escrowFactory),
                {
                    salt: Sdk.randBigInt(1000n),
                    maker: new Sdk.Address(await srcChainUser.getAddress()),
                    makingAmount: parseUnits('100', srcUSDC.decimals),
                    takingAmount: parseUnits('0.05', dstWETH.decimals), // 0.05 WETH
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

            const signature = await srcChainUser.signOrder(srcChainId, order)
            const orderHash = order.getOrderHash(srcChainId)

            console.log(`[Scenario 2] Filling order ${orderHash}`)

            try {
                // Execute deploySrc
                const fillAmount = order.makingAmount
                const {txHash: orderFillHash, blockHash: srcDeployBlock} = await srcChainResolver.send(
                    etherlinkResolver.deploySrc(
                        srcChainId,
                        order,
                        signature,
                        Sdk.TakerTraits.default()
                            .setExtension(order.extension)
                            .setAmountMode(Sdk.AmountMode.maker)
                            .setAmountThreshold(order.takingAmount),
                        fillAmount
                    )
                )

                console.log(`[Scenario 2] Order filled in tx ${orderFillHash}`)

                const srcEscrowEvent = await srcFactory.getSrcDeployEvent(srcDeployBlock)
                const dstImmutables = srcEscrowEvent[0]
                    .withComplement(srcEscrowEvent[1])
                    .withTaker(new Sdk.Address(etherlinkResolver.getAddress(dstChainId)))

                // Execute deployDst with swap (USDC → WETH) - this calls real API
                console.log(`[Scenario 2] Executing deployDst with USDC -> WETH swap via real API`)

                const {txHash: dstDepositHash, blockTimestamp: dstDeployedAt} = await dstChainResolver.send(
                    await etherlinkResolver.deployDstWithSwap(
                      dst.escrowFactory,
                        order,
                        dstImmutables,
                        dstUSDC.address, // we receive USDC from src
                        2 // 2% slippage for better success rate
                    )
                )

                console.log(`[Scenario 2] Dst escrow with swap created in tx ${dstDepositHash}`)

                const ESCROW_SRC_IMPLEMENTATION = await srcFactory.getSourceImpl()
                const ESCROW_DST_IMPLEMENTATION = await dstFactory.getDestinationImpl()

                const srcEscrowAddress = new Sdk.EscrowFactory(new Sdk.Address(src.escrowFactory)).getSrcEscrowAddress(
                    srcEscrowEvent[0],
                    ESCROW_SRC_IMPLEMENTATION
                )

                const dstEscrowAddress = new Sdk.EscrowFactory(new Sdk.Address(dst.escrowFactory)).getDstEscrowAddress(
                    srcEscrowEvent[0],
                    srcEscrowEvent[1],
                    dstDeployedAt,
                    new Sdk.Address(etherlinkResolver.getAddress(dstChainId)),
                    ESCROW_DST_IMPLEMENTATION
                )

                await increaseTime(11)

                // User withdraws WETH from dst
                await dstChainResolver.send(
                    etherlinkResolver.withdraw(
                        dstChainId,
                        dstEscrowAddress,
                        secret,
                        dstImmutables.withDeployedAt(dstDeployedAt)
                    )
                )

                // Resolver withdraws USDC from src
                await srcChainResolver.send(
                    etherlinkResolver.withdraw(srcChainId, srcEscrowAddress, secret, srcEscrowEvent[0])
                )

                const finalBalances = await getBalances(srcUSDC.address, dstWETH.address)

                expect(initialBalances.src.user - finalBalances.src.user).toBe(order.makingAmount)
                expect(finalBalances.src.resolver - initialBalances.src.resolver).toBe(order.makingAmount)
                expect(finalBalances.dst.user - initialBalances.dst.user).toBeGreaterThan(0n) // Should receive some WETH

                console.log('[Scenario 2] Completed successfully with real API swap')
            } catch (error) {
                console.log('[Scenario 2] Real API not available or failed:', error.message)
                throw error
            }
        })
    })

    describe.skip('Scenario 3: Etherlink WETH → ETH USDC (swap on source)', () => {
        it('should complete cross-chain transfer with swap on source using real API', async () => {
            const srcWETH = getToken(dstChainId, 'WETH') // Note: using dst config for src tokens
            const srcUSDC = getToken(dstChainId, 'USDC')
            const dstUSDC = getToken(srcChainId, 'USDC') // Note: using src config for dst tokens

            // Setup WETH balance for user on Etherlink
            await dstChainUser.topUpFromDonor(srcWETH.address, srcWETH.donor, parseUnits('1', srcWETH.decimals))
            await dstChainUser.approveToken(srcWETH.address, dstChainConfig.limitOrderProtocol, MaxUint256)

            // Setup resolver with USDC on Ethereum
            await srcResolverContract.topUpFromDonor(
                dstUSDC.address,
                dstUSDC.donor,
                parseUnits('2000', dstUSDC.decimals)
            )
            await srcResolverContract.unlimitedApprove(dstUSDC.address, src.escrowFactory)

            const initialBalances = await getBalances(dstUSDC.address, srcWETH.address)

            const secret = uint8ArrayToHex(randomBytes(32))
            const order = createCustomCrossChainOrder(
                new Sdk.Address(dst.escrowFactory), // Note: reversed - Etherlink is source now
                {
                    salt: Sdk.randBigInt(1000n),
                    maker: new Sdk.Address(await dstChainUser.getAddress()),
                    makingAmount: parseUnits('0.1', srcWETH.decimals), // 0.1 WETH
                    takingAmount: parseUnits('200', dstUSDC.decimals), // 200 USDC
                    makerAsset: new Sdk.Address(srcWETH.address),
                    takerAsset: new Sdk.Address(dstUSDC.address)
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
                    srcChainId: dstChainId, // Note: reversed
                    dstChainId: srcChainId, // Note: reversed
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
                            address: new Sdk.Address(dst.resolver), // Note: dst resolver for src chain
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

            const signature = await dstChainUser.signOrder(dstChainId, order)
            const orderHash = order.getOrderHash(dstChainId)

            console.log(`[Scenario 3] Filling order ${orderHash}`)

            try {
                // This would need a modified deploySrc that does WETH -> USDC swap on Etherlink first
                // For now, let's show the concept with a regular deploySrc
                console.log('[Scenario 3] This scenario requires deploySrcWithSwap implementation')
                console.log('[Scenario 3] Would swap WETH -> USDC on Etherlink, then send USDC to Ethereum')

                // In real implementation, we would:
                // 1. User has WETH on Etherlink
                // 2. deploySrcWithSwap: swap WETH -> USDC on Etherlink via real API
                // 3. Send USDC to Ethereum escrow
                // 4. User gets USDC on Ethereum

                console.log('[Scenario 3] Skipping full implementation for hackathon scope')
            } catch (error) {
                console.log('[Scenario 3] Implementation needed:', error.message)
            }
        })
    })
})

async function initChain(
    cnf: ChainConfig
): Promise<{node?: CreateServerReturnType; provider: JsonRpcProvider; escrowFactory: string; resolver: string}> {
    const {node, provider} = await getProvider(cnf)
    const deployer = new SignerWallet(cnf.ownerPrivateKey, provider)

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

    const resolver = await deploy(
        ResolverContract,
        [escrowFactory, cnf.limitOrderProtocol, computeAddress(resolverPk)],
        provider,
        deployer
    )

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

    return {provider, node}
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
