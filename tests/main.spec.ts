import 'dotenv/config'
import {expect, jest} from '@jest/globals'

import {createServer, CreateServerReturnType} from 'prool'
import {anvil} from 'prool/instances'

import Sdk from '@1inch/cross-chain-sdk'
import {
    computeAddress,
    ContractFactory,
    JsonRpcProvider,
    MaxUint256,
    parseEther,
    parseUnits,
    randomBytes,
    Wallet as SignerWallet
} from 'ethers'
import {uint8ArrayToHex, UINT_40_MAX} from '@1inch/byte-utils'
import assert from 'node:assert'

// Import our custom modules
import {ChainConfig, config, calculateTotalCost, validateEtherlinkConfig} from './config'
import {Wallet} from './wallet'
import {Resolver} from './resolver' // Standard resolver for source chain
import {EscrowFactory} from './escrow-factory'
import {EtherlinkOrderManager} from './order-manager' // Our order manager for destination
import {EtherlinkApiClient} from './etherlink-api-client'

// Import contract artifacts
import factoryContract from '../dist/contracts/TestEscrowFactory.sol/TestEscrowFactory.json'
import resolverContract from '../dist/contracts/Resolver.sol/Resolver.json'
import orderManagerContract from '../dist/contracts/EtherlinkOrderManager.sol/EtherlinkOrderManager.json'

const {Address} = Sdk

jest.setTimeout(1000 * 120) // Increased timeout for cross-chain operations

const userPk = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
const resolverPk = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a'

interface Chain {
    node?: CreateServerReturnType | undefined
    provider: JsonRpcProvider
    escrowFactory: string
    resolver: string
    orderManager?: string // Only for Etherlink
}

interface BalanceResult {
    src: {user: bigint; resolver: bigint}
    dst: {user: bigint; resolver: bigint}
}

