import { graphql } from './graphql.js';

/**
 * @description
 * Fragment selecting the current-score fields of the plugin's `SellerScore`
 * Admin API type. `score`, `fulfillmentSla`, `cancellationReturnRate` and
 * `lastCalculatedAt` are nullable (null ⇒ the seller had no orders in the
 * 90-day window); `flagged` is non-null.
 *
 * @since 3.8.0
 */
export const sellerScoreFields = graphql(`
    fragment sellerScoreFields on SellerScore {
        id
        sellerId
        score
        fulfillmentSla
        cancellationReturnRate
        lastCalculatedAt
        flagged
    }
`);

/**
 * @description
 * Fragment selecting the immutable snapshot fields of `SellerScoreSnapshot`
 * (one row per non-null recalculation). All fields are non-null.
 *
 * @since 3.8.0
 */
export const sellerScoreSnapshotFields = graphql(`
    fragment sellerScoreSnapshotFields on SellerScoreSnapshot {
        id
        score
        fulfillmentSla
        cancellationReturnRate
        calculatedAt
    }
`);

/**
 * @description
 * Loads a single seller's current score, the related core `Seller` ({ id, name }),
 * and the full ordered score `history`. Backs the seller-detail page block (Flow 1).
 *
 * @since 3.8.0
 */
export const getSellerScoreDocument = graphql(
    `
        query GetSellerScore($sellerId: ID!) {
            sellerScore(sellerId: $sellerId) {
                ...sellerScoreFields
                seller {
                    id
                    name
                }
                history {
                    ...sellerScoreSnapshotFields
                }
            }
        }
    `,
    [sellerScoreFields, sellerScoreSnapshotFields],
);

/**
 * @description
 * Returns ONLY the sellers currently below the configured flagging threshold
 * (the stored `flagged = true` rows). Backs the Flagged Sellers route (Flow 2)
 * and the summary widget. This is NOT a generic all-sellers list.
 *
 * @since 3.8.0
 */
export const getFlaggedSellersDocument = graphql(
    `
        query GetFlaggedSellers {
            flaggedSellers {
                ...sellerScoreFields
                seller {
                    id
                    name
                }
            }
        }
    `,
    [sellerScoreFields],
);

/**
 * @description
 * Forces a recalculation of one seller's score and returns the updated
 * `SellerScore`. Backs the per-row Recalculate action on the Flagged Sellers route.
 *
 * @since 3.8.0
 */
export const recalculateSellerScoreDocument = graphql(
    `
        mutation RecalculateSellerScore($sellerId: ID!) {
            recalculateSellerScore(sellerId: $sellerId) {
                ...sellerScoreFields
            }
        }
    `,
    [sellerScoreFields],
);
