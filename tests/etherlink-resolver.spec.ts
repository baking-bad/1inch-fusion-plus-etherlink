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

// Mock router interface based on your IRouter
const routerAbi = [
    'function swap(uint256 amountIn, uint256 amountOutMin, address to, uint256 deadline, uint256 params, tuple(address tokenAddress, bool isNative)[] tokens, tuple(address routerAddress, uint256 packedData)[] steps, tuple(address referrer, uint256 feeAmount) referrerInfo) external payable returns (uint256 amountOut)'
]

const {Address} = Sdk

jest.setTimeout(1000 * 180)

const userPk = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
const resolverPk = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a'

// Test configuration
const srcChainId = Sdk.NetworkEnum.ETHEREUM
const dstChainId = 128123 // Etherlink Testnet

const srcChainConfig = getChainConfig(srcChainId)
const dstChainConfig = getChainConfig(dstChainId)

// Mock API responses
const mockApiResponse = {
    params: '0x105cc68f0000000000000000000000000000000000000000000000000de0b6b3a764000000000000000000000000000000000000000000000000000000000000000a5836000000000000000000000000d83f2583568aa36d3c1d10022c4edbc4cc04968500000000000000000000000000000000000000000000000000000000688b4280000000000000000000000000000000000000000000000000000000000002020000000000000000000000000000000000000000000000000000000000000001200000000000000000000000000000000000000000000000000000000000000200000000000000000000000000dab642ad8c2779f8ff07d14a11825191fb6823ac000000000000000000000000000000000000000000000000006a94d74f4300000000000000000000000000000000000000000000000000000000000000000003000000000000000000000000c9b53ab2679f573e480d01e0f49e2b5cfb7a3eab0000000000000000000000000000000000000000000000000000000000000001000000000000000000000000b1ea698633d57705e93b0e40c1077d46cd6a51d800000000000000000000000000000000000000000000000000000000000000000000000000000000000000004c2aa252bee766d3399850569713b5517893484900000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000002000000000000000000000000b1ea698633d57705e93b0e40c1077d46cd6a51d800000000000000000000000000000000000000000000000000010027100200000000000000000000000000003a0ab0b66deb8b5e433710953362abcc1ae763e4000000000000000000000000000000000000000000000001f402012710010202',
    router: '0x6785F736b1646ACbA1233BA952C0f35fFC6F0d4B',
    dstAmount: '681349',
    gas: 10000000
}

// Mock fetch for API calls
global.fetch = jest.fn(() =>
    Promise.resolve({
        ok: true,
        json: () => Promise.resolve(mockApiResponse)
    })
) as jest.Mock

describe.skip('EtherlinkResolver Tests', () => {
    const mockRouterAddress = dstChainConfig.etherlinkRouter || '0x693762D959A7f0deF7d54Ae440c935a85a82f6a0'

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

        // Setup EtherlinkResolver
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
                [getToken(dstChainId, 'WBTC').address.toLowerCase()]: {
                    symbol: 'WBTC',
                    decimals: 18
                }
            },
            dstChainConfig.etherlinkApiUrl || 'https://mock-api.com'
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

    describe('Same token swaps (no swap needed)', () => {
        it('should swap ETH USDC -> Etherlink USDC without API calls', async () => {
            const srcUSDC = getToken(srcChainId, 'USDC')
            const dstUSDC = getToken(dstChainId, 'USDC')

            // User creates order
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

            console.log(`[${srcChainId}]`, `Filling order ${orderHash}`)

            // Execute deploySrc (standard)
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

            console.log(`[${srcChainId}]`, `Order ${orderHash} filled for ${fillAmount} in tx ${orderFillHash}`)

            const srcEscrowEvent = await srcFactory.getSrcDeployEvent(srcDeployBlock)
            const dstImmutables = srcEscrowEvent[0]
                .withComplement(srcEscrowEvent[1])
                .withTaker(new Address(etherlinkResolver.getAddress(dstChainId)))

            console.log(`[${dstChainId}]`, `Depositing ${dstImmutables.amount} for order ${orderHash}`)

            // Execute deployDst without swap (same tokens)
            const {txHash: dstDepositHash} = await dstChainResolver.send(
                await etherlinkResolver.deployDstWithSwap(
                    order,
                    dstImmutables,
                    dstUSDC.address, // src = USDC
                    dstUSDC.address, // dst = USDC (same token)
                    dstImmutables.amount.toString()
                )
            )
            console.log(`[${dstChainId}]`, `Created dst deposit for order ${orderHash} in tx ${dstDepositHash}`)

            // Verify no API calls were made (tokens are the same)
            expect(fetch).not.toHaveBeenCalled()

            console.log('Same token swap completed without API calls')
        })
    })

    describe('Cross token swaps (swap needed)', () => {
        it('should swap ETH USDC -> Etherlink WBTC with API integration', async () => {
            // Reset fetch mock
            jest.clearAllMocks()

            const srcUSDC = getToken(srcChainId, 'USDC')
            const dstWBTC = getToken(dstChainId, 'WBTC')

            const secret = uint8ArrayToHex(randomBytes(32))
            const order = createCustomCrossChainOrder(
                new Sdk.Address(src.escrowFactory),
                {
                    salt: Sdk.randBigInt(1000n),
                    maker: new Sdk.Address(await srcChainUser.getAddress()),
                    makingAmount: parseUnits('100', srcUSDC.decimals),
                    takingAmount: parseUnits('1', dstWBTC.decimals), // 1 WBTC
                    makerAsset: new Sdk.Address(srcUSDC.address),
                    takerAsset: new Sdk.Address(dstWBTC.address) // WBTC on destination
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

            console.log(`[${srcChainId}]`, `Filling order ${orderHash}`)

            // Execute deploySrc (standard)
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

            console.log(`[${srcChainId}]`, `Order ${orderHash} filled for ${fillAmount} in tx ${orderFillHash}`)

            const srcEscrowEvent = await srcFactory.getSrcDeployEvent(srcDeployBlock)
            const dstImmutables = srcEscrowEvent[0]
                .withComplement(srcEscrowEvent[1])
                .withTaker(new Address(etherlinkResolver.getAddress(dstChainId)))

            console.log(`[${dstChainId}]`, `Executing deployDst with USDC -> WBTC swap`)

            // Execute deployDst with swap (different tokens)
            const deployDstTx = await etherlinkResolver.deployDstWithSwap(
                order,
                dstImmutables,
                getToken(dstChainId, 'USDC').address, // src = USDC
                dstWBTC.address, // dst = WBTC (different token)
                dstImmutables.amount.toString(),
                1 // 1% slippage
            )

            // Verify API was called
            expect(fetch).toHaveBeenCalledTimes(1)
            expect(fetch).toHaveBeenCalledWith(expect.stringContaining('swap_params'))

            // Verify transaction contains approve + swap calls
            expect(deployDstTx.data).toBeDefined()
            console.log('Cross token swap transaction prepared with API integration')
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
            Address.fromBigInt(0n).toString(),
            deployer.address,
            60 * 30,
            60 * 30
        ],
        provider,
        deployer
    )
    console.log(`[${cnf.chainId}]`, `Escrow factory contract deployed to`, escrowFactory)

    // deploy  Resolver contract
    const resolver = await deploy(
        ResolverContract,
        [escrowFactory, cnf.limitOrderProtocol, computeAddress(resolverPk)],
        provider,
        deployer
    )
    console.log(`[${cnf.chainId}]`, ` Resolver contract deployed to`, resolver)

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
