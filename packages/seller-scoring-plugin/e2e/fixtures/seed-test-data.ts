/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * @file Deterministic programmatic seed helpers for the Seller Scoring plugin's
 * e2e suite and performance benchmark.
 *
 * This module is a **plain TypeScript helper** — it contains no `describe`/`it`
 * blocks and registers no test framework of its own. It is imported by the two
 * sibling files:
 *
 *  - `../seller-scoring.e2e-spec.ts` imports {@link seedSellerScenario},
 *    {@link SeededSeller} and {@link getSeededOrder}.
 *  - `../seller-scoring.bench.ts` imports {@link seedPerformanceData}.
 *
 * ## Why seed directly into the database rather than through the checkout API?
 *
 * The {@link SellerScoringService} scores a seller by reading the core
 * `Order.orderPlacedAt`, `Order.state`, `Order.type`, `Order.channels`,
 * `Order.fulfillments` and `Order.payments[].refunds` fields over a rolling
 * 90-day window. Producing the exact, assertable composite/per-metric values the
 * feature specification pins down (`85.0`, `0.0`, `null`, `70.0`) requires precise
 * control over:
 *
 *  - `orderPlacedAt` — to place an order inside/outside the 90-day window and
 *    inside/outside the fulfillment-SLA delta; and
 *  - the number of fulfillments/refunds/cancellations per seller.
 *
 * Neither is achievable through the public checkout API (which stamps
 * `orderPlacedAt` at "now" and drives state through the full order process), and
 * running 50,000 checkouts for the benchmark would be infeasible. Because scoring
 * never inspects `OrderLine`s, the seeded orders carry none — keeping the seed
 * lightweight.
 *
 * ## Read-only / additive-to-core guarantee
 *
 * Every write performed here is an INSERT of a *new* row (a new `Seller`,
 * `Channel`, `Order`, `Fulfillment`, `Payment`, `Refund`, or a plugin-owned
 * `SellerScore`/`SellerScoreSnapshot`). No core entity definition, column,
 * relation, or behaviour is ever altered, and only public `@vendure/core`
 * entry points are used (never deep `@vendure/core/dist/...` paths).
 *
 * @since 3.8.0
 * @docsCategory core plugins/SellerScoringPlugin
 */
import { OrderType } from '@vendure/common/lib/generated-types';
import { ID } from '@vendure/common/lib/shared-types';
import {
    ChannelService,
    Fulfillment,
    isGraphQlErrorResult,
    Order,
    Payment,
    Refund,
    RequestContextService,
    SellerService,
    TransactionalConnection,
} from '@vendure/core';
import { TestServer } from '@vendure/testing';

import { SellerScoreSnapshot } from '../../src/entities/seller-score-snapshot.entity';
import { SellerScore } from '../../src/entities/seller-score.entity';

/** Number of milliseconds in one hour — used to backdate `orderPlacedAt`. */
const MS_PER_HOUR = 60 * 60 * 1000;

/** Number of milliseconds in one day. */
const MS_PER_DAY = 24 * MS_PER_HOUR;

/**
 * A process-wide monotonically increasing counter appended (together with the
 * seller id and a timestamp) to generated `Channel.code`/`Channel.token` and
 * `Order.code` values. The e2e spec seeds many sellers into a single, shared,
 * persistent sqljs database, so these identifiers must be unique across every
 * call to avoid tripping the unique constraints on those columns.
 */
let uniqueCounter = 0;

/**
 * Resolves the shared runtime handles the seed helpers need from a booted
 * {@link TestServer}: an admin {@link RequestContext}, the
 * {@link TransactionalConnection}, and the core {@link ChannelService} /
 * {@link SellerService}.
 *
 * `server.app` is the underlying NestJS application; `.get(Token)` resolves a
 * (singleton-scoped) provider from its injector. All four providers are
 * registered by `@vendure/core`, so they resolve regardless of whether the
 * Seller Scoring plugin itself is loaded — which is what lets the benchmark's
 * baseline (no-plugin) server reuse this same helper.
 */
