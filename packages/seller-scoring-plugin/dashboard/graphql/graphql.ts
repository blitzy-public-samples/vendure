/**
 * @description
 * Re-exports the `@vendure/dashboard` `graphql()` tag function and the `gql.tada`
 * type helpers, so the Seller Scoring dashboard extension can author typed Admin API
 * operation documents (see `./operations.ts`) that are validated against the running
 * server schema. The plugin's Admin API schema extension (`SellerScore`,
 * `SellerScoreSnapshot`, `sellerScore`, `flaggedSellers`, `recalculateSellerScore`)
 * is registered server-side by {@link SellerScoringPlugin}, so these documents resolve
 * correctly at runtime.
 *
 * @since 3.8.0
 */
export { graphql } from '@/vdb/graphql/graphql.js';
export type { ResultOf, VariablesOf, FragmentOf } from 'gql.tada';
