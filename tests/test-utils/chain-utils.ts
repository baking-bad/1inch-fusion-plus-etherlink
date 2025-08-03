import {createServer, CreateServerReturnType} from 'prool'
import {anvil} from 'prool/instances'
import {
    computeAddress,
    ContractFactory,
    JsonRpcProvider,
    parseEther,
    parseUnits,
    randomBytes,
    Wallet as SignerWallet
} from 'ethers'
import Sdk from '@1inch/cross-chain-sdk'
import {uint8ArrayToHex, UINT_40_MAX} from '@1inch/byte-utils'
import assert from 'node:assert'

import {getChainConfig, getToken, ChainConfig} from '../config'
import {Wallet} from '../wallet'
import {EscrowFactory} from '../escrow-factory'
import {EtherlinkResolver, TokenConfig} from '../etherlink-resolver'
import {createCustomCrossChainOrder} from '../custom-cross-chain-order'
import factoryContract from '../../dist/contracts/TestEscrowFactory.sol/TestEscrowFactory.json'
import ResolverContract from '../../dist/contracts/Resolver.sol/Resolver.json'

export interface TokenAmount {
    token: string // symbol like 'USDC', 'WETH'
    amount: number // human readable amount like 1.01
}

export interface ChainData {
    chainId: number
    node?: CreateServerReturnType
    provider: JsonRpcProvider
    escrowFactory: string
    resolver: string
    config: ChainConfig

    // Wallets
    userWallet: Wallet
    resolverWallet: Wallet

    // Services
    escrowFactoryService: EscrowFactory
}

export class TestEnvironment {
    private chains: Map<number, ChainData> = new Map()

    private etherlinkResolver?: EtherlinkResolver

    private readonly srcChainId: number

    private readonly dstChainId: number

    private dstDeployedAt?: bigint // Store deployed timestamp

    constructor(srcChainId: number, dstChainId: number) {
        this.srcChainId = srcChainId
        this.dstChainId = dstChainId
    }

    /**
     * Initialize single chain with deployed contracts and wallets
     */
    async initChain(chainId: number): Promise<ChainData> {
        if (this.chains.has(chainId)) {
            return this.chains.get(chainId)!
        }

        const config = getChainConfig(chainId)
        const {node, provider} = await getProvider(config)
        const deployer = new SignerWallet(config.ownerPk, provider)

        // Deploy EscrowFactory
        const escrowFactory = await deploy(
            factoryContract,
            [
                config.limitOrderProtocol,
                config.wrappedNative,
                Sdk.Address.fromBigInt(0n).toString(), // accessToken
                deployer.address, // owner
                60 * 30, // src rescue delay
                60 * 30 // dst rescue delay
            ],
            provider,
            deployer
        )

        console.log(`[${config.chainId}] Escrow factory deployed to ${escrowFactory}`)

        // Deploy Enhanced Resolver
        const resolver = await deploy(
            ResolverContract,
            [
                escrowFactory,
                config.limitOrderProtocol,
                computeAddress(config.resolverPk) // resolver as owner
            ],
            provider,
            deployer
        )

        console.log(`[${config.chainId}] Enhanced Resolver deployed to ${resolver}`)

        // Create wallets
        const userWallet = new Wallet(config.userPk, provider)
        const resolverWallet = new Wallet(config.resolverPk, provider)

        // Create services
        const escrowFactoryService = new EscrowFactory(provider, escrowFactory)

        const chainData: ChainData = {
            chainId,
            node,
            provider,
            escrowFactory,
            resolver,
            config,
            userWallet,
            resolverWallet,
            escrowFactoryService
        }

        this.chains.set(chainId, chainData)

        return chainData
    }

    /**
     * Initialize chains (defaults to src and dst)
     */
    async initChains(): Promise<void> {
        await this.initAllChains([this.srcChainId, this.dstChainId])
    }

    /**
     * Initialize multiple chains
     */
    async initAllChains(chainIds: number[]): Promise<void> {
        await Promise.all(chainIds.map((chainId) => this.initChain(chainId)))
    }

    /**
     * Get source chain data
     */
    getSrcChain(): ChainData {
        return this.getChain(this.srcChainId)
    }

    /**
     * Get destination chain data
     */
    getDstChain(): ChainData {
        return this.getChain(this.dstChainId)
    }

