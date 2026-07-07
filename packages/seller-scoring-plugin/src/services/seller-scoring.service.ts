import { Inject, Injectable } from '@nestjs/common';
import { OrderType } from '@vendure/common/lib/generated-types';
import { ID, Logger, Order, RequestContext, Seller, TransactionalConnection } from '@vendure/core';
import { MoreThanOrEqual, Not } from 'typeorm';

import { loggerCtx, SELLER_SCORING_PLUGIN_OPTIONS } from '../constants';
import { SellerScoreSnapshot } from '../entities/seller-score-snapshot.entity';
import { SellerScore } from '../entities/seller-score.entity';
import { SellerScoringPluginOptions } from '../types';

/**
 * The rolling window over which a seller's orders are considered when scoring.
 * Fixed by the feature specification at 90 days (see AAP §0.2.5); this is a domain
 * constant, not a configurable option.
 */
const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Number of milliseconds in one hour. Used to convert the configurable `slaHours`
 * plugin option into a millisecond delta for the fulfillment-SLA comparison.
 */
const MS_PER_HOUR = 60 * 60 * 1000;

/**
 * @description
 * Computes and persists each marketplace seller's composite performance score
 * (fulfillment SLA adherence + cancellation/return rate) over a rolling 90-day
 * window, retaining a full snapshot history and flagging sellers below a
 * configurable threshold. This service only flags — it never suspends, deactivates,
 * or removes a seller.
 *
 * The composite score is defined verbatim as:
 *
 * ```text
 * composite = 100 × (0.5 × FulfillmentSLA + 0.5 × (1 − CancellationReturnRate))
 * ```
 *
 * where `FulfillmentSLA` is the fraction of fulfillments shipped within the
 * configured `slaHours` of order placement, and `CancellationReturnRate` is the
 * fraction of in-window orders that were cancelled or refunded. A seller with no
 * orders in the window has a `null` score (not `0`) and produces no snapshot.
 *
 * The service is stateless with respect to the domain: it reads (but never mutates)
 * the core `Seller`, `Order`, `Fulfillment`, `Payment`, and `Refund` entities, and
 * only ever writes the plugin-owned {@link SellerScore} and {@link SellerScoreSnapshot}
 * entities. It is invoked by the plugin's event subscriber (on order/fulfillment/refund
 * domain events) and by the Admin API resolvers.
 *
 * @since 3.8.0
 * @docsCategory core plugins/SellerScoringPlugin
 */
@Injectable()
export class SellerScoringService {
    constructor(
        private connection: TransactionalConnection,
        @Inject(SELLER_SCORING_PLUGIN_OPTIONS) private options: SellerScoringPluginOptions,
    ) {}