async function getContext(server: TestServer): Promise<{
    ctx: Awaited<ReturnType<RequestContextService['create']>>;
    connection: TransactionalConnection;
    channelService: ChannelService;
    sellerService: SellerService;
}> {
    const ctx = await server.app.get(RequestContextService).create({ apiType: 'admin' });
    const connection = server.app.get(TransactionalConnection);
    const channelService = server.app.get(ChannelService);
    const sellerService = server.app.get(SellerService);
    return { ctx, connection, channelService, sellerService };
}

/**
 * @description
 * Declarative description of the in-window order mix to seed for a single
 * scenario seller. Every count defaults to `0`/`false` when omitted. The
 * resulting data is engineered so the {@link SellerScoringService} computes a
 * deterministic, exactly-assertable score for the seller (see the scenario table
 * in the plugin's e2e spec).
 *
 * @since 3.8.0
 * @docsCategory core plugins/SellerScoringPlugin
 */
export interface ScenarioSpec {
    /** Human-readable seller name; also used as the returned `sellerName`. */
    name: string;
    /**
     * Orders (each carrying exactly one fulfillment) placed so that
     * `fulfillment.createdAt − orderPlacedAt <= slaHours` — i.e. shipped within
     * the SLA. Contributes to the numerator *and* denominator of `FulfillmentSLA`.
     */
    ordersWithinSla?: number;
    /**
     * Orders (each carrying exactly one fulfillment) placed so the delta is
     * `> slaHours` (but still inside the 90-day window) — shipped late.
     * Contributes to the denominator of `FulfillmentSLA` only.
     */
    ordersBeyondSla?: number;
    /** Orders with NO fulfillment at all (unshipped demand). */
    ordersNoFulfillment?: number;
    /**
     * Marks the FIRST `cancelledCount` seeded orders as `state = 'Cancelled'`.
     * Counts toward `CancellationReturnRate`. A cancelled order KEEPS whatever
     * fulfillment its category implies (the scoring service counts fulfillments
     * irrespective of order state — see {@link seedSellerScenario}).
     */
    cancelledCount?: number;
    /**
     * Gives the NEXT `refundedCount` seeded (non-cancelled) orders a `Settled`
     * refund. Counts toward `CancellationReturnRate`.
     */
    refundedCount?: number;
    /**
     * When `true`, ALL of this seller's orders are placed ~100 days ago, i.e.
     * older than the 90-day window, so the seller has no in-window orders and
     * therefore a `null` score.
     */
    outOfWindow?: boolean;
    /**
     * SLA threshold in hours. Defaults to the plugin's configured `slaHours`
     * (48). The within/beyond timestamps are derived from this value so custom
     * thresholds classify correctly.
     */
    slaHours?: number;
}

/**
 * @description
 * Identifiers returned after seeding one scenario seller, sufficient for the
 * e2e spec to query the Admin API, publish EventBus events, and reload orders.
 *
 * @since 3.8.0
 * @docsCategory core plugins/SellerScoringPlugin
 */
export interface SeededSeller {
    /** The created core `Seller`'s id. */
    sellerId: ID;
    /** The name the seller was created with (echoes {@link ScenarioSpec.name}). */
    sellerName: string;
    /** The id of the `Channel` bound to this seller (via `Channel.sellerId`). */
    channelId: ID;
    /** The seller channel's token (usable as the `vendure-token` header). */
    channelToken: string;
    /** The ids of every seeded order, in creation order. */
    orderIds: ID[];
}

/**
 * Internal per-order plan produced from a {@link ScenarioSpec}. Whether an order
 * carries a fulfillment is decided SOLELY by its category (within/beyond ⇒ yes,
 * none ⇒ no); the `cancelled`/`refunded` markers are applied independently and do
 * NOT add or remove a fulfillment.
 */
interface OrderPlan {
    category: 'within' | 'beyond' | 'none';
    placedAt: Date;
    hasFulfillment: boolean;
    withinSla: boolean;
    cancelled: boolean;
    refunded: boolean;
}

