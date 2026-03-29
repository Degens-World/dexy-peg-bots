# Intervention Sandwich: How One Wallet Extracted 12 ERG From the USE Protocol

## The Wallet

**`9gE9WmtpVgr4zDddn8RcDE6fmsyhqhMwbDUDAMQcrTFEG1ijXg2`**

[View on Explorer](https://explorer.ergoplatform.com/en/addresses/9gE9WmtpVgr4zDddn8RcDE6fmsyhqhMwbDUDAMQcrTFEG1ijXg2)

---

## What Happened

On March 29, 2026, the USE stablecoin's LP was trading at 97% of oracle price. The tracking98 bot had been offline for 40 hours. Community developers manually triggered the tracking98 box at block 1752193 to restore the protocol's peg defense.

The wallet above was watching. Within minutes of the tracking trigger confirming, they executed a textbook intervention sandwich — buying USE cheap, firing the intervention themselves, then selling USE at the restored price.

---

## The Sequence

### Step 1: Buy USE Below Peg

| Block | TX | ERG Spent | USE Bought | Price |
|-------|----|-----------|------------|-------|
| 1752308 | [`a1da8581...`](https://explorer.ergoplatform.com/en/transactions/a1da85817630e0d62b24) | 800.00 ERG | 223.683 USE | 3.576 ERG/USE |
| 1752354 | [`a158d531...`](https://explorer.ergoplatform.com/en/transactions/a158d531aad4772a6067) | 400.00 ERG | 111.354 USE | 3.593 ERG/USE |

**Total: 1,200.00 ERG spent, 335.037 USE acquired at avg 3.582 ERG/USE**

The LP was below peg (97% of oracle). USE was cheap. The arbitrageur knew the intervention would push the price up.

### Step 2: Fire the Intervention

| Block | TX | Cost |
|-------|----|------|
| 1752356 | [`39eb2051...`](https://explorer.ergoplatform.com/en/transactions/39eb2051f58caef0ef7fe7132d1005866d2891828a9a3b2f879af0e691d4dad2) | 0.002 ERG (miner fee) |

The arbitrageur fired the intervention TX themselves. The Bank spent **2,181 ERG** (the full 1% cap) buying 608 USE from the LP. This pushed the LP rate from 97% to 99.7% of oracle.

The intervention was a permissionless operation. Anyone could have fired it. The arbitrageur chose to do it themselves to control timing — ensuring they were positioned before the price moved.

### Step 3: Sell USE at Restored Price

| Block | TX | ERG Received | USE Sold | Price |
|-------|----|-------------|----------|-------|
| 1752358 | [`999c00d0...`](https://explorer.ergoplatform.com/en/transactions/999c00d085f95a33f4fb) | 403.96 ERG | 111.354 USE | 3.628 ERG/USE |
| 1752380 | [`b52e8fbe...`](https://explorer.ergoplatform.com/en/transactions/b52e8fbef58e97a8b910) | 807.90 ERG | 223.683 USE | 3.612 ERG/USE |

**Total: 1,211.86 ERG received, 335.037 USE sold at avg 3.617 ERG/USE**

---

## The Math

```
ERG In:    1,200.00 (buying USE)
ERG Out:   1,211.86 (selling USE)
Fee:           0.00 (0.002 ERG miner fee, negligible)
─────────────────────
NET PROFIT:  +11.85 ERG
USE RISK:      0.00 (bought and sold same amount)

Avg Buy:    3.582 ERG/USE
Avg Sell:   3.617 ERG/USE
Spread:     0.035 ERG/USE (0.99%)
```

---

## Why This Is Problematic

### The Protocol Only Needed 0.3% to Stabilize

The LP was at 97% of oracle. Pushing it to 98% (the threshold that unblocks redemptions and minting) required moving the price by approximately **1 percentage point** — about 0.3% of the Bank's reserves (~650 ERG).

Instead, the intervention used the **full 1% cap (2,181 ERG)** — pushing the price all the way to 99.7%. The extra 1.7% of price movement beyond what was needed created the arbitrage opportunity.

The arbitrageur didn't stabilize the protocol out of goodwill. They:

1. **Waited** for someone else (us) to trigger tracking98 — contributing nothing to the 40-hour outage
2. **Front-loaded** their buy before firing intervention — maximizing their spread
3. **Used the full 1% cap** — extracting maximum Bank ERG into the LP for maximum price impact
4. **Sold immediately after** — taking profit while the protocol did the actual work of buying USE at a discount

### The Bank Paid for Their Profit

The 11.85 ERG profit came from the **Bank's reserves**. The Bank spent 2,181 ERG to buy USE from the LP. The arbitrageur captured 11.85 ERG of that by buying before and selling after. The Bank still got its USE at a discount, but 0.5% of the intervention value leaked to the arbitrageur.

### This Is Repeatable

Every intervention creates the same opportunity. The tracking trigger is the signal. The 20-block waiting period gives arbitrageurs time to position. The 1% cap creates a predictable price impact to front-run.

At 2 interventions per day during a depeg, that's ~24 ERG/day of risk-free extraction.

---

## The Fix

We've reduced our intervention bot's cap from 1% to **0.5%** of Bank reserves. This:

- Still pushes the price above 98% (unblocking redemptions)
- Halves the price impact available to sandwich
- Reduces arbitrage profit from ~12 ERG to ~3 ERG (barely worth the capital + timing risk)
- Means two interventions may be needed instead of one, but at 360 blocks apart, this is acceptable

The bot code is open-source at **https://github.com/Degens-World/dexy-peg-bots** — anyone can run their own with whatever cap they choose.

---

## Recommendations for Protocol Design

1. **Lower the contract's max intervention cap** from 1% to 0.5% via governance update
2. **Use commit-reveal for intervention timing** — hide the intervention TX until it's mined, preventing front-running
3. **Combine tracking trigger + intervention** into a single TX (eliminating the 20-block positioning window)
4. **Add a minimum depeg duration** before intervention — if the price naturally recovers within N blocks, don't intervene at all (the tracking mechanism partially does this, but the threshold is low at 20 blocks)

---

*Report by CQ
 — March 29, 2026*
*White-hat security research for the Ergo community*
