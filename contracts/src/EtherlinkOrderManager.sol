// SPDX-License-Identifier: MIT

pragma solidity 0.8.23;

import {Ownable} from "openzeppelin-contracts/contracts/access/Ownable.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol";
import {AddressLib} from "solidity-utils/contracts/libraries/AddressLib.sol";
import {IBaseEscrow} from "../lib/cross-chain-swap/contracts/interfaces/IBaseEscrow.sol";
import {IEscrow} from "../lib/cross-chain-swap/contracts/interfaces/IEscrow.sol";

/**
 * @title Etherlink Order Manager
 * @notice Manages token conversions and escrow operations for Fusion+ on Etherlink
 * @dev This contract coordinates between token swaps and escrow creation/management
 * It holds tokens, performs conversions when needed, and interfaces with the resolver
 * @custom:security-contact security@1inch.io
 */

interface IEtherlinkRouter {
    struct ReferrerInfo {
        address referrer;
        uint256 feeAmount;
    }

    struct TokenInfo {
        address tokenAddress;
        bool isNative;
    }

    struct SwapStep {
        address routerAddress;
        uint256 packedData;
    }

    function swap(
        uint256 amountIn,
        uint256 amountOutMin,
        address to,
        uint256 deadline,
        uint256 params,
        TokenInfo[] calldata tokens,
        SwapStep[] calldata steps,
        ReferrerInfo calldata referrerInfo
    ) external payable returns (uint256 amountOut);
}

interface IResolver {
    function deployDst(
        IBaseEscrow.Immutables calldata dstImmutables,
        uint256 srcCancellationTimestamp
    ) external payable;

    function withdraw(
        IEscrow escrow,
        bytes32 secret,
        IBaseEscrow.Immutables calldata immutables
    ) external;

    function cancel(
        IEscrow escrow,
        IBaseEscrow.Immutables calldata immutables
    ) external;

    function arbitraryCalls(
        address[] calldata targets,
        bytes[] calldata arguments
    ) external;
}