    /**
     * @description
     * Recalculates and persists the composite performance score for a single seller
     * over the rolling 90-day window, following the deterministic flow specified in
     * AAP §0.3.3:
     *
     * 1. A missing or soft-deleted seller is skipped entirely (no order query, no
     *    upsert, no snapshot); the existing {@link SellerScore} — including its flag
     *    and history — is retained and returned unchanged.
     * 2. A seller with no orders in the window receives a `null` score: the current
     *    {@link SellerScore} row is upserted with null metrics and `flagged = false`,
     *    and **no** {@link SellerScoreSnapshot} is written.
     * 3. Otherwise the composite is computed, the current {@link SellerScore} is
     *    upserted, and exactly one immutable {@link SellerScoreSnapshot} is inserted.
     *
     * This method is invoked once per relevant domain event, so two events firing in
     * quick succession for the same seller produce two recalculations (and, for
     * non-null results, two snapshots) with none dropped.
     *
     * @since 3.8.0
     */
    async recalculate(ctx: RequestContext, sellerId: ID): Promise<SellerScore | undefined> {
        // 1. Load the seller and guard against soft-delete / absence.
        // `Seller` is `SoftDeletable` (`deletedAt: Date | null`). A soft-deleted or
        // non-existent seller is skipped: we perform NO order query, NO upsert, and NO
        // snapshot, and simply return the existing SellerScore (or undefined). This
        // honours AAP §0.9.3: a seller that becomes inactive after being flagged retains
        // its flag and history and is excluded from further event-driven recalculation.
        const seller = await this.connection.getRepository(ctx, Seller).findOne({ where: { id: sellerId } });
        if (!seller || seller.deletedAt != null) {
            Logger.verbose(
                `Skipping recalculation for missing/soft-deleted seller ${String(sellerId)}`,
                loggerCtx,
            );
            return this.getScore(ctx, sellerId);
        }

        // 2. Resolve the seller's in-window orders.
        // Seller-order selection rule (validated against order-splitter.ts / OrderSellerStrategy):
        // the aggregate order is `type = OrderType.Aggregate` on the default channel;
        // per-seller orders are `type = OrderType.Seller` with `channels = [sellerChannel,
        // defaultChannel]`; unsplit single-seller orders are `type = OrderType.Regular` on
        // the seller's channel. An order is attributed to seller S iff `order.channels`
        // contains a channel whose `sellerId === S.id` AND `order.type !== OrderType.Aggregate`
        // (excluding the aggregate order prevents double-counting its per-seller children).
        //   - `channels: { sellerId }`      → TypeORM relation-where on `Channel.sellerId`.
        //   - `type: Not(OrderType.Aggregate)` → excludes the aggregate order.
        //   - `orderPlacedAt: MoreThanOrEqual(cutoff)` → keeps only orders placed within the
        //     trailing 90 days, and naturally excludes rows with a NULL `orderPlacedAt`.
        const now = new Date();
        const cutoff = new Date(now.getTime() - NINETY_DAYS_MS);
        // ROBUSTNESS NOTE: loading two collection relations in a single `find`
        // (`fulfillments` is ManyToMany, `payments.refunds` is OneToMany) can, on some SQL
        // drivers, multiply the joined rows. TypeORM de-duplicates the root `Order` entities
        // by id and hydrates the nested arrays, so this is generally safe. If, during e2e
        // validation, row duplication or missing nested rows is ever observed, switch to an
        // explicit QueryBuilder with leftJoinAndSelect for `channels`, `fulfillments`,
        // `payments`, and `payment.refunds` filtered by `channel.sellerId`, `order.type`, and
        // `order.orderPlacedAt`, or split into per-collection queries. The unit spec mocks the
        // repository, so the exact query mechanism is not exercised there.
        const orders = await this.connection.getRepository(ctx, Order).find({
            where: {
                channels: { sellerId },
                type: Not(OrderType.Aggregate),
                orderPlacedAt: MoreThanOrEqual(cutoff),
            },
            relations: {
                fulfillments: true,
                payments: { refunds: true },
            },
        });

        // 3. No orders in window → null score, and NO snapshot (AAP §0.2.5: "null, not 0").
        if (orders.length === 0) {
            const nullScore = await this.upsertSellerScore(ctx, sellerId, {
                score: null,
                fulfillmentSla: null,
                cancellationReturnRate: null,
                flagged: false,
                lastCalculatedAt: now,
            });
            Logger.verbose(`Seller ${String(sellerId)} has no orders in window; score=null`, loggerCtx);
            return nullScore;
        }

        // 4. CancellationReturnRate = (# orders cancelled OR refunded) / (# in-window orders).
        // An order counts at most once even if it is both cancelled and refunded.
        //   - cancelled ⇔ order.state === 'Cancelled'.
        //   - refunded  ⇔ the order has at least one Refund in state 'Settled', reached via
        //     order.payments[].refunds[].
        let cancelledOrReturned = 0;
        for (const order of orders) {
            const isCancelled = order.state === 'Cancelled';
            const isRefunded = (order.payments ?? []).some(payment =>
                (payment.refunds ?? []).some(refund => refund.state === 'Settled'),
            );
            if (isCancelled || isRefunded) {
                cancelledOrReturned++;
            }
        }
        const cancellationReturnRate = cancelledOrReturned / orders.length;

        // 5. FulfillmentSLA = (# fulfillments shipped within slaHours) / (# fulfillments).
        // The denominator is ALL fulfillments across the in-window orders; the numerator is
        // those whose shipped timestamp is within `slaHours` of order placement. The shipped
        // timestamp is `fulfillment.createdAt` — the Fulfillment entity has no dedicated
        // shippedAt/deliveredAt column (state-transition times live only in history records).
        // DOMAIN RULE (AAP §0.2.5): a seller with ≥1 in-window order but ZERO fulfillments has
        // FulfillmentSLA = 0 (unshipped demand counts fully against SLA). The
        // `totalFulfillments === 0 ? 0 : ...` expression enforces this (we only reach here when
        // orders.length > 0). `slaHours` is sourced exclusively from the injected options.
        let totalFulfillments = 0;
        let withinSla = 0;
        const slaMs = this.options.slaHours * MS_PER_HOUR;
        for (const order of orders) {
            const placedAt = order.orderPlacedAt ? new Date(order.orderPlacedAt).getTime() : undefined;
            for (const fulfillment of order.fulfillments ?? []) {
                totalFulfillments++;
                if (placedAt != null) {
                    const shippedAt = new Date(fulfillment.createdAt).getTime();
                    if (shippedAt - placedAt <= slaMs) {
                        withinSla++;
                    }
                }
            }
        }
        const fulfillmentSla = totalFulfillments === 0 ? 0 : withinSla / totalFulfillments;

        // 6. Composite + flag. The formula is implemented verbatim, and the 2-decimal rounding
        // is essential so that the specified exact values assert deterministically: e.g.
        // `0.5 * 0.8 + 0.5 * 0.9` evaluates to `0.8500000000000001` in IEEE-754, so
        // `100 * (...)` = `85.00000000000001`; `Math.round(85.00000000000001 * 100) / 100 === 85`.
        // `flagged` uses a strict `<` against the configured threshold: a composite exactly
        // equal to the threshold is NOT flagged. Setting `flagged` is the ONLY consequence —
        // the Seller entity itself is never modified (flag-only, AAP §0.2.3).
        const composite = this.round(100 * (0.5 * fulfillmentSla + 0.5 * (1 - cancellationReturnRate)));
        const flagged = composite < this.options.flaggingThreshold;

        // 7. Upsert the current SellerScore and insert exactly one immutable snapshot.
        // Snapshot integrity (AAP §0.9.3): exactly one SellerScoreSnapshot per non-null
        // recalculation, always freshly constructed and inserted (never updated).
        const sellerScore = await this.upsertSellerScore(ctx, sellerId, {
            score: composite,
            fulfillmentSla,
            cancellationReturnRate,
            flagged,
            lastCalculatedAt: now,
        });
        await this.connection.getRepository(ctx, SellerScoreSnapshot).save(
            new SellerScoreSnapshot({
                sellerId,
                score: composite,
                fulfillmentSla,
                cancellationReturnRate,
                calculatedAt: now,
            }),
        );
        Logger.verbose(
            `Recalculated seller ${String(sellerId)}: score=${composite} sla=${fulfillmentSla} ` +
                `crr=${cancellationReturnRate} flagged=${String(flagged)}`,
            loggerCtx,
        );
        return sellerScore;
    }