    /**
     * Get chain data by chainId
     */
    getChain(chainId: number): ChainData {
        const chain = this.chains.get(chainId)

        if (!chain) {
            throw new Error(`Chain ${chainId} not initialized. Call initChain(${chainId}) first.`)
        }

        return chain
    }

    /**
     * Get all initialized chains
     */
    getAllChains(): ChainData[] {
        return Array.from(this.chains.values())
    }

    /**
     * Get providers for time manipulation
     */
    getProviders(): JsonRpcProvider[] {
        return this.getAllChains().map((chain) => chain.provider)
    }

    /**
     * Check if chain is initialized
     */
    hasChain(chainId: number): boolean {
        return this.chains.has(chainId)
    }

    /**
     * Convenience getters
     */
    getUserWallet(chainId: number): Wallet {
        return this.getChain(chainId).userWallet
    }

    getResolverWallet(chainId: number): Wallet {
        return this.getChain(chainId).resolverWallet
    }

    getEscrowFactory(chainId: number): EscrowFactory {
        return this.getChain(chainId).escrowFactoryService
    }

    /**
     * Create and store EtherlinkResolver
     */
    createEtherlinkResolver(
        etherlinkChainId: number,
        supportedTokenSymbols: string[],
        apiUrl: string
    ): EtherlinkResolver {
        const addresses: Record<number, string> = {}

        for (const chain of this.getAllChains()) {
            addresses[chain.chainId] = chain.resolver
        }

        // Build supported tokens config from chain tokens
        const supportedTokens: TokenConfig = {}

        for (const symbol of supportedTokenSymbols) {
            const tokenInfo = getToken(etherlinkChainId, symbol)
            supportedTokens[tokenInfo.address.toLowerCase()] = {
                symbol,
                decimals: tokenInfo.decimals
            }
        }

        this.etherlinkResolver = new EtherlinkResolver(addresses, supportedTokens, apiUrl)

        return this.etherlinkResolver
    }

    /**
     * Get EtherlinkResolver instance
     */
    getEtherlinkResolver(): EtherlinkResolver {
        if (!this.etherlinkResolver) {
            throw new Error('EtherlinkResolver not created. Call createEtherlinkResolver() first.')
        }

        return this.etherlinkResolver
    }

    /**
     * Setup user balances with auto-approval to LOP
     */
    async setupUserBalances(chainId: number, tokens: TokenAmount[]): Promise<void> {
        const chain = this.getChain(chainId)
        const userWallet = chain.userWallet

        for (const {token, amount} of tokens) {
            const tokenInfo = getToken(chainId, token)
            const amountWei = parseUnits(amount.toString(), tokenInfo.decimals)

            if (tokenInfo.isNative) {
                // Native token (ETH/XTZ)
                if (chain.config.createFork) {
                    const donorWallet = await Wallet.fromAddress(tokenInfo.donor, chain.provider)
                    await donorWallet.transfer(await userWallet.getAddress(), amountWei)
                } else {
                    const ownerWallet = new Wallet(chain.config.ownerPk, chain.provider)
                    await ownerWallet.transfer(await userWallet.getAddress(), amountWei)
                }
                // Native tokens don't need approval
            } else {
                // ERC20 token
                if (chain.config.createFork) {
                    await userWallet.topUpFromDonor(tokenInfo.address, tokenInfo.donor, amountWei)
                } else {
                    const ownerWallet = new Wallet(chain.config.ownerPk, chain.provider)
                    await ownerWallet.transferToken(tokenInfo.address, await userWallet.getAddress(), amountWei)
                }

                await userWallet.unlimitedApprove(tokenInfo.address, chain.config.limitOrderProtocol)
                console.log(`[${chainId}] User approved ${token} to LOP`)
            }
        }

        console.log(`[${chainId}] User balances setup completed for tokens: ${tokens.map((t) => t.token).join(', ')}`)
    }

