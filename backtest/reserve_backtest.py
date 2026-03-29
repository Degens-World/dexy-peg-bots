"""
USE Protocol — SigUSD Mixed Reserve Backtest
=============================================

Backtests the proposed SigUSD mixed reserve strategy (UIP-002) for the USE
stablecoin protocol across historical ERG price data.

Compares 4 reserve strategies × 2 intervention regimes (current vs UIP-001)
across hypothetical USE existence since SigmaUSD launch (May 2021) and
real calibration window (Dec 2025 → present).

Data inputs (in backtest/data/):
  - erg-usd-max.csv          — CoinGecko daily ERG/USD prices
  - sigmausd_erg_balance.csv  — SigmaUSD contract ERG balance (ergo.watch)
  - sigmausd_sigusd_balance.csv — SigmaUSD contract SigUSD token balance
  - block_timestamps.csv      — height ↔ timestamp mapping

Usage:
  python reserve_backtest.py              # Run all phases
  python reserve_backtest.py --phase 1    # Run specific phase
"""

import os
import sys
import csv
import numpy as np
import pandas as pd
from datetime import datetime, timezone
from pathlib import Path

# ===== Paths ===== #

BASE_DIR = Path(__file__).parent
DATA_DIR = BASE_DIR / "data"
RESULTS_DIR = BASE_DIR / "results"
RESULTS_DIR.mkdir(exist_ok=True)

# Reuse CoinGecko loader from existing pool-backtest
sys.path.insert(0, str(Path("/home/cq/p2p-options-contracts/pool-backtest")))
try:
    from data_loader import load_coingecko
except ImportError:
    # Fallback inline loader if import fails
    def load_coingecko(path, start_date="2019-01-01"):
        df = pd.read_csv(path)
        df["date"] = pd.to_datetime(df["snapped_at"].str.replace(" UTC", "", regex=False))
        df = df.sort_values("date").reset_index(drop=True)
        df = df[df["date"] >= start_date].reset_index(drop=True)
        df = df.rename(columns={"price": "close", "total_volume": "volume"})
        return df[["date", "close", "volume"]].copy()

# ===== Constants ===== #

# SigmaUSD thresholds
SIGUSD_MINT_THRESHOLD = 4.0     # Ratio > 400% to mint SigUSD via contract
SIGUSD_REDEEM_FLOOR = 1.0       # Ratio > 100% to redeem (never breached)
SIGUSD_REDEMPTION_FEE = 0.0225  # 2.25% (2% to reserves + 0.25% frontend)
SIGUSD_DEX_FEE = 0.003          # 0.3% Spectrum LP swap fee
SIGUSD_DEX_SLIPPAGE = 0.015     # ~1.5% avg slippage for $1K daily buys

# SigUSD token total emission (raw units, 2 decimals)
SIGUSD_TOTAL_EMISSION = 10_000_000_000_000  # 100 billion base units

# USE protocol parameters
USE_BOOTSTRAP_ERG = 215_579          # ERG at bootstrap
USE_BOOTSTRAP_OUTSTANDING = 116_017  # USE in circulation
USE_BOOTSTRAP_PRICE = 0.54           # Approx ERG/USD at bootstrap (Dec 2025)
USE_BOOTSTRAP_RATIO = 1.10           # 110% reserve ratio

# Intervention parameters
INTERVENTIONS_PER_DAY_CURRENT = 2    # 360 blocks ≈ 12 hrs → 2/day max
INTERVENTIONS_PER_DAY_UIP001 = 4     # 180 blocks ≈ 6 hrs → 4/day max

# Accumulation parameters
SIGUSD_ACCUMULATION_RATE = 0.001     # 0.1% of ERG reserves converted per day (contract mint)
SIGUSD_DEX_DAILY_USD = 1000          # $1K/day DEX buys when contract mint blocked
SIGUSD_DEX_POOL_SIGUSD = 79_532      # Current DEX pool depth (SigUSD side)

# MewFinance SigUSD/ERG pool
MEWFINANCE_POOL_NFT = "9916d75132593c8b07fe18bd8d583bda1652eed7565cf41a4738ddd90fc992ec"


# ===== Data Loading ===== #

def load_erg_prices():
    """Load daily ERG/USD prices from CoinGecko CSV."""
    path = DATA_DIR / "erg-usd-max.csv"
    df = load_coingecko(str(path), start_date="2019-01-01")
    df["date"] = pd.to_datetime(df["date"]).dt.tz_localize(None)
    return df[["date", "close"]].rename(columns={"close": "erg_price"})


def load_block_timestamps():
    """Load height ↔ timestamp mapping. 1.75M rows — sample to daily for speed."""
    # Try both filenames
    for fname in ["block_timestamps_master.csv", "block_timestamps.csv"]:
        path = DATA_DIR / fname
        if path.exists():
            break
    else:
        raise FileNotFoundError("Missing block_timestamps_master.csv or block_timestamps.csv")

    print(f"  Loading {path.name} (large file, sampling to daily)...")
    df = pd.read_csv(path, usecols=["height", "timestamp_ms"])
    df["date"] = pd.to_datetime(df["timestamp_ms"], unit="ms", utc=True).dt.tz_localize(None)

    # Sample to ~daily resolution (every 720 blocks) for speed
    df_daily = df.iloc[::720].copy().reset_index(drop=True)
    # Also include the last row
    if df_daily["height"].iloc[-1] != df["height"].iloc[-1]:
        df_daily = pd.concat([df_daily, df.iloc[[-1]]], ignore_index=True)

    return df_daily[["height", "date"]].sort_values("height").reset_index(drop=True)


