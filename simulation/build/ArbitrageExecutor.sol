// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address recipient, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
}

interface IAavePool {
    function flashLoanSimple(
        address receiver,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16 referralCode
    ) external;
    function FLASHLOAN_PREMIUM_TOTAL() external view returns (uint128);
}

interface IAaveFlashBorrower {
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external returns (bool);
}

interface IUniswapV2Router {
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);
    function getAmountsOut(uint256 amountIn, address[] calldata path)
        external view returns (uint256[] memory amounts);
}

interface ISwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }
    function exactInputSingle(ExactInputSingleParams calldata params)
        external payable returns (uint256 amountOut);
}

library FullMath {
    /// @notice Calculates floor(a×b÷denominator)
    function mulDiv(uint256 a, uint256 b, uint256 denominator) internal pure returns (uint256 result) {
        unchecked {
            uint256 prod0 = a * b;
            uint256 prod1;
            assembly {
                let mm := mulmod(a, b, not(0))
                prod1 := sub(sub(mm, prod0), lt(mm, prod0))
            }
            if (prod1 == 0) {
                require(denominator > 0);
                assembly { result := div(prod0, denominator) }
                return result;
            }
            require(denominator > prod1);
            uint256 remainder;
            assembly { remainder := mulmod(a, b, denominator) }
            assembly { prod1 := sub(prod1, gt(remainder, prod0)) }
            assembly { prod0 := sub(prod0, remainder) }
            uint256 twos = (0 - denominator) & denominator;
            assembly { denominator := div(denominator, twos) }
            assembly { prod0 := div(prod0, twos) }
            assembly { twos := add(div(sub(0, twos), twos), 1) }
            prod0 |= prod1 * twos;
            uint256 inv = (3 * denominator) ^ 2;
            inv *= 2 - denominator * inv;
            inv *= 2 - denominator * inv;
            inv *= 2 - denominator * inv;
            inv *= 2 - denominator * inv;
            result = prod0 * inv;
            return result;
        }
    }
}

library TokenOps {
    error TokenCallReverted(address token, bytes data);
    error TokenCallReturnedFalse(address token);
    error TokenCallMalformed(address token);

    function safeSend(IERC20 token, address to, uint256 value) internal {
        _callOptionalReturn(token, abi.encodeWithSelector(IERC20.transfer.selector, to, value));
    }

    function safeApproveExact(IERC20 token, address spender, uint256 value) internal {
        if (_callOptionalReturnBool(token, abi.encodeWithSelector(IERC20.approve.selector, spender, value))) {
            return;
        }
        _callOptionalReturn(token, abi.encodeWithSelector(IERC20.approve.selector, spender, 0));
        _callOptionalReturn(token, abi.encodeWithSelector(IERC20.approve.selector, spender, value));
    }

    function _callOptionalReturn(IERC20 token, bytes memory payload) private {
        (bool ok, bytes memory ret) = address(token).call(payload);
        if (!ok) revert TokenCallReverted(address(token), ret);
        if (ret.length == 0) return;
        if (ret.length != 32) revert TokenCallMalformed(address(token));
        if (!abi.decode(ret, (bool))) revert TokenCallReturnedFalse(address(token));
    }

    function _callOptionalReturnBool(IERC20 token, bytes memory payload) private returns (bool) {
        (bool ok, bytes memory ret) = address(token).call(payload);
        if (!ok) return false;
        if (ret.length == 0) return true;
        if (ret.length != 32) return false;
        return abi.decode(ret, (bool));
    }
}

abstract contract ReentrancyGuard {
    uint256 private constant _NOT_ENTERED = 1;
    uint256 private constant _ENTERED = 2;
    uint256 private _status;
    error ReentrantCall();
    constructor() { _status = _NOT_ENTERED; }
    modifier nonReentrant() {
        if (_status == _ENTERED) revert ReentrantCall();
        _status = _ENTERED;
        _;
        _status = _NOT_ENTERED;
    }
}

