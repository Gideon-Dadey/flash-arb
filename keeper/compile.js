"use strict";

const fs = require("fs");
const path = require("path");
const solc = require("solc");

function compileExecutor() {
  const solPath = path.join(__dirname, "..", "contracts", "ArbitrageExecutor.sol");
  if (!fs.existsSync(solPath)) throw new Error(`Missing ${solPath}`);

  const input = {
    language: "Solidity",
    sources: { "ArbitrageExecutor.sol": { content: fs.readFileSync(solPath, "utf8") } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "paris",
      outputSelection: { "*": { "*": ["abi", "evm.bytecode"] } },
    },
  };

  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (out.errors || []).filter((e) => e.severity === "error");
  if (errors.length) throw new Error("solc:\n" + errors.map((e) => e.formattedMessage).join("\n"));

  const c = out.contracts["ArbitrageExecutor.sol"].ArbitrageExecutor;
  if (!c?.evm?.bytecode?.object) throw new Error("bytecode missing");
  return { abi: c.abi, bytecode: "0x" + c.evm.bytecode.object };
}

module.exports = { compileExecutor };