def load_sigmausd_history():
    """Load SigmaUSD on-chain balance history and merge with dates."""
    erg_df = pd.read_csv(DATA_DIR / "sigmausd_erg_balance.csv")
    sig_df = pd.read_csv(DATA_DIR / "sigmausd_sigusd_balance.csv")

    # Both are indexed by height (descending from API). Sort ascending.
    erg_df = erg_df.sort_values("height").reset_index(drop=True)
    sig_df = sig_df.sort_values("height").reset_index(drop=True)

    return erg_df, sig_df


def build_daily_sigmausd(erg_bal_df, sig_bal_df, block_ts_df, erg_prices_df):
    """
    Build daily SigmaUSD state by joining balance history with dates and ERG prices.
    Returns DataFrame with: date, erg_in_contract, sigusd_circulating, erg_price, reserve_ratio
    """
    # Map heights to dates using block_timestamps
    # For each balance height, find the nearest block timestamp
    ts_lookup = block_ts_df.set_index("height")["date"]

    def height_to_date(h):
        # Find nearest height in lookup
        idx = ts_lookup.index.searchsorted(h)
        if idx >= len(ts_lookup):
            idx = len(ts_lookup) - 1
        return ts_lookup.iloc[idx]

    # Sample at daily resolution: take one data point per day
    # Use the ERG balance data (denser) as the primary timeline
    erg_bal_df = erg_bal_df.copy()
    erg_bal_df["date"] = erg_bal_df["height"].apply(height_to_date)
    erg_bal_df["date"] = erg_bal_df["date"].dt.normalize()
    erg_daily = erg_bal_df.groupby("date").last().reset_index()

    sig_bal_df = sig_bal_df.copy()
    sig_bal_df["date"] = sig_bal_df["height"].apply(height_to_date)
    sig_bal_df["date"] = sig_bal_df["date"].dt.normalize()
    sig_daily = sig_bal_df.groupby("date").last().reset_index()

    # Merge ERG and SigUSD balances
    daily = pd.merge(erg_daily[["date", "erg_balance_nano"]],
                     sig_daily[["date", "sigusd_balance_raw"]],
                     on="date", how="outer").sort_values("date")
    daily = daily.ffill().dropna()

    # Compute derived columns
    daily["erg_in_contract"] = daily["erg_balance_nano"].astype(float) / 1e9
    # SigUSD circulating = total emission - amount in contract
    # SigUSD has 2 decimals: raw / 100 = human-readable SigUSD (≈ USD)
    daily["sigusd_circulating"] = (SIGUSD_TOTAL_EMISSION - daily["sigusd_balance_raw"].astype(float)) / 100.0

    # Merge with ERG prices
    erg_prices_df = erg_prices_df.copy()
    erg_prices_df["date"] = erg_prices_df["date"].dt.normalize()
    daily = pd.merge(daily, erg_prices_df, on="date", how="left")
    daily["erg_price"] = daily["erg_price"].ffill()
    daily = daily.dropna(subset=["erg_price"])

    # Reserve ratio
    daily["reserves_usd"] = daily["erg_in_contract"] * daily["erg_price"]
    daily["reserve_ratio"] = daily["reserves_usd"] / daily["sigusd_circulating"].clip(lower=1)

    return daily[["date", "erg_in_contract", "sigusd_circulating", "erg_price",
                   "reserves_usd", "reserve_ratio"]].reset_index(drop=True)


# ===== Phase 1: ERG Drawdown Analysis ===== #

def phase1_drawdowns(erg_prices):
    """Identify ERG drawdown episodes."""
    print("\n" + "=" * 60)
    print("PHASE 1: ERG DRAWDOWN ANALYSIS")
    print("=" * 60)

    df = erg_prices.copy()
    df["ath"] = df["erg_price"].cummax()
    df["drawdown_pct"] = (df["erg_price"] - df["ath"]) / df["ath"]

    # Identify episodes > 30% drawdown
    episodes = []
    in_episode = False
    ep_start = None
    ep_peak = None
    ep_trough_price = None
    ep_trough_date = None

    for _, row in df.iterrows():
        if row["drawdown_pct"] < -0.30:
            if not in_episode:
                in_episode = True
                ep_start = row["date"]
                ep_peak = row["ath"]
                ep_trough_price = row["erg_price"]
                ep_trough_date = row["date"]
            if row["erg_price"] < ep_trough_price:
                ep_trough_price = row["erg_price"]
                ep_trough_date = row["date"]
        else:
            if in_episode:
                max_dd = (ep_trough_price - ep_peak) / ep_peak
                duration = (ep_trough_date - ep_start).days
                episodes.append({
                    "start": ep_start.strftime("%Y-%m-%d"),
                    "trough": ep_trough_date.strftime("%Y-%m-%d"),
                    "end": row["date"].strftime("%Y-%m-%d"),
                    "peak_price": round(ep_peak, 4),
                    "trough_price": round(ep_trough_price, 4),
                    "max_drawdown_pct": round(max_dd * 100, 1),
                    "duration_days": duration,
                })
                in_episode = False

    # Handle ongoing episode
    if in_episode:
        max_dd = (ep_trough_price - ep_peak) / ep_peak
        episodes.append({
            "start": ep_start.strftime("%Y-%m-%d"),
            "trough": ep_trough_date.strftime("%Y-%m-%d"),
            "end": "ongoing",
            "peak_price": round(ep_peak, 4),
            "trough_price": round(ep_trough_price, 4),
            "max_drawdown_pct": round(max_dd * 100, 1),
            "duration_days": (ep_trough_date - ep_start).days,
        })

    ep_df = pd.DataFrame(episodes)
    ep_df.to_csv(RESULTS_DIR / "drawdown_episodes.csv", index=False)

    print(f"\nFound {len(episodes)} drawdown episodes > 30%:")
    for ep in episodes:
        print(f"  {ep['start']} → {ep['trough']} | {ep['max_drawdown_pct']}% | "
              f"${ep['peak_price']} → ${ep['trough_price']} | {ep['duration_days']}d")

    # Also save daily drawdown data
    df[["date", "erg_price", "ath", "drawdown_pct"]].to_csv(
        RESULTS_DIR / "erg_drawdown_daily.csv", index=False)

    return df