contract ArbitrageExecutor is IAaveFlashBorrower, ReentrancyGuard {
    using TokenOps for IERC20;

    enum DexType { V2, V3 }

    struct Hop {
        DexType dexType;
        address router;
        address tokenIn;
        address tokenOut;
        uint256 minOut;
        uint24 fee;
    }

    error Unauthorized();
    error ZeroAddress();
    error ZeroAmount();
    error BadCallback();
    error LoanAlreadyOpen();
    error NoLoanOpen();
    error ContractPaused();
    error MustBePaused();
    error NativeTransfersDisabled();
    error AddressNotContract(address target);
    error DeadlineTooFar();
    error DeadlineExpired();
    error ExecutionTimeout();
    error NoProfitableRouteFound();
    error SlippageBpsTooHigh();
    error MinProfitBpsZero();
    error RouterNotWhitelisted(address router);
    error TokenNotWhitelisted(address token);
    error InvalidHopCount();
    error RouteMustStartAndEndOnAsset();
    error HopMinOutZero();
    error EmptyRouterResult();
    error ZeroRouterOutput();
    error InsufficientLoanBalance();
    error ArithmeticOverflow();
    error ProfitWithdrawalLocked();
    error UnlockTimeNotReached();
    error BatchTooLarge();
    error UnsupportedDexType();

    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant MAX_SLIPPAGE_BPS = 1_000;
    uint256 public constant MIN_HOPS = 2;
    uint256 public constant MAX_HOPS = 12;
    uint256 public constant MAX_PLAN_LIFETIME = 30 minutes;
    uint256 public constant MAX_EXECUTION_DELAY = 30 seconds;
    uint256 public constant MAX_BATCH_SIZE = 50;
    uint256 public constant PROFIT_LOCK_PERIOD = 24 hours;

    address public immutable owner;
    address public immutable aavePool;

    address public executor;
    bool public paused;
    bool public loanOpen;
    mapping(address => bool) public routerWhitelist;
    mapping(address => bool) public tokenWhitelist;
    uint256 public slippageBps = 30;
    uint256 public minProfitBps = 50;
    uint256 public profitUnlockTime;

    bytes32 public activeRequestHash;
    address public activeAsset;
    uint256 public activeAmount;
    uint256 public balanceBefore;
    uint256 public executionStartTime;

    event PauseStatusChanged(bool isPaused);
    event ExecutorUpdated(address indexed executor);
    event RouterWhitelistUpdated(address indexed router, bool allowed);
    event TokenWhitelistUpdated(address indexed token, bool allowed);
    event SlippageBpsUpdated(uint256 bps);
    event MinProfitBpsUpdated(uint256 bps);
    event FlashRequested(address indexed asset, uint256 amount, uint256 deadline, uint256 hopCount, bytes32 requestHash);
    event HopExecuted(uint256 indexed hopIndex, DexType dexType, address indexed router, address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut);
    event FlashCompleted(address indexed asset, uint256 amount, uint256 premium, uint256 profit, bytes32 requestHash);
    event TokenRecovered(address indexed token, address indexed recipient, uint256 amount);
    event ProfitWithdrawn(address indexed token, address indexed recipient, uint256 amount);
    event ExecutionDelayed(uint256 elapsed, uint256 limit);

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }
    modifier onlyExecutorOrOwner() {
        if (msg.sender != executor && msg.sender != owner) revert Unauthorized();
        _;
    }
    modifier whenRunning() {
        if (paused) revert ContractPaused();
        _;
    }
    modifier noLoanInProgress() {
        if (loanOpen) revert LoanAlreadyOpen();
        _;
    }

    constructor(address pool_, address executor_, address[] memory routers, address[] memory tokens) {
        if (pool_ == address(0)) revert ZeroAddress();
        _requireContract(pool_);
        owner = msg.sender;
        aavePool = pool_;
        executor = executor_ == address(0) ? msg.sender : executor_;
        profitUnlockTime = block.timestamp + PROFIT_LOCK_PERIOD;

        for (uint256 i = 0; i < routers.length; ) {
            _setRouterAllowed(routers[i], true);
            unchecked { ++i; }
        }
        for (uint256 i = 0; i < tokens.length; ) {
            _setTokenAllowed(tokens[i], true);
            unchecked { ++i; }
        }
    }

    function pause() external onlyOwner noLoanInProgress {
        paused = true;
        emit PauseStatusChanged(true);
    }
    function unpause() external onlyOwner noLoanInProgress {
        paused = false;
        emit PauseStatusChanged(false);
    }
    function setExecutor(address executor_) external onlyOwner {
        if (executor_ == address(0)) revert ZeroAddress();
        executor = executor_;
        emit ExecutorUpdated(executor_);
    }
    function setRouterAllowed(address router, bool allowed) external onlyOwner noLoanInProgress {
        _setRouterAllowed(router, allowed);
    }
    function setTokenAllowed(address token, bool allowed) external onlyOwner noLoanInProgress {
        _setTokenAllowed(token, allowed);
    }
    function setMultipleRouters(address[] calldata routers, bool[] calldata allowed) external onlyOwner noLoanInProgress {
        if (routers.length != allowed.length || routers.length > MAX_BATCH_SIZE) revert BatchTooLarge();
        for (uint256 i = 0; i < routers.length; ) {
            _setRouterAllowed(routers[i], allowed[i]);
            unchecked { ++i; }
        }
    }
    function setMultipleTokens(address[] calldata tokens, bool[] calldata allowed) external onlyOwner noLoanInProgress {
        if (tokens.length != allowed.length || tokens.length > MAX_BATCH_SIZE) revert BatchTooLarge();
        for (uint256 i = 0; i < tokens.length; ) {
            _setTokenAllowed(tokens[i], allowed[i]);
            unchecked { ++i; }
        }
    }
    function setSlippageBps(uint256 bps) external onlyOwner noLoanInProgress {
        if (bps > MAX_SLIPPAGE_BPS) revert SlippageBpsTooHigh();
        slippageBps = bps;
        emit SlippageBpsUpdated(bps);
    }
    function setMinProfitBps(uint256 bps) external onlyOwner noLoanInProgress {
        if (bps == 0 || bps >= BPS_DENOMINATOR) revert MinProfitBpsZero();
        minProfitBps = bps;
        emit MinProfitBpsUpdated(bps);
    }

    function emergencyProfitWithdraw(address token, address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (block.timestamp < profitUnlockTime) revert UnlockTimeNotReached();

        uint256 currentBalance = IERC20(token).balanceOf(address(this));
        if (loanOpen && token == activeAsset) {
            uint256 protected = balanceBefore + activeAmount;
            if (currentBalance <= protected) revert ProfitWithdrawalLocked();
            if (amount > currentBalance - protected) revert ProfitWithdrawalLocked();
        }
        IERC20(token).safeSend(to, amount);
        emit ProfitWithdrawn(token, to, amount);
    }

    function flashLoanPremiumBps() external view returns (uint256) {
        return uint256(IAavePool(aavePool).FLASHLOAN_PREMIUM_TOTAL());
    }

    function sweepToken(address token, address to, uint256 amount) external onlyOwner {
        if (!paused) revert MustBePaused();
        if (token == address(0) || to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        IERC20(token).safeSend(to, amount);
        emit TokenRecovered(token, to, amount);
    }

    function previewRoute(uint256 amountIn, Hop[] calldata hops) external view returns (uint256[] memory amountsOut) {
        if (amountIn == 0) revert ZeroAmount();
        _validateRouteShape(activeAsset == address(0) ? hops[0].tokenIn : activeAsset, hops);
        uint256 hopCount = hops.length;
        amountsOut = new uint256[](hopCount);
        uint256 currentIn = amountIn;

        for (uint256 i = 0; i < hopCount; ) {
            if (hops[i].dexType != DexType.V2) revert UnsupportedDexType();
            address[] memory path = new address[](2);
            path[0] = hops[i].tokenIn;
            path[1] = hops[i].tokenOut;
            uint256[] memory quoted = IUniswapV2Router(hops[i].router).getAmountsOut(currentIn, path);
            if (quoted.length < 2) revert EmptyRouterResult();
            uint256 out = quoted[quoted.length - 1];
            if (out == 0) revert ZeroRouterOutput();
            amountsOut[i] = out;
            currentIn = out;
            unchecked { ++i; }
        }
    }

    function startArbitrage(
        address asset,
        uint256 amount,
        uint256 deadline,
        Hop[] calldata hops
    ) external onlyExecutorOrOwner whenRunning noLoanInProgress nonReentrant {
        if (asset == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (!tokenWhitelist[asset]) revert TokenNotWhitelisted(asset);
        if (deadline < block.timestamp) revert DeadlineExpired();
        if (deadline > block.timestamp + MAX_PLAN_LIFETIME) revert DeadlineTooFar();
        _validateRouteShape(asset, hops);

        bytes memory params = abi.encode(asset, amount, deadline, msg.sender, hops);
        loanOpen = true;
        executionStartTime = block.timestamp;
        activeRequestHash = keccak256(params);
        activeAsset = asset;
        activeAmount = amount;
        balanceBefore = IERC20(asset).balanceOf(address(this));

        emit FlashRequested(asset, amount, deadline, hops.length, activeRequestHash);
        IAavePool(aavePool).flashLoanSimple(address(this), asset, amount, params, 0);
        if (loanOpen) revert BadCallback();
    }

    //
    // flashLoanSimple), and if the callback also had nonReentrant, the
    // "external call -> callback in the same tx" pattern: the guard had been
    // copied onto the callback by mistake.
    //
    //      initiator == address(this), loanOpen == true, asset/amount match
    //      activeAsset/activeAmount and keccak256(params) == activeRequestHash.
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external override whenRunning returns (bool) {
        if (block.timestamp > executionStartTime + MAX_EXECUTION_DELAY) {
            emit ExecutionDelayed(block.timestamp - executionStartTime, MAX_EXECUTION_DELAY);
            revert ExecutionTimeout();
        }

        (address expectedAsset, uint256 expectedAmount, uint256 deadline, , Hop[] memory hops) =
            abi.decode(params, (address, uint256, uint256, address, Hop[]));

        _validateFlashCallback(asset, amount, initiator, params, expectedAsset, expectedAmount);
        if (deadline < block.timestamp) revert DeadlineExpired();
        _ensureLoanReceived(asset, amount);
        _executeHops(hops);
        uint256 profit = _approveRepaymentAndGetProfit(asset, amount, premium);
        _resetLoanState();

        emit FlashCompleted(asset, amount, premium, profit, activeRequestHash);
        return true;
    }

    function _validateRouteShape(address asset, Hop[] calldata hops) internal view {
        uint256 hopCount = hops.length;
        if (hopCount < MIN_HOPS || hopCount > MAX_HOPS) revert InvalidHopCount();
        if (hops[0].tokenIn != asset || hops[hopCount - 1].tokenOut != asset) revert RouteMustStartAndEndOnAsset();

        for (uint256 i = 0; i < hopCount; ) {
            Hop calldata hop = hops[i];
            if (!routerWhitelist[hop.router]) revert RouterNotWhitelisted(hop.router);
            if (!tokenWhitelist[hop.tokenIn]) revert TokenNotWhitelisted(hop.tokenIn);
            if (!tokenWhitelist[hop.tokenOut]) revert TokenNotWhitelisted(hop.tokenOut);
            if (hop.minOut == 0) revert HopMinOutZero();
            if (i + 1 < hopCount && hop.tokenOut != hops[i + 1].tokenIn) revert RouteMustStartAndEndOnAsset();
            unchecked { ++i; }
        }
    }

    function _executeHops(Hop[] memory hops) internal {
        uint256 currentAmount = activeAmount; // first hop uses flash loan amount

        for (uint256 i = 0; i < hops.length; ) {
            Hop memory hop = hops[i];
            if (currentAmount == 0) revert ZeroAmount();

            uint256 received;
            if (hop.dexType == DexType.V2) {
                received = _executeV2Hop(hop, currentAmount);
            } else if (hop.dexType == DexType.V3) {
                received = _executeV3Hop(hop, currentAmount);
            } else {
                revert UnsupportedDexType();
            }

            emit HopExecuted(i, hop.dexType, hop.router, hop.tokenIn, hop.tokenOut, currentAmount, received);
            currentAmount = received;
            unchecked { ++i; }
        }
    }

    function _executeV2Hop(Hop memory hop, uint256 amountIn) internal returns (uint256 amountOut) {
        address[] memory path = new address[](2);
        path[0] = hop.tokenIn;
        path[1] = hop.tokenOut;

        IERC20(hop.tokenIn).safeApproveExact(hop.router, amountIn);
        uint256[] memory amounts = IUniswapV2Router(hop.router).swapExactTokensForTokens(
            amountIn,
            hop.minOut,
            path,
            address(this),
            block.timestamp
        );
        IERC20(hop.tokenIn).safeApproveExact(hop.router, 0);

        if (amounts.length < 2) revert EmptyRouterResult();
        amountOut = amounts[amounts.length - 1];
        if (amountOut < hop.minOut) revert NoProfitableRouteFound();
    }

    function _executeV3Hop(Hop memory hop, uint256 amountIn) internal returns (uint256 amountOut) {
        IERC20(hop.tokenIn).safeApproveExact(hop.router, amountIn);

        ISwapRouter.ExactInputSingleParams memory params = ISwapRouter.ExactInputSingleParams({
            tokenIn: hop.tokenIn,
            tokenOut: hop.tokenOut,
            fee: hop.fee,
            recipient: address(this),
            deadline: block.timestamp,
            amountIn: amountIn,
            amountOutMinimum: hop.minOut,
            sqrtPriceLimitX96: 0
        });

        amountOut = ISwapRouter(hop.router).exactInputSingle(params);
        IERC20(hop.tokenIn).safeApproveExact(hop.router, 0);

        if (amountOut < hop.minOut) revert NoProfitableRouteFound();
    }

    function _validateFlashCallback(
        address asset, uint256 amount, address initiator,
        bytes calldata params, address expectedAsset, uint256 expectedAmount
    ) internal view {
        if (msg.sender != aavePool) revert BadCallback();
        if (initiator != address(this)) revert BadCallback();
        if (!loanOpen) revert NoLoanOpen();
        if (asset != activeAsset || amount != activeAmount) revert BadCallback();
        if (asset != expectedAsset || amount != expectedAmount) revert BadCallback();
        if (keccak256(params) != activeRequestHash) revert BadCallback();
    }

    function _ensureLoanReceived(address asset, uint256 amount) internal view {
        uint256 currentBalance = IERC20(asset).balanceOf(address(this));
        if (currentBalance < balanceBefore + amount) revert InsufficientLoanBalance();
    }

    function _approveRepaymentAndGetProfit(address asset, uint256 amount, uint256 premium)
        internal returns (uint256 profit)
    {
        uint256 debt = amount + premium;
        if (debt < amount) revert ArithmeticOverflow();

        uint256 endingBalance = IERC20(asset).balanceOf(address(this));
        uint256 minProfitAbs = FullMath.mulDiv(amount, minProfitBps, BPS_DENOMINATOR);
        uint256 required = balanceBefore + debt + minProfitAbs;

        if (required < balanceBefore || required < debt) revert ArithmeticOverflow();
        if (endingBalance < required) revert NoProfitableRouteFound();

        profit = endingBalance - balanceBefore - debt;
        IERC20(asset).safeApproveExact(aavePool, debt);
    }

    function _setRouterAllowed(address router, bool allowed) internal {
        if (router == address(0)) revert ZeroAddress();
        if (allowed) _requireContract(router);
        routerWhitelist[router] = allowed;
        emit RouterWhitelistUpdated(router, allowed);
    }
    function _setTokenAllowed(address token, bool allowed) internal {
        if (token == address(0)) revert ZeroAddress();
        if (allowed) _requireContract(token);
        tokenWhitelist[token] = allowed;
        emit TokenWhitelistUpdated(token, allowed);
    }
    function _requireContract(address target) internal view {
        if (target.code.length == 0) revert AddressNotContract(target);
    }

    function _resetLoanState() internal {
        loanOpen = false;
        activeRequestHash = bytes32(0);
        activeAsset = address(0);
        activeAmount = 0;
        balanceBefore = 0;
        executionStartTime = 0;
    }

    receive() external payable { revert NativeTransfersDisabled(); }
    fallback() external payable { revert NativeTransfersDisabled(); }
}
