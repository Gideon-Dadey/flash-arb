"use strict";

const { ethers } = require("ethers");

const BPS = 10000n;
const PRICE_IMPACT_BPS = 100; // 1%
const E18 = 10n ** 18n;

const STATE = {
  v2Pairs: new Map(),
  v3Pools: new Map(),
  tokens: new Set(),
  tokenDecimals: new Map(),
  tokenSymbols: new Map(),
  graph: new Map(),
  lastBlockNumber: 0,
  startedAt: Date.now(),
  stats: { windowStart: Date.now(), counters: {}, sums: {}, dropReasons: {} },
  lifetime: { simPassed: 0, expectedNetAsset: 0n },
};

const CFG = {
  arbContract: "",
  flashAsset: "",
  flashAmount: "0",
  stablecoins: [],
};

function quoteV2Reserve(amountIn, rIn, rOut, feeBps) {
  if (amountIn <= 0n || rIn <= 0n || rOut <= 0n) return 0n;
  const feeMul = 10000n - BigInt(feeBps);
  const num = amountIn * feeMul * rOut;
  const den = rIn * 10000n + amountIn * feeMul;
  return den === 0n ? 0n : num / den;
}

function reserveCycleQuote(amountIn, cycle) {
  let cur = amountIn;
  const fee = 30;
  for (const edge of cycle) {
    if (edge.type !== "v2") return -1n;
    const p = STATE.v2Pairs.get(edge.key);
    if (!p) return 0n;
    const isT0 = edge.tokenIn.toLowerCase() === p.token0.toLowerCase();
    const rIn = isT0 ? p.reserve0 : p.reserve1;
    const rOut = isT0 ? p.reserve1 : p.reserve0;
    const out = quoteV2Reserve(cur, rIn, rOut, fee);
    if (out === 0n) return 0n;
    const spotNum = rOut * cur;
    const execNum = out * rIn;
    if (spotNum > 0n) {
      const impactBps = ((spotNum - execNum) * BPS) / spotNum;
      if (impactBps > BigInt(PRICE_IMPACT_BPS)) return 0n;
    }
    cur = out;
  }
  return cur;
}

function buildMinOutHops(quotedHops, totalSlippageBps) {
  if (totalSlippageBps < 0 || totalSlippageBps > 1000) throw new Error("Invalid slippage");
  const n = quotedHops.length;
  if (n === 0) return [];
  const totalRatio = (10000 - totalSlippageBps) / 10000;
  const hopRatio = Math.pow(totalRatio, 1 / n);
  const hopSlippageBps = Math.ceil((1 - hopRatio) * 10000);
  const multiplier = 10000n - BigInt(hopSlippageBps);
  return quotedHops.map((hop) => {
    const minOut = (hop.quoteOut * multiplier) / 10000n;
    if (minOut <= 0n) throw new Error("minOut zero");
    return {
      dexType: hop.dexType,
      router: hop.router,
      tokenIn: hop.tokenIn,
      tokenOut: hop.tokenOut,
      minOut,
      fee: hop.fee,
    };
  });
}

function calcEconomics({ amountIn, worstCaseFinal, premiumBps, gasCostAsset }) {
  const premium = (amountIn * premiumBps) / BPS;
  const worstGross = worstCaseFinal > amountIn ? worstCaseFinal - amountIn : 0n;
  const afterAave = worstGross > premium ? worstGross - premium : 0n;
  const afterGas = afterAave > gasCostAsset ? afterAave - gasCostAsset : 0n;
  const profitBps = amountIn > 0n ? Number((afterGas * BPS) / amountIn) : 0;
  return { premium, worstGross, afterAave, afterGas, profitBps };
}

function parseRealizedProfit(receipt) {
  const iface = new ethers.Interface([
    "event FlashCompleted(address indexed asset,uint256 amount,uint256 premium,uint256 profit,bytes32 requestHash)",
  ]);
  for (const lg of receipt.logs || []) {
    try {
      if (CFG.arbContract && lg.address.toLowerCase() !== CFG.arbContract.toLowerCase()) continue;
      const p = iface.parseLog(lg);
      if (p && p.name === "FlashCompleted") return BigInt(p.args.profit);
    } catch {}
  }
  return null;
}

function integerSqrt(x) {
  if (x <= 0n) return 0n;
  if (x < 4n) return 1n;
  let z = x;
  let y = (x + 1n) / 2n;
  while (y < z) {
    z = y;
    y = (x / y + y) / 2n;
  }
  return z;
}

module.exports = {
  quoteV2Reserve,
  calcEconomics,
  buildMinOutHops,
  reserveCycleQuote,
  parseRealizedProfit,
  integerSqrt,
  CFG,
  STATE,
  PRICE_IMPACT_BPS,
  E18,
};