    /**
     * @description
     * Returns the current {@link SellerScore} for the given seller, or `undefined` if
     * the seller has never been scored. Backs the `sellerScore(sellerId)` Admin query.
     *
     * @since 3.8.0
     */
    getScore(ctx: RequestContext, sellerId: ID): Promise<SellerScore | undefined> {
        return this.connection
            .getRepository(ctx, SellerScore)
            .findOne({ where: { sellerId } })
            .then(row => row ?? undefined);
    }

    /**
     * @description
     * Returns only the sellers that are currently flagged — i.e. whose composite score
     * was below the configured threshold as of their last recalculation — ordered by
     * ascending score (worst first). Backs the `flaggedSellers` Admin query.
     *
     * This relies on the persisted `flagged` boolean rather than re-filtering by the
     * live threshold, honouring AAP §0.9.3: a threshold change is applied only at each
     * seller's next recalculation (there is no bulk immediate re-flag). Null-score rows
     * are never flagged, so they are inherently excluded from the result.
     *
     * @since 3.8.0
     */
    getFlaggedSellers(ctx: RequestContext): Promise<SellerScore[]> {
        return this.connection.getRepository(ctx, SellerScore).find({
            where: { flagged: true },
            order: { score: 'ASC' },
        });
    }

    /**
     * @description
     * Returns the full, chronologically-ordered history of {@link SellerScoreSnapshot}
     * rows for a seller (oldest first). Backs the `SellerScore.history` field resolver.
     *
     * @since 3.8.0
     */
    getHistory(ctx: RequestContext, sellerId: ID): Promise<SellerScoreSnapshot[]> {
        return this.connection.getRepository(ctx, SellerScoreSnapshot).find({
            where: { sellerId },
            order: { calculatedAt: 'ASC' },
        });
    }

    /**
     * Upserts the single current {@link SellerScore} row for a seller. There is exactly
     * one current-score row per seller (enforced by a unique index on `sellerId`), so an
     * existing row is loaded and mutated in place; otherwise a new row is created. Only
     * the score, per-metric values, flag, and last-calculated timestamp are written — the
     * `sellerId` reference is set once on creation and never changed.
     */
    private async upsertSellerScore(
        ctx: RequestContext,
        sellerId: ID,
        data: Pick<
            SellerScore,
            'score' | 'fulfillmentSla' | 'cancellationReturnRate' | 'flagged' | 'lastCalculatedAt'
        >,
    ): Promise<SellerScore> {
        const repo = this.connection.getRepository(ctx, SellerScore);
        let sellerScore = await repo.findOne({ where: { sellerId } });
        if (!sellerScore) {
            sellerScore = new SellerScore({ sellerId });
        }
        sellerScore.score = data.score;
        sellerScore.fulfillmentSla = data.fulfillmentSla;
        sellerScore.cancellationReturnRate = data.cancellationReturnRate;
        sellerScore.flagged = data.flagged;
        sellerScore.lastCalculatedAt = data.lastCalculatedAt;
        return repo.save(sellerScore);
    }

    /**
     * Rounds a value to 2 decimal places. Required so that the composite score asserts to
     * the exact specified values (e.g. `85.0`, `0.0`) despite IEEE-754 floating-point
     * representation error.
     */
    private round(value: number): number {
        return Math.round(value * 100) / 100;
    }
}