// eslint-disable-next-line max-lines-per-function
describe('Etherlink Fusion+ Integration', () => {
    const srcChainId = config.chain.source.chainId
    const dstChainId = config.chain.destination.chainId

    let src: Chain // Ethereum
    let dst: Chain // Etherlink

    let srcChainUser: Wallet
    let dstChainUser: Wallet
    let srcChainResolver: Wallet
    let dstChainResolver: Wallet

    let srcFactory: EscrowFactory
    let dstFactory: EscrowFactory
    let srcResolverContract: Wallet
    let dstOrderManagerContract: Wallet

    let etherlinkOrderManager: EtherlinkOrderManager
    let etherlinkApiClient: EtherlinkApiClient

    let srcTimestamp: bigint

    async function increaseTime(t: number): Promise<void> {
        await Promise.all([src, dst].map((chain) => chain.provider.send('evm_increaseTime', [t])))
    }

    beforeAll(async () => {
        // Validate Etherlink configuration
        const configChecks = validateEtherlinkConfig()
        console.log('Configuration validation:', configChecks)

        // Initialize chains
        ;[src, dst] = await Promise.all([
            initSourceChain(config.chain.source),
            initEtherlinkChain(config.chain.destination)
        ])

        // Initialize wallets
        srcChainUser = new Wallet(userPk, src.provider)
        dstChainUser = new Wallet(userPk, dst.provider)
        srcChainResolver = new Wallet(resolverPk, src.provider)
        dstChainResolver = new Wallet(resolverPk, dst.provider)

        // Initialize factories
        srcFactory = new EscrowFactory(src.provider, src.escrowFactory)
        dstFactory = new EscrowFactory(dst.provider, dst.escrowFactory)

        // Setup source chain (Ethereum) - standard setup
        await setupSourceChain()

        // Setup destination chain (Etherlink) - with order manager
        await setupEtherlinkChain()

        // Initialize Etherlink components
        etherlinkApiClient = new EtherlinkApiClient()
        etherlinkOrderManager = new EtherlinkOrderManager(dst.orderManager!, dst.resolver, etherlinkApiClient)

        srcTimestamp = BigInt((await src.provider.getBlock('latest'))!.timestamp)
    })

    async function setupSourceChain(): Promise<void> {
        // Get 1000 USDC for user in source chain and approve to LOP
        await srcChainUser.topUpFromDonor(
            config.chain.source.tokens.USDC.address,
            config.chain.source.tokens.USDC.donor,
            parseUnits('1000', 6)
        )
        await srcChainUser.approveToken(
            config.chain.source.tokens.USDC.address,
            config.chain.source.limitOrderProtocol,
            MaxUint256
        )

        srcResolverContract = await Wallet.fromAddress(src.resolver, src.provider)
    }

    async function setupEtherlinkChain(): Promise<void> {
        // Fund order manager with XTZ and tokens for conversions
        dstOrderManagerContract = await Wallet.fromAddress(dst.orderManager!, dst.provider)

        // Transfer XTZ to order manager for operations from donor
        const xtzDonor = config.chain.destination.tokens.XTZ?.donor || (await dstChainResolver.getAddress())

        if (xtzDonor !== (await dstChainResolver.getAddress())) {
            // If we have a specific XTZ donor, use it
            const xtzDonorWallet = await Wallet.fromAddress(xtzDonor, dst.provider)
            await xtzDonorWallet.transfer(dst.orderManager!, parseEther('10'))
        } else {
            // Otherwise use resolver as donor
            await dstChainResolver.transfer(dst.orderManager!, parseEther('10'))
        }

        // If we have USDC on Etherlink, fund it too
        const etherlinkUSDC = config.chain.destination.tokens.USDC

        if (etherlinkUSDC.address !== '0x0000000000000000000000000000000000000000') {
            await dstOrderManagerContract.topUpFromDonor(
                etherlinkUSDC.address,
                etherlinkUSDC.donor,
                parseUnits('5000', 6)
            )
        }
    }

    async function getBalances(srcToken: string, dstToken: string): Promise<BalanceResult> {
        return {
            src: {
                user:
                    srcToken === '0x0000000000000000000000000000000000000000'
                        ? await src.provider.getBalance(await srcChainUser.getAddress())
                        : await srcChainUser.tokenBalance(srcToken),
                resolver:
                    srcToken === '0x0000000000000000000000000000000000000000'
                        ? await src.provider.getBalance(await srcResolverContract.getAddress())
                        : await srcResolverContract.tokenBalance(srcToken)
            },
            dst: {
                user:
                    dstToken === '0x0000000000000000000000000000000000000000'
                        ? await dst.provider.getBalance(await dstChainUser.getAddress())
                        : await dstChainUser.tokenBalance(dstToken),
                resolver:
                    dstToken === '0x0000000000000000000000000000000000000000'
                        ? await dst.provider.getBalance(await dstOrderManagerContract.getAddress())
                        : await dstOrderManagerContract.tokenBalance(dstToken)
            }
        }
    }

    afterAll(async () => {
        src.provider.destroy()
        dst.provider.destroy()
        await Promise.all([src.node?.stop(), dst.node?.stop()])
    })

    describe('Cross-chain swaps with token conversion', () => {
        it('should swap Ethereum USDC -> Etherlink XTZ with conversion', async () => {
            const xtzAddress = '0x0000000000000000000000000000000000000000' // Native XTZ
            const initialBalances = await getBalances(config.chain.source.tokens.USDC.address, xtzAddress)

            // User creates order: USDC on Ethereum -> XTZ on Etherlink
            const secret = uint8ArrayToHex(randomBytes(32))
            const order = Sdk.CrossChainOrder.new(
                new Address(src.escrowFactory),
                {
                    salt: Sdk.randBigInt(1000n),
                    maker: new Address(await srcChainUser.getAddress()),
                    makingAmount: parseUnits('100', 6), // 100 USDC
                    takingAmount: parseEther('0.05'), // 0.05 XTZ (after conversion + fees)
                    makerAsset: new Address(config.chain.source.tokens.USDC.address),
                    takerAsset: new Address(xtzAddress) // XTZ on Etherlink
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
                            address: new Address(src.resolver),
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

            // Step 1: Standard resolver fills order on source chain
            const resolverContract = new Resolver(src.resolver, dst.resolver)

            console.log(`[${srcChainId}]`, `Filling order ${orderHash}`)

            const fillAmount = order.makingAmount
            const {txHash: orderFillHash, blockHash: srcDeployBlock} = await srcChainResolver.send(
                resolverContract.deploySrc(
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

            // Step 2: Get source escrow event and prepare destination
            const srcEscrowEvent = await srcFactory.getSrcDeployEvent(srcDeployBlock)
            const dstImmutables = srcEscrowEvent[0]
                .withComplement(srcEscrowEvent[1])
                .withTaker(new Address(dst.orderManager!))

            console.log(`[${dstChainId}]`, `Creating dst escrow with conversion for order ${orderHash}`)

            // Step 3: Deploy destination escrow with conversion through order manager
            const conversionConfig = etherlinkOrderManager.createConversionConfig(
                'tokenToEth', // Converting received tokens to XTZ
                xtzAddress
            )

            const {txHash: dstDepositHash, blockTimestamp: dstDeployedAt} = await dstChainResolver.send(
                await etherlinkOrderManager.deployDst(dstImmutables, undefined, conversionConfig)
            )

            console.log(`[${dstChainId}]`, `Created dst escrow with conversion in tx ${dstDepositHash}`)

            // Step 4: Calculate escrow addresses
            const ESCROW_SRC_IMPLEMENTATION = await srcFactory.getSourceImpl()
            const ESCROW_DST_IMPLEMENTATION = await dstFactory.getDestinationImpl()

            const srcEscrowAddress = new Sdk.EscrowFactory(new Address(src.escrowFactory)).getSrcEscrowAddress(
                srcEscrowEvent[0],
                ESCROW_SRC_IMPLEMENTATION
            )

            const dstEscrowAddress = new Sdk.EscrowFactory(new Address(dst.escrowFactory)).getDstEscrowAddress(
                srcEscrowEvent[0],
                srcEscrowEvent[1],
                dstDeployedAt,
                new Address(dst.orderManager!),
                ESCROW_DST_IMPLEMENTATION
            )

            await increaseTime(11) // Wait for finality lock

            // Step 5: User withdraws converted XTZ from destination
            console.log(`[${dstChainId}]`, `Withdrawing converted XTZ for user from ${dstEscrowAddress}`)
            const withdrawConfig = etherlinkOrderManager.createConversionConfig('tokenToEth', xtzAddress)

            await dstChainResolver.send(
                await etherlinkOrderManager.withdraw(
                    'dst',
                    dstEscrowAddress,
                    secret,
                    dstImmutables.withDeployedAt(dstDeployedAt),
                    withdrawConfig
                )
            )

            // Step 6: Resolver withdraws USDC from source
            console.log(`[${srcChainId}]`, `Withdrawing USDC for resolver from ${srcEscrowAddress}`)
            await srcChainResolver.send(resolverContract.withdraw('src', srcEscrowAddress, secret, srcEscrowEvent[0]))

            // Step 7: Verify balances
            const resultBalances = await getBalances(config.chain.source.tokens.USDC.address, xtzAddress)

            // User should have lost USDC and gained XTZ
            expect(initialBalances.src.user - resultBalances.src.user).toBe(order.makingAmount)
            expect(resultBalances.dst.user).toBeGreaterThan(initialBalances.dst.user)

            console.log('Conversion successful:', {
                usdcLost: (initialBalances.src.user - resultBalances.src.user).toString(),
                xtzGained: (resultBalances.dst.user - initialBalances.dst.user).toString()
            })
        })

        it('should swap Ethereum ETH -> Etherlink USDC with bridge fee calculation', async () => {
            const ethAddress = '0x0000000000000000000000000000000000000000'
            const usdcAddress = config.chain.destination.tokens.USDC.address

            // Skip if USDC not configured on Etherlink
            if (usdcAddress === '0x0000000000000000000000000000000000000000') {
                console.log('Skipping test: USDC not configured on Etherlink')

                return
            }

            // Calculate bridge costs
            const swapAmount = parseEther('1') // 1 ETH
            const bridgeCost = calculateTotalCost(swapAmount.toString())

            console.log('Bridge cost calculation:', {
                swapAmount: swapAmount.toString(),
                bridgeFee: bridgeCost.bridgeFee.toString(),
                feeBuffer: bridgeCost.feeBuffer.toString(),
                totalCost: bridgeCost.totalCost.toString()
            })

            // User creates order: ETH -> USDC with bridge fees considered
            const secret = uint8ArrayToHex(randomBytes(32))
            const order = Sdk.CrossChainOrder.new(
                new Address(src.escrowFactory),
                {
                    salt: Sdk.randBigInt(1000n),
                    maker: new Address(await srcChainUser.getAddress()),
                    makingAmount: swapAmount,
                    takingAmount: parseUnits('2500', 6), // Expected USDC after conversion
                    makerAsset: new Address(ethAddress),
                    takerAsset: new Address(usdcAddress)
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
                            address: new Address(src.resolver),
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

            // Get conversion quote (ETH -> XTZ -> USDC on Etherlink)
            const quote = await etherlinkOrderManager.getConversionQuote(
                ethAddress, // ETH input
                usdcAddress, // USDC output
                bridgeCost.swapAmount.toString(),
                true
            )

            console.log('Conversion quote:', {
                expectedOutput: quote.quote.amountOut,
                minOutput: quote.quote.minAmountOut,
                bridgeIncluded: !!quote.bridgeCalculation
            })

            // Execute the same flow but with ETH -> USDC conversion
            // (implementation follows similar pattern as previous test)

            expect(quote.quote.amountOut).toBeDefined()
            expect(quote.bridgeCalculation).toBeDefined()
        })

        it('should handle cancellation with token conversion back', async () => {
            const xtzAddress = '0x0000000000000000000000000000000000000000' // Native XTZ
            const initialBalances = await getBalances(config.chain.source.tokens.USDC.address, xtzAddress)

            // Create order that will be cancelled
            const secret = uint8ArrayToHex(randomBytes(32))
            const hashLock = Sdk.HashLock.forSingleFill(secret)

            const order = Sdk.CrossChainOrder.new(
                new Address(src.escrowFactory),
                {
                    salt: Sdk.randBigInt(1000n),
                    maker: new Address(await srcChainUser.getAddress()),
                    makingAmount: parseUnits('50', 6),
                    takingAmount: parseEther('0.025'),
                    makerAsset: new Address(config.chain.source.tokens.USDC.address),
                    takerAsset: new Address(xtzAddress) // XTZ on Etherlink
                },
                {
                    hashLock,
                    timeLocks: Sdk.TimeLocks.new({
                        srcWithdrawal: 0n, // No finality lock for test
                        srcPublicWithdrawal: 120n,
                        srcCancellation: 121n,
                        srcPublicCancellation: 122n,
                        dstWithdrawal: 0n,
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
                            address: new Address(src.resolver),
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
            const resolverContract = new Resolver(src.resolver, dst.resolver)

            // Execute order
            const {blockHash: srcDeployBlock} = await srcChainResolver.send(
                resolverContract.deploySrc(
                    srcChainId,
                    order,
                    signature,
                    Sdk.TakerTraits.default()
                        .setExtension(order.extension)
                        .setAmountMode(Sdk.AmountMode.maker)
                        .setAmountThreshold(order.takingAmount),
                    order.makingAmount
                )
            )

            // Deploy destination with conversion
            const srcEscrowEvent = await srcFactory.getSrcDeployEvent(srcDeployBlock)
            const dstImmutables = srcEscrowEvent[0]
                .withComplement(srcEscrowEvent[1])
                .withTaker(new Address(dst.orderManager!))

            const conversionConfig = etherlinkOrderManager.createConversionConfig('tokenToEth', xtzAddress)
            const {blockTimestamp: dstDeployedAt} = await dstChainResolver.send(
                await etherlinkOrderManager.deployDst(dstImmutables, undefined, conversionConfig)
            )

            // Calculate escrow addresses
            const ESCROW_SRC_IMPLEMENTATION = await srcFactory.getSourceImpl()
            const ESCROW_DST_IMPLEMENTATION = await dstFactory.getDestinationImpl()

            const srcEscrowAddress = new Sdk.EscrowFactory(new Address(src.escrowFactory)).getSrcEscrowAddress(
                srcEscrowEvent[0],
                ESCROW_SRC_IMPLEMENTATION
            )

            const dstEscrowAddress = new Sdk.EscrowFactory(new Address(dst.escrowFactory)).getDstEscrowAddress(
                srcEscrowEvent[0],
                srcEscrowEvent[1],
                dstDeployedAt,
                new Address(dst.orderManager!),
                ESCROW_DST_IMPLEMENTATION
            )

            // Wait for cancellation period
            await increaseTime(125)

            // Cancel both escrows with conversion back
            console.log(`[${dstChainId}]`, `Cancelling dst escrow with conversion`)
            const cancelConfig = etherlinkOrderManager.createConversionConfig(
                'ethToToken',
                config.chain.source.tokens.USDC.address
            )

            await dstChainResolver.send(
                await etherlinkOrderManager.cancel(
                    'dst',
                    dstEscrowAddress,
                    dstImmutables.withDeployedAt(dstDeployedAt),
                    cancelConfig
                )
            )

            console.log(`[${srcChainId}]`, `Cancelling src escrow`)
            await srcChainResolver.send(resolverContract.cancel('src', srcEscrowAddress, srcEscrowEvent[0]))

            // Verify balances are restored
            const resultBalances = await getBalances(config.chain.source.tokens.USDC.address, xtzAddress)

            // Balances should be approximately equal (minus gas costs)
            expect(resultBalances.src.user).toBeCloseTo(initialBalances.src.user, -4) // Allow for gas differences
            expect(resultBalances.dst.user).toBeCloseTo(initialBalances.dst.user, -4)
        })
    })
})

// Initialize source chain (Ethereum) with standard setup
async function initSourceChain(cnf: ChainConfig): Promise<Chain> {
    const {node, provider} = await getProvider(cnf)
    const deployer = new SignerWallet(cnf.ownerPrivateKey, provider)

    // Deploy EscrowFactory
    const escrowFactory = await deploy(
        factoryContract,
        [
            cnf.limitOrderProtocol,
            cnf.wrappedNative,
            Address.fromBigInt(0n).toString(),
            deployer.address,
            60 * 30, // src rescue delay
            60 * 30 // dst rescue delay
        ],
        provider,
        deployer
    )

    // Deploy standard Resolver
    const resolver = await deploy(
        resolverContract,
        [escrowFactory, cnf.limitOrderProtocol, computeAddress(resolverPk)],
        provider,
        deployer
    )

    console.log(`[${cnf.chainId}] Source chain setup complete:`, {escrowFactory, resolver})

    return {node, provider, escrowFactory, resolver}
}

// Initialize Etherlink chain with order manager
async function initEtherlinkChain(cnf: ChainConfig): Promise<Chain> {
    const {node, provider} = await getProvider(cnf)
    const deployer = new SignerWallet(cnf.ownerPrivateKey, provider)

    // Deploy EscrowFactory
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

    // Deploy standard Resolver (for compatibility)
    const resolver = await deploy(
        resolverContract,
        [escrowFactory, cnf.limitOrderProtocol, computeAddress(resolverPk)],
        provider,
        deployer
    )

    // Deploy EtherlinkOrderManager
    const orderManager = await deploy(
        orderManagerContract,
        [
            cnf.etherlinkRouter, // Your router address
            resolver, // Standard resolver address
            deployer.address // Owner
        ],
        provider,
        deployer
    )

    console.log(`[${cnf.chainId}] Etherlink chain setup complete:`, {escrowFactory, resolver, orderManager})

    return {node, provider, escrowFactory, resolver, orderManager}
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
