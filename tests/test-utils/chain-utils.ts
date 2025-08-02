import {createServer, CreateServerReturnType} from 'prool'
import {anvil} from 'prool/instances'
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
import Sdk from '@1inch/cross-chain-sdk'
import {uint8ArrayToHex, UINT_40_MAX} from '@1inch/byte-utils'
import assert from 'node:assert'

import {getChainConfig, getToken, ChainConfig} from '../config'
import {Wallet} from '../wallet'
import {EscrowFactory} from '../escrow-factory'
import {EtherlinkResolver, TokenConfig} from '../etherlink-resolver'
import factoryContract from '../../dist/contracts/TestEscrowFactory.sol/TestEscrowFactory.json'
import ResolverContract from '../../dist/contracts/Resolver.sol/Resolver.json'
import {createCustomCrossChainOrder} from '../custom-cross-chain-order'

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
    resolverContract: Wallet // impersonated resolver contract

    // Services
    escrowFactoryService: EscrowFactory
}

export class TestEnvironment {
    private chains: Map<number, ChainData> = new Map()

    private etherlinkResolver?: EtherlinkResolver

    constructor() {}

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
        const resolverContract = await Wallet.fromAddress(resolver, provider)

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
            resolverContract,
            escrowFactoryService
        }

        this.chains.set(chainId, chainData)

        return chainData
    }

    /**
     * Initialize multiple chains
     */
    async initAllChains(chainIds: number[]): Promise<void> {
        await Promise.all(chainIds.map((chainId) => this.initChain(chainId)))
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

    getResolverContract(chainId: number): Wallet {
        return this.getChain(chainId).resolverContract
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
     * Create standard CrossChain order with default settings
     */
    async createOrder(params: {
        srcChainId: number
        dstChainId: number
        makingToken: string // symbol like 'USDC'
        takingToken: string // symbol like 'WXTZ'
        makingAmount: number // human readable like 10.5
        takingAmount: number // human readable like 0.1
        secret?: string // auto-generate if not provided
    }): Promise<{
        order: Sdk.CrossChainOrder
        secret: string
    }> {
        const srcChain = this.getChain(params.srcChainId)
        const dstChain = this.getChain(params.dstChainId)

        const makingTokenInfo = getToken(params.srcChainId, params.makingToken)
        const takingTokenInfo = getToken(params.dstChainId, params.takingToken)

        const makingAmount = parseUnits(params.makingAmount.toString(), makingTokenInfo.decimals)
        const takingAmount = parseUnits(params.takingAmount.toString(), takingTokenInfo.decimals)

        const secret = params.secret || uint8ArrayToHex(randomBytes(32))
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
                hashLock: Sdk.HashLock.forSingleFill(secret),
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
                allowPartialFills: false,
                allowMultipleFills: false
            }
        )

        return {order, secret}
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

                // Auto-approve to LOP
                await userWallet.approveToken(tokenInfo.address, chain.config.limitOrderProtocol, MaxUint256)
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
