// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

import {ArbitrageExecutor} from "../src/ArbitrageExecutor.sol";
import {IERC20} from "../src/ArbitrageExecutor.sol";

interface HEVM {
    function createSelectFork(string calldata urlOrAlias) external returns (uint256);
    function createSelectFork(string calldata urlOrAlias, uint256 blockNumber) external returns (uint256);
    function deal(address account, uint256 newBalance) external;
    function prank(address account) external;
    function startPrank(address account) external;
    function stopPrank() external;
    function expectRevert() external;
    function expectRevert(bytes4 revertData) external;
    function envOr(string calldata name, string calldata defaultValue) external returns (string memory);
    function envOr(string calldata name, uint256 defaultValue) external returns (uint256);
}

library console2 {
    address private constant CONSOLE_ADDRESS = 0x000000000000000000636F6e736F6c652e6c6f67;

    function _sendLogPayload(bytes memory payload) private view {
        (bool ok,) = CONSOLE_ADDRESS.staticcall(payload);
        require(ok, "console2 log failed");
    }

    function log(string memory p0) internal view {
        _sendLogPayload(abi.encodeWithSelector(bytes4(keccak256("log(string)")), p0));
    }

    function log(string memory p0, uint256 p1) internal view {
        _sendLogPayload(abi.encodeWithSelector(bytes4(keccak256("log(string,uint256)")), p0, p1));
    }

    function log(string memory p0, string memory p1) internal view {
        _sendLogPayload(abi.encodeWithSelector(bytes4(keccak256("log(string,string)")), p0, p1));
    }
}

interface IWETH is IERC20 {
    function deposit() external payable;
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
        external
        view
        returns (uint256[] memory amounts);
}

abstract contract TestBase {
    HEVM internal constant vm = HEVM(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);

    function assertGt(uint256 a, uint256 b, string memory message) internal view {
        if (a <= b) {
            console2.log("ASSERTION FAILED (assertGt):", message);
            revert("assertGt failed");
        }
    }

    function assertTrue(bool condition, string memory message) internal view {
        if (!condition) {
            console2.log("ASSERTION FAILED (assertTrue):", message);
            revert("assertTrue failed");
        }
    }
}

