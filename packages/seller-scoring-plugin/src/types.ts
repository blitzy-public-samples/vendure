/**
 * @description
 * Configuration options for the {@link SellerScoringPlugin}, passed to the static
 * `SellerScoringPlugin.init()` method.
 *
 * @since 3.8.0
 * @docsCategory core plugins/SellerScoringPlugin
 */
export interface SellerScoringPluginOptions {
    /**
     * @description
     * A fulfillment must be shipped within this many hours of the order being placed
     * for it to count towards the fulfillment SLA metric.
     *
     * @default 48
     */
    slaHours: number;
    /**
     * @description
     * Sellers whose current composite score (on a 0–100 scale) falls strictly below
     * this threshold are flagged for review. The plugin only flags — it never
     * auto-suspends, deactivates, or removes a seller.
     */
    flaggingThreshold: number;
}
