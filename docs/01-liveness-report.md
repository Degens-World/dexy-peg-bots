# USE Protocol Liveness Failure Report — March 29, 2026

## Summary

On March 29, 2026, the USE (DexyUSD) stablecoin protocol on Ergo was found in a **frozen state** — its peg defense mechanism had been inactive for approximately 40 hours despite conditions requiring intervention. The LP rate had drifted to 97% of oracle price, below the 98% intervention threshold, but no off-chain bot was triggering the tracking98 box required to initiate a bank intervention.

This report documents the discovery, diagnosis, manual intervention, and resulting arbitrage extraction by a third-party bot.

---

## Timeline

| Block | Time (approx) | Event |
|-------|---------------|-------|
| 1750250 | ~64 hrs prior | Last intervention fired |
| 1750942 | ~41 hrs prior | tracking98 briefly triggered then reset (block 1750970) |
| 1750970 | ~40 hrs prior | **Last tracking98 activity — bot goes silent** |
| — | ~40 hrs gap | LP rate drifts below 98%, no bot triggers tracking98 |
| 1752170 | Investigation begins | On-chain analysis confirms LP at 97.0%, tracking98 in RESET |
| 1752193 | **Manual trigger** | We submit tracking98 trigger TX ([`1216990f...`](https://explorer.ergoplatform.com/en/transactions/1216990ffcb61d10e8b7545705bff94aa128607479779a8c3ba255a0197239cc)) |
| 1752308 | Arbitrageur buys | `9gE9Wm...` buys 223 USE from LP at 3.576 ERG/USE |
| 1752354 | Arbitrageur buys more | Same wallet buys 111 USE at 3.593 ERG/USE |
| 1752356 | **Intervention fires** | Arbitrageur fires intervention TX ([`39eb2051...`](https://explorer.ergoplatform.com/en/transactions/39eb2051f58caef0ef7fe7132d1005866d2891828a9a3b2f879af0e691d4dad2)) |
| 1752358 | Arbitrageur sells | Sells 111 USE back at 3.628 ERG/USE |
| 1752380 | Arbitrageur sells | Sells 223 USE back at 3.612 ERG/USE |

---

## Root Cause

The USE protocol's peg defense is a **two-step process**:

1. **Tracking98 trigger** — An off-chain bot must submit a TX to transition the tracking98 box from RESET to TRIGGERED state when LP rate < 98% of oracle
2. **Intervention** — After 20+ blocks of sustained tracking, a second TX fires the bank intervention

Both steps are **permissionless** — anyone can submit them. However, in practice, they depend on off-chain bots run by protocol operators or community members.

**The tracking98 bot went offline around block 1750970.** From that point, even though the LP rate was below 98%, no bot submitted the tracking trigger. Without the trigger, intervention could not fire. Without intervention:

- LP rate stayed below 98%
- **LP redemptions were blocked** (redeem.es requires rate > 98% of oracle)
- **FreeMint was blocked** (also requires rate > 98%)
- The protocol was effectively **frozen** — no minting, no LP exits, no peg defense

---

## Protocol State at Discovery

| Metric | Value |
|--------|-------|
| Bank ERG | 218,106 ERG |
| LP ERG | 273,714 ERG |
| LP USE | 76,986 USE |
| Oracle rate | 3.665 ERG/USE |
| LP rate | 3.555 ERG/USE |
| **LP/Oracle ratio** | **97.0%** (below 98% threshold) |
| Bank reserve ratio | ~51% (ERG price decline) |
| Tracking98 state | RESET (R7 = INT_MAX) |
| Blocks since last tracking activity | 1,200 (~40 hours) |
| Intervention gap | 1,920 blocks (>> 360 required) |

---

## Actions Taken

### 1. Manual Tracking98 Trigger

We built and submitted a tracking98 trigger transaction at block 1752193. This was a permissionless operation requiring only ~0.001 ERG in miner fees. The TX set R7 = 1752193 (current HEIGHT), transitioning the tracking box from RESET to TRIGGERED state.

TX: [`1216990ffcb61d10e8b7545705bff94aa128607479779a8c3ba255a0197239cc`](https://explorer.ergoplatform.com/en/transactions/1216990ffcb61d10e8b7545705bff94aa128607479779a8c3ba255a0197239cc)

### 2. Intervention (by third party)

After our trigger confirmed, a third-party bot (`9gE9WmtpVgr4zDddn8RcDE6fmsyhqhMwbDUDAMQcrTFEG1ijXg2`) fired the intervention at block 1752356. The bank spent 2,181 ERG (1% cap) to buy 608 USE from the LP, pushing the ratio from 97% to 99.7%.

### 3. Open-Source Bot Release

We packaged and released the trigger and intervention bots as open-source tools to prevent future liveness failures:

**https://github.com/Degens-World/dexy-peg-bots**

---

## Impact

- **Protocol was frozen for ~40 hours** — no LP exits, no minting, no peg defense
- **LP holders were trapped** — could not redeem positions during the outage
- **Bank lost 2,181 ERG** to intervention (by design, buying USE at discount)
- **Arbitrageur extracted ~12 ERG** by sandwiching the intervention (see separate report)
- **Peg restored** to 99.7% — LP redemptions and FreeMint unblocked

---

## Recommendations

1. **Multiple tracking bot operators** — The protocol should not depend on a single bot operator. The open-source bots we released help with this.

2. **Intervention frequency circuit breaker** — If interventions fire every epoch for an extended period, the protocol should pause and require governance action rather than draining the bank mechanically.

3. **Adaptive reserve cap** — The 1% per-intervention cap is fixed. Consider reducing it after consecutive interventions to slow extraction rate.

4. **Monitoring dashboard alerts** — CruxFinance's analytics page shows the reserve ratio but doesn't alert when tracking boxes go stale or the bot is offline.

5. **On-chain tracking liveness check** — A contract modification could allow the tracking box to self-trigger after N blocks of inactivity, removing the off-chain dependency entirely.