contract EtherlinkOrderManager is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct ConversionParams {
        bool needsConversion;           // Whether conversion is required
        address tokenIn;                // Input token for conversion
        address tokenOut;               // Output token for conversion
        uint256 amountOutMin;           // Minimum output amount (slippage protection)
        uint256 deadline;               // Conversion deadline
        uint256 routerParams;           // Packed parameters for router
        IEtherlinkRouter.TokenInfo[] tokens;  // Token path
        IEtherlinkRouter.SwapStep[] steps;    // Swap steps
        IEtherlinkRouter.ReferrerInfo referrerInfo; // Referrer information
    }

    struct OrderExecution {
        IBaseEscrow.Immutables dstImmutables;
        uint256 srcCancellationTimestamp;
        ConversionParams conversionParams;
        bytes32 orderHash;
    }

    error InvalidConversionParams();
    error ConversionFailed();
    error InsufficientBalance();
    error UnauthorizedCaller();
    error OrderAlreadyProcessed();
    error InvalidOrderHash();

    event OrderExecuted(
        bytes32 indexed orderHash,
        address indexed user,
        address escrowAddress,
        bool conversionUsed
    );

    event ConversionExecuted(
        bytes32 indexed orderHash,
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 amountOut
    );

    event UserWithdrawal(
        bytes32 indexed orderHash,
        address indexed user,
        address indexed token,
        uint256 amount,
        bool conversionUsed
    );

    event FundsDeposited(
        address indexed from,
        address indexed token,
        uint256 amount
    );

    IEtherlinkRouter private immutable _ROUTER;
    IResolver private immutable _RESOLVER;

    // Trusted operators who can execute orders (off-chain services)
    mapping(address => bool) public trustedOperators;

    // Track processed orders to prevent double execution
    mapping(bytes32 => bool) public processedOrders;

    // Emergency pause mechanism
    bool public paused = false;

    modifier onlyTrustedOperator() {
        if (!trustedOperators[msg.sender] && msg.sender != owner()) {
            revert UnauthorizedCaller();
        }
        _;
    }

    modifier whenNotPaused() {
        require(!paused, "Contract is paused");
        _;
    }

    constructor(
        IEtherlinkRouter router,
        IResolver resolver,
        address initialOwner
    ) Ownable(initialOwner) {
        _ROUTER = router;
        _RESOLVER = resolver;

        // Owner is trusted by default
        trustedOperators[initialOwner] = true;
    }

    receive() external payable {
        emit FundsDeposited(msg.sender, address(0), msg.value);
    }

    /**
     * @notice Execute order with optional token conversion
     * @dev Main function that handles the complete order flow:
     * 1. Optionally convert tokens if needed
     * 2. Create destination escrow with correct tokens
     * @param execution Order execution parameters including conversion data
     */
    function executeOrder(
        OrderExecution calldata execution
    ) external onlyTrustedOperator whenNotPaused nonReentrant {
        bytes32 orderHash = execution.orderHash;

        // Prevent double execution
        if (processedOrders[orderHash]) {
            revert OrderAlreadyProcessed();
        }
        processedOrders[orderHash] = true;

        address finalToken = AddressLib.get(execution.dstImmutables.token);
        uint256 finalAmount = execution.dstImmutables.amount;
        uint256 safetyDeposit = execution.dstImmutables.safetyDeposit;

        // Execute conversion if needed
        if (execution.conversionParams.needsConversion) {
            uint256 convertedAmount = _executeConversion(
                execution.conversionParams,
                finalAmount,
                orderHash
            );

            // Ensure we have enough tokens after conversion to fulfill the order
            if (convertedAmount < finalAmount) {
                revert InsufficientBalance();
            }
        }

        // Verify we have sufficient balance for the escrow
        if (finalToken == address(0)) {
            require(address(this).balance >= finalAmount + safetyDeposit, "Insufficient ETH balance");
        } else {
            require(IERC20(finalToken).balanceOf(address(this)) >= finalAmount, "Insufficient token balance");
            // Approve resolver to spend tokens for escrow creation
            IERC20(finalToken).forceApprove(address(_RESOLVER), finalAmount);
        }

        // Create destination escrow with original immutables (don't modify them)
        uint256 totalValue = finalToken == address(0) ? finalAmount + safetyDeposit : safetyDeposit;

        _RESOLVER.deployDst{value: totalValue}(
            execution.dstImmutables,
            execution.srcCancellationTimestamp
        );

        emit OrderExecuted(
            orderHash,
            AddressLib.get(execution.dstImmutables.maker),
            address(0), // Escrow address computed by factory
            execution.conversionParams.needsConversion
        );
    }

    /**
     * @notice Withdraw funds for user with optional conversion back
     * @dev Handles withdrawal from completed escrows with optional token conversion
     * @param escrow Escrow contract to withdraw from
     * @param secret Secret for escrow withdrawal
     * @param immutables Escrow immutables
     * @param conversionParams Conversion parameters for withdrawal conversion
     * @param orderHash Order hash for tracking
     */
    function withdrawForUser(
        IEscrow escrow,
        bytes32 secret,
        IBaseEscrow.Immutables calldata immutables,
        ConversionParams calldata conversionParams,
        bytes32 orderHash
    ) external onlyTrustedOperator whenNotPaused nonReentrant {
        // Withdraw from escrow to this contract
        _RESOLVER.withdraw(escrow, secret, immutables);

        address user = AddressLib.get(immutables.taker);
        address tokenFromEscrow = AddressLib.get(immutables.token);
        uint256 amountFromEscrow = immutables.amount;

        uint256 finalAmount = amountFromEscrow;
        address finalToken = tokenFromEscrow;

        // Convert tokens if needed
        if (conversionParams.needsConversion) {
            finalAmount = _executeConversion(
                conversionParams,
                amountFromEscrow,
                orderHash
            );
            finalToken = conversionParams.tokenOut;
        }

        // Transfer final tokens to user
        if (finalToken == address(0)) {
            payable(user).transfer(finalAmount);
        } else {
            IERC20(finalToken).safeTransfer(user, finalAmount);
        }

        emit UserWithdrawal(
            orderHash,
            user,
            finalToken,
            finalAmount,
            conversionParams.needsConversion
        );
    }

    /**
     * @notice Cancel escrow and return funds
     * @dev Handles escrow cancellation with optional token conversion
     */
    function cancelOrder(
        IEscrow escrow,
        IBaseEscrow.Immutables calldata immutables,
        ConversionParams calldata conversionParams,
        bytes32 orderHash
    ) external onlyTrustedOperator whenNotPaused nonReentrant {
        // Cancel escrow
        _RESOLVER.cancel(escrow, immutables);

        address user = AddressLib.get(immutables.maker);
        address tokenFromEscrow = AddressLib.get(immutables.token);
        uint256 amountFromEscrow = immutables.amount;

        uint256 finalAmount = amountFromEscrow;
        address finalToken = tokenFromEscrow;

        // Convert tokens back if needed
        if (conversionParams.needsConversion) {
            finalAmount = _executeConversion(
                conversionParams,
                amountFromEscrow,
                orderHash
            );
            finalToken = conversionParams.tokenOut;
        }

        // Return funds to original maker
        if (finalToken == address(0)) {
            payable(user).transfer(finalAmount);
        } else {
            IERC20(finalToken).safeTransfer(user, finalAmount);
        }

        emit UserWithdrawal(
            orderHash,
            user,
            finalToken,
            finalAmount,
            conversionParams.needsConversion
        );
    }

    /**
     * @notice Internal function to execute token conversion
     * @param params Conversion parameters
     * @param amountIn Input amount for conversion
     * @param orderHash Order hash for tracking
     * @return amountOut Output amount from conversion
     */
    function _executeConversion(
        ConversionParams calldata params,
        uint256 amountIn,
        bytes32 orderHash
    ) internal returns (uint256 amountOut) {
        // Validate conversion parameters
        if (!params.needsConversion || params.tokens.length == 0 || params.steps.length == 0) {
            revert InvalidConversionParams();
        }

        // Check balance
        if (params.tokenIn == address(0)) {
            if (address(this).balance < amountIn) {
                revert InsufficientBalance();
            }
        } else {
            if (IERC20(params.tokenIn).balanceOf(address(this)) < amountIn) {
                revert InsufficientBalance();
            }
        }

        // Execute swap
        try _ROUTER.swap{value: params.tokenIn == address(0) ? amountIn : 0}(
            amountIn,
            params.amountOutMin,
            address(this), // Receive tokens to this contract
            params.deadline,
            params.routerParams,
            params.tokens,
            params.steps,
            params.referrerInfo
        ) returns (uint256 _amountOut) {
            amountOut = _amountOut;

            emit ConversionExecuted(
                orderHash,
                params.tokenIn,
                params.tokenOut,
                amountIn,
                amountOut
            );
        } catch {
            revert ConversionFailed();
        }

        return amountOut;
    }

    /**
     * @notice Deposit tokens to the contract
     * @param token Token address (address(0) for ETH)
     * @param amount Amount to deposit
     */
    function depositToken(address token, uint256 amount) payable external {
        if (token == address(0)) {
            require(msg.value == amount, "ETH amount mismatch");
        } else {
            IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        }

        emit FundsDeposited(msg.sender, token, amount);
    }

    /**
     * @notice Add trusted operator
     * @param operator Address to add as trusted operator
     */
    function addTrustedOperator(address operator) external onlyOwner {
        trustedOperators[operator] = true;
    }

    /**
     * @notice Remove trusted operator
     * @param operator Address to remove from trusted operators
     */
    function removeTrustedOperator(address operator) external onlyOwner {
        trustedOperators[operator] = false;
    }

    /**
     * @notice Emergency pause/unpause
     * @param _paused New pause state
     */
    function setPaused(bool _paused) external onlyOwner {
        paused = _paused;
    }

    /**
     * @notice Emergency withdraw function
     * @param token Token address (address(0) for ETH)
     * @param amount Amount to withdraw
     * @param to Recipient address
     */
    function emergencyWithdraw(
        address token,
        uint256 amount,
        address to
    ) external onlyOwner {
        if (token == address(0)) {
            payable(to).transfer(amount);
        } else {
            IERC20(token).safeTransfer(to, amount);
        }
    }

    /**
     * @notice Get contract balances
     * @param token Token address to check (address(0) for ETH)
     * @return balance Current balance
     */
    function getBalance(address token) external view returns (uint256 balance) {
        if (token == address(0)) {
            return address(this).balance;
        } else {
            return IERC20(token).balanceOf(address(this));
        }
    }

    /**
     * @notice Check if operator is trusted
     * @param operator Address to check
     * @return trusted Whether the operator is trusted
     */
    function isTrustedOperator(address operator) external view returns (bool trusted) {
        return trustedOperators[operator] || operator == owner();
    }
}