/**
 * @description
 * Seeds one core `Seller`, one `Channel` bound to that seller, and the exact
 * order/fulfillment/refund/cancellation mix described by `spec`, then returns the
 * created identifiers. The seeded data is fully deterministic — this function
 * introduces NO randomness — so the {@link SellerScoringService} computes the
 * scenario's pinned composite/per-metric values exactly.
 *
 * It deliberately performs NO recalculation: the caller (the e2e spec) decides
 * when and how a recalculation is triggered — either via the
 * `recalculateSellerScore` mutation or by publishing an EventBus event — so both
 * code paths can be exercised against the same seeded fixtures.
 *
 * ### How the fulfillment-SLA fraction is engineered
 *
 * The scoring service computes `FulfillmentSLA` as
 * `#(fulfillments shipped within slaHours) / #(all fulfillments across in-window
 * orders)` and, crucially, counts EVERY fulfillment regardless of its order's
 * state. A cancelled order therefore still contributes its fulfillment to the
 * denominator. This is why a cancelled order here KEEPS the fulfillment its
 * category implies: e.g. scenario `{ ordersWithinSla: 8, ordersBeyondSla: 2,
 * cancelledCount: 1 }` yields 10 fulfillments (8 within + 2 beyond) → SLA
 * `= 8/10 = 0.8`, while the single cancellation drives `CancellationReturnRate
 * = 1/10 = 0.1`, so the composite is `100 · (0.5·0.8 + 0.5·0.9) = 85.0`.
 *
 * The SLA delta is controlled purely by backdating the freely-settable
 * `Order.orderPlacedAt`: the fulfillment's own `createdAt` is a TypeORM
 * `@CreateDateColumn` (auto-stamped ≈now and not settable), so a "within" order
 * is placed 1h ago (delta ≤ slaHours) and a "beyond" order `slaHours + 52`h ago
 * (delta > slaHours, still inside the 90-day window; = 100h for the default 48h
 * SLA).
 *
 * @since 3.8.0
 */
