# dexy-peg-bots

USE (DexyUSD) peg defense bots + protocol analysis for Ergo.

Built after a 40-hour liveness failure on March 29, 2026 left the USE protocol frozen — no interventions, no LP exits, no minting. We triggered tracking98 manually, documented an arbitrageur sandwiching the intervention for 12 ERG, and built the tools so it doesn't happen again.

## Bots

| Bot | What it does |
|-----|-------------|
| `trigger-tracking98.mjs` | Triggers tracking98 box when LP rate < 98% of oracle. Prerequisite for intervention. |
| `98-intervention-bot.mjs` | Fires bank intervention — Bank buys USE from LP to restore peg. |

Both use Ergo node signing (`/wallet/transaction/sign` with `inputsRaw`) and **token-free fee box selection** to prevent accidental token burns.

```bash
# Setup
npm install
cp .env.example .env
# Edit .env with your node URL, API key, and wallet mnemonic

# Check status
node trigger-tracking98.mjs --check
node 98-intervention-bot.mjs --check

# Dry run (signs via node, doesn't submit)
node trigger-tracking98.mjs --dry-run
node 98-intervention-bot.mjs --dry-run

# Execute
node trigger-tracking98.mjs --execute
# Wait >20 blocks...
node 98-intervention-bot.mjs --execute
```

## Backtest

Historical simulation of SigUSD mixed reserve strategy across all major ERG crash cycles (2021-2026). Supports UIP-002.

**Key finding:** 30% ERG / 70% SigUSD holds **72% reserve ratio through 80%+ ERG crashes** where the current 100% ERG strategy falls to 1%.

See [`backtest/README.md`](backtest/README.md) for details.

## Protocol Analysis

| Document | Summary |
|----------|---------|
| [Liveness Report](docs/01-liveness-report.md) | 40-hour bot outage, frozen protocol, manual restoration |
| [Exploit Analysis](docs/02-exploit-analysis.md) | 8 vulnerability findings across 22 contracts |
| [Arbitrage Extraction](docs/03-arbitrage-extraction.md) | Wallet `9gE9Wm...` sandwiched intervention for 12 ERG |
| [UIP-001](docs/UIP-001-balancing-interventions.md) | Richie's proposal: LP-based intervention sizing |
| [UIP-002](docs/UIP-002-intervention-reform.md) | Intervention reform: 0.7% cap, operator fast-path, SigUSD mixed reserve (with backtest data) |

## Licenses

- **Bots** (`*.mjs`): [AGPL-3.0](LICENSE-AGPL)
- **Backtest & docs**: [MIT](LICENSE-MIT)

## Contributing

Run the bots. The more operators watching the tracking boxes, the less likely a 40-hour outage happens again. The bots are permissionless — anyone with an Ergo node and ~1 ERG for fees can operate them.
