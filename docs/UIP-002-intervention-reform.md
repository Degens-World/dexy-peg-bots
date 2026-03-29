# UIP-002: Intervention Reform — Liveness, Extraction, and Reserve Resilience

**Author(s):** CQ (Degens-World)
**Status:** Proposed
**Created:** 2026-03-29
**License:** CC0

---

## Description

This UIP proposes three coordinated changes to the USE stablecoin protocol's peg defense
mechanism, motivated by a confirmed 40-hour liveness failure and documented on-chain
arbitrage extraction on March 29, 2026. The changes address (1) intervention sizing to
reduce MEV extraction while preserving reliable threshold crossing, (2) a tiered operator
model to improve liveness without sacrificing permissionless fallback, and (3) a SigUSD
mixed-reserve strategy to reduce structural reserve value erosion during ERG price declines.

---

## Motivation

### Liveness Failure — March 29, 2026

The tracking98 bot went offline at approximately block 1750970. For the following 40 hours,
the LP rate drifted to 97% of oracle price with no off-chain actor triggering the tracking
box. During this window:

- LP redemptions were blocked (`redeem.es` requires rate > 98% of oracle)
- FreeMint was blocked
- The bank intervention mechanism was entirely inactive
- LP holders could not exit positions

The protocol was restored only via manual community intervention (block 1752193). This
demonstrated that the two-step peg defense architecture creates a critical single point of
failure in its off-chain dependency.

### Intervention Sandwich — March 29, 2026

Immediately following the manual tracking trigger, wallet
`9gE9WmtpVgr4zDddn8RcDE6fmsyhqhMwbDUDAMQcrTFEG1ijXg2` executed a textbook sandwich:

| Step | Action | ERG |
|------|--------|-----|
| Buy | 335 USE at avg 3.582 ERG/USE | −1,200.00 |
| Execute | Intervention (Bank injects 2,181 ERG) | −0.002 |
| Sell | 335 USE at avg 3.617 ERG/USE | +1,211.86 |
| **Net** | **Zero USE risk** | **+11.85 ERG** |

The arbitrageur waited for a community-submitted tracking trigger, then used the mandatory
20-block positioning window to front-load their buy before firing the intervention
themselves at the full 1% cap.

**Important:** The LP was at 97% of oracle before the arb bought in. The arb's 1,200 ERG
purchase moved the LP from 97% to approximately 98% *before* the intervention fired. The
intervention then pushed it from ~98% to 99.7%. These are separate effects — the
arbitrageur's capital did a portion of the price correction work, and the Bank's 2,181 ERG
did the rest. Conflating the two overstates the intervention's price impact and understates
the arb's contribution to the move.

At the current intervention frequency during sustained depeg conditions, this represents
a worst-case extraction of ~24 ERG/day (two interventions per day at maximum frequency).
In practice, a single intervention often restores the LP above 98% and subsequent
interventions don't trigger, so actual extraction is lower.

### Reserve Value Erosion

The Bank's reserve ratio has declined from ~110% at bootstrap to ~51% today. This erosion
is not primarily attributable to intervention mechanics — minting fees have kept ERG inflows
positive. The ratio declined because ERG/USD approximately halved while USE obligations
remained in dollar terms. The Bank holds exclusively ERG-denominated reserves and therefore
has no structural hedge against the asset it is defending against.

### The LP Lock Is the Only Thing Keeping This Protocol Alive

The USE LP has a 2-year redemption lock. If LP holders could exit freely today, rational
actors seeing a 51% reserve ratio would redeem immediately — withdrawing ERG from the LP,
collapsing the pool depth, accelerating the depeg, and triggering a classic bank run. The
protocol survives today not because of its economic design but because exit is contractually
blocked. This is not a sustainable foundation. When the lock expires, the protocol must be
in a position where LP holders *choose* to stay — which requires reserve ratios that inspire
confidence, not the current 51%.

---

## Specification

This proposal includes three changes:

### Change 1: Adjust Intervention Cap — 1% → 0.7% of Bank Reserves

**Why not 0.5%:**

From a clean 97% starting point (no arb front-running), the post-swap rate cap of 99.5%
binds before the reserve cap in most conditions. At 0.5% of Bank reserves (~1,090 ERG at
current levels), the intervention pushes the LP from 97% to approximately **97.6%** —
below the 98% threshold required to unblock LP redemptions and FreeMint. The intervention
would fire, spend Bank ERG, and leave the protocol still frozen. This is worse than the
status quo.