export async function seedSellerScenario(server: TestServer, spec: ScenarioSpec): Promise<SeededSeller> {
    const { ctx, connection, channelService, sellerService } = await getContext(server);

    // --- 3a. Create the seller. -------------------------------------------------
    const seller = await sellerService.create(ctx, { name: spec.name });

    // --- 3b. Create the seller's channel. --------------------------------------
    // Currency/zones are inherited from the default channel (which is loaded with
    // its `defaultShippingZone`/`defaultTaxZone` relations). Binding `sellerId` is
    // what makes the scoring service's `Seller.channels → Channel.sellerId →
    // Order.channels` traversal attribute this seller's orders.
    const defaultChannel = await channelService.getDefaultChannel(ctx);
    const suffix = `${String(seller.id)}-${Date.now()}-${uniqueCounter++}`;
    const channelResult = await channelService.create(ctx, {
        code: `ss-${suffix}`,
        token: `ss-token-${suffix}`,
        sellerId: seller.id,
        defaultCurrencyCode: defaultChannel.defaultCurrencyCode,
        defaultLanguageCode: defaultChannel.defaultLanguageCode,
        pricesIncludeTax: defaultChannel.pricesIncludeTax,
        defaultShippingZoneId: defaultChannel.defaultShippingZone.id,
        defaultTaxZoneId: defaultChannel.defaultTaxZone.id,
    });
    // `ChannelService.create` returns an error-result union; narrow it before use.
    if (isGraphQlErrorResult(channelResult)) {
        throw new Error(`Failed to create seller channel: ${channelResult.message}`);
    }
    const channel = channelResult;

    // --- 3c. Compute the category timestamps (the core SLA/window trick). -------
    const slaHours = spec.slaHours ?? 48;
    const now = Date.now();
    const withinPlacedAt = new Date(now - 1 * MS_PER_HOUR); // delta ≈ 1h ≤ slaHours
    // `slaHours + 52`h is strictly greater than the SLA yet safely inside the
    // 90-day (2160h) window for any realistic threshold; equals 100h for slaHours=48.
    const beyondPlacedAt = new Date(now - (slaHours + 52) * MS_PER_HOUR);
    // ~100 days ago — older than the 90-day window, so excluded entirely.
    const outOfWindowPlacedAt = new Date(now - 100 * MS_PER_DAY);
    const resolvePlacedAt = (base: Date): Date => (spec.outOfWindow === true ? outOfWindowPlacedAt : base);

    // --- Build the ordered per-order plan. -------------------------------------
    // Order matters: within-SLA orders first, then beyond-SLA, then no-fulfillment.
    // Cancellations apply to the FIRST N; refunds to the NEXT M non-cancelled.
    const withinCount = spec.ordersWithinSla ?? 0;
    const beyondCount = spec.ordersBeyondSla ?? 0;
    const noneCount = spec.ordersNoFulfillment ?? 0;
    const plans: OrderPlan[] = [];
    for (let i = 0; i < withinCount; i++) {
        plans.push({
            category: 'within',
            placedAt: resolvePlacedAt(withinPlacedAt),
            hasFulfillment: true,
            withinSla: true,
            cancelled: false,
            refunded: false,
        });
    }
    for (let i = 0; i < beyondCount; i++) {
        plans.push({
            category: 'beyond',
            placedAt: resolvePlacedAt(beyondPlacedAt),
            hasFulfillment: true,
            withinSla: false,
            cancelled: false,
            refunded: false,
        });
    }
    for (let i = 0; i < noneCount; i++) {
        // A no-fulfillment order still needs an in-window `orderPlacedAt` so it
        // counts toward the order set (and thus the CRR denominator); reuse the
        // within timestamp (its SLA classification is irrelevant with no fulfillment).
        plans.push({
            category: 'none',
            placedAt: resolvePlacedAt(withinPlacedAt),
            hasFulfillment: false,
            withinSla: false,
            cancelled: false,
            refunded: false,
        });
    }

    // Apply cancellations to the first N orders.
    const cancelledCount = Math.min(spec.cancelledCount ?? 0, plans.length);
    for (let i = 0; i < cancelledCount; i++) {
        plans[i].cancelled = true;
    }
    // Apply Settled refunds to the next M non-cancelled orders.
    let refundsRemaining = spec.refundedCount ?? 0;
    for (let i = 0; i < plans.length && refundsRemaining > 0; i++) {
        if (!plans[i].cancelled) {
            plans[i].refunded = true;
            refundsRemaining--;
        }
    }

    // --- 3d–3f. Persist orders, fulfillments and refunds. ----------------------
    const orderRepo = connection.getRepository(ctx, Order);
    const fulfillmentRepo = connection.getRepository(ctx, Fulfillment);
    const paymentRepo = connection.getRepository(ctx, Payment);
    const refundRepo = connection.getRepository(ctx, Refund);
    const orderIds: ID[] = [];

    for (let index = 0; index < plans.length; index++) {
        const plan = plans[index];

        // Pre-save the fulfillment first: `Order.fulfillments` is a ManyToMany with
        // no cascade, so the related row must already exist before it can be linked.
        let fulfillment: Fulfillment | undefined;
        if (plan.hasFulfillment) {
            fulfillment = await fulfillmentRepo.save(
                new Fulfillment({
                    state: 'Shipped',
                    method: 'seed-fulfillment',
                    handlerCode: 'seed-handler',
                    trackingCode: '',
                }),
            );
        }

        const order = new Order({
            code: `SS-${String(seller.id)}-${now}-${index}`,
            state: plan.cancelled ? 'Cancelled' : 'PaymentSettled',
            // MUST be a Seller order — the scoring service excludes `Aggregate`.
            type: OrderType.Seller,
            active: false,
            orderPlacedAt: plan.placedAt,
            couponCodes: [],
            shippingAddress: {},
            billingAddress: {},
            currencyCode: defaultChannel.defaultCurrencyCode,
            subTotal: 0,
            subTotalWithTax: 0,
        });
        // Attribute the order to ONLY the seller's channel (isolation: no other
        // seller's `channels.sellerId` query can pick it up). Setting both owning
        // ManyToMany relations before a single save writes both join tables at once.
        order.channels = [channel];
        if (fulfillment) {
            order.fulfillments = [fulfillment];
        }
        const savedOrder = await orderRepo.save(order);
        orderIds.push(savedOrder.id);

        // A Settled refund (reached via order.payments[].refunds[]) is what makes an
        // order count toward CancellationReturnRate. Persist the payment first so the
        // refund can reference it by id.
        if (plan.refunded) {
            const savedPayment = await paymentRepo.save(
                new Payment({
                    method: 'seed-payment',
                    amount: 0,
                    state: 'Settled',
                    metadata: {},
                    order: savedOrder,
                }),
            );
            await refundRepo.save(
                new Refund({
                    items: 0,
                    shipping: 0,
                    adjustment: 0,
                    total: 0,
                    method: 'seed-refund',
                    state: 'Settled',
                    metadata: {},
                    paymentId: savedPayment.id,
                }),
            );
        }
    }

    return {
        sellerId: seller.id,
        sellerName: spec.name,
        channelId: channel.id,
        channelToken: channel.token,
        orderIds,
    };
}