contract ArbitrageExecutorProof is TestBase {
    address internal constant AAVE_POOL = 0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2;
    address internal constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address internal constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address internal constant UNI_ROUTER = 0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D;
    address internal constant SUSHI_ROUTER = 0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F;

    ArbitrageExecutor internal arb;

    function setUp() public {
        string memory rpc = vm.envOr("MAINNET_RPC", "https://ethereum-rpc.publicnode.com");
        uint256 forkBlock = vm.envOr("FORK_BLOCK", uint256(0));
        if (forkBlock == 0) {
            vm.createSelectFork(rpc);
        } else {
            vm.createSelectFork(rpc, forkBlock);
        }

        address[] memory routers = new address[](2);
        routers[0] = UNI_ROUTER;
        routers[1] = SUSHI_ROUTER;
        address[] memory tokens = new address[](2);
        tokens[0] = WETH;
        tokens[1] = USDC;

        arb = new ArbitrageExecutor(AAVE_POOL, address(this), routers, tokens);
        assertTrue(!arb.paused(), "contract must start unpaused");
        assertTrue(arb.executor() == address(this), "executor must be the test contract");
    }

    function _whaleMovePrice(uint256 wethAmount) internal {
        address whale = address(uint160(uint256(keccak256("arbitrage-proof-whale"))));
        vm.deal(whale, wethAmount + 1 ether);
        vm.startPrank(whale);
        IWETH(WETH).deposit{value: wethAmount}();
        IERC20(WETH).approve(UNI_ROUTER, wethAmount);
        address[] memory path = new address[](2);
        path[0] = WETH;
        path[1] = USDC;
        IUniswapV2Router(UNI_ROUTER).swapExactTokensForTokens(
            wethAmount, 0, path, whale, block.timestamp + 120
        );
        vm.stopPrank();
    }

    function _quote(address router, uint256 amountIn, address tokenIn, address tokenOut)
        internal
        view
        returns (uint256)
    {
        address[] memory path = new address[](2);
        path[0] = tokenIn;
        path[1] = tokenOut;
        uint256[] memory amounts = IUniswapV2Router(router).getAmountsOut(amountIn, path);
        return amounts[amounts.length - 1];
    }

    function _buildHops(uint256 flashUsdc) internal view returns (ArbitrageExecutor.Hop[] memory hops) {
        uint256 q1 = _quote(UNI_ROUTER, flashUsdc, USDC, WETH);
        uint256 q2 = _quote(SUSHI_ROUTER, q1, WETH, USDC);
        hops = new ArbitrageExecutor.Hop[](2);
        hops[0] = ArbitrageExecutor.Hop({
            dexType: ArbitrageExecutor.DexType.V2,
            router: UNI_ROUTER,
            tokenIn: USDC,
            tokenOut: WETH,
            minOut: q1 * 995 / 1000,
            fee: 0
        });
        hops[1] = ArbitrageExecutor.Hop({
            dexType: ArbitrageExecutor.DexType.V2,
            router: SUSHI_ROUTER,
            tokenIn: WETH,
            tokenOut: USDC,
            minOut: q2 * 995 / 1000,
            fee: 0
        });
    }

    function _runArb(uint256 flashUsdc, ArbitrageExecutor.Hop[] memory hops) internal returns (uint256 profit) {
        uint256 balanceBefore = IERC20(USDC).balanceOf(address(arb));
        arb.startArbitrage(USDC, flashUsdc, block.timestamp + 120, hops);
        uint256 balanceAfter = IERC20(USDC).balanceOf(address(arb));
        profit = balanceAfter - balanceBefore;
    }

    function test_PROOF1_flashloanExecutesAndProfits() public {
        _whaleMovePrice(1_000 ether);
        uint256 flashUsdc = 20_000e6;
        uint256 premiumBps = arb.flashLoanPremiumBps();
        console2.log("Aave premium bps:", premiumBps);
        uint256 profit = _runArb(flashUsdc, _buildHops(flashUsdc));
        console2.log("GROSS PROFIT USDC (6dec):", profit);
        assertGt(profit, 0, "PROOF1: must be profitable");
        assertGt(profit, flashUsdc * premiumBps / 10_000, "PROOF1: profit > premium");
    }

    function test_PROOF2_profitScales_whale100() public {
        _whaleMovePrice(100 ether);
        uint256 flashUsdc = 2_000e6;
        uint256 profit = _runArb(flashUsdc, _buildHops(flashUsdc));
        console2.log("GROSS PROFIT USDC whale=100:", profit);
        assertGt(profit, 0, "PROOF2: must be profitable");
    }

    function test_PROOF3_profitScales_whale5000() public {
        _whaleMovePrice(5_000 ether);
        uint256 flashUsdc = 50_000e6;
        uint256 profit = _runArb(flashUsdc, _buildHops(flashUsdc));
        console2.log("GROSS PROFIT USDC whale=5000:", profit);
        assertGt(profit, 0, "PROOF3: must be profitable");
    }

    function test_T1_inflatedMinOutReverts() public {
        _whaleMovePrice(1_000 ether);
        uint256 flashUsdc = 20_000e6;
        ArbitrageExecutor.Hop[] memory hops = _buildHops(flashUsdc);
        hops[0].minOut = _quote(UNI_ROUTER, flashUsdc, USDC, WETH) * 2;
        vm.expectRevert();
        arb.startArbitrage(USDC, flashUsdc, block.timestamp + 120, hops);
    }

    function test_T2_minProfitInvariantReverts() public {
        _whaleMovePrice(1_000 ether);
        uint256 flashUsdc = 20_000e6;
        ArbitrageExecutor.Hop[] memory hops = _buildHops(flashUsdc);
        arb.setMinProfitBps(9_000);
        vm.expectRevert(ArbitrageExecutor.NoProfitableRouteFound.selector);
        arb.startArbitrage(USDC, flashUsdc, block.timestamp + 120, hops);
    }

    function test_T3_unauthorizedReverts() public {
        ArbitrageExecutor.Hop[] memory hops = _buildHops(20_000e6);
        vm.prank(address(0xE411));
        vm.expectRevert(ArbitrageExecutor.Unauthorized.selector);
        arb.startArbitrage(USDC, 20_000e6, block.timestamp + 120, hops);
    }

    function test_T4_honestOrganicBaseline() public view {
        uint256 amountIn = 20_000e6;
        uint256 wethOut = _quote(UNI_ROUTER, amountIn, USDC, WETH);
        _quote(SUSHI_ROUTER, wethOut, WETH, USDC);
    }
}