At 0.7% of Bank reserves (~1,527 ERG at current levels), the intervention pushes the LP
from 97% to approximately **98.3%**, reliably crossing the 98% threshold with a small margin.

**Proposed:** Set the maximum intervention cap at 0.7% of Bank reserves.

**Effect on sandwich economics:**

The arb's sandwich profit scales with the price impact the Bank's ERG creates. Reducing
the Bank's spend from 1% to 0.7% while also noting that arb front-running already moves
the LP partway to 98%, the residual Bank move is smaller:

| Cap | Scenario | Bank Spend (est.) | Net LP Move | Est. Sandwich Profit |
|-----|----------|-------------------|-------------|----------------------|
| 1.0% | With arb pre-positioning | ~2,181 ERG | ~98% → 99.7% | ~12 ERG |
| 0.7% | With arb pre-positioning | ~1,527 ERG | ~98% → 99.2% | ~6 ERG |
| 0.7% | No arb (clean trigger) | ~1,527 ERG | ~97% → 98.3% | ~0 ERG (no position) |

The 0.7% cap reduces sandwich profit in the arb-present scenario and reliably restores
functionality in the arb-absent scenario.

**Note:** These estimates are approximations using the constant-product AMM formula with
current LP reserves. Actual price impact depends on LP depth at the time of intervention.
The contract's 99.5% post-swap cap remains the binding constraint when the LP is close to
peg; the 0.7% reserve cap binds during deep depegs.

### Change 2: Tiered Operator Model — Oracle Operator Fast-Path

**Current behavior:** Any wallet can trigger tracking98 and fire interventions. The
mandatory 20-block window between tracking trigger and intervention creates a public
positioning signal exploitable by any actor.

**Proposed:** Add a whitelisted fast-path for recognized oracle pool operators affecting
`intervention.es` only. The `tracking.es` contract does not require modification — it
remains permissionless on both paths.

- **Standard path (permissionless, unchanged):** Any wallet may trigger tracking98 via
  `tracking.es`. After 20+ blocks of sustained tracking, any wallet may fire the
  intervention via `intervention.es`. This path remains fully open as a community fallback.

- **Operator fast-path (new):** Wallets whitelisted in `intervention.es` may fire the
  intervention without requiring a prior tracking trigger or waiting period, provided the
  LP price condition is satisfied. The tracking box is used as a data-input for price
  validation but its R7 trigger state is not checked for whitelisted operators.

**Whitelist management:** The operator whitelist is governed by the existing updateNFT
mechanism. Initial candidate list: active ERG/USD oracle pool operators (the oracle pool
used by USE, NFT `6a2b821b...`). Operator count and identities should be confirmed against
current pool participants before deployment.

**Implementation notes:**

The whitelist check compares `INPUTS(3).propositionBytes` (the fee payer box) against
stored operator proposition bytes. Operator P2PK proposition bytes are 36 bytes
(`0x0008cd` + 33-byte compressed pubkey), stored as `Coll[Byte]` literals — not Base58
addresses, which are not a native ErgoScript type.

Two implementation risks require testing before deployment:

1. **JIT cost:** 15 chained `Coll[Byte]` comparisons via `||` is non-trivial. ErgoScript's
   JIT cost budget may be exceeded with the full operator list. Options: reduce whitelist
   size, use a hash-based membership check, or benchmark against the cost limit before
   committing to 15 entries.

2. **Input index robustness:** `INPUTS(3)` assumes the operator is the fee payer at exactly
   index 3. If the operator uses multiple UTXOs for fees, this assumption breaks. A more
   robust approach checks whether any input beyond the fixed protocol boxes (LP, Bank,
   Intervention) carries a whitelisted proposition, using a fold or existential check over
   the remaining inputs.

**Why this does not eliminate permissionless fallback:**

The standard path is fully unchanged. If all whitelisted operators are offline (as occurred
today), any community member can still trigger tracking and fire the intervention via the
existing 20-block path. The fast-path only removes the sandwich window when a trusted
operator acts first.

### Change 3: SigUSD Mixed Reserve Strategy — 30% ERG / 70% SigUSD Target

This change is a governance recommendation rather than a contract modification.

**Current state:** Bank holds exclusively ERG-denominated reserves (215,925 ERG, ~$60K).

**Proposed:** Target a **30% ERG / 70% SigUSD** reserve mix. This recommendation is
backed by a historical backtest simulating hypothetical USE existence across the full
SigmaUSD era (June 2021 → present), covering the Nov 2021 ATH crash ($18→$1.50),
May 2022 Luna event, and the 2023-2026 sustained decline.

