"use strict";

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { CFG, log } = require("./config");
const { compileExecutor } = require("./compile");

async function main() {
  if (!CFG.keeperPk) throw new Error("Set KEEPER_PK in .env");
  if (!CFG.rpcUrl) throw new Error("Set RPC_URL in .env");

  const provider = new ethers.JsonRpcProvider(CFG.rpcUrl);
  const wallet = new ethers.Wallet(CFG.keeperPk, provider);
  const net = await provider.getNetwork();
  const bal = await provider.getBalance(wallet.address);

  log("info", "deploy starting", {
    chainId: net.chainId.toString(),
    deployer: wallet.address,
    eth: ethers.formatEther(bal),
    aavePool: CFG.aavePool,
  });

  if (bal < CFG.minNative) {
    throw new Error(
      `Deployer balance ${ethers.formatEther(bal)} ETH < MIN_NATIVE_RESERVE_ETH`
    );
  }
  if (CFG.chainId > 0n && BigInt(net.chainId) !== CFG.chainId) {
    throw new Error(`CHAIN_ID mismatch: env=${CFG.chainId} rpc=${net.chainId}`);
  }

  const { abi, bytecode } = compileExecutor();
  const factory = new ethers.ContractFactory(abi, bytecode, wallet);
  const routers = CFG.v2Routers;
  const tokens = [...new Set([CFG.flashAsset, CFG.wrappedNative, ...CFG.bootstrapTokens])];

  const arb = await factory.deploy(CFG.aavePool, wallet.address, routers, tokens);
  const receipt = await arb.deploymentTransaction().wait();
  const arbAddr = await arb.getAddress();

  if (await arb.paused()) {
    await (await arb.unpause()).wait();
  }

  const outDir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${net.chainId}.json`);
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        chainId: Number(net.chainId),
        address: arbAddr,
        deployer: wallet.address,
        aavePool: CFG.aavePool,
        routers,
        tokens,
        deployTx: receipt.hash,
        deployedAt: new Date().toISOString(),
      },
      null,
      2
    )
  );

  const envPath = path.join(__dirname, "..", ".env");
  if (fs.existsSync(envPath)) {
    let envText = fs.readFileSync(envPath, "utf8");
    if (/^ARB_CONTRACT=/m.test(envText)) {
      envText = envText.replace(/^ARB_CONTRACT=.*$/m, `ARB_CONTRACT=${arbAddr}`);
    } else {
      envText += `\nARB_CONTRACT=${arbAddr}\n`;
    }
    fs.writeFileSync(envPath, envText);
  }

  console.log(`\nDeployed ARB_CONTRACT=${arbAddr}\nSaved ${outPath}\n`);
}

main().catch((e) => {
  console.error("[deploy fatal]", e.message || e);
  process.exit(1);
});