/**
 * @description
 * Reloads a previously-seeded order with its `channels` relation eagerly loaded.
 * The e2e spec needs the populated `channels` collection to construct
 * `OrderStateTransitionEvent` / `RefundStateTransitionEvent` instances so that,
 * when published on the EventBus, the plugin's subscriber can resolve the seller
 * from `order.channels[].sellerId`.
 *
 * @since 3.8.0
 */
export async function getSeededOrder(server: TestServer, orderId: ID): Promise<Order> {
    const { ctx, connection } = await getContext(server);
    const order = await connection.getRepository(ctx, Order).findOne({
        // `ID` is `string | number`; TypeORM's `FindOptionsWhere` expects the
        // configured id column type, so the union is widened here.
        where: { id: orderId as any },
        relations: { channels: true },
    });
    if (!order) {
        throw new Error(`Seeded order ${String(orderId)} not found`);
    }
    return order;
}

/**
 * @description
 * Bulk seeder for the performance benchmark. Creates `opts.sellerCount` sellers
 * (each with one bound channel), bulk-inserts `opts.orderCount` orders spread
 * across those channels (all inside the 90-day window), and — only when
 * `opts.seedScores` is `true` — directly inserts one `SellerScore` (plus history
 * snapshots) per seller so the read resolvers return realistic data without
 * running hundreds of full recalculations.
 *
 * Unlike {@link seedSellerScenario}, this function MAY use randomness for
 * non-asserted bulk fields (e.g. how far back inside the window each order is
 * placed, and the exact score magnitudes) — the benchmark asserts only latency
 * and that `flaggedSellers` returns populated data, never exact values.
 *
 * @param opts.sellerCount       Number of sellers/channels to create.
 * @param opts.orderCount        Number of orders to bulk-insert (0 to skip).
 * @param opts.flaggedFraction   Fraction of seeded scores that are flagged
 *                               (`score < flaggingThreshold`). Default `0.2`.
 * @param opts.seedScores        When `true`, insert `SellerScore`(+snapshot) rows.
 *                               When `false` (default), seed sellers/orders only —
 *                               used by the baseline (no-plugin) server, whose
 *                               database has no `seller_score` table.
 * @param opts.flaggingThreshold Threshold that separates flagged vs. non-flagged
 *                               seeded scores. Default `70`.
 *
 * @since 3.8.0
 */
