"use strict";

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const KEEPER_PATH = path.join(__dirname, "build", "keeper_v3_3.js");
if (!fs.existsSync(KEEPER_PATH)) {
  console.error("build/keeper_v3_3.js missing");
  process.exit(1);
}
const keeper = require(KEEPER_PATH);
const { quoteV2Reserve, calcEconomics, buildMinOutHops, reserveCycleQuote } = keeper;

const UNI_ROUTER = "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D";
const SUSHI_ROUTER = "0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F";
const UNI_FACTORY = "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f";
const SUSHI_FACTORY = "0xC0AEe478e3658e2610c5F7A4A2E1777cE9e4f2Ac";
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const DAI = "0x6B175474E89094C44Da98b954EedeAC495271d0F";

const V2_FEE_BPS = 30;
const PREMIUM_BPS_MOCK = 5n;
const SLIPPAGE_BPS = 50;
const WHALE_SIZES_WETH = (process.env.WHALES_WETH || "100,1000,5000").split(",").map((s) => BigInt(s.trim()));
const E18 = 10n ** 18n;
const E6 = 10n ** 6n;
const FLASH_USDC = process.env.FLASH_USDC ? BigInt(process.env.FLASH_USDC) : 1_000_000n * E6;
const SIM_GAS_USED = BigInt(process.env.SIM_GAS_USED || "350000");
const SIM_GAS_PRICE_WEI = ethers.parseUnits(process.env.SIM_GAS_PRICE_GWEI || "5", "gwei");

const PAIR_ABI = [
  "function token0() view returns (address)",
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
];
const FACTORY_ABI = ["function getPair(address tokenA, address tokenB) view returns (address pair)"];

const fmtUsdc = (x) =>
  Number(ethers.formatUnits(x, 6)).toLocaleString("en-US", { maximumFractionDigits: 2 });
const fmtWeth = (x) =>
  Number(ethers.formatEther(x)).toLocaleString("en-US", { maximumFractionDigits: 2 });
const priceUsdcPerWeth = (rWeth, rUsdc) => Number(rUsdc) / 1e6 / (Number(rWeth) / 1e18);
const pad = (s, n) => String(s).padStart(n);

function table(headers, rows) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const line = (cols) => cols.map((c, i) => pad(c, widths[i])).join(" | ");
  console.log("  " + line(headers));
  console.log("  " + widths.map((w) => "-".repeat(w)).join("-+-"));
  for (const r of rows) console.log("  " + line(r));
}

