"use strict";

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const { ethers } = require("ethers");

const env = (n, f = "") => {
  const v = process.env[n];
  return v == null || String(v).trim() === "" ? f : String(v).trim();
};
const envBool = (n, f) => {
  const v = process.env[n];
  return v === undefined ? f : String(v).toLowerCase() === "true";
};
const envInt = (n, f) => {
  const v = process.env[n];
  if (v === undefined || v === "") return f;
  const p = Number(v);
  if (!Number.isFinite(p)) throw new Error(`${n} must be numeric`);
  return p;
};
const splitAddr = (v) =>
  v
    ? v
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean)
        .map((a) => ethers.getAddress(a))
    : [];

const CFG = {
  rpcUrl: env("RPC_URL", "https://ethereum-rpc.publicnode.com"),
  wsUrl: env("WS_RPC_URL", ""),
  keeperPk: env("KEEPER_PK", ""),
  arbContract: env("ARB_CONTRACT", ""),
  flashAsset: env("FLASH_ASSET", "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"),
  flashAmount: env("FLASH_AMOUNT", "20000000000"),
  wrappedNative: env("WRAPPED_NATIVE", "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"),
  chainId: BigInt(env("CHAIN_ID", "1")),
  aavePool: env("AAVE_POOL", "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2"),

  dryRun: envBool("DRY_RUN", true),
  liveForce: envBool("LIVE_FORCE", false),
  allowPublicMempool: envBool("ALLOW_PUBLIC_MEMPOOL", false),
  useFlashbots: envBool("USE_FLASHBOTS", false),
  flashbotsRelay: env("FLASHBOTS_RELAY", "https://relay.flashbots.net"),

  minProfitBps: envInt("MIN_PROFIT_BPS_LOCAL", 50),
  slippageBps: envInt("ROUTE_SLIPPAGE_BPS", 30),
  pollMs: envInt("POLL_INTERVAL_MS", 12000),
  maxGasBpsOfTrade: envInt("MAX_GAS_BPS_OF_TRADE", 80),
  minNative: ethers.parseEther(env("MIN_NATIVE_RESERVE_ETH", "0.02")),
  deadlineSec: envInt("DEADLINE_SECONDS", 60),

  v2Factories: splitAddr(
    env(
      "V2_FACTORIES",
      "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f,0xC0AEe478e3658e2610c5F7A4A2E1777cE9e4f2Ac"
    )
  ),
  v2Routers: splitAddr(
    env(
      "V2_ROUTERS",
      "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D,0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F"
    )
  ),
  stablecoins: splitAddr(
    env(
      "STABLECOINS",
      "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48,0x6B175474E89094C44Da98b954EedeAC495271d0F,0xdAC17F958D2ee523a2206206994597C13D831ec7"
    )
  ),
  bootstrapTokens: splitAddr(
    env(
      "BOOTSTRAP_TOKENS",
      "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2,0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48,0x6B175474E89094C44Da98b954EedeAC495271d0F"
    )
  ),
};

function canSubmitLive() {
  return !CFG.dryRun && CFG.liveForce === true;
}

function log(level, msg, meta = {}) {
  console.log(JSON.stringify({ t: new Date().toISOString(), level, msg, ...meta }));
}

module.exports = { CFG, canSubmitLive, log, env, envBool, envInt, splitAddr };