    /**
     * Setup resolver wallet balances
     */
    async setupResolverBalances(chainId: number, tokens: TokenAmount[]): Promise<void> {
        const chain = this.getChain(chainId)

        for (const {token, amount} of tokens) {
            const tokenInfo = getToken(chainId, token)
            const amountWei = parseUnits(amount.toString(), tokenInfo.decimals)

            if (tokenInfo.isNative) {
                // Native token (ETH/XTZ)
                if (chain.config.createFork) {
                    const donorWallet = await Wallet.fromAddress(tokenInfo.donor, chain.provider)
                    await donorWallet.transfer(await chain.resolverWallet.getAddress(), amountWei)
                } else {
                    const ownerWallet = new Wallet(chain.config.ownerPk, chain.provider)
                    await ownerWallet.transfer(await chain.resolverWallet.getAddress(), amountWei)
                }
            } else {
                // ERC20 token
                if (chain.config.createFork) {
                    await chain.resolverWallet.topUpFromDonor(tokenInfo.address, tokenInfo.donor, amountWei)
                } else {
                    const ownerWallet = new Wallet(chain.config.ownerPk, chain.provider)
                    await ownerWallet.transferToken(
                        tokenInfo.address,
                        await chain.resolverWallet.getAddress(),
                        amountWei
                    )
                }
            }
        }

        console.log(
            `[${chainId}] Resolver wallet balances setup completed for tokens: ${tokens.map((t) => t.token).join(', ')}`
        )
    }

    /**
     * Setup resolver contract balances (transfer to contract address)
     */
    async setupResolverContractBalances(chainId: number, tokens: TokenAmount[]): Promise<void> {
        const chain = this.getChain(chainId)
        const resolverAddress = chain.resolver

        for (const {token, amount} of tokens) {
            const tokenInfo = getToken(chainId, token)
            const amountWei = parseUnits(amount.toString(), tokenInfo.decimals)

            if (tokenInfo.isNative) {
                // Native token to contract
                await chain.resolverWallet.transfer(resolverAddress, amountWei)
            } else {
                // ERC20 token to contract
                await chain.resolverWallet.transferToken(tokenInfo.address, resolverAddress, amountWei)
            }
        }

        console.log(
            `[${chainId}] Resolver contract balances setup completed for tokens: ${tokens.map((t) => t.token).join(', ')}`
        )
    }