# ===== Phase 2: SigmaRSV Reserve Ratio ===== #

def phase2_sigmausd_ratio(sigmausd_daily):
    """Analyze SigmaRSV reserve ratio history."""
    print("\n" + "=" * 60)
    print("PHASE 2: SIGMAUSD RESERVE RATIO RECONSTRUCTION")
    print("=" * 60)

    df = sigmausd_daily.copy()
    df["mint_available"] = df["reserve_ratio"] > SIGUSD_MINT_THRESHOLD
    df["redeem_available"] = df["reserve_ratio"] > SIGUSD_REDEEM_FLOOR

    df.to_csv(RESULTS_DIR / "sigmausd_ratio_daily.csv", index=False)

    print(f"\nDate range: {df['date'].min().strftime('%Y-%m-%d')} → {df['date'].max().strftime('%Y-%m-%d')}")
    print(f"Data points: {len(df)}")
    print(f"Current ratio: {df['reserve_ratio'].iloc[-1]:.1%}")
    print(f"Min ratio: {df['reserve_ratio'].min():.1%} ({df.loc[df['reserve_ratio'].idxmin(), 'date'].strftime('%Y-%m-%d')})")
    print(f"Max ratio: {df['reserve_ratio'].max():.1%}")
    print(f"Days > 400%: {df['mint_available'].sum()} ({df['mint_available'].mean():.1%})")
    print(f"Days < 100%: {(~df['redeem_available']).sum()}")

    return df


# ===== Phase 3: USE Bank Reserve Simulation ===== #

