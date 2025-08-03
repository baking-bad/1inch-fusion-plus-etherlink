# Enhanced 1inch Fusion+ with Etherlink Integration

Enhanced cross-chain swap resolver for 1inch Fusion+ with integrated 3Route DEX aggregator support on Etherlink. Extends the standard resolver to handle token swaps when exact tokens are not available in the resolver's inventory.

## Problem Statement

Standard 1inch Fusion+ resolvers must maintain exact token inventories for cross-chain swaps. This implementation solves inventory management by integrating with 3Route DEX aggregator on Etherlink, enabling automatic token swaps during escrow operations.

## Solution Architecture

### Core Components

1. **Enhanced Resolver Contract** - Extends standard resolver with arbitrary call support for pre/post operation token swaps
2. **EtherlinkResolver Service** - TypeScript service integrating with 3Route DEX aggregator API
3. **3Route API Client** - HTTP client for quote fetching and swap execution
4. **Test Framework** - Comprehensive multi-chain testing environment

### Integration Scenarios

**Scenario 1: Direct Transfer**
```
ETH USDC → Etherlink USDC (no swap needed)
```

**Scenario 2: Swap on Destination**
```
ETH USDC → Etherlink WXTZ (swap USDC→WXTZ via 3Route during deployDst)
```

**Scenario 3: Reverse Swap on Withdrawal**
```
Resolver swaps received tokens back to preferred inventory tokens
```

**Scenario 4: Cancel with Reverse Swap**
```
Timeout cancellation with automatic token recovery via swap
```

## Key Features

- **Seamless Integration**: Works with existing 1inch Fusion+ protocol
- **Automatic Swaps**: 3Route DEX aggregator integration during escrow operations
- **Inventory Management**: Reduces resolver token holding requirements
- **Slippage Protection**: Configurable slippage tolerance for all swaps
- **Comprehensive Testing**: Full test coverage for all scenarios

## Quick Start

### Environment Setup
```bash
npm install
cp .env.example .env
```

### Configuration
```bash
# Ethereum
ETH_CHAIN_RPC=https://eth-mainnet.alchemyapi.io/v2/your-key

# Etherlink
ETHERLINK_CHAIN_RPC=https://etherlink-rpc.url
ETHERLINK_API_URL=https://api.3route.io
ETHERLINK_API_KEY=your-3route-api-key
```

### Run Tests
```bash
npm test
```

## Implementation Details

### Enhanced Resolver Contract

```solidity
contract Resolver is Ownable {
    function deployDst(
        address[] calldata targets,
        bytes[] calldata callsData,
        IBaseEscrow.Immutables calldata dstImmutables,
        uint256 srcCancellationTimestamp
    ) external onlyOwner payable;

    function withdraw(
        IEscrow escrow,
        bytes32 secret,
        IBaseEscrow.Immutables calldata immutables,
        address[] calldata targets,
        bytes[] calldata callsData
    ) external;
}
```

### EtherlinkResolver API

```typescript
class EtherlinkResolver {
  deployDstWithSwap(escrowFactory, order, immutables, srcToken, slippage)
  withdrawWithSwap(chainId, escrow, secret, immutables, src, dst, amount, slippage)
  cancelWithSwap(chainId, escrow, immutables, src, dst, amount, slippage)
}
```

## Test Results

### Test Coverage
- **Scenario 1**: USDC→USDC transfer without swaps
- **Scenario 2**: USDC→WXTZ with 3Route DEX aggregator integration
- **Cancel Tests**: Both direct and reverse swap scenarios
- **Integration Tests**: Token support and swap detection

### Key Validations
- Resolver contract balance management
- Slippage tolerance verification
- Transaction complexity validation (multiple calls)
- Balance restoration on cancellation

## Supported Networks

- **Ethereum Mainnet**: Source chain for cross-chain swaps
- **Etherlink Testnet**: Destination chain with DEX aggregator integration

### Token Configuration (Etherlink)
```typescript
{
  USDC: '0x4C2AA252BEe766D3399850569713b55178934849',
    WXTZ: '0xB1Ea698633d57705e93b0E40c1077d46CD6A51d8',
    XTZ: '0x0000000000000000000000000000000000000000' // Native
}
```

## Technical Innovation

1. **Arbitrary Call Support**: Enhanced resolver contract enables complex multi-step operations
2. **3Route Integration**: Seamless DEX aggregator integration for optimal routing
3. **State Management**: Proper immutable handling for src vs dst escrow operations

This implementation demonstrates how cross-chain protocols can be enhanced with 3Route DeFi integrations while maintaining security and compatibility with existing infrastructure.