function runMock() {
  console.log("=== MOCK SIMULATION (synthetic reserves, REAL keeper math) ===");
  console.log(
    `flash = ${fmtUsdc(FLASH_USDC)} USDC | premium = ${PREMIUM_BPS_MOCK} bps | gas = ${SIM_GAS_USED} @ ${ethers.formatUnits(SIM_GAS_PRICE_WEI, "gwei")} gwei`
  );
  console.log("pools: Uni 30k WETH / 60M USDC | Sushi 12k WETH / 24M USDC\n");

  const UNI_KEY = "mock_uni";
  const SUSHI_KEY = "mock_sushi";
  keeper.STATE.v2Pairs.set(UNI_KEY, {
    pair: UNI_KEY,
    token0: USDC,
    token1: WETH,
    reserve0: 0n,
    reserve1: 0n,
  });
  keeper.STATE.v2Pairs.set(SUSHI_KEY, {
    pair: SUSHI_KEY,
    token0: USDC,
    token1: WETH,
    reserve0: 0n,
    reserve1: 0n,
  });
  const uniP = keeper.STATE.v2Pairs.get(UNI_KEY);
  const sushiP = keeper.STATE.v2Pairs.get(SUSHI_KEY);

  const rows = [];
  for (const whaleWeth of WHALE_SIZES_WETH) {
    let uniUsdc = 60_000_000n * E6,
      uniWeth = 30_000n * E18;
    let sushiUsdc = 24_000_000n * E6,
      sushiWeth = 12_000n * E18;
    const priceBefore = priceUsdcPerWeth(uniWeth, uniUsdc);

    const whaleIn = whaleWeth * E18;
    const whaleOut = quoteV2Reserve(whaleIn, uniWeth, uniUsdc, V2_FEE_BPS);
    uniWeth += whaleIn;
    uniUsdc -= whaleOut;
    const priceAfter = priceUsdcPerWeth(uniWeth, uniUsdc);

    const hop1Out = quoteV2Reserve(FLASH_USDC, uniUsdc, uniWeth, V2_FEE_BPS);
    const hop2Out = quoteV2Reserve(hop1Out, sushiWeth, sushiUsdc, V2_FEE_BPS);
    const quotedHops = [
      { dexType: 0, router: UNI_ROUTER, tokenIn: USDC, tokenOut: WETH, quoteOut: hop1Out, fee: 0 },
      { dexType: 0, router: SUSHI_ROUTER, tokenIn: WETH, tokenOut: USDC, quoteOut: hop2Out, fee: 0 },
    ];
    const minHops = buildMinOutHops(quotedHops, SLIPPAGE_BPS);
    const worstCaseFinal = minHops[minHops.length - 1].minOut;

    const gasNative = SIM_GAS_USED * SIM_GAS_PRICE_WEI;
    const gasCostAsset = quoteV2Reserve(gasNative, sushiWeth, sushiUsdc, V2_FEE_BPS);
    const econ = calcEconomics({
      amountIn: FLASH_USDC,
      worstCaseFinal,
      premiumBps: PREMIUM_BPS_MOCK,
      gasCostAsset,
    });

    uniP.reserve0 = uniUsdc;
    uniP.reserve1 = uniWeth;
    sushiP.reserve0 = sushiUsdc;
    sushiP.reserve1 = sushiWeth;
    const cycle = [
      { tokenIn: USDC, tokenOut: WETH, type: "v2", key: UNI_KEY, fee: 0 },
      { tokenIn: WETH, tokenOut: USDC, type: "v2", key: SUSHI_KEY, fee: 0 },
    ];
    const reserveFinal = reserveCycleQuote(FLASH_USDC, cycle);
    const guard = reserveFinal === 0n ? "REJECT (>1% impact)" : "pass";
    const net = econ.afterGas;
    rows.push([
      `${fmtWeth(whaleWeth * E18)}`,
      priceBefore.toFixed(2),
      priceAfter.toFixed(2),
      fmtUsdc(econ.worstGross),
      fmtUsdc(econ.premium),
      fmtUsdc(gasCostAsset),
      (net >= 0n ? "" : "-") + fmtUsdc(net < 0n ? -net : net),
      `${econ.profitBps}`,
      guard,
      net > 0n ? "PROFIT" : "LOSS",
    ]);
  }
  table(
    ["whale(WETH)", "Uni$ bef", "Uni$ aft", "gross USDC", "premium", "gas USDC", "NET USDC", "net bps", "keeper guard", "verdict"],
    rows
  );

  console.log("\n── Auto-sized sweep (best NET flash size that passes impact guard) ──");
  const sweepRows = [];
  for (const whaleWeth of WHALE_SIZES_WETH) {
    let uniUsdc = 60_000_000n * E6,
      uniWeth = 30_000n * E18;
    const sushiUsdc = 24_000_000n * E6,
      sushiWeth = 12_000n * E18;
    const whaleIn = whaleWeth * E18;
    const whaleOut = quoteV2Reserve(whaleIn, uniWeth, uniUsdc, V2_FEE_BPS);
    uniWeth += whaleIn;
    uniUsdc -= whaleOut;
    uniP.reserve0 = uniUsdc;
    uniP.reserve1 = uniWeth;
    sushiP.reserve0 = sushiUsdc;
    sushiP.reserve1 = sushiWeth;
    const cycle = [
      { tokenIn: USDC, tokenOut: WETH, type: "v2", key: UNI_KEY, fee: 0 },
      { tokenIn: WETH, tokenOut: USDC, type: "v2", key: SUSHI_KEY, fee: 0 },
    ];
    let bestRow = null;
    for (const sizeUsd of [10_000n, 25_000n, 50_000n, 100_000n, 250_000n, 500_000n, 1_000_000n]) {
      const amount = sizeUsd * E6;
      const reserveFinal = reserveCycleQuote(amount, cycle);
      const guardPass = reserveFinal !== 0n;
      const h1 = quoteV2Reserve(amount, uniUsdc, uniWeth, V2_FEE_BPS);
      const h2 = quoteV2Reserve(h1, sushiWeth, sushiUsdc, V2_FEE_BPS);
      const minHops2 = buildMinOutHops(
        [
          { dexType: 0, router: UNI_ROUTER, tokenIn: USDC, tokenOut: WETH, quoteOut: h1, fee: 0 },
          { dexType: 0, router: SUSHI_ROUTER, tokenIn: WETH, tokenOut: USDC, quoteOut: h2, fee: 0 },
        ],
        SLIPPAGE_BPS
      );
      const gasCostAsset = quoteV2Reserve(SIM_GAS_USED * SIM_GAS_PRICE_WEI, sushiWeth, sushiUsdc, V2_FEE_BPS);
      const econ = calcEconomics({
        amountIn: amount,
        worstCaseFinal: minHops2[1].minOut,
        premiumBps: PREMIUM_BPS_MOCK,
        gasCostAsset,
      });
      const net = econ.afterGas;
      if (guardPass && (!bestRow || net > bestRow.net)) {
        bestRow = { sizeUsd, net, gross: econ.worstGross, bps: econ.profitBps };
      }
    }
    if (bestRow) {
      sweepRows.push([
        fmtWeth(whaleWeth * E18),
        fmtUsdc(bestRow.sizeUsd * E6),
        fmtUsdc(bestRow.gross),
        (bestRow.net >= 0n ? "" : "-") + fmtUsdc(bestRow.net < 0n ? -bestRow.net : bestRow.net),
        `${bestRow.bps}`,
        bestRow.net > 0n ? "PROFIT" : "LOSS",
      ]);
    } else {
      sweepRows.push([fmtWeth(whaleWeth * E18), "—", "—", "—", "—", "no size passes guard"]);
    }
  }
  table(["whale(WETH)", "best flash USDC", "gross USDC", "NET USDC", "net bps", "verdict"], sweepRows);
  console.log("\n=== MOCK DONE ===");
}