**Backtested hedge effectiveness (hypothetical USE, 110% starting ratio, current regime):**

| ERG Drawdown | 100% ERG | 70% ERG / 30% SigUSD | 50/50 | **30% ERG / 70% SigUSD** |
|---|---|---|---|---|
| 0–10% | 100.5% | 115.7% | 112.7% | 107.2% |
| 10–25% | 84.2% | 101.2% | 102.9% | 102.3% |
| 25–40% | 73.2% | 89.4% | 95.0% | 99.0% |
| 40–60% | 50.0% | 69.7% | 81.5% | **92.0%** |
| 60–80% | 21.9% | 41.7% | 62.9% | **83.5%** |
| 80%+ | 1.2% | 5.7% | 35.2% | **71.9%** |

The 70% SigUSD strategy holds **72% reserve ratio even during 80%+ ERG crashes** where
the current 100% ERG strategy falls to 1%. Under UIP-001's smaller/faster intervention
regime, the numbers improve further (76% at 80%+ drawdown).

**Sensitivity analysis** confirms 70% SigUSD with an 75-80% trigger ratio produces the
highest minimum reserve ratio across all tested parameter combinations:

| Configuration | Min Reserve Ratio | Mean Reserve Ratio |
|---|---|---|
| 70% SigUSD, trigger at 75% | **77.0%** | 79.4% |
| 70% SigUSD, trigger at 80% | 71.9% | 77.2% |
| 60% SigUSD, trigger at 75% | 54.3% | 63.5% |
| 50% SigUSD, trigger at 75% | 38.9% | 50.9% |

**Operational mechanics during stress:**

When reserve ratio falls below 75-80% (governance parameter):
- Switch intervention funding from ERG reserves to SigUSD
- Redeem SigUSD at oracle price → receive ERG → inject into LP
- Cost: dollar-in, dollar-out minus ~2.25% SigUSD fee
- vs. spending ERG that has lost 35-50%+ of its dollar value during a sustained decline

**SigUSD availability — honest assessment:**

SigUSD **redemption** (spending reserves → ERG) is available at any SigmaUSD ratio above
100%. SigUSD holders have contractual priority over SigRSV holders by design — the AgeUSD
contract explicitly protects them. The 100% floor has never been breached historically.

SigUSD **minting** (accumulating new reserves) requires SigmaRSV ratio above 400%.
Historical data from ergo.watch shows:

| Year | Days > 400% (mint open) | Longest Open | Longest Closed |
|------|------------------------|-------------|---------------|
| 2021 | 191 / 264 (72%) | 69 days | 16 days |
| 2022 | 112 / 329 (34%) | 21 days | 58 days |
| 2023 | 94 / 316 (30%) | 51 days | 69 days |
| 2024 | 223 / 323 (69%) | 99 days | 27 days |
| 2025 | 245 / 337 (73%) | 82 days | 28 days |
| 2026 YTD | 0 / 58 (0%) | 0 days | 58 days |

The binding constraint is accumulation, not deployment. The hedge spends down during
crises but cannot be restocked via contract mint until SigmaRSV recovers above 400%.

**DEX accumulation path (eliminates the 400% constraint):**

The 400% mint threshold only blocks minting **new** SigUSD through the SigmaUSD contract.
Existing SigUSD trades freely on DEX pools regardless of SigmaRSV ratio. The Bank can
buy SigUSD directly from the MewFinance SigUSD/ERG pool (pool NFT
`9916d75132593c8b07fe18bd8d583bda1652eed7565cf41a4738ddd90fc992ec`).

Current pool state: ~79,532 SigUSD / ~286,431 ERG (~$160K TVL).

| Daily Buy | Slippage | Fee | Total Cost | Days to 70% Target |
|-----------|---------|-----|------------|---------------------|
| $1,000/day | ~1.5% | 0.3% | ~1.8% | **43 days** |
| $2,000/day | ~2.5% | 0.3% | ~2.8% | **22 days** |

This is **cheaper** than contract minting (1.8% DEX cost vs 2.25% contract fee) and
available **every day** regardless of SigmaRSV ratio. The 2026 problem (0 mint days
this year) is completely eliminated.

**Recommended accumulation strategy:**
1. Buy $1-2K SigUSD/day from DEX at ~1.5-2.5% slippage (available immediately)
2. When SigmaRSV recovers above 400%, supplement with contract minting (larger amounts,
   lower per-unit cost for amounts above ~$3K)
