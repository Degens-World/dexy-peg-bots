# USE Protocol — SigUSD Mixed Reserve Backtest

Quantitative analysis supporting UIP-002's reserve diversification recommendation.

## Quick Start

```bash
# Install deps
pip install pandas numpy matplotlib seaborn requests

# Run full backtest (all 7 phases)
python reserve_backtest.py

# Run single phase
python reserve_backtest.py --phase 3
```

## Data

Place in `data/` before running:

| File | Source | Size | How to get |
|------|--------|------|-----------|
| `erg-usd-max.csv` | CoinGecko | ~200KB | Export from coingecko.com (ERG max history) |
| `block_timestamps_master.csv` | Ergo chain | ~86MB | Not in this repo (too large). See dedicated block timestamps repo |
| `sigmausd_erg_balance.csv` | ergo.watch | ~570KB | Auto-fetched on first run (cached) |
| `sigmausd_sigusd_balance.csv` | ergo.watch | ~284KB | Auto-fetched on first run (cached) |

## Results

| File | Description |
|------|-------------|
| `hedge_effectiveness.csv` | **Key table** — reserve ratio by drawdown bucket × strategy |
| `sensitivity_grid.csv` | 48-point parameter sweep (SigUSD fraction × trigger ratio × regime) |
| `accumulation_roadmap.json` | From-today path to 70% SigUSD target |
| `accumulation_windows.csv` | SigUSD mint window availability by year |
| `drawdown_episodes.csv` | ERG drawdown episodes > 30% |
| `reserve_ratio_daily.csv` | Daily reserve ratio for all simulations |

## Key Finding

**30% ERG / 70% SigUSD** holds 72% reserve ratio through 80%+ ERG crashes
where the current 100% ERG strategy falls to 1%.
