pragma solidity 0.8.23;

import "cross-chain-swap/EscrowFactory.sol";

/**
 * @title Test Escrow Factory for Etherlink integration
 * @notice Factory contract to create escrow contracts for cross-chain atomic swaps on Etherlink
 * @dev This is a corrected version of the original example that had a constructor parameter bug
 */
contract TestEscrowFactory is EscrowFactory {
    constructor(
        address limitOrderProtocol,
        IERC20 feeToken,
        IERC20 accessToken,
        address owner,
        uint32 rescueDelaySrc,
        uint32 rescueDelayDst
    ) EscrowFactory(
    limitOrderProtocol,
    feeToken,
    accessToken,
    owner,
    rescueDelaySrc,  // Fixed: was rescueDelayDst in original example
    rescueDelayDst
    ) {}
}