class UseBankSim:
    """Simulate USE Bank reserves under different strategies."""

    def __init__(self, erg_reserves, sigusd_reserves, use_outstanding,
                 erg_price, intervention_regime="current"):
        self.erg_reserves = erg_reserves
        self.sigusd_reserves = sigusd_reserves  # USD value
        self.use_outstanding = use_outstanding
        self.erg_price = erg_price
        self.regime = intervention_regime

        # LP state (simplified: assume LP holds ~60% of circulating USE in ERG equivalent)
        self.lp_erg = erg_reserves * 1.2  # LP typically larger than Bank

    @property
    def total_reserves_usd(self):
        return (self.erg_reserves * self.erg_price) + self.sigusd_reserves

    @property
    def reserve_ratio(self):
        if self.use_outstanding <= 0:
            return 999.0
        return self.total_reserves_usd / self.use_outstanding

    def interventions_per_day(self):
        if self.regime == "current":
            return INTERVENTIONS_PER_DAY_CURRENT
        else:
            return INTERVENTIONS_PER_DAY_UIP001

    def intervention_size_erg(self):
        """ERG to spend per intervention."""
        if self.regime == "current":
            return self.erg_reserves * 0.01  # 1% of Bank
        else:
            return self.lp_erg * 0.005  # 0.5% of LP (UIP-001)

    def step(self, new_erg_price, prev_erg_price, sigmausd_ratio,
             sigusd_fraction_target, trigger_ratio=0.85):
        """
        Advance one day. Returns dict of state.

        Intervention trigger: The real protocol fires when LP rate < 98% of oracle.
        LP rate diverges from oracle when there's active selling pressure on USE,
        which correlates with rapid ERG price drops (not slow grinds).

        Model: intervention fires when the daily ERG price drop exceeds ~2%
        (proxy for LP drifting below 98% of oracle) AND reserve ratio is declining.
        On-chain data shows ~42 interventions in 113 days — roughly 1 every 2.7 days
        during the Dec 2025 → Mar 2026 period.
        """
        self.erg_price = new_erg_price
        self.lp_erg = self.erg_reserves * 1.2

        # Minting fee income: 0.3% of daily minting volume → Bank
        # Real data: ~500 USE minted per day average → 1.5 USE worth of ERG
        # Simplified: Bank gains ~0.001% of reserves per day from fees
        fee_income_erg = self.erg_reserves * 0.00001  # conservative daily fee income
        self.erg_reserves += fee_income_erg

        # Intervention trigger: daily ERG price drop > 2% (proxy for LP < 98% oracle)
        daily_return = (new_erg_price - prev_erg_price) / prev_erg_price if prev_erg_price > 0 else 0
        interventions_today = 0

        if daily_return < -0.02 and self.reserve_ratio < 1.5:
            # Price dropped sharply — LP likely below 98%, intervention fires
            max_interventions = min(self.interventions_per_day(), 1)  # typically 1/day
            for _ in range(max_interventions):
                erg_to_spend = self.intervention_size_erg()

                use_sigusd = (self.reserve_ratio < trigger_ratio and
                              self.sigusd_reserves > 0 and
                              sigmausd_ratio > SIGUSD_REDEEM_FLOOR)

                if use_sigusd:
                    sigusd_to_spend = min(
                        erg_to_spend * self.erg_price,
                        self.sigusd_reserves
                    )
                    self.sigusd_reserves -= sigusd_to_spend
                else:
                    erg_to_spend = min(erg_to_spend, self.erg_reserves * 0.5)
                    self.erg_reserves -= erg_to_spend

                interventions_today += 1

        # SigUSD accumulation — two paths, always available
        current_sigusd_frac = self.sigusd_reserves / max(self.total_reserves_usd, 1)
        if current_sigusd_frac < sigusd_fraction_target and self.erg_reserves > 0:
            if sigmausd_ratio > SIGUSD_MINT_THRESHOLD:
                # Path 1: Contract mint (cheaper, larger amounts)
                # 0.1% of reserves/day, 2.25% fee
                erg_to_convert = self.erg_reserves * SIGUSD_ACCUMULATION_RATE
                usd_value = erg_to_convert * self.erg_price * (1 - SIGUSD_REDEMPTION_FEE)
                self.erg_reserves -= erg_to_convert
                self.sigusd_reserves += usd_value
                accum_path = "contract"
            else:
                # Path 2: DEX buy (available anytime, limited by liquidity)
                # ~$1K/day, ~1.8% total cost (0.3% fee + ~1.5% slippage)
                daily_buy_usd = min(SIGUSD_DEX_DAILY_USD,
                                    self.erg_reserves * self.erg_price * 0.01)  # max 1% of reserves
                erg_cost = daily_buy_usd / self.erg_price if self.erg_price > 0 else 0
                sigusd_received = daily_buy_usd * (1 - SIGUSD_DEX_FEE - SIGUSD_DEX_SLIPPAGE)
                if erg_cost <= self.erg_reserves:
                    self.erg_reserves -= erg_cost
                    self.sigusd_reserves += sigusd_received
                    accum_path = "dex"
                else:
                    accum_path = "none"
        else:
            accum_path = "none"

        return {
            "erg_reserves": self.erg_reserves,
            "sigusd_reserves": self.sigusd_reserves,
            "total_usd": self.total_reserves_usd,
            "reserve_ratio": self.reserve_ratio,
            "interventions": interventions_today,
            "accum_path": accum_path,
        }


def run_simulation(erg_prices, sigmausd_ratios, strategy, regime, window_start, window_end=None):
    """
    Run a single simulation.

    strategy: dict with 'name', 'sigusd_frac', 'trigger_ratio'
    regime: 'current' or 'uip001'
    """
    # Filter price data to window
    mask = erg_prices["date"] >= window_start
    if window_end:
        mask &= erg_prices["date"] <= window_end
    prices = erg_prices[mask].copy().reset_index(drop=True)

    if len(prices) == 0:
        return pd.DataFrame()

    # Bootstrap USE Bank at window start
    start_price = prices["erg_price"].iloc[0]
    use_outstanding = 100_000  # Normalized to $100K outstanding
    target_ratio = USE_BOOTSTRAP_RATIO
    total_usd = use_outstanding * target_ratio  # 110% of outstanding

    erg_frac = 1.0 - strategy["sigusd_frac"]
    erg_reserves = (total_usd * erg_frac) / start_price
    sigusd_reserves = total_usd * strategy["sigusd_frac"]

    sim = UseBankSim(erg_reserves, sigusd_reserves, use_outstanding,
                     start_price, intervention_regime=regime)

    # Merge sigmausd ratios with price dates
    # For each day, find the closest sigmausd ratio
    sig_ratio_series = sigmausd_ratios.set_index("date")["reserve_ratio"]

    results = []
    prev_price = prices["erg_price"].iloc[0]
    for _, row in prices.iterrows():
        date = row["date"]
        sig_ratio_idx = sig_ratio_series.index.searchsorted(date)
        if sig_ratio_idx >= len(sig_ratio_series):
            sig_ratio_idx = len(sig_ratio_series) - 1
        sig_ratio = sig_ratio_series.iloc[sig_ratio_idx]

        state = sim.step(row["erg_price"], prev_price, sig_ratio,
                        strategy["sigusd_frac"], strategy.get("trigger_ratio", 0.85))
        prev_price = row["erg_price"]

        results.append({
            "date": date,
            "erg_price": row["erg_price"],
            "strategy": strategy["name"],
            "regime": regime,
            "sigmausd_ratio": sig_ratio,
            **state
        })

    return pd.DataFrame(results)