export async function seedPerformanceData(
    server: TestServer,
    opts: {
        sellerCount: number;
        orderCount: number;
        flaggedFraction?: number;
        seedScores?: boolean;
        flaggingThreshold?: number;
    },
): Promise<{ sellerIds: ID[] }> {
    const { ctx, connection, channelService, sellerService } = await getContext(server);
    const flaggedFraction = opts.flaggedFraction ?? 0.2;
    const seedScores = opts.seedScores ?? false;
    const flaggingThreshold = opts.flaggingThreshold ?? 70;

    const defaultChannel = await channelService.getDefaultChannel(ctx);

    // --- 5b. Create sellers + channels. ----------------------------------------
    const sellerIds: ID[] = [];
    const channelIds: ID[] = [];
    const batchStamp = Date.now();
    for (let i = 0; i < opts.sellerCount; i++) {
        const seller = await sellerService.create(ctx, { name: `Perf Seller ${i}` });
        const suffix = `${String(seller.id)}-${batchStamp}-${uniqueCounter++}`;
        const channelResult = await channelService.create(ctx, {
            code: `perf-${suffix}`,
            token: `perf-token-${suffix}`,
            sellerId: seller.id,
            defaultCurrencyCode: defaultChannel.defaultCurrencyCode,
            defaultLanguageCode: defaultChannel.defaultLanguageCode,
            pricesIncludeTax: defaultChannel.pricesIncludeTax,
            defaultShippingZoneId: defaultChannel.defaultShippingZone.id,
            defaultTaxZoneId: defaultChannel.defaultTaxZone.id,
        });
        if (isGraphQlErrorResult(channelResult)) {
            throw new Error(`Failed to create perf channel: ${channelResult.message}`);
        }
        sellerIds.push(seller.id);
        channelIds.push(channelResult.id);
    }

    // --- 5c. Bulk-insert orders (batched raw inserts + join rows). -------------
    if (opts.orderCount > 0 && channelIds.length > 0) {
        await bulkInsertOrders(connection, defaultChannel.defaultCurrencyCode, channelIds, opts.orderCount);
    }

    // --- 5d. Direct SellerScore(+snapshot) inserts, guarded by seedScores. -----
    // Guarding behind `seedScores` ensures the baseline server (which does not
    // load the plugin and therefore has no `seller_score`/`seller_score_snapshot`
    // tables) never touches those repositories.
    if (seedScores) {
        await bulkInsertScores(connection, ctx, sellerIds, flaggedFraction, flaggingThreshold);
    }

    return { sellerIds };
}

/**
 * Maximum number of order rows inserted per multi-row INSERT statement. Each
 * order row binds ~11 parameters, so 500 rows ≈ 5,500 bound parameters — well
 * under the limits of every supported driver (sql.js/SQLite `SQLITE_MAX_VARIABLE_NUMBER`
 * = 32,766; MySQL/MariaDB 16-bit placeholder limit = 65,535; PostgreSQL = 65,535),
 * while keeping the 50,000-order seed to ~100 fast in-memory statements.
 */
const ORDER_INSERT_BATCH = 500;

/**
 * Bulk-inserts `orderCount` `Order` rows spread round-robin across `channelIds`,
 * all placed at a random point inside the trailing 80 days (safely within the
 * 90-day scoring window), then writes the corresponding `order_channels_channel`
 * join rows.
 *
 * Uses raw `Repository.insert` + a `QueryBuilder` join-table insert (rather than
 * per-entity `save`) so the 50,000-order benchmark seed completes quickly: no
 * relation cascades, subscribers, or entity hydration are involved. The join
 * table name and its owner/inverse column names are derived from TypeORM's
 * relation metadata so the seeder tolerates any (currently none) entity-name
 * prefix without hardcoding.
 */
