# Vendure Seller Scoring Plugin

The `SellerScoringPlugin` automatically and continuously scores each marketplace seller on two
operational metrics — **fulfillment SLA adherence** and **cancellation/return rate** — derived
entirely from existing order, fulfillment, and refund data. It persists a current score plus a full
immutable history, surfaces the results in the React admin dashboard, and flags sellers whose current
score falls below a configurable threshold.

> **The plugin only flags underperforming sellers for human review. It never auto-suspends,
> deactivates, or removes a seller.** A human always reviews the flagged seller and decides on next
> steps.

`npm install @vendure/seller-scoring-plugin`

## Registration

Add the plugin to your Vendure server configuration and configure the two plugin options via the
static `init()` method:

```ts
import { SellerScoringPlugin } from '@vendure/seller-scoring-plugin';
import { VendureConfig } from '@vendure/core';

export const config: VendureConfig = {
    // ...
    plugins: [
        SellerScoringPlugin.init({
            // Fulfillments must ship within this many hours of order placement
            // to count towards the fulfillment SLA metric. Default: 48.
            slaHours: 48,
            // Sellers whose current composite score (0–100) falls below this
            // value are flagged for review.
            flaggingThreshold: 70,
        }),
    ],
};
```

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `slaHours` | `number` | `48` | A fulfillment must ship within this many hours of order placement to count as within-SLA. |
| `flaggingThreshold` | `number` | — | Sellers whose current composite score is below this `0–100` value are flagged. Configure a value that suits your marketplace (e.g. `70`). |

## Scoring

Each seller's composite score is computed on a **0–100** scale over a **rolling 90-day window** of orders:

```text
composite = 100 × (0.5 × FulfillmentSLA + 0.5 × (1 − CancellationReturnRate))

FulfillmentSLA          = fraction of fulfillments shipped within the configured slaHours
                          (default 48h) measured from order placement
CancellationReturnRate  = fraction of orders in the window that were cancelled or refunded
Window                  = rolling 90 days of orders
```

An equal weight (0.5 / 0.5) is applied to the fulfillment SLA adherence and the complement of the
cancellation/return rate, so a higher composite score means better operational performance.

### Domain rules

- If a seller has one or more orders but **zero** fulfillments in the window, `FulfillmentSLA = 0`
  (unshipped demand counts fully against SLA).
- A seller with **no orders at all** in the window has a **null** score (not `0`), is excluded from
  flagging, and produces **no** history snapshot for that recalculation.

### Worked examples

- 8 of 10 fulfillments shipped within 48h (`FulfillmentSLA = 0.8`) and 1 of 10 orders
  cancelled/refunded (`CancellationReturnRate = 0.1`):
  `100 × (0.5 × 0.8 + 0.5 × 0.9) = 85.0`
- All orders cancelled (zero fulfillments ⇒ `FulfillmentSLA = 0`, `CancellationReturnRate = 1.0`):
  `100 × (0.5 × 0 + 0.5 × (1 − 1.0)) = 0.0`

## How it works

- Scores are recomputed automatically whenever a relevant order, fulfillment, or refund event fires
  (via the Vendure `EventBus`) — no polling or manual trigger is required for normal operation.
- Every non-null recalculation writes one immutable `SellerScoreSnapshot` row, preserving a full,
  queryable history. Null-score recalculations (no orders in the window) write no snapshot.
- Results surface in the admin dashboard on the seller detail page (current score, per-metric
  breakdown, and history), in a dedicated **Flagged Sellers** list view, and in a summary widget.

## Admin API

The plugin extends the Admin API with exactly the following operations (nothing more):

```graphql
extend type Query {
    sellerScore(sellerId: ID!): SellerScore
    flaggedSellers: [SellerScore!]!
}

extend type Mutation {
    recalculateSellerScore(sellerId: ID!): SellerScore
}
```

- `sellerScore` returns the seller's current score plus `history: [SellerScoreSnapshot]`.
- `flaggedSellers` returns **only** sellers whose current score is below the configured threshold.
- `recalculateSellerScore` forces a recalculation for one seller.

Queries require the `ReadSeller` permission; the mutation requires `UpdateSeller`.
