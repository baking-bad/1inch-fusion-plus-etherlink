import Sdk from '@1inch/cross-chain-sdk'
import {SettlementPostInteractionData, now, Interaction} from '@1inch/fusion-sdk'
import assert from 'assert'

// Our custom supported chains including Etherlink
const CUSTOM_SUPPORTED_CHAINS = new Set([
    1, // Ethereum
    56, // BSC
    137, // Polygon
    42161, // Arbitrum
    128123 // Etherlink Testnet
])

// TRUE_ERC20 addresses for our custom chains
const CUSTOM_TRUE_ERC20: Record<number, string> = {
    1: '0x0000000000000000000000000000000000000001', // Ethereum
    56: '0x0000000000000000000000000000000000000001', // BSC
    137: '0x0000000000000000000000000000000000000001', // Polygon
    42161: '0x0000000000000000000000000000000000000001', // Arbitrum
    128123: '0x0000000000000000000000000000000000000001' // Etherlink
}

export function createCustomCrossChainOrder(
    escrowFactory: Sdk.Address,
    orderInfo: {
        salt: bigint
        maker: Sdk.Address
        makingAmount: bigint
        takingAmount: bigint
        makerAsset: Sdk.Address
        takerAsset: Sdk.Address
        receiver?: Sdk.Address
    },
    escrowParams: {
        hashLock: Sdk.HashLock
        timeLocks: Sdk.TimeLocks
        srcChainId: number
        dstChainId: number
        srcSafetyDeposit: bigint
        dstSafetyDeposit: bigint
    },
    details: {
        auction: Sdk.AuctionDetails
        whitelist?: Array<{
            address: Sdk.Address
            allowFrom: bigint
        }>
        resolvingStartTime?: bigint
        fees?: {
            bankFee?: bigint
            integratorFee?: bigint
            integratorReceiver?: Sdk.Address
        }
    },
    extra?: {
        nonce?: bigint
        allowPartialFills?: boolean
        allowMultipleFills?: boolean
        enablePermit2?: boolean
        permit?: string
        orderExpirationDelay?: bigint
    }
): Sdk.CrossChainOrder {
    // Custom validation for our supported chains
    assert(
        CUSTOM_SUPPORTED_CHAINS.has(escrowParams.srcChainId),
        `Not supported source chain ${escrowParams.srcChainId}`
    )
    assert(
        CUSTOM_SUPPORTED_CHAINS.has(escrowParams.dstChainId),
        `Not supported destination chain ${escrowParams.dstChainId}`
    )
    assert(escrowParams.srcChainId !== escrowParams.dstChainId, 'Chains must be different')

    // Create post interaction data
    const postInteractionData = SettlementPostInteractionData.new({
        whitelist: details.whitelist || [],
        integratorFee: details.fees?.integratorFee
            ? {
                  ratio: details.fees.integratorFee,
                  receiver:
                      details.fees.integratorReceiver || new Sdk.Address('0x0000000000000000000000000000000000000000')
              }
            : undefined,
        bankFee: details.fees?.bankFee || 0n,
        resolvingStartTime: details.resolvingStartTime ?? now(),
        customReceiver: orderInfo.receiver
    })

    // Create escrow extension
    const ext = new Sdk.EscrowExtension(
        escrowFactory,
        details.auction,
        postInteractionData,
        extra?.permit ? new Interaction(orderInfo.makerAsset, extra.permit) : undefined,
        escrowParams.hashLock,
        escrowParams.dstChainId,
        orderInfo.takerAsset,
        escrowParams.srcSafetyDeposit,
        escrowParams.dstSafetyDeposit,
        escrowParams.timeLocks
    )

    // Create CrossChainOrder directly (bypassing SDK validation)
    const CrossChainOrderClass = Sdk.CrossChainOrder as any

    return new CrossChainOrderClass(
        ext,
        {
            ...orderInfo,
            takerAsset: new Sdk.Address(CUSTOM_TRUE_ERC20[escrowParams.srcChainId])
        },
        extra
    )
}