def phase3_simulation(erg_prices, sigmausd_daily):
    """Run all simulation scenarios."""
    print("\n" + "=" * 60)
    print("PHASE 3: USE BANK RESERVE SIMULATION")
    print("=" * 60)

    strategies = [
        {"name": "A_100pct_erg", "sigusd_frac": 0.0, "trigger_ratio": 0.85},
        {"name": "B_70_30", "sigusd_frac": 0.30, "trigger_ratio": 0.85},
        {"name": "C_50_50", "sigusd_frac": 0.50, "trigger_ratio": 0.85},
        {"name": "D_30_70", "sigusd_frac": 0.70, "trigger_ratio": 0.85},
    ]

    regimes = ["current", "uip001"]

    # Simulation windows
    windows = [
        ("hypothetical_full", "2021-06-01", None),       # Full SigmaUSD era
        ("hypothetical_ath", "2021-11-01", "2022-07-01"), # ATH crash cycle
        ("hypothetical_luna", "2022-03-01", "2022-12-01"),# Luna crash
        ("real_calibration", "2025-12-01", None),         # Real USE
    ]

    all_results = []
    for window_name, start, end in windows:
        print(f"\n  Window: {window_name} ({start} → {end or 'present'})")
        for regime in regimes:
            for strategy in strategies:
                result = run_simulation(erg_prices, sigmausd_daily,
                                       strategy, regime, start, end)
                if len(result) > 0:
                    result["window"] = window_name
                    all_results.append(result)
                    final_ratio = result["reserve_ratio"].iloc[-1]
                    min_ratio = result["reserve_ratio"].min()
                    print(f"    {regime:8s} | {strategy['name']:15s} | "
                          f"final={final_ratio:.1%} min={min_ratio:.1%}")

    combined = pd.concat(all_results, ignore_index=True)
    combined.to_csv(RESULTS_DIR / "reserve_ratio_daily.csv", index=False)
    print(f"\n  Saved {len(combined)} rows to reserve_ratio_daily.csv")
    return combined


# ===== Phase 4: Hedge Effectiveness ===== #

def phase4_hedge_effectiveness(sim_results, erg_drawdowns, sigmausd_daily):
    """Compute hedge effectiveness by drawdown bucket."""
    print("\n" + "=" * 60)
    print("PHASE 4: HEDGE EFFECTIVENESS BY DRAWDOWN BUCKET")
    print("=" * 60)

    buckets = [
        (0, -0.10, "0-10%"),
        (-0.10, -0.25, "10-25%"),
        (-0.25, -0.40, "25-40%"),
        (-0.40, -0.60, "40-60%"),
        (-0.60, -0.80, "60-80%"),
        (-0.80, -1.00, "80%+"),
    ]

    # Merge drawdown data with simulation results
    dd = erg_drawdowns[["date", "drawdown_pct"]].copy()
    dd["date"] = dd["date"].dt.normalize()

    results = []
    for regime in ["current", "uip001"]:
        for bkt_lo, bkt_hi, bkt_name in buckets:
            # Find dates in this drawdown bucket
            mask = (dd["drawdown_pct"] >= bkt_hi) & (dd["drawdown_pct"] < bkt_lo)
            bucket_dates = set(dd[mask]["date"])

            if not bucket_dates:
                continue

            # For each strategy, compute mean reserve ratio on these dates
            for strategy in ["A_100pct_erg", "B_70_30", "C_50_50", "D_30_70"]:
                strat_data = sim_results[
                    (sim_results["strategy"] == strategy) &
                    (sim_results["regime"] == regime) &
                    (sim_results["window"] == "hypothetical_full")
                ]
                if len(strat_data) == 0:
                    continue

                in_bucket = strat_data[strat_data["date"].isin(bucket_dates)]
                if len(in_bucket) == 0:
                    continue

                # SigmaUSD availability during these dates
                sig_dates = sigmausd_daily[sigmausd_daily["date"].isin(bucket_dates)]

                results.append({
                    "regime": regime,
                    "drawdown_bucket": bkt_name,
                    "strategy": strategy,
                    "mean_reserve_ratio": round(in_bucket["reserve_ratio"].mean(), 4),
                    "min_reserve_ratio": round(in_bucket["reserve_ratio"].min(), 4),
                    "days_in_bucket": len(in_bucket),
                    "sigusd_mint_available_pct": round(
                        (sig_dates["reserve_ratio"] > SIGUSD_MINT_THRESHOLD).mean() * 100, 1
                    ) if len(sig_dates) > 0 else 0,
                    "sigusd_redeem_available_pct": round(
                        (sig_dates["reserve_ratio"] > SIGUSD_REDEEM_FLOOR).mean() * 100, 1
                    ) if len(sig_dates) > 0 else 0,
                })

    hedge_df = pd.DataFrame(results)
    hedge_df.to_csv(RESULTS_DIR / "hedge_effectiveness.csv", index=False)

    # Print summary table
    print("\n  Hypothetical full window, current regime:")
    current = hedge_df[hedge_df["regime"] == "current"]
    for bkt in ["0-10%", "10-25%", "25-40%", "40-60%", "60-80%", "80%+"]:
        row_data = current[current["drawdown_bucket"] == bkt]
        if len(row_data) == 0:
            continue
        line = f"  {bkt:8s} |"
        for strat in ["A_100pct_erg", "B_70_30", "C_50_50", "D_30_70"]:
            s = row_data[row_data["strategy"] == strat]
            if len(s) > 0:
                line += f" {s['mean_reserve_ratio'].iloc[0]:6.1%} |"
            else:
                line += f"   N/A  |"
        mint_avail = row_data["sigusd_mint_available_pct"].iloc[0] if len(row_data) > 0 else 0
        line += f" mint:{mint_avail:.0f}%"
        print(line)

    return hedge_df