async function pickRpc() {
  const candidates = process.env.FORK_RPC
    ? [process.env.FORK_RPC]
    : ["https://ethereum-rpc.publicnode.com", "https://1rpc.io/eth", "https://eth.drpc.org"];
  for (const url of candidates) {
    try {
      const p = new ethers.JsonRpcProvider(url, 1, { staticNetwork: true });
      const bn = await Promise.race([
        p.getBlockNumber(),
        new Promise((_, r) => setTimeout(() => r(new Error("timeout")), 8000)),
      ]);
      console.log(`[rpc] OK: ${url} (block ${bn})`);
      return { provider: p, url };
    } catch (e) {
      console.log(`[rpc] unavailable: ${url} (${e.message})`);
    }
  }
  throw new Error("no reachable RPC");
}

async function runOrganic() {
  console.log("=== ORGANIC SCAN (no manipulation, real reserves, 2-hop cross-DEX) ===");
  const { provider } = await pickRpc();
  const uniFactory = new ethers.Contract(UNI_FACTORY, FACTORY_ABI, provider);
  const sushiFactory = new ethers.Contract(SUSHI_FACTORY, FACTORY_ABI, provider);
  const tokens = [
    { sym: "WETH", addr: WETH, dec: 18, probe: 10n * E18 },
    { sym: "USDC", addr: USDC, dec: 6, probe: 20_000n * E6 },
    { sym: "DAI", addr: DAI, dec: 18, probe: 20_000n * E18 },
  ];
  const pairs = [];
  for (let i = 0; i < tokens.length; i++) {
    for (let j = i + 1; j < tokens.length; j++) {
      const [uniPair, sushiPair] = await Promise.all([
        uniFactory.getPair(tokens[i].addr, tokens[j].addr),
        sushiFactory.getPair(tokens[i].addr, tokens[j].addr),
      ]);
      pairs.push({ a: tokens[i], b: tokens[j], uniPair, sushiPair });
    }
  }
  async function reservesOf(pairAddr, tIn) {
    const pair = new ethers.Contract(pairAddr, PAIR_ABI, provider);
    const [t0, res] = await Promise.all([pair.token0(), pair.getReserves()]);
    const r0 = BigInt(res.reserve0),
      r1 = BigInt(res.reserve1);
    return t0.toLowerCase() === tIn.toLowerCase() ? { rIn: r0, rOut: r1 } : { rIn: r1, rOut: r0 };
  }

  let best = { spreadBps: -Infinity, label: "" };
  const rows = [];
  for (const p of pairs) {
    if (p.uniPair === ethers.ZeroAddress || p.sushiPair === ethers.ZeroAddress) {
      rows.push([`${p.a.sym}/${p.b.sym}`, "—", "pair missing", "—", "—"]);
      continue;
    }
    for (const dir of [
      { tin: p.a, tout: p.b },
      { tin: p.b, tout: p.a },
    ]) {
      for (const [first, second, fName, sName] of [
        [p.uniPair, p.sushiPair, "Uni", "Sushi"],
        [p.sushiPair, p.uniPair, "Sushi", "Uni"],
      ]) {
        const amountIn = dir.tin.probe;
        const r1 = await reservesOf(first, dir.tin.addr);
        const out1 = quoteV2Reserve(amountIn, r1.rIn, r1.rOut, V2_FEE_BPS);
        const r2 = await reservesOf(second, dir.tout.addr);
        const out2 = quoteV2Reserve(out1, r2.rIn, r2.rOut, V2_FEE_BPS);
        const spreadBps = Number(((out2 - amountIn) * 10000n) / amountIn);
        const label = `${dir.tin.sym}->${dir.tout.sym}(${fName})->${dir.tin.sym}(${sName})`;
        rows.push([
          label,
          `${Number(ethers.formatUnits(amountIn, dir.tin.dec)).toLocaleString()} ${dir.tin.sym}`,
          `${spreadBps} bps`,
          spreadBps > 5 ? "covers 5bps premium" : "below premium+fees",
          spreadBps > 5 ? "YES" : "no",
        ]);
        if (spreadBps > best.spreadBps) best = { spreadBps, label };
      }
    }
  }
  table(["2-hop cycle", "size in", "gross spread", "economics", "opportunity"], rows);
  console.log(
    `\norganic opportunity exists: ${best.spreadBps > 5 ? "YES" : "no"} (best spread ${best.spreadBps} bps: ${best.label})`
  );
  console.log(
    "(Healthy markets usually show no free organic cross-DEX spread after fees+premium — searchers close them.)"
  );
  console.log("=== ORGANIC DONE ===");
  provider.destroy?.();
}

(async () => {
  const mode = process.argv[2] || "--mock";
  try {
    if (mode === "--mock") runMock();
    else if (mode === "--mainnet") await runOrganic();
    else {
      console.error("usage: node profit_simulation.js [--mock|--mainnet]");
      process.exit(1);
    }
  } catch (err) {
    console.error(`[fatal] ${err.message}`);
    process.exit(1);
  }
})();
