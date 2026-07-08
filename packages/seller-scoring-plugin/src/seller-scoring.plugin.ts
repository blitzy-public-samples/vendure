import { OnApplicationBootstrap } from '@nestjs/common';
import { PluginCommonModule, VendurePlugin } from '@vendure/core';

import { adminApiExtensions } from './api/api-extensions';
import { SellerScoreAdminResolver } from './api/seller-score-admin.resolver';
import { SellerScoreEntityResolver } from './api/seller-score-entity.resolver';
import { SELLER_SCORING_PLUGIN_OPTIONS } from './constants';
import { SellerScoreSnapshot } from './entities/seller-score-snapshot.entity';
import { SellerScore } from './entities/seller-score.entity';
import { OrderEventsSubscriber } from './event-subscribers/order-events.subscriber';
import { SellerScoringService } from './services/seller-scoring.service';
import { SellerScoringPluginOptions } from './types';

/**
 * @description
 * The `SellerScoringPlugin` automatically scores each marketplace seller on two
 * operational metrics — fulfillment SLA adherence and cancellation/return rate —
 * blended into a single composite score on a 0–100 scale over a rolling 90-day
 * window of orders. Scores are recalculated automatically in response to the core
 * order, fulfillment, and refund domain events (via the {@link OrderEventsSubscriber}),
 * a full history of every non-null calculation is persisted as immutable snapshots,
 * the results are surfaced in the admin dashboard, and any seller whose current
 * composite score falls below a configurable threshold is flagged for review.
 *
 * The plugin is entirely additive and read-only with respect to the core data model:
 * it reads `Seller`, `Order`, `Fulfillment`, and `Refund` (and their relations)
 * without ever modifying them, extends only the Admin GraphQL API (the Shop API is
 * left untouched), and creates only its own `seller_score` and `seller_score_snapshot`
 * tables. It couples to the order lifecycle exclusively through the {@link EventBus}.
 *
 * The plugin never auto-suspends, deactivates, or removes a seller — it flags only.
 * A human reviews the flagged seller and decides on next steps.
 *
 * @example
 * ```ts
 * import { SellerScoringPlugin } from '@vendure/seller-scoring-plugin';
 *
 * const config: VendureConfig = {
 *   plugins: [
 *     // `slaHours` defaults to 48 when omitted; `flaggingThreshold` is required.
 *     SellerScoringPlugin.init({ slaHours: 48, flaggingThreshold: 70 }),
 *   ],
 * };
 * ```
 *
 * @since 3.8.0
 * @docsCategory core plugins/SellerScoringPlugin
 */
@VendurePlugin({
    imports: [PluginCommonModule],
    // Register both new entities so TypeORM creates and reads the `seller_score` and
    // `seller_score_snapshot` tables. This is strictly additive — no existing entity,
    // table, column, or relation is altered.
    entities: [SellerScore, SellerScoreSnapshot],
    // Extend ONLY the Admin API (the Shop API is intentionally left untouched). The
    // schema and resolvers expose exactly the fixed surface: the `sellerScore` and
    // `flaggedSellers` queries and the `recalculateSellerScore` mutation.
    adminApiExtensions: {
        schema: adminApiExtensions,
        resolvers: [SellerScoreAdminResolver, SellerScoreEntityResolver],
    },
    providers: [
        // Expose the statically-stored, resolved options behind the DI injection token
        // so the service, subscriber, and resolvers can inject them. This mirrors the
        // verified pattern used by the multivendor-plugin and email-plugin.
        { provide: SELLER_SCORING_PLUGIN_OPTIONS, useFactory: () => SellerScoringPlugin.options },
        SellerScoringService,
        OrderEventsSubscriber,
    ],
    // NOTE: the dashboard path is resolved by the `@vendure/dashboard` Vite plugin
    // RELATIVE TO THE DIRECTORY OF THIS PLUGIN SOURCE FILE
    // (packages/seller-scoring-plugin/src). The dashboard entry lives at the
    // package-root sibling `dashboard/` folder, so the correct value is
    // '../dashboard/index.tsx' (NOT './dashboard/index.tsx'). This differs from
    // sibling plugins whose plugin class sits at the package root; here the class is
    // nested one level deeper under `src/`, hence the leading '../'.
    dashboard: '../dashboard/index.tsx',
    compatibility: '^3.0.0',
})
export class SellerScoringPlugin implements OnApplicationBootstrap {
    /**
     * @description
     * The resolved plugin options, populated by {@link SellerScoringPlugin.init} and
     * returned by the `SELLER_SCORING_PLUGIN_OPTIONS` provider factory.
     */
    static options: SellerScoringPluginOptions;

    /**
     * @description
     * Configures the plugin and returns the plugin class so it can be placed directly
     * in the VendureConfig `plugins` array. The `slaHours` option defaults to `48`
     * when omitted; `flaggingThreshold` is required and has no default.
     *
     * @since 3.8.0
     */
    static init(
        options: Partial<SellerScoringPluginOptions> & { flaggingThreshold: number },
    ): typeof SellerScoringPlugin {
        // Merge the default(s) first, then spread the caller's options so any provided
        // value (e.g. an explicit `slaHours`) overrides the default. `flaggingThreshold`
        // is supplied by the caller. Configuration is never hardcoded elsewhere in the
        // plugin — every consumer reads these options via the injection token.
        this.options = { slaHours: 48, ...options };
        return SellerScoringPlugin;
    }

    constructor(private orderEventsSubscriber: OrderEventsSubscriber) {}

    /**
     * @description
     * Wires up the plugin's {@link EventBus} subscriptions once the application has
     * bootstrapped. All subscription logic is delegated to the injectable
     * {@link OrderEventsSubscriber}, which is the single, canonical place where the
     * order, fulfillment, and refund state-transition events are subscribed — this
     * guarantees each event is subscribed exactly once (no double subscription) and
     * keeps the coupling to the order lifecycle purely event-based.
     */
    onApplicationBootstrap(): void {
        this.orderEventsSubscriber.register();
    }
}
