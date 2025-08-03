# Enhanced 1inch Fusion+ with Etherlink Integration

Enhanced cross-chain swap resolver for 1inch Fusion+ with integrated 3Route DEX aggregator support on Etherlink. Extends the hackathon resolver example to handle token swaps when exact tokens are not available in the resolver's inventory.

## Problem Statement

Standard 1inch Fusion+ resolvers must maintain exact token inventories for cross-chain swaps. This implementation enhances the resolver example provided for the hackathon by integrating with 3Route DEX aggregator on Etherlink, enabling automatic token swaps during escrow operations.

## Solution Architecture

### Core Components

1. **Enhanced Resolver Contract** - Extends the hackathon resolver example with arbitrary call support for pre/post operation token swaps
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

## Installation

### Install Dependencies
```shell
pnpm install
```

### Install Foundry
```shell
curl -L https://foundry.paradigm.xyz | bash
```

### Install Contract Dependencies
```shell
forge install
```

## Configuration

### Environment Setup
```bash
cp .env.example .env
```

### Required Environment Variables
```bash
# Ethereum (required)
ETH_CHAIN_RPC=https://eth.merkle.io
ETH_CHAIN_CREATE_FORK=true

# Etherlink Testnet (default)
TEST_ETHERLINK_CHAIN_RPC=https://node.ghostnet.etherlink.com
TEST_ETHERLINK_CHAIN_CREATE_FORK=false
TEST_ETHERLINK_API_URL=https://api.3route.io
TEST_ETHERLINK_API_KEY=your-3route-api-key

# Etherlink Mainnet (optional)
ETHERLINK_MAINNET_RPC=https://node.mainnet.etherlink.com
ETHERLINK_MAINNET_CREATE_FORK=false
ETHERLINK_MAINNET_API_URL=https://api.3route.io
ETHERLINK_MAINNET_API_KEY=your-3route-api-key
```

## Running Tests

### Build Contracts First
```shell
forge build
```

### Fork Testing (Default)
```shell
# Run all tests
forge build && node --experimental-vm-modules ./node_modules/jest/bin/jest.js --runInBand

# Run specific test
node --experimental-vm-modules ./node_modules/jest/bin/jest.js -t 'should swap USDC to WXTZ using API integration and complete withdraw'

# Run scenario tests only
node --experimental-vm-modules ./node_modules/jest/bin/jest.js -t 'Scenario'
```

### Mainnet Testing
For real mainnet testing, set these environment variables:
```bash
#ETHERLINK_MAINNET_CREATE_FORK=false
ETHERLINK_MAINNET_OWNER_PK=your-owner-private-key
ETHERLINK_MAINNET_RESOLVER_PK=your-resolver-private-key  
ETHERLINK_MAINNET_USER_PK=your-user-private-key
```

Then modify the test file:
```typescript
// Change in your test file
const dstChainId = 42793 // Etherlink Mainnet instead of 128123 (testnet)

// Replace time manipulation calls
await increaseTime(env.getProviders(), 15) 
// with real delays for mainnet
await delay(15) // 15 seconds real delay
```

### Run Specific Scenarios
```bash
# All scenarios with 3Route integration
node --experimental-vm-modules ./node_modules/jest/bin/jest.js -t 'should swap USDC to WXTZ using API integration and complete withdraw'

# Main scenario (no swap)
node --experimental-vm-modules ./node_modules/jest/bin/jest.js -t 'should transfer USDC to USDC without API calls'

## Live Demo Results

### Real Mainnet Transactions

**Swap + Escrow Creation:**
https://explorer.etherlink.com/tx/0xc8fbe25c94f5d9c0ac98932dfda0fc537ed17a750f033a2e19fbb78f30e9df3f

This transaction shows:
- USDC approval to 3Route router
- USDC → WXTZ swap via 3Route DEX aggregator
- WXTZ approval to escrow factory
- Destination escrow creation with swapped tokens

**User Withdrawal:**
https://explorer.etherlink.com/tx/0x24254ccb995689909881df55e53f11adde14cab4cef9cd95a8853271d59a5326

This transaction shows the user receiving exactly 0.6 WXTZ as specified in the test order.

## Implementation Details

### Enhanced Resolver Contract

Building on the hackathon resolver example:

```solidity
contract Resolver is Ownable {
    // Original example methods
    function deploySrc(...) external payable onlyOwner;

// Enhanced methods with arbitrary calls
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

// Fund management
function withdrawFunds(address token, address to, uint256 amount) external onlyOwner;
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
- **Integration Tests**: Token support and swap detection

## Supported Networks

### Ethereum Mainnet
- **Chain ID**: 1
- **Role**: Source chain for cross-chain swaps
- **RPC**: https://eth.merkle.io

### Etherlink Testnet (Ghostnet)
- **Chain ID**: 128123
- **Role**: Destination chain with DEX aggregator integration
- **RPC**: https://node.ghostnet.etherlink.com

### Etherlink Mainnet
- **Chain ID**: 42793
- **Role**: Production destination chain
- **RPC**: https://node.mainnet.etherlink.com

### Token Configuration

**Etherlink Testnet:**
```typescript
{
  USDC: '0x4C2AA252BEe766D3399850569713b55178934849',
    WXTZ: '0xB1Ea698633d57705e93b0E40c1077d46CD6A51d8',
    XTZ: '0x0000000000000000000000000000000000000000' // Native
}
```

**Etherlink Mainnet:**
```typescript
{
  USDC: '0x796Ea11Fa2dD751eD01b53C372fFDB4AAa8f00F9',
    WXTZ: '0xc9b53ab2679f573e480d01e0f49e2b5cfb7a3eab',
    WETH: '0xfc24f770F94edBca6D6f885E12d4317320BcB401',
    WBTC: '0xbFc94CD2B1E55999Cfc7347a9313e88702B83d0F',
    XTZ: '0x0000000000000000000000000000000000000000' // Native
}
```

## Technical Innovation

1. **Arbitrary Call Support**: Enhanced resolver contract enables complex multi-step operations beyond the base example
2. **3Route Integration**: Seamless DEX aggregator integration for optimal routing

## Results

- Successfully enhances the hackathon resolver example with 3Route DEX aggregator capabilities
- Reduces resolver inventory requirements

This implementation demonstrates how cross-chain protocols can be enhanced with 3Route DeFi integrations while maintaining security and compatibility with existing infrastructure.