    /**
     * Create standard CrossChain order with default settings
     */
    async createOrder(params: {
        makingToken: string // symbol like 'USDC'
        takingToken: string // symbol like 'WXTZ'
        makingAmount: number // human readable like 10.5
        takingAmount: number // human readable like 0.1
        secret?: string // auto-generate if not provided
    }): Promise<{
        order: Sdk.CrossChainOrder
        secret: string
    }> {
        const srcChain = this.getSrcChain()
        const dstChain = this.getDstChain()

        const makingTokenInfo = getToken(this.srcChainId, params.makingToken)
        const takingTokenInfo = getToken(this.dstChainId, params.takingToken)

        const makingAmount = parseUnits(params.makingAmount.toString(), makingTokenInfo.decimals)
        const takingAmount = parseUnits(params.takingAmount.toString(), takingTokenInfo.decimals)

        const secret = params.secret || uint8ArrayToHex(randomBytes(32))
        const startTime = await this.getCurrentTimestamp(this.srcChainId)

        const order = createCustomCrossChainOrder(
            new Sdk.Address(srcChain.escrowFactory),
            {
                salt: Sdk.randBigInt(1000n),
                maker: new Sdk.Address(await srcChain.userWallet.getAddress()),
                makingAmount,
                takingAmount,
                makerAsset: new Sdk.Address(makingTokenInfo.address),
                takerAsset: new Sdk.Address(takingTokenInfo.address)
            },
            {
                hashLock: Sdk.HashLock.forSingleFill(secret),
                timeLocks: this.createStandardTimeLocks(),
                srcChainId: this.srcChainId,
                dstChainId: this.dstChainId,
                srcSafetyDeposit: parseEther('0.001'),
                dstSafetyDeposit: parseEther('0.001')
            },
            {
                auction: this.createStandardAuction(startTime),
                whitelist: [
                    {
                        address: new Sdk.Address(srcChain.resolver),
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

        return {order, secret}
    }

    /**
     * Create order for multiple fills
     */
    async createMultiFillOrder(params: {
        srcChainId: number
        dstChainId: number
        makingToken: string
        takingToken: string
        makingAmount: number
        takingAmount: number
        secretCount: number
    }): Promise<{
        order: Sdk.CrossChainOrder
        secrets: string[]
    }> {
        const srcChain = this.getChain(params.srcChainId)
        const dstChain = this.getChain(params.dstChainId)

        const makingTokenInfo = getToken(params.srcChainId, params.makingToken)
        const takingTokenInfo = getToken(params.dstChainId, params.takingToken)

        const makingAmount = parseUnits(params.makingAmount.toString(), makingTokenInfo.decimals)
        const takingAmount = parseUnits(params.takingAmount.toString(), takingTokenInfo.decimals)

        // Generate multiple secrets
        const secrets = Array.from({length: params.secretCount}).map(() => uint8ArrayToHex(randomBytes(32)))
        const secretHashes = secrets.map((s) => Sdk.HashLock.hashSecret(s))
        const leaves = Sdk.HashLock.getMerkleLeaves(secrets)

        const startTime = await this.getCurrentTimestamp(params.srcChainId)

        const order = createCustomCrossChainOrder(
            new Sdk.Address(srcChain.escrowFactory),
            {
                salt: Sdk.randBigInt(1000n),
                maker: new Sdk.Address(await srcChain.userWallet.getAddress()),
                makingAmount,
                takingAmount,
                makerAsset: new Sdk.Address(makingTokenInfo.address),
                takerAsset: new Sdk.Address(takingTokenInfo.address)
            },
            {
                hashLock: Sdk.HashLock.forMultipleFills(leaves),
                timeLocks: this.createStandardTimeLocks(),
                srcChainId: params.srcChainId,
                dstChainId: params.dstChainId,
                srcSafetyDeposit: parseEther('0.001'),
                dstSafetyDeposit: parseEther('0.001')
            },
            {
                auction: this.createStandardAuction(startTime),
                whitelist: [
                    {
                        address: new Sdk.Address(srcChain.resolver),
                        allowFrom: 0n
                    }
                ],
                resolvingStartTime: 0n
            },
            {
                nonce: Sdk.randBigInt(UINT_40_MAX),
                allowPartialFills: true,
                allowMultipleFills: true
            }
        )

        return {order, secrets}
    }

    /**
     * Execute deploySrc flow and return context for deployDst
     */
    async executeDeploySrc(
        order: Sdk.CrossChainOrder,
        secret: string
    ): Promise<{
        orderHash: string
        srcTxHash: string
        dstImmutables: Sdk.Immutables
        deployedAt: bigint
    }> {
        const srcChainResolver = this.getResolverWallet(this.srcChainId)
        const etherlinkResolver = this.getEtherlinkResolver()

        // Sign order
        const signature = await this.getUserWallet(this.srcChainId).signOrder(this.srcChainId, order)
        const orderHash = order.getOrderHash(this.srcChainId)

        console.log(`[${this.srcChainId}] Filling order ${orderHash}`)

        // Execute deploySrc
        const {
            txHash: orderFillHash,
            blockHash: srcDeployBlock,
            blockTimestamp
        } = await srcChainResolver.send(
            etherlinkResolver.deploySrc(
                this.srcChainId,
                order,
                signature,
                Sdk.TakerTraits.default()
                    .setExtension(order.extension)
                    .setAmountMode(Sdk.AmountMode.maker)
                    .setAmountThreshold(order.takingAmount),
                order.makingAmount
            )
        )

        console.log(`[${this.srcChainId}] Order filled in tx ${orderFillHash}`)

        // Get escrow data
        const srcEscrowEvent = await this.getEscrowFactory(this.srcChainId).getSrcDeployEvent(srcDeployBlock)
        const dstImmutables = srcEscrowEvent[0]
            .withComplement(srcEscrowEvent[1])
            .withTaker(new Sdk.Address(etherlinkResolver.getAddress(this.dstChainId)))

        // Store deployed timestamp for later use
        this.dstDeployedAt = blockTimestamp

        return {
            orderHash,
            srcTxHash: orderFillHash,
            dstImmutables,
            deployedAt: blockTimestamp
        }
    }

    async increaseTime(seconds: number): Promise<void> {
        await increaseTime(this.getProviders(), seconds)
    }

    /**
     * Calculate escrow addresses for withdraw operations
     */
    private async calculateEscrowAddresses(
        dstImmutables: Sdk.Immutables,
        deployedAt: bigint
    ): Promise<{
        srcEscrowAddress: string
        dstEscrowAddress: string
    }> {
        const srcChain = this.getSrcChain()
        const dstChain = this.getDstChain()
        const etherlinkResolver = this.getEtherlinkResolver()

        const ESCROW_SRC_IMPLEMENTATION = await this.getEscrowFactory(this.srcChainId).getSourceImpl()
        const ESCROW_DST_IMPLEMENTATION = await this.getEscrowFactory(this.dstChainId).getDestinationImpl()

        // For src escrow, we need the base immutables (without complement)
        const srcImmutables = Sdk.Immutables.new({
            orderHash: dstImmutables.orderHash,
            hashLock: dstImmutables.hashLock,
            maker: dstImmutables.maker,
            taker: dstImmutables.taker,
            token: dstImmutables.token,
            amount: dstImmutables.amount,
            safetyDeposit: dstImmutables.safetyDeposit,
            timeLocks: dstImmutables.timeLocks
        })

        const srcEscrowAddress = new Sdk.EscrowFactory(new Sdk.Address(srcChain.escrowFactory)).getSrcEscrowAddress(
            srcImmutables,
            ESCROW_SRC_IMPLEMENTATION
        )

        // For dst escrow, we need the complement data
        const dstEscrowAddress = new Sdk.EscrowFactory(new Sdk.Address(dstChain.escrowFactory)).getDstEscrowAddress(
            srcImmutables, // base immutables
            Sdk.DstImmutablesComplement.new({
                maker: dstImmutables.maker, // This should be the dst user
                amount: dstImmutables.amount, // This should be the dst amount
                token: dstImmutables.token, // This should be the dst token
                safetyDeposit: dstImmutables.safetyDeposit
            }),
            deployedAt,
            new Sdk.Address(etherlinkResolver.getAddress(this.dstChainId)),
            ESCROW_DST_IMPLEMENTATION
        )

        return {
            srcEscrowAddress: srcEscrowAddress.toString(),
            dstEscrowAddress: dstEscrowAddress.toString()
        }
    }

    /**
     * Execute withdraw on destination chain
     */
    async withdrawDst(
        dstImmutables: Sdk.Immutables,
        secret: string,
        deployedAt?: bigint,
        swapConfig?: {
            fromToken: string // token address received from escrow
            toToken: string // preferred token address
            amount: bigint // amount to swap
            slippage?: number // slippage percentage (default 1%)
        }
    ): Promise<{
        txHash: string
        escrowAddress: string
    }> {
        const timestamp = deployedAt || this.dstDeployedAt || BigInt(Math.floor(Date.now() / 1000))
        const {dstEscrowAddress} = await this.calculateEscrowAddresses(dstImmutables, timestamp)

        const dstChainResolver = this.getResolverWallet(this.dstChainId)
        const etherlinkResolver = this.getEtherlinkResolver()

        console.log(`[${this.dstChainId}] Withdrawing funds for user from ${dstEscrowAddress}`)

        let withdrawTx

        if (swapConfig) {
            // Withdraw with swap
            withdrawTx = await etherlinkResolver.withdrawWithSwap(
                this.dstChainId,
                new Sdk.Address(dstEscrowAddress),
                secret,
                dstImmutables,
                swapConfig.fromToken,
                swapConfig.toToken,
                swapConfig.amount.toString(),
                swapConfig.slippage || 1
            )
        } else {
            // Simple withdraw without swap
            withdrawTx = etherlinkResolver.withdraw(
                this.dstChainId,
                new Sdk.Address(dstEscrowAddress),
                secret,
                dstImmutables,
                [] // No swap calls
            )
        }

        const {txHash} = await dstChainResolver.send(withdrawTx)

        return {
            txHash,
            escrowAddress: dstEscrowAddress
        }
    }

    /**
     * Execute withdraw on source chain
     */
    async withdrawSrc(
        srcImmutables: Sdk.Immutables,
        secret: string,
        deployedAt?: bigint,
        swapConfig?: {
            fromToken: string // token address received from escrow
            toToken: string // preferred token address
            amount: bigint // amount to swap
            slippage?: number // slippage percentage (default 1%)
        }
    ): Promise<{
        txHash: string
        escrowAddress: string
    }> {
        const timestamp = deployedAt || this.dstDeployedAt || BigInt(Math.floor(Date.now() / 1000))
        const {srcEscrowAddress} = await this.calculateEscrowAddresses(srcImmutables, timestamp)

        const srcChainResolver = this.getResolverWallet(this.srcChainId)
        const etherlinkResolver = this.getEtherlinkResolver()

        console.log(`[${this.srcChainId}] Withdrawing funds for resolver from ${srcEscrowAddress}`)

        let withdrawTx

        if (swapConfig) {
            // Withdraw with swap
            withdrawTx = await etherlinkResolver.withdrawWithSwap(
                this.srcChainId,
                new Sdk.Address(srcEscrowAddress),
                secret,
                srcImmutables, // Use source immutables for src withdraw
                swapConfig.fromToken,
                swapConfig.toToken,
                swapConfig.amount.toString(),
                swapConfig.slippage || 1
            )
        } else {
            // Simple withdraw without swap
            withdrawTx = etherlinkResolver.withdraw(
                this.srcChainId,
                new Sdk.Address(srcEscrowAddress),
                secret,
                srcImmutables, // Use source immutables for src withdraw
                [] // No swap calls
            )
        }

        const {txHash} = await srcChainResolver.send(withdrawTx)

        return {
            txHash,
            escrowAddress: srcEscrowAddress
        }
    }

    /**
     * Create standard TimeLocks for tests
     */
    private createStandardTimeLocks(): Sdk.TimeLocks {
        return Sdk.TimeLocks.new({
            srcWithdrawal: 10n, // 10sec finality lock for test
            srcPublicWithdrawal: 120n, // 2m for private withdrawal
            srcCancellation: 121n, // 1sec public withdrawal
            srcPublicCancellation: 122n, // 1sec private cancellation
            dstWithdrawal: 10n, // 10sec finality lock for test
            dstPublicWithdrawal: 100n, // 100sec private withdrawal
            dstCancellation: 101n // 1sec public withdrawal
        })
    }

    /**
     * Create standard AuctionDetails for tests
     */
    private createStandardAuction(startTime: bigint): Sdk.AuctionDetails {
        return new Sdk.AuctionDetails({
            initialRateBump: 0,
            points: [],
            duration: 120n,
            startTime
        })
    }

    /**
     * Get current timestamp from chain
     */
    async getCurrentTimestamp(chainId: number): Promise<bigint> {
        const chain = this.getChain(chainId)
        const block = await chain.provider.getBlock('latest')

        return BigInt(block!.timestamp)
    }

    /**
     * Cleanup all resources
     */
    async cleanup(): Promise<void> {
        const chains = this.getAllChains()

        // Destroy providers
        chains.forEach((chain) => {
            chain.provider.destroy()
        })

        // Stop nodes
        await Promise.all(chains.filter((chain) => chain.node).map((chain) => chain.node!.stop()))

        this.chains.clear()
        this.etherlinkResolver = undefined
        console.log('Test environment cleaned up')
    }
}

/**
 * Increase time on multiple providers
 */
export async function increaseTime(providers: JsonRpcProvider[], seconds: number): Promise<void> {
    await Promise.all(providers.map((provider) => provider.send('evm_increaseTime', [seconds])))
}

/**
 * Get provider for chain (fork or real network)
 */
export async function getProvider(config: ChainConfig): Promise<{
    node?: CreateServerReturnType
    provider: JsonRpcProvider
}> {
    if (!config.createFork) {
        return {
            provider: new JsonRpcProvider(config.url, config.chainId, {
                cacheTimeout: -1,
                staticNetwork: true
            })
        }
    }

    const node = createServer({
        instance: anvil({forkUrl: config.url, chainId: config.chainId}),
        limit: 1
    })
    await node.start()

    const address = node.address()
    assert(address)

    const provider = new JsonRpcProvider(`http://[${address.address}]:${address.port}/1`, config.chainId, {
        cacheTimeout: -1,
        staticNetwork: true
    })

    return {
        provider,
        node
    }
}

/**
 * Deploy contract and return its address
 */
export async function deploy(
    json: {abi: any; bytecode: any},
    params: unknown[],
    provider: JsonRpcProvider,
    deployer: SignerWallet
): Promise<string> {
    const deployed = await new ContractFactory(json.abi, json.bytecode, deployer).deploy(...params)
    await deployed.waitForDeployment()

    return await deployed.getAddress()
}