# ===== Phase 5: Accumulation Windows ===== #

def phase5_accumulation(sigmausd_daily):
    """Analyze SigUSD accumulation window availability."""
    print("\n" + "=" * 60)
    print("PHASE 5: ACCUMULATION WINDOW ANALYSIS")
    print("=" * 60)

    df = sigmausd_daily.copy()
    df["mint_open"] = df["reserve_ratio"] > SIGUSD_MINT_THRESHOLD
    df["year"] = df["date"].dt.year

    yearly = []
    for year, ydf in df.groupby("year"):
        open_days = ydf["mint_open"].sum()
        closed_days = len(ydf) - open_days

        # Longest consecutive windows
        runs = ydf["mint_open"].astype(int).diff().fillna(0).abs().cumsum()
        if open_days > 0:
            longest_open = ydf[ydf["mint_open"]].groupby(runs[ydf["mint_open"].values]).size().max()
        else:
            longest_open = 0

        if closed_days > 0:
            longest_closed = ydf[~ydf["mint_open"]].groupby(runs[~ydf["mint_open"].values]).size().max()
        else:
            longest_closed = 0

        yearly.append({
            "year": year,
            "total_days": len(ydf),
            "days_above_400pct": open_days,
            "days_below_400pct": closed_days,
            "pct_open": round(open_days / len(ydf) * 100, 1),
            "longest_open_window": longest_open,
            "longest_closed_window": longest_closed,
        })

    acc_df = pd.DataFrame(yearly)
    acc_df.to_csv(RESULTS_DIR / "accumulation_windows.csv", index=False)

    print(f"\n{'Year':>6} | {'Open':>5} | {'Closed':>6} | {'%Open':>5} | {'Max Open':>8} | {'Max Closed':>10}")
    print("-" * 55)
    for _, row in acc_df.iterrows():
        print(f"{row['year']:>6} | {row['days_above_400pct']:>5} | "
              f"{row['days_below_400pct']:>6} | {row['pct_open']:>5.1f} | "
              f"{row['longest_open_window']:>8} | {row['longest_closed_window']:>10}")

    return acc_df


# ===== Phase 6: Sensitivity Analysis ===== #

def phase6_sensitivity(erg_prices, sigmausd_daily):
    """Grid search over key parameters."""
    print("\n" + "=" * 60)
    print("PHASE 6: SENSITIVITY ANALYSIS")
    print("=" * 60)

    sigusd_fracs = [0.2, 0.3, 0.4, 0.5, 0.6, 0.7]
    trigger_ratios = [0.90, 0.85, 0.80, 0.75]
    # Use hypothetical full window for sensitivity
    window_start = "2021-06-01"

    results = []
    total = len(sigusd_fracs) * len(trigger_ratios) * 2
    count = 0

    for regime in ["current", "uip001"]:
        for sf in sigusd_fracs:
            for tr in trigger_ratios:
                count += 1
                strategy = {
                    "name": f"sf{int(sf*100)}_tr{int(tr*100)}",
                    "sigusd_frac": sf,
                    "trigger_ratio": tr
                }
                result = run_simulation(erg_prices, sigmausd_daily,
                                       strategy, regime, window_start)
                if len(result) > 0:
                    results.append({
                        "regime": regime,
                        "sigusd_fraction": sf,
                        "trigger_ratio": tr,
                        "mean_ratio": round(result["reserve_ratio"].mean(), 4),
                        "min_ratio": round(result["reserve_ratio"].min(), 4),
                        "final_ratio": round(result["reserve_ratio"].iloc[-1], 4),
                        "days_below_100pct": (result["reserve_ratio"] < 1.0).sum(),
                    })

                if count % 10 == 0:
                    print(f"  {count}/{total} combinations...")

    sens_df = pd.DataFrame(results)
    sens_df.to_csv(RESULTS_DIR / "sensitivity_grid.csv", index=False)

    # Generate heatmap
    try:
        import matplotlib.pyplot as plt
        import seaborn as sns

        for regime in ["current", "uip001"]:
            rdf = sens_df[sens_df["regime"] == regime]
            pivot = rdf.pivot_table(values="min_ratio", index="trigger_ratio",
                                    columns="sigusd_fraction", aggfunc="first")

            fig, ax = plt.subplots(figsize=(10, 6))
            sns.heatmap(pivot, annot=True, fmt=".1%", cmap="RdYlGn",
                       center=1.0, ax=ax)
            ax.set_title(f"Min Reserve Ratio — {regime.upper()} Regime\n"
                        f"(Hypothetical USE, Jun 2021 → Present)")
            ax.set_xlabel("SigUSD Reserve Fraction")
            ax.set_ylabel("SigUSD Trigger Ratio")
            plt.tight_layout()
            plt.savefig(RESULTS_DIR / f"sensitivity_heatmap_{regime}.png", dpi=150)
            plt.close()
            print(f"  Saved heatmap: sensitivity_heatmap_{regime}.png")

    except ImportError:
        print("  matplotlib/seaborn not available — skipping heatmap")

    return sens_df