3. Target: ~$42K SigUSD (70% of current $60K reserves) in 6-8 weeks

**Correlated risk — honest assessment:**

Both USE and SigUSD depend on ERG collateral. The backtest shows the hedge provides
material protection through 60-80% ERG declines (84% reserve ratio vs 22% without hedge).
At 80%+ decline, the hedge still holds 72% vs 1%, but SigmaRSV ratio approaches stress
levels and **new SigUSD cannot be minted to replenish**. The hedge spends down but cannot
be restocked during the worst of the crisis — only after recovery.

This is strictly better than pure ERG at every drawdown depth tested. It is not a
complete solution to the fundamental problem of a dollar stablecoin backed by a volatile
asset, but it converts a protocol-ending scenario (1% reserves) into a survivable one
(72% reserves).

---

## Rationale

### On intervention sizing

Reducing the cap from 1% to 0.7% preserves reliable 98% threshold crossing from a 97%
starting point while reducing the Bank's price impact and therefore sandwich profitability.
The 99.5% post-swap cap in the existing contract means the Bank rarely deploys the full
reserve-percentage cap anyway — the effective change is narrowing the maximum price push,
which directly reduces sandwich profit without impeding protocol function.

### On the tiered model vs. full permissioning

Full permissioning (operators only, no fallback) creates a hard dependency on operator
uptime — the exact failure mode observed today. The tiered model rewards operators
economically (they capture intervention value by acting first and eliminating sandwich
competition) without removing the community rescue path. This aligns incentives without
introducing new single points of failure. The key question — whether enough operators will
actually run bots to make the fast-path reliable — is an open governance question that
should be assessed via direct polling of the oracle operator group before deployment.

### On commit-reveal

A commit-reveal scheme for intervention timing was considered. On Ergo's transparent
eUTXO chain, a commitment TX is itself an observable UTXO. Sophisticated watchers
monitoring commitment box contracts would replace the tracking98 signal with a
commitment-box signal — same positioning window, different observable. The tracking trigger
is the root signal and it is unavoidable; hiding the intervention behind a commitment does
not change the information available to the arb. The operator fast-path is structurally
cleaner because it eliminates the window entirely rather than obscuring a signal that
remains detectable.

### On SigUSD dependency risk

The correlated risk concern is real and quantified by the backtest. At 80%+ ERG drawdown,
the 70% SigUSD strategy still holds 72% reserve ratio vs 1% for pure ERG — a 71 percentage
point improvement. The hedge degrades at extreme levels (SigUSD mint blocked, SigmaRSV
approaching stress) but does not fail: SigUSD redemption has never been unavailable
historically (SigmaRSV has never breached the 100% floor).

### On DEX vs contract accumulation

The DEX path (buying existing SigUSD from the MewFinance pool) is strictly superior to
waiting for contract mint windows when SigmaRSV is below 400%:
- Available immediately (no 400% dependency)
- Cheaper for amounts < $3K/day (1.8% total cost vs 2.25% contract fee)
- Current pool depth supports $1-2K/day at acceptable slippage
- Eliminates the "can't accumulate during the exact periods you need to" problem

The contract mint path remains preferable when SigmaRSV > 400% for larger amounts
($5K+/day) where DEX slippage exceeds the 2.25% contract fee.

---

## Backwards Compatibility

**Change 1** affects `intervention.es` and requires redeployment of the intervention
contract. Existing tokens and LP positions are unaffected.

**Change 2** affects `intervention.es` only. The `tracking.es` contract is unchanged —
the permissionless tracking trigger remains exactly as deployed. The intervention NFT
would be migrated to the updated contract.

**Change 3** requires no contract changes.

---

## Open Questions

### Answered by backtest

4. ~~What ERG/SigUSD reserve ratio is optimal?~~ **Answered: 30% ERG / 70% SigUSD.**
   Sensitivity analysis across 6 ratios × 4 trigger thresholds × 2 intervention regimes
   shows 70% SigUSD with a 75% trigger produces the highest minimum reserve ratio (77%)
   across all tested scenarios. See `backtest/results/sensitivity_grid.csv`.

5. ~~What threshold should trigger the SigUSD spending path?~~ **Answered: 75-80%.**
   The 75% trigger produces the best minimum ratio; 80% is nearly as good with slightly
   less aggressive SigUSD deployment. The exact value is a governance preference between
   "conserve SigUSD for deeper stress" (75%) and "deploy sooner for smoother defense" (80%).

