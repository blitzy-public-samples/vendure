import { Injectable } from '@nestjs/common';
import {
    EventBus,
    Fulfillment,
    FulfillmentStateTransitionEvent,
    ID,
    Logger,
    Order,
    OrderStateTransitionEvent,
    RefundStateTransitionEvent,
    RequestContext,
    TransactionalConnection,
} from '@vendure/core';

import { loggerCtx } from '../constants';
import { SellerScoringService } from '../services/seller-scoring.service';

/**
 * @description
 * Subscribes to the core order, fulfillment, and refund state-transition events and
 * triggers a recalculation of the affected seller's performance score. This is the
 * plugin's only coupling to the order lifecycle and integrates purely via the
 * {@link EventBus} — it never patches or calls core order/fulfillment/refund internals.
 *
 * A failure while recalculating a score is logged and swallowed so that it can never
 * disrupt the originating order/fulfillment/refund transaction.
 *
 * @since 3.8.0
 * @docsCategory core plugins/SellerScoringPlugin
 */
@Injectable()
export class OrderEventsSubscriber {
    constructor(
        private eventBus: EventBus,
        private connection: TransactionalConnection,
        private sellerScoringService: SellerScoringService,
    ) {}

    /**
     * @description
     * Registers debounce-free subscriptions to the three domain events that can affect a
     * seller's score. Called exactly once by `SellerScoringPlugin.onApplicationBootstrap()`;
     * this is the single, canonical place where every `EventBus` subscription of the plugin
     * is wired up. The plugin class delegates all subscription wiring here and never
     * subscribes itself, which guarantees each event is subscribed exactly once (no double
     * subscription).
     *
     * Each subscription delegates to a private async handler via `void ...` (fire-and-forget):
     * the recalculation runs asynchronously and the RxJS pipeline is never awaited, so the
     * emitting order/fulfillment/refund transaction is neither blocked nor otherwise affected.
     *
     * The subscriptions are intentionally debounce-free — no `debounceTime`, `throttle`, or
     * `buffer` rate-limiting operator is applied — so that every relevant event produces its
     * own recalculation and no score snapshots are dropped when several events fire in quick
     * succession for the same seller.
     *
     * @since 3.8.0
     */
    register(): void {
        this.eventBus.ofType(OrderStateTransitionEvent).subscribe(event => {
            void this.handleOrders(event.ctx, [event.order]);
        });
        this.eventBus.ofType(RefundStateTransitionEvent).subscribe(event => {
            // The refund event carries a direct `order` reference (in addition to `refund`),
            // so no Payment → Order traversal is needed to reach the affected order here.
            void this.handleOrders(event.ctx, [event.order]);
        });
        this.eventBus.ofType(FulfillmentStateTransitionEvent).subscribe(event => {
            void this.handleFulfillment(event.ctx, event.fulfillment);
        });
    }

    /**
     * @description
     * Resolves the affected seller(s) for the given orders and recalculates each one's score
     * via {@link SellerScoringService.recalculate}. Any error — whether from the read-only
     * seller resolution or from the scoring itself — is logged via {@link loggerCtx} and
     * swallowed, so it can never surface as an unhandled promise rejection nor disrupt the
     * emitting order/fulfillment/refund transaction (backward-compatibility guarantee).
     *
     * The context used both for the read-only traversal and for `recalculate` is `event.ctx`,
     * the context of the emitting transaction, which is the correct default. (Fresh-context
     * fallback: in the rare case where just-committed data is not yet visible under `event.ctx`,
     * a fresh admin context could be created with `RequestContextService.create({ apiType: 'admin' })`
     * — the pattern used by the multivendor example plugin. That service is intentionally NOT
     * injected here: `event.ctx` is sufficient, and omitting it honours the mandated
     * three-argument constructor.)
     */
    private async handleOrders(ctx: RequestContext, orders: Order[]): Promise<void> {
        try {
            const sellerIds = await this.resolveSellerIds(ctx, orders);
            for (const sellerId of sellerIds) {
                // The service internally guards missing / soft-deleted sellers, so this
                // subscriber only needs to resolve the id(s) and delegate.
                await this.sellerScoringService.recalculate(ctx, sellerId);
            }
        } catch (err: any) {
            Logger.error(err?.message ?? String(err), loggerCtx);
        }
    }

    /**
     * @description
     * Loads the orders attached to a fulfillment and recalculates their seller(s). The event
     * payload is not guaranteed to have the `orders` relation (nor the nested `channels`)
     * hydrated, so the fulfillment is reloaded with those relations before delegating to
     * {@link handleOrders} — this keeps the seller-resolution and recalculation logic in a
     * single place. The hydration read is wrapped in its own try/catch so that a database read
     * failure is logged and swallowed rather than escaping as an unhandled rejection.
     */
    private async handleFulfillment(ctx: RequestContext, fulfillment: Fulfillment): Promise<void> {
        try {
            const hydrated = await this.connection.getRepository(ctx, Fulfillment).findOne({
                where: { id: fulfillment.id },
                relations: { orders: { channels: true } },
            });
            const orders = hydrated?.orders ?? [];
            await this.handleOrders(ctx, orders);
        } catch (err: any) {
            Logger.error(err?.message ?? String(err), loggerCtx);
        }
    }

    /**
     * @description
     * Resolves the distinct, non-null seller ids attributed to the given orders via the
     * `Order.channels → Channel.sellerId` relationship. This is a strictly read-only traversal
     * of core data: it only reads `Order` and `Channel` and never writes to them (or to any
     * other core entity). The only writes in the whole feature happen inside the service, to
     * the plugin-owned `SellerScore` / `SellerScoreSnapshot` entities.
     *
     * Orders are reloaded with their `channels` relation when it is not already present, because
     * event payloads are not guaranteed to have relations hydrated. A `Set` deduplicates the
     * result so that each seller is recalculated at most once per event — a single fulfillment
     * can span multiple orders, and a per-seller order can carry multiple channels.
     */
    private async resolveSellerIds(ctx: RequestContext, orders: Order[]): Promise<ID[]> {
        const sellerIds = new Set<ID>();
        for (const order of orders) {
            let channels = order.channels;
            if (!channels) {
                const hydrated = await this.connection.getRepository(ctx, Order).findOne({
                    where: { id: order.id },
                    relations: { channels: true },
                });
                channels = hydrated?.channels ?? [];
            }
            // Aggregate-order note: Vendure splits an order into an aggregate order
            // (`type = OrderType.Aggregate`, on the default channel) plus per-seller orders.
            // Resolving seller ids from an order's channels may therefore include the default
            // channel's seller, if one is configured. This is harmless: the SellerScoringService
            // explicitly excludes `OrderType.Aggregate` orders from the score computation, and the
            // `Set` above keeps recalculations minimal. Order-splitting logic is intentionally not
            // re-implemented here (out of scope) — we simply resolve seller ids and delegate.
            for (const channel of channels) {
                if (channel.sellerId != null) {
                    sellerIds.add(channel.sellerId);
                }
            }
        }
        return Array.from(sellerIds);
    }
}
