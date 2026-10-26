# flash-arb

**Atomic cross-DEX arbitrage on Ethereum, powered by Aave V3 flash loans.**

Borrow → route → repay → keep the spread — or the whole transaction reverts.  
No inventory required for the trade size. Gas is the only standing cost.

```
┌─────────────┐     flash      ┌──────────────────┐
│  Aave V3    │ ─────────────► │ ArbitrageExecutor│
│  Pool       │ ◄───────────── │  (your contract) │
└─────────────┘   repay+fee    └────────┬─────────┘
                                        │ hops
                          ┌─────────────┴─────────────┐
                          ▼                           ▼
                   Uniswap V2                    SushiSwap
```

---

## Why this exists

Most “arb bots” fail for one of three reasons: bad on-chain accounting, no simulation gate, or they send naked txs into the public mempool.

**flash-arb** is built around a single invariant:

> After every hop and the Aave premium,  
> `endingBalance ≥ balanceBefore + debt + minProfitAbs`  
> or the transaction **cannot** succeed.

That is not a promise of finding edge. It is a promise that a completed trade is not an unprofitable one.

---

## Architecture

| Layer | Role |
|-------|------|
| **`contracts/ArbitrageExecutor.sol`** | On-chain executor: whitelist, flash callback, V2/V3 hops, profit lock |
| **`keeper/`** | Off-chain searcher: discover pairs, quote, score economics, dry-run / live submit |
| **`simulation/`** | Offline math + organic mainnet scans (no keys required) |
| **`arb-proof/`** | Foundry mainnet-fork proofs — end-to-end flash loans against real Aave/Uni/Sushi |

### On-chain security model

1. **Executor / owner only** can call `startArbitrage`
2. **Router + token allowlists** — no arbitrary calls
3. **Route must start and end** on the flash asset
4. **Per-hop `minOut`** — early revert on slippage
5. **Global min-profit BPS** — final balance is the source of truth
6. **30s execution window** inside the Aave callback
7. **No native ETH** — `receive` / `fallback` revert
8. **24h timelock** on emergency profit withdrawal

### Keeper pipeline (every scan)

```
pairs → 2-hop cycles → reserve pre-screen (≤1% impact)
     → router quotes → cumulative slippage minOut
     → Aave premium + gas in asset units
     → profitBps gate
     → eth_call simulation (if contract deployed)
     → DRY_RUN log  |  LIVE submit (opt-in only)
```

---

## Quick start

```bash
git clone https://github.com/Gideon-Dadey/flash-arb.git
cd flash-arb
cp .env.example .env
npm install
```

### 1. Watch the market (no wallet)

```bash
npm run keeper:once    # one scan
npm run keeper         # continuous loop
```

You will mostly see `no profitable route`. That is a healthy market, not a broken bot.

### 2. Prove the contract (Foundry)

```bash
# requires Foundry: https://book.getfoundry.sh/getting-started/installation
npm run test:forge
```

Fork proofs manufacture a Uni/Sushi dislocation, flash USDC from real Aave V3, execute the route, and assert net profit on-chain. **7/7 tests.**

### 3. Deploy

1. Dedicated hot wallet with ~0.05–0.2 ETH for gas  
2. Set `KEEPER_PK` + a reliable `RPC_URL` in `.env`  
3. Deploy:

```bash
npm run deploy
```

`ARB_CONTRACT` is written into `.env` automatically.

### 4. Arm live (explicit)

```env
DRY_RUN=false
LIVE_FORCE=true
USE_FLASHBOTS=true
```

```bash
npm run keeper
```

Live mode refuses to fire unless **both** flags are set. Prefer Flashbots. Public mempool is sandwich territory.

---

## Commands

| Command | What it does |
|---------|----------------|
| `npm run keeper:once` | Single scan — quote only unless live-armed |
| `npm run keeper` | Continuous searcher loop |
| `npm run deploy` | Compile + deploy `ArbitrageExecutor` |
| `npm run test:forge` | Mainnet-fork proof suite |
| `npm run sim:mock` | Synthetic reserves, real keeper math |
| `npm run sim:mainnet` | Organic 2-hop spread check (read-only) |

---

## Configuration

Copy `.env.example` → `.env`. Never commit secrets.

| Variable | Purpose | Safe default |
|----------|---------|--------------|
| `DRY_RUN` | Block all trade submissions | `true` |
| `LIVE_FORCE` | Second key required for live | `false` |
| `USE_FLASHBOTS` | Private bundle path | `false` until live |
| `ALLOW_PUBLIC_MEMPOOL` | Public send (risky) | `false` |
| `FLASH_ASSET` | Borrowed token (USDC) | mainnet USDC |
| `FLASH_AMOUNT` | Loan size (token decimals) | `20000000000` (20k USDC) |
| `MIN_PROFIT_BPS_LOCAL` | Keeper net profit floor | `50` (0.50%) |
| `ROUTE_SLIPPAGE_BPS` | Cumulative slippage haircut | `30` |
| `POLL_INTERVAL_MS` | Scan cadence | `12000` |
| `MIN_NATIVE_RESERVE_ETH` | Gas floor before deploy/live | `0.02` |

Full list: [`.env.example`](./.env.example).

---

## Repository layout

```
flash-arb/
├── contracts/ArbitrageExecutor.sol   # source of truth
├── keeper/
│   ├── keeper.js                     # searcher loop
│   ├── deploy.js                     # mainnet deploy
│   ├── compile.js                    # solc 0.8.21
│   └── config.js                     # env → CFG
├── simulation/
│   ├── profit_simulation.js          # --mock / --mainnet
│   └── build/                        # keeper math helpers
├── arb-proof/                        # Foundry fork tests
├── deployments/                      # written by deploy.js
└── .env.example
```

---

## Mental model: what profit actually is

```
gross   = final flash-asset out − flash amount
net     = gross − Aave premium − gas (in asset terms)
accept  ↔ net / flash ≥ MIN_PROFIT_BPS_LOCAL
          AND eth_call(startArbitrage) succeeds
          AND (if live) bundle/sim gates pass
```

Flash loans remove capital lockup. They do **not** remove:

- gas burn on failed attempts  
- competition from colocated searchers  
- the fact that liquid Uni↔Sushi 2-hop edges are usually already closed  

Treat this as **infrastructure**, not a yield product.

---

## Operating doctrine

| Do | Don't |
|----|-------|
| Start in `DRY_RUN` for days | Paste `KEEPER_PK` into chat or commits |
| Use a dedicated gas wallet | Fund with money you can't lose |
| Prefer Flashbots for live | Blind-send to public mempool |
| Size flash loans for ≤1% impact | Max-size every opportunity |
| Withdraw profits deliberately | Expect free money from idle scans |

Profit that lands sits **on the contract**. Owner withdraws via `emergencyProfitWithdraw` after the unlock period.

---

## Stack

- Solidity `^0.8.21`
- Aave V3 Pool (mainnet)
- Uniswap V2 + SushiSwap routers
- Node.js + ethers v6
- Foundry (fork proofs)
- Optional Flashbots relay

---

## License

MIT — see repository license terms.

---

**Built to be correct under failure.**  
If the route is wrong, the chain reverts. If the edge is gone, the keeper stays silent. That silence is the feature.