### Remaining open

1. What is the correct intervention cap given current LP depth? The 0.7% estimate should
   be validated against live LP reserves using the constant-product formula before
   deployment.
2. Can the operator whitelist check be implemented within ErgoScript's JIT cost budget
   for 15 operators? What is the maximum practical whitelist size?
3. Is INPUTS(3) a reliable fee payer index, or does a fold/existential check over
   remaining inputs provide better robustness?
6. Should whitelisted operators receive an explicit on-chain reward?
7. How many of the current oracle pool operators would realistically run intervention bots?
8. Should the DEX accumulation be automated (a bot that buys $1K SigUSD/day from the
   MewFinance pool) or manually executed by governance?
9. At what DEX pool depth does slippage become prohibitive? Current pool (~$80K SigUSD
   side) supports $1-2K/day easily but would need to grow for faster accumulation.

---

## Reference Implementation

A reference implementation of the intervention bot (currently using 0.5% cap — to be
updated to 0.7% pending this proposal) is available at:

**https://github.com/Degens-World/dexy-peg-bots**

The operator fast-path logic in `intervention.es` (pseudocode — Coll[Byte] literals
to be substituted for actual operator proposition bytes at deployment time):

```scala
// Operator whitelist — stored as raw Coll[Byte] (36 bytes each)
// Format: 0x0008cd ++ 33-byte compressed pubkey
// NOTE: JIT cost must be benchmarked before finalizing whitelist size

val isAuthorizedOperator =
  INPUTS(3).propositionBytes == operator1PropositionBytes ||
  INPUTS(3).propositionBytes == operator2PropositionBytes
  // ... up to N operators (N to be determined by JIT cost testing)

// Fast-path: authorized operator, LP condition required, timing gap waived
// Standard path: any wallet, requires T_INT blocks of sustained tracking
val validTiming =
  if (isAuthorizedOperator) {
    lpRateBelowThreshold  // LP price check still enforced
  } else {
    tracking98Triggered && (HEIGHT - triggerHeight > T_INT)
  }
```

---

## Supporting Data

The reserve strategy recommendation in Change 3 is backed by a quantitative backtest:

**Repository:** https://github.com/Degens-World/dexy-peg-bots/tree/master/backtest

**Data sources:**
- ERG/USD daily prices: CoinGecko (July 2019 → March 2026, 2,464 data points)
- SigmaUSD on-chain state: ergo.watch API (height 453064 → 1752380, full balance history)
- Block timestamps: Ergo chain (all 1.75M blocks)
- SigUSD DEX liquidity: MewFinance pool (current state)

**Methodology:**
- Hypothetical USE existence simulated from SigmaUSD launch (June 2021) through all
  major ERG drawdown cycles, bootstrapped at 110% reserve ratio
- 4 reserve strategies × 2 intervention regimes × 4 simulation windows
- 48-point sensitivity grid (6 SigUSD fractions × 4 trigger ratios × 2 regimes)
- Intervention trigger: daily ERG price drop > 2% as proxy for LP rate < 98% of oracle
- Calibration check: Strategy A reproduces ~39% reserve ratio from Dec 2025 bootstrap
  (actual: ~51%, gap attributable to minting fee income not modeled)

**Output files:**
- `results/hedge_effectiveness.csv` — Table 3 (key deliverable)
- `results/sensitivity_grid.csv` — Full parameter sweep
- `results/accumulation_windows.csv` — SigUSD mint window availability by year
- `results/accumulation_roadmap.json` — Current-state path to 70% target
- `results/sensitivity_heatmap_current.png` / `sensitivity_heatmap_uip001.png`

---

## FAQ — Anticipated Objections

### "SigUSD is a terrible, inefficient design"

SigUSD's reserve ratio has never fallen below ~160% in five years of operation through
multiple 70-90% ERG crashes. USE is at 51% after four months. The "inefficiency" — heavy
overcollateralization, 2.25% fees, the 400% mint lock — is precisely what makes SigUSD
reliable as a hedge asset. The things people complain about (expensive, restrictive) are
the features that protect SigUSD holders during stress. We are not proposing USE adopt
SigUSD's design. We are proposing USE *use* SigUSD's proven stability as a reserve asset.

### "You're making USE dependent on SigUSD — that's adding risk"