# ===== Main ===== #

def main():
    print("=" * 60)
    print("USE PROTOCOL — SIGUSD MIXED RESERVE BACKTEST")
    print("=" * 60)

    phase = int(sys.argv[2]) if len(sys.argv) > 2 and sys.argv[1] == "--phase" else 0

    # Load data
    print("\nLoading data...")
    erg_prices = load_erg_prices()
    print(f"  ERG prices: {len(erg_prices)} days ({erg_prices['date'].min().strftime('%Y-%m-%d')} → {erg_prices['date'].max().strftime('%Y-%m-%d')})")

    block_ts = load_block_timestamps()
    print(f"  Block timestamps: {len(block_ts)} entries")

    erg_bal, sig_bal = load_sigmausd_history()
    print(f"  SigmaUSD ERG balance: {len(erg_bal)} entries")
    print(f"  SigmaUSD SigUSD balance: {len(sig_bal)} entries")

    sigmausd_daily = build_daily_sigmausd(erg_bal, sig_bal, block_ts, erg_prices)
    print(f"  SigmaUSD daily: {len(sigmausd_daily)} days")
    print(f"  Current reserve ratio: {sigmausd_daily['reserve_ratio'].iloc[-1]:.1%}")

    if phase == 0 or phase == 1:
        drawdowns = phase1_drawdowns(erg_prices)
    else:
        drawdowns = erg_prices.copy()
        drawdowns["ath"] = drawdowns["erg_price"].cummax()
        drawdowns["drawdown_pct"] = (drawdowns["erg_price"] - drawdowns["ath"]) / drawdowns["ath"]

    if phase == 0 or phase == 2:
        sigmausd_ratio = phase2_sigmausd_ratio(sigmausd_daily)
    else:
        sigmausd_ratio = sigmausd_daily

    if phase == 0 or phase == 3:
        sim_results = phase3_simulation(erg_prices, sigmausd_daily)
    else:
        sim_results = None

    if phase == 0 or phase == 4:
        if sim_results is None:
            sim_results = pd.read_csv(RESULTS_DIR / "reserve_ratio_daily.csv",
                                      parse_dates=["date"])
        phase4_hedge_effectiveness(sim_results, drawdowns, sigmausd_daily)

    if phase == 0 or phase == 5:
        phase5_accumulation(sigmausd_daily)

    if phase == 0 or phase == 6:
        phase6_sensitivity(erg_prices, sigmausd_daily)

    if phase == 0 or phase == 7:
        phase7_accumulation_roadmap(sigmausd_daily)

    print("\n" + "=" * 60)
    print("COMPLETE — Results in backtest/results/")
    print("=" * 60)


# ===== Phase 7: Accumulation Roadmap from Today ===== #

