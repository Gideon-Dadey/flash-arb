"use strict";

const { ethers } = require("ethers");
const { CFG, canSubmitLive, log } = require("./config");
const {
  quoteV2Reserve,
  calcEconomics,
  buildMinOutHops,
  reserveCycleQuote,
} = require("../simulation/build/keeper_v3_3.js");

const FACTORY_ABI = [
  "function getPair(address tokenA, address tokenB) view returns (address pair)",
];
const PAIR_ABI = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
];
const ROUTER_ABI = [
  "function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)",
];
const ARB_ABI = [
  "function previewRoute(uint256 amountIn,(uint8 dexType,address router,address tokenIn,address tokenOut,uint256 minOut,uint24 fee)[] hops) view returns (uint256[] amountsOut)",
  "function startArbitrage(address asset,uint256 amount,uint256 deadline,(uint8 dexType,address router,address tokenIn,address tokenOut,uint256 minOut,uint24 fee)[] hops)",
  "function flashLoanPremiumBps() view returns (uint256)",
  "function paused() view returns (bool)",
  "function executor() view returns (address)",
  "function owner() view returns (address)",
  "function minProfitBps() view returns (uint256)",
];

const V2_FEE_BPS = 30;
const BPS = 10000n;
const STATE = {
  pairs: [], // { factory, router, pair, token0, token1, reserve0, reserve1, key }
  lastBlock: 0,
  scans: 0,
  opps: 0,
  submitted: 0,
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function buildProviders() {
  const provider = new ethers.JsonRpcProvider(CFG.rpcUrl);
  let wallet = null;
  if (CFG.keeperPk) {
    wallet = new ethers.Wallet(CFG.keeperPk, provider);
  }
  return { provider, wallet };
}

async function discoverPairs(provider) {
  const tokens = [...new Set([CFG.flashAsset, ...CFG.bootstrapTokens, ...CFG.stablecoins])];
  const pairs = [];
  for (let fi = 0; fi < CFG.v2Factories.length; fi++) {
    const factoryAddr = CFG.v2Factories[fi];
    const router = CFG.v2Routers[fi] || CFG.v2Routers[0];
    const factory = new ethers.Contract(factoryAddr, FACTORY_ABI, provider);
    for (let i = 0; i < tokens.length; i++) {
      for (let j = i + 1; j < tokens.length; j++) {
        try {
          const pairAddr = await factory.getPair(tokens[i], tokens[j]);
          if (!pairAddr || pairAddr === ethers.ZeroAddress) continue;
          const pair = new ethers.Contract(pairAddr, PAIR_ABI, provider);
          const [t0, t1, res] = await Promise.all([
            pair.token0(),
            pair.token1(),
            pair.getReserves(),
          ]);
          const key = `${factoryAddr.slice(0, 6)}:${pairAddr.toLowerCase()}`;
          pairs.push({
            factory: factoryAddr,
            router,
            pair: pairAddr,
            token0: ethers.getAddress(t0),
            token1: ethers.getAddress(t1),
            reserve0: BigInt(res.reserve0),
            reserve1: BigInt(res.reserve1),
            key,
          });
        } catch {
          /* skip */
        }
      }
    }
  }
  STATE.pairs = pairs;
  log("info", "pairs discovered", { count: pairs.length, tokens: tokens.length });
  return pairs;
}

async function refreshReserves(provider) {
  for (const p of STATE.pairs) {
    try {
      const pair = new ethers.Contract(p.pair, PAIR_ABI, provider);
      const res = await pair.getReserves();
      p.reserve0 = BigInt(res.reserve0);
      p.reserve1 = BigInt(res.reserve1);
    } catch {
      /* keep old */
    }
  }
}

function findTwoHopCycles(flashAsset) {
  const flash = flashAsset.toLowerCase();
  const byToken = new Map();
  for (const p of STATE.pairs) {
    if (p.reserve0 === 0n || p.reserve1 === 0n) continue;
    for (const t of [p.token0, p.token1]) {
      const k = t.toLowerCase();
      if (!byToken.has(k)) byToken.set(k, []);
      byToken.get(k).push(p);
    }
  }

  const cycles = [];
  const firstLegs = byToken.get(flash) || [];
  for (const p1 of firstLegs) {
    const mid = p1.token0.toLowerCase() === flash ? p1.token1 : p1.token0;
    const secondLegs = byToken.get(mid.toLowerCase()) || [];
    for (const p2 of secondLegs) {
      if (p2.pair.toLowerCase() === p1.pair.toLowerCase()) continue;
      const back =
        p2.token0.toLowerCase() === mid.toLowerCase() ? p2.token1 : p2.token0;
      if (back.toLowerCase() !== flash) continue;
      cycles.push([
        {
          tokenIn: flashAsset,
          tokenOut: mid,
          type: "v2",
          key: p1.key,
          fee: 0,
          router: p1.router,
          pairMeta: p1,
        },
        {
          tokenIn: mid,
          tokenOut: flashAsset,
          type: "v2",
          key: p2.key,
          fee: 0,
          router: p2.router,
          pairMeta: p2,
        },
      ]);
    }
  }
  return cycles;
}

function loadKeeperStatePairs() {
  const { STATE: kState } = require("../simulation/build/keeper_v3_3.js");
  kState.v2Pairs.clear();
  for (const p of STATE.pairs) {
    kState.v2Pairs.set(p.key, {
      pair: p.pair,
      token0: p.token0,
      token1: p.token1,
      reserve0: p.reserve0,
      reserve1: p.reserve1,
    });
  }
}

async function routerQuote(provider, router, amountIn, tokenIn, tokenOut) {
  const c = new ethers.Contract(router, ROUTER_ABI, provider);
  const amounts = await c.getAmountsOut(amountIn, [tokenIn, tokenOut]);
  return BigInt(amounts[amounts.length - 1]);
}

async function getGasCostInAsset(provider, gasLimit) {
  const fee = await provider.getFeeData();
  const maxFee = fee.maxFeePerGas || fee.gasPrice || 3_000_000_000n;
  const gasCostNative = gasLimit * maxFee;
  if (CFG.flashAsset.toLowerCase() === CFG.wrappedNative.toLowerCase()) {
    return { gasCostAsset: gasCostNative, maxFeePerGas: maxFee, maxPriorityFeePerGas: fee.maxPriorityFeePerGas || 1_000_000_000n };
  }
  try {
    const out = await routerQuote(
      provider,
      CFG.v2Routers[0],
      gasCostNative,
      CFG.wrappedNative,
      CFG.flashAsset
    );
    return {
      gasCostAsset: out,
      maxFeePerGas: maxFee,
      maxPriorityFeePerGas: fee.maxPriorityFeePerGas || 1_000_000_000n,
    };
  } catch {
    return {
      gasCostAsset: 0n,
      maxFeePerGas: maxFee,
      maxPriorityFeePerGas: fee.maxPriorityFeePerGas || 1_000_000_000n,
      unknown: true,
    };
  }
}

async function evaluateCycle(provider, arb, wallet, cycle) {
  const amountIn = BigInt(CFG.flashAmount);
  loadKeeperStatePairs();

  const reserveFinal = reserveCycleQuote(amountIn, cycle);
  if (reserveFinal === 0n) return null; // impact or zero

  let hop1Out, hop2Out;
  try {
    hop1Out = await routerQuote(
      provider,
      cycle[0].router,
      amountIn,
      cycle[0].tokenIn,
      cycle[0].tokenOut
    );
    hop2Out = await routerQuote(
      provider,
      cycle[1].router,
      hop1Out,
      cycle[1].tokenIn,
      cycle[1].tokenOut
    );
  } catch {
    return null;
  }
  if (hop1Out === 0n || hop2Out === 0n) return null;

  const quotedHops = [
    {
      dexType: 0,
      router: cycle[0].router,
      tokenIn: cycle[0].tokenIn,
      tokenOut: cycle[0].tokenOut,
      quoteOut: hop1Out,
      fee: 0,
    },
    {
      dexType: 0,
      router: cycle[1].router,
      tokenIn: cycle[1].tokenIn,
      tokenOut: cycle[1].tokenOut,
      quoteOut: hop2Out,
      fee: 0,
    },
  ];

  let minHops;
  try {
    minHops = buildMinOutHops(quotedHops, CFG.slippageBps);
  } catch {
    return null;
  }
  const worstCaseFinal = minHops[minHops.length - 1].minOut;

  let premiumBps = 5n;
  if (arb) {
    try {
      premiumBps = BigInt(await arb.flashLoanPremiumBps());
    } catch {
      /* default */
    }
  }

  const gasInfo = await getGasCostInAsset(provider, 450_000n);
  if (gasInfo.unknown) return null;

  const economics = calcEconomics({
    amountIn,
    worstCaseFinal,
    premiumBps,
    gasCostAsset: gasInfo.gasCostAsset,
  });

  const gasBps =
    amountIn > 0n ? Number((gasInfo.gasCostAsset * BPS) / amountIn) : 999999;
  if (gasBps > CFG.maxGasBpsOfTrade) return null;
  if (economics.profitBps < CFG.minProfitBps) return null;

  const deadline = Math.floor(Date.now() / 1000) + CFG.deadlineSec;
  let simOk = null;
  let simErr = null;
  if (arb && wallet) {
    try {
      await arb.startArbitrage.staticCall(
        CFG.flashAsset,
        amountIn,
        deadline,
        minHops
      );
      simOk = true;
    } catch (e) {
      simOk = false;
      simErr = (e.shortMessage || e.message || "").slice(0, 160);
    }
  }

  return {
    hops: minHops,
    quotedHops,
    deadline,
    finalAmount: hop2Out,
    worstCaseFinal,
    premiumBps,
    economics,
    gasInfo,
    simOk,
    simErr,
    label: `${cycle[0].tokenOut.slice(0, 6)} via ${cycle[0].router.slice(0, 6)}→${cycle[1].router.slice(0, 6)}`,
  };
}

async function submitLive(provider, arb, wallet, opp) {
  if (!canSubmitLive()) {
    log("info", "LIVE blocked (need DRY_RUN=false and LIVE_FORCE=true)", {
      dryRun: CFG.dryRun,
      liveForce: CFG.liveForce,
    });
    return null;
  }
  if (!CFG.allowPublicMempool && !CFG.useFlashbots) {
    log("warn", "LIVE blocked: set USE_FLASHBOTS=true or ALLOW_PUBLIC_MEMPOOL=true");
    return null;
  }

  const bal = await provider.getBalance(wallet.address);
  if (bal < CFG.minNative) {
    throw new Error(`Native too low: ${ethers.formatEther(bal)} ETH`);
  }

  const amountIn = BigInt(CFG.flashAmount);
  try {
    await arb.startArbitrage.staticCall(
      CFG.flashAsset,
      amountIn,
      opp.deadline,
      opp.hops
    );
  } catch (e) {
    log("warn", "final sim failed — not submitting", {
      err: (e.shortMessage || e.message || "").slice(0, 160),
    });
    return null;
  }

  if (opp.deadline <= Math.floor(Date.now() / 1000)) {
    log("warn", "deadline passed");
    return null;
  }

  const fee = await provider.getFeeData();
  const txReq = await arb.startArbitrage.populateTransaction(
    CFG.flashAsset,
    amountIn,
    opp.deadline,
    opp.hops
  );

  if (CFG.useFlashbots) {
    const nonce = await provider.getTransactionCount(wallet.address, "pending");
    const signed = await wallet.signTransaction({
      ...txReq,
      chainId: Number(CFG.chainId),
      nonce,
      gasLimit: 900_000n,
      maxFeePerGas: fee.maxFeePerGas || fee.gasPrice,
      maxPriorityFeePerGas: fee.maxPriorityFeePerGas || 2_000_000_000n,
      type: 2,
    });
    const body = {
      jsonrpc: "2.0",
      id: 1,
      method: "eth_sendBundle",
      params: [
        {
          txs: [signed],
          blockNumber: "0x" + ((await provider.getBlockNumber()) + 1).toString(16),
        },
      ],
    };
    const sig = await wallet.signMessage(JSON.stringify(body));
    const res = await fetch(CFG.flashbotsRelay, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Flashbots-Signature": `${wallet.address}:${sig}`,
      },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    STATE.submitted++;
    log("info", "Flashbots bundle sent", { result: json.result || json.error || json });
    return json;
  }

  log("warn", "sending via PUBLIC mempool — sandwich risk");
  const tx = await wallet.sendTransaction({
    ...txReq,
    gasLimit: 900_000n,
    maxFeePerGas: fee.maxFeePerGas || fee.gasPrice,
    maxPriorityFeePerGas: fee.maxPriorityFeePerGas || 2_000_000_000n,
  });
  log("info", "tx sent", { hash: tx.hash });
  const receipt = await tx.wait();
  STATE.submitted++;
  log("info", "tx mined", {
    hash: receipt.hash,
    status: receipt.status,
    gasUsed: receipt.gasUsed.toString(),
  });
  return receipt;
}

async function scanOnce(provider, arb, wallet) {
  STATE.scans++;
  await refreshReserves(provider);
  const cycles = findTwoHopCycles(CFG.flashAsset);
  let best = null;

  for (const cycle of cycles) {
    try {
      const opp = await evaluateCycle(provider, arb, wallet, cycle);
      if (!opp) continue;
      if (!best || opp.economics.afterGas > best.economics.afterGas) best = opp;
    } catch {
      /* next */
    }
  }

  if (!best) {
    log("info", "scan: no profitable route", {
      scan: STATE.scans,
      block: STATE.lastBlock,
      cycles: cycles.length,
      mode: canSubmitLive() ? "LIVE" : "DRY_RUN",
    });
    return null;
  }

  STATE.opps++;
  log("info", "OPPORTUNITY", {
    scan: STATE.scans,
    block: STATE.lastBlock,
    label: best.label,
    flash: CFG.flashAmount,
    quotedOut: best.finalAmount.toString(),
    worstCase: best.worstCaseFinal.toString(),
    netAsset: best.economics.afterGas.toString(),
    netBps: best.economics.profitBps,
    premiumBps: best.premiumBps.toString(),
    gasAsset: best.gasInfo.gasCostAsset.toString(),
    simOk: best.simOk,
    simErr: best.simErr,
    mode: canSubmitLive() ? "LIVE" : "DRY_RUN",
  });

  if (canSubmitLive() && arb && wallet && best.simOk !== false) {
    if (best.simOk === false) {
      log("warn", "skip submit — eth_call sim failed", { err: best.simErr });
      return best;
    }
    await submitLive(provider, arb, wallet, best);
  }
  return best;
}

async function mainLoop(once) {
  const { provider, wallet } = await buildProviders();
  const net = await provider.getNetwork();

  log("info", "KEEPER START", {
    chainId: net.chainId.toString(),
    wallet: wallet ? wallet.address : "(scan-only, no KEEPER_PK)",
    arb: CFG.arbContract || "(none — quote-only)",
    flashAsset: CFG.flashAsset,
    flashAmount: CFG.flashAmount,
    dryRun: CFG.dryRun,
    liveForce: CFG.liveForce,
    canSubmitLive: canSubmitLive(),
    pollMs: CFG.pollMs,
  });

  if (canSubmitLive()) {
    log("warn", "LIVE MODE ARMED — real txs may be sent");
    if (!wallet) throw new Error("LIVE requires KEEPER_PK");
    if (!CFG.arbContract) throw new Error("LIVE requires ARB_CONTRACT");
  }

  let arb = null;
  if (CFG.arbContract) {
    if (!wallet) throw new Error("ARB_CONTRACT set but KEEPER_PK missing");
    arb = new ethers.Contract(CFG.arbContract, ARB_ABI, wallet);
    const [exec, owner, paused] = await Promise.all([
      arb.executor(),
      arb.owner(),
      arb.paused(),
    ]);
    log("info", "contract linked", { exec, owner, paused });
    if (
      canSubmitLive() &&
      wallet.address.toLowerCase() !== exec.toLowerCase() &&
      wallet.address.toLowerCase() !== owner.toLowerCase()
    ) {
      throw new Error("KEEPER_PK is not contract executor/owner");
    }
    if (paused && canSubmitLive()) throw new Error("contract is paused");
  }

  await discoverPairs(provider);

  if (once) {
    STATE.lastBlock = await provider.getBlockNumber();
    await scanOnce(provider, arb, wallet);
    log("info", "once-done", { scans: STATE.scans, opps: STATE.opps, submitted: STATE.submitted });
    return;
  }

  while (true) {
    try {
      STATE.lastBlock = await provider.getBlockNumber();
      await scanOnce(provider, arb, wallet);
    } catch (e) {
      log("error", "loop error", { err: e.message || String(e) });
    }
    await sleep(CFG.pollMs);
  }
}

const once = process.argv.includes("--once");
mainLoop(once).catch((e) => {
  console.error("[keeper fatal]", e.message || e);
  process.exit(1);
});