USE is already 100% dependent on a single volatile asset (ERG). Replacing 70% of that
exposure with a dollar-denominated asset that has held its peg through every ERG crash
since 2021 is *reducing* concentration risk, not adding dependency. The alternative —
doing nothing — means the next 50% ERG decline takes the reserve ratio from 51% to ~25%.
The protocol does not survive that.

### "Just fix the intervention mechanism — the reserve mix is unnecessary"

UIP-001 (smaller/faster interventions) and Changes 1-2 of this proposal improve
intervention efficiency and reduce MEV extraction. They do not solve the fundamental
problem: a dollar stablecoin whose reserves are denominated entirely in an asset that has
fallen 98.5% from ATH. No intervention mechanism can outrun that math. The backtest
shows that even with UIP-001's optimized interventions, the 100% ERG strategy still
falls to 2.7% reserve ratio during 80%+ drawdowns. The reserve mix is not an alternative
to fixing interventions — it is the complement that makes intervention fixes meaningful.

### "SigUSD could depeg too — then you've lost both"

Addressed honestly in the correlated risk section above. The backtest quantifies this:
at 80%+ ERG drawdown, the SigUSD hedge still holds 72% reserve ratio vs 1% without it.
SigUSD redemption has been available through every historical stress event (SigmaRSV
has never breached 100%). The hedge degrades at extreme depths but does not fail.
72% is survivable. 1% is not.

### "Why not use USDT/USDC bridged via Rosen?"

No. A permissionless protocol should not hold permissioned assets as reserves.
USDT/USDC can be frozen, blacklisted, or seized by their issuers at any time —
Tether and Circle have done this repeatedly. Building a critical reserve dependency
on assets that a centralized entity can unilaterally destroy defeats the purpose of
building on Ergo in the first place. SigUSD is a permissionless, on-chain, algorithmic
stablecoin with no admin keys, no blacklist function, and no issuer who can freeze funds.
It is the only stablecoin on Ergo that matches the protocol's own trust assumptions.

### "The backtest is hypothetical — USE didn't exist before December 2025"

Correct. The hypothetical simulation extrapolates USE parameters across historical ERG
price data and real SigmaUSD on-chain state. The December 2025 calibration window
validates the model against known ground truth (simulated 39% vs observed 51% — gap
attributable to minting fee income not fully modeled). The hypothetical windows provide
stress-test data across drawdown scenarios that the 4-month real window cannot cover.
All results are clearly labeled as hypothetical or calibration.

### "70% SigUSD is too aggressive — start smaller"

The sensitivity analysis shows that lower SigUSD fractions provide proportionally less
protection during severe stress:

| SigUSD % | Reserve ratio at 60-80% ERG drawdown |
|----------|--------------------------------------|
| 30% | 42% |
| 50% | 63% |
| **70%** | **84%** |

A 30% allocation barely helps during severe stress (42% is still below 50% and trending
toward insolvency). The protection curve is roughly linear — there is no "sweet spot"
below 70% that provides adequate protection during the stress scenarios where the hedge
is actually needed. Starting at 30% to be "conservative" means accepting that the hedge
won't meaningfully help when it matters most.

That said, any SigUSD allocation is better than zero. If governance prefers a staged
rollout, accumulating 30% first (achievable in ~2 weeks via DEX at $1K/day) and
observing before continuing to 70% is a reasonable approach.

### "Who pays for the slippage and fees during accumulation?"

The Bank does, from its existing ERG reserves. At $1K/day with 1.8% total cost
(0.3% LP fee + ~1.5% slippage), the cost is ~$18/day or ~$770 total to reach the
70% target over 43 days. This is roughly **0.6 ERG/day** at current prices — less than
the miner fee for a single intervention. The accumulation cost is negligible relative
to the protection it provides.

### "What happens when the LP lock expires and people can exit?"

If the reserve ratio is still at 51% (or lower), rational LP holders exit immediately.
The protocol enters a death spiral: LP withdrawals reduce pool depth, which widens the
depeg, which triggers more interventions, which drain the Bank, which lowers the reserve
ratio, which motivates more exits. This is a textbook bank run.

If the reserve ratio is at 70-80% (achievable with the SigUSD hedge even after further
ERG decline), LP holders have reason to stay — the protocol is demonstrably solvent and
actively defended. The difference between 51% and 80% reserve ratio is the difference
between a bank run and a functioning protocol. The SigUSD hedge buys that margin.

---

*Based on on-chain analysis, liveness failure documentation, and historical backtest — March 29, 2026*
*White-hat security research for the Ergo community*