def phase7_accumulation_roadmap(sigmausd_daily):
    """
    Model how to get from current state (0% SigUSD) to 70/30 target.
    Uses current real Bank state and shows timeline for DEX + contract accumulation.
    """
    print("\n" + "=" * 60)
    print("PHASE 7: 70/30 ACCUMULATION ROADMAP FROM TODAY")
    print("=" * 60)

    # Current real state
    bank_erg = 215_925          # ERG in Bank (post-intervention)
    erg_price = 0.28            # Current ERG/USD
    use_outstanding = 116_449   # USE in circulation
    sigusd_in_bank = 0          # Current SigUSD reserves

    bank_usd = bank_erg * erg_price
    target_sigusd_frac = 0.70   # 70% SigUSD target
    target_sigusd_usd = bank_usd * target_sigusd_frac

    # Current SigmaRSV ratio (from latest data)
    current_sigmausd_ratio = sigmausd_daily["reserve_ratio"].iloc[-1]
    contract_mint_available = current_sigmausd_ratio > SIGUSD_MINT_THRESHOLD

    print(f"\n  Current State:")
    print(f"    Bank ERG:        {bank_erg:>10,} ERG (${bank_usd:,.0f})")
    print(f"    SigUSD in Bank:  ${sigusd_in_bank:>10,}")
    print(f"    USE outstanding: {use_outstanding:>10,} USE")
    print(f"    Reserve ratio:   {bank_usd / use_outstanding:.1%}")
    print(f"    SigmaRSV ratio:  {current_sigmausd_ratio:.1%}")
    print(f"    Contract mint:   {'OPEN' if contract_mint_available else 'BLOCKED (<400%)'}")

    print(f"\n  Target:")
    print(f"    SigUSD fraction: {target_sigusd_frac:.0%}")
    print(f"    SigUSD needed:   ${target_sigusd_usd:,.0f}")

    # DEX pool constraints
    pool_sigusd = SIGUSD_DEX_POOL_SIGUSD
    print(f"\n  MewFinance Pool:")
    print(f"    SigUSD depth:    ${pool_sigusd:,}")
    print(f"    Max daily buy:   ${SIGUSD_DEX_DAILY_USD:,} (at ~1.5% slippage)")

    # Scenario 1: DEX only ($1K/day)
    dex_cost_pct = SIGUSD_DEX_FEE + SIGUSD_DEX_SLIPPAGE  # ~1.8%
    dex_daily_net = SIGUSD_DEX_DAILY_USD * (1 - dex_cost_pct)
    days_dex_only = target_sigusd_usd / dex_daily_net

    # Scenario 2: DEX $2K/day (more slippage)
    dex_2k_slippage = 0.025  # ~2.5% at $2K
    dex_2k_daily_net = 2000 * (1 - SIGUSD_DEX_FEE - dex_2k_slippage)
    days_dex_2k = target_sigusd_usd / dex_2k_daily_net

    # Scenario 3: Contract mint when available (faster, cheaper)
    # 0.1% of reserves/day via contract = ~$60/day at current reserves
    contract_daily = bank_usd * SIGUSD_ACCUMULATION_RATE * (1 - SIGUSD_REDEMPTION_FEE)
    days_contract_only = target_sigusd_usd / contract_daily if contract_daily > 0 else float('inf')

    # Scenario 4: Hybrid — DEX now, contract when 400% opens
    # Historical data shows ~50% of days have mint window open
    # Use DEX for closed days, contract for open days
    hybrid_daily = dex_daily_net * 0.5 + contract_daily * 0.5
    days_hybrid = target_sigusd_usd / hybrid_daily if hybrid_daily > 0 else float('inf')

    # ERG cost for each scenario
    erg_cost_dex_1k = (SIGUSD_DEX_DAILY_USD / erg_price) * days_dex_only
    erg_cost_dex_2k = (2000 / erg_price) * days_dex_2k
    erg_remaining_after_dex_1k = bank_erg - erg_cost_dex_1k

    print(f"\n  {'─' * 60}")
    print(f"  ACCUMULATION SCENARIOS (to reach ${target_sigusd_usd:,.0f} SigUSD)")
    print(f"  {'─' * 60}")

    scenarios = [
        ("DEX $1K/day", days_dex_only, SIGUSD_DEX_DAILY_USD, dex_cost_pct,
         erg_cost_dex_1k),
        ("DEX $2K/day", days_dex_2k, 2000, SIGUSD_DEX_FEE + dex_2k_slippage,
         (2000 / erg_price) * days_dex_2k),
        ("Contract only (if >400%)", days_contract_only, contract_daily / (1-SIGUSD_REDEMPTION_FEE),
         SIGUSD_REDEMPTION_FEE, (contract_daily / (1-SIGUSD_REDEMPTION_FEE) / erg_price) * days_contract_only),
    ]

    print(f"\n  {'Scenario':<25} | {'Days':>6} | {'Months':>6} | {'Daily $':>8} | {'Fee':>5} | {'ERG Cost':>10}")
    print(f"  {'-'*25}-+-{'-'*6}-+-{'-'*6}-+-{'-'*8}-+-{'-'*5}-+-{'-'*10}")
    for name, days, daily, fee, erg_cost in scenarios:
        months = days / 30
        print(f"  {name:<25} | {days:>6.0f} | {months:>6.1f} | ${daily:>7,.0f} | {fee:>4.1%} | {erg_cost:>9,.0f}")

    # What the Bank looks like after accumulation (DEX $1K/day scenario)
    erg_after = bank_erg - erg_cost_dex_1k
    sigusd_after = target_sigusd_usd
    total_usd_after = erg_after * erg_price + sigusd_after
    ratio_after = total_usd_after / use_outstanding

    print(f"\n  Post-accumulation state (DEX $1K/day scenario):")
    print(f"    ERG remaining:   {erg_after:>10,.0f} ERG (${erg_after * erg_price:,.0f})")
    print(f"    SigUSD held:     ${sigusd_after:>10,.0f}")
    print(f"    Total reserves:  ${total_usd_after:>10,.0f}")
    print(f"    Reserve ratio:   {ratio_after:.1%}")
    print(f"    ERG/SigUSD split: {erg_after * erg_price / total_usd_after:.0%} / {sigusd_after / total_usd_after:.0%}")

    # Timeline visualization
    print(f"\n  Timeline (DEX $1K/day):")
    milestones = [0.10, 0.25, 0.50, 0.70]
    for m in milestones:
        usd_needed = bank_usd * m
        days_to = usd_needed / dex_daily_net
        erg_spent = (SIGUSD_DEX_DAILY_USD / erg_price) * days_to
        print(f"    {m:>4.0%} SigUSD (${usd_needed:>7,.0f}): {days_to:>4.0f} days ({days_to/30:.1f} mo) | {erg_spent:,.0f} ERG spent")

    # Save roadmap
    roadmap = {
        "current_bank_erg": bank_erg,
        "current_erg_price": erg_price,
        "current_bank_usd": bank_usd,
        "target_sigusd_frac": target_sigusd_frac,
        "target_sigusd_usd": target_sigusd_usd,
        "contract_mint_available": contract_mint_available,
        "sigmausd_ratio": current_sigmausd_ratio,
        "dex_pool_sigusd": pool_sigusd,
        "scenario_dex_1k_days": round(days_dex_only),
        "scenario_dex_2k_days": round(days_dex_2k),
        "scenario_contract_days": round(days_contract_only) if days_contract_only < 1e6 else "N/A",
    }
    import json
    with open(RESULTS_DIR / "accumulation_roadmap.json", "w") as f:
        json.dump(roadmap, f, indent=2, default=str)

    print(f"\n  Saved to results/accumulation_roadmap.json")


if __name__ == "__main__":
    main()
