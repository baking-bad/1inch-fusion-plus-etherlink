import {Interface, Signature, TransactionRequest} from 'ethers'
import Sdk from '@1inch/cross-chain-sdk'
import ResolverContract from '../dist/contracts/Resolver.sol/Resolver.json'

export interface ResolverAddresses {
    [chainId: number]: string
}

export interface ArbitraryCall {
    target: string
    data: string
}

export class Resolver {
    private readonly iface = new Interface(ResolverContract.abi)

    private readonly addresses: ResolverAddresses

    constructor(addresses: ResolverAddresses) {
        this.addresses = addresses
    }

    public getAddress(chainId: number): string {
        const address = this.addresses[chainId]

        if (!address) {
            throw new Error(`No resolver address configured for chain ${chainId}`)
        }

        return address
    }

    public deploySrc(
        srcChainId: number,
        order: Sdk.CrossChainOrder,
        signature: string,
        takerTraits: Sdk.TakerTraits,
        amount: bigint,
        hashLock?: Sdk.HashLock
    ): TransactionRequest {
        const {r, yParityAndS: vs} = Signature.from(signature)
        const {args, trait} = takerTraits.encode()
        const immutables = order.toSrcImmutables(
            srcChainId,
            new Sdk.Address(this.getAddress(srcChainId)),
            amount,
            hashLock || order.escrowExtension.hashLockInfo
        )

        return {
            to: this.getAddress(srcChainId),
            data: this.iface.encodeFunctionData('deploySrc', [
                immutables.build(),
                order.build(),
                r,
                vs,
                amount,
                trait,
                args
            ]),
            value: order.escrowExtension.srcSafetyDeposit
        }
    }

    public deployDst(
        order: Sdk.CrossChainOrder,
        immutables: Sdk.Immutables,
        calls: ArbitraryCall[] = []
    ): TransactionRequest {
        const targets = calls.map((call) => call.target)
        const callsData = calls.map((call) => call.data)

        return {
            to: this.getAddress(order.escrowExtension.dstChainId),
            data: this.iface.encodeFunctionData('deployDst', [
                targets,
                callsData,
                immutables.build(),
                immutables.timeLocks.toSrcTimeLocks().privateCancellation
            ]),
            value: immutables.safetyDeposit
        }
    }

    public withdraw(
        chainId: number,
        escrow: Sdk.Address,
        secret: string,
        immutables: Sdk.Immutables,
        calls: ArbitraryCall[] = []
    ): TransactionRequest {
        const targets = calls.map((call) => call.target)
        const callsData = calls.map((call) => call.data)

        return {
            to: this.getAddress(chainId),
            data: this.iface.encodeFunctionData('withdraw', [
                escrow.toString(),
                secret,
                immutables.build(),
                targets,
                callsData
            ])
        }
    }

    public cancel(
        chainId: number,
        escrow: Sdk.Address,
        immutables: Sdk.Immutables,
        calls: ArbitraryCall[] = []
    ): TransactionRequest {
        const targets = calls.map((call) => call.target)
        const callsData = calls.map((call) => call.data)

        return {
            to: this.getAddress(chainId),
            data: this.iface.encodeFunctionData('cancel', [escrow.toString(), immutables.build(), targets, callsData])
        }
    }

    public arbitraryCalls(chainId: number, calls: ArbitraryCall[]): TransactionRequest {
        const targets = calls.map((call) => call.target)
        const callsData = calls.map((call) => call.data)

        return {
            to: this.getAddress(chainId),
            data: this.iface.encodeFunctionData('arbitraryCalls', [targets, callsData])
        }
    }
}