async function bulkInsertOrders(
    connection: TransactionalConnection,
    currencyCode: Order['currencyCode'],
    channelIds: ID[],
    orderCount: number,
): Promise<void> {
    const dataSource = connection.rawConnection;
    const orderRepo = dataSource.getRepository(Order);

    // Resolve the `Order.channels` join table + its two FK column names from metadata.
    const orderMetadata = dataSource.getMetadata(Order);
    const channelsRelation = orderMetadata.manyToManyRelations.find(
        relation => relation.propertyName === 'channels',
    );
    if (!channelsRelation || !channelsRelation.junctionEntityMetadata) {
        throw new Error('Unable to resolve the Order.channels join-table metadata');
    }
    const junctionTable = channelsRelation.junctionEntityMetadata.tableName;
    const orderJoinColumn = channelsRelation.joinColumns[0].databaseName;
    const channelJoinColumn = channelsRelation.inverseJoinColumns[0].databaseName;

    const now = Date.now();
    let orderBatch: Order[] = [];
    // Parallel array: the channel each queued order should be linked to.
    let channelForOrder: ID[] = [];

    const flushBatch = async (): Promise<void> => {
        if (orderBatch.length === 0) {
            return;
        }
        const insertResult = await orderRepo.insert(orderBatch);
        // `identifiers` preserves input order, so index i maps to channelForOrder[i].
        const joinRows = insertResult.identifiers.map((identifier, i) => ({
            [orderJoinColumn]: identifier.id as ID,
            [channelJoinColumn]: channelForOrder[i],
        }));
        await dataSource
            .createQueryBuilder()
            .insert()
            .into(junctionTable, [orderJoinColumn, channelJoinColumn])
            .values(joinRows)
            .execute();
        orderBatch = [];
        channelForOrder = [];
    };

    for (let i = 0; i < orderCount; i++) {
        const channelId = channelIds[i % channelIds.length];
        // Random placement within the last 80 days keeps every order inside the
        // 90-day window; the exact offset is not asserted by the benchmark.
        const placedAt = new Date(now - Math.floor(Math.random() * 80) * MS_PER_DAY);
        orderBatch.push(
            new Order({
                code: `perf-order-${now}-${i}`,
                state: 'PaymentSettled',
                type: OrderType.Seller,
                active: false,
                orderPlacedAt: placedAt,
                couponCodes: [],
                shippingAddress: {},
                billingAddress: {},
                currencyCode,
                subTotal: 0,
                subTotalWithTax: 0,
            }),
        );
        channelForOrder.push(channelId);
        if (orderBatch.length >= ORDER_INSERT_BATCH) {
            await flushBatch();
        }
    }
    await flushBatch();
}

/**
 * Directly inserts one current {@link SellerScore} per seller (plus two history
 * {@link SellerScoreSnapshot} rows), making ~`flaggedFraction` of them flagged.
 *
 * Rows are persisted through the repository + entity constructor (never raw SQL)
 * so the `@EntityId() sellerId` column's physical type (int vs. varchar) is
 * resolved by the configured id strategy automatically. The exact score
 * magnitudes are NOT asserted by the benchmark — only the invariant that a
 * flagged row has `score < flaggingThreshold` and a non-flagged row has
 * `score >= flaggingThreshold`.
 */
async function bulkInsertScores(
    connection: TransactionalConnection,
    ctx: Awaited<ReturnType<RequestContextService['create']>>,
    sellerIds: ID[],
    flaggedFraction: number,
    flaggingThreshold: number,
): Promise<void> {
    const scoreRepo = connection.getRepository(ctx, SellerScore);
    const snapshotRepo = connection.getRepository(ctx, SellerScoreSnapshot);

    const flaggedBoundary = Math.floor(sellerIds.length * flaggedFraction);
    const scores: SellerScore[] = [];
    const snapshots: SellerScoreSnapshot[] = [];
    const nowMs = Date.now();

    for (let i = 0; i < sellerIds.length; i++) {
        const sellerId = sellerIds[i];
        const flagged = i < flaggedBoundary;
        // Keep flagged/non-flagged scores firmly on the correct side of the
        // threshold, clamped to the valid 0–100 range.
        const score = flagged ? Math.max(0, flaggingThreshold - 30) : Math.min(100, flaggingThreshold + 15);
        const fulfillmentSla = flagged ? 0.4 : 0.9;
        const cancellationReturnRate = flagged ? 0.4 : 0.05;
        const lastCalculatedAt = new Date(nowMs);

        scores.push(
            new SellerScore({
                sellerId,
                score,
                fulfillmentSla,
                cancellationReturnRate,
                lastCalculatedAt,
                flagged,
            }),
        );
        // Two snapshots per seller give the history endpoints realistic,
        // chronologically-ordered data (an earlier calculation then the current one).
        snapshots.push(
            new SellerScoreSnapshot({
                sellerId,
                score,
                fulfillmentSla,
                cancellationReturnRate,
                calculatedAt: new Date(nowMs - MS_PER_DAY),
            }),
        );
        snapshots.push(
            new SellerScoreSnapshot({
                sellerId,
                score,
                fulfillmentSla,
                cancellationReturnRate,
                calculatedAt: lastCalculatedAt,
            }),
        );
    }

    await scoreRepo.save(scores, { chunk: 100 });
    await snapshotRepo.save(snapshots, { chunk: 100 });
}
