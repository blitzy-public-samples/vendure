/**
 * @file End-to-end test suite for the {@link SellerScoringPlugin}.
 *
 * These tests boot a real Vendure server (via `@vendure/testing`) with the plugin
 * installed against an in-memory `sqljs` database, and exercise the feature through
 * the same public seams a real integration would use:
 *
 *  - the fixed Admin GraphQL API surface — the `sellerScore` and `flaggedSellers`
 *    queries and the `recalculateSellerScore` mutation;
 *  - the `EventBus`, by publishing the very order / refund / fulfillment
 *    state-transition events the plugin subscribes to; and
 *  - deterministic, directly-seeded fixture data (see `./fixtures/seed-test-data`).
 *
 * The suite asserts the EXACT composite and per-metric values the feature
 * specification pins down (`85.0`, `0.0`, `null`, `70.0`, `90.0`) — never merely
 * that "a score was produced" — and verifies the two governing domain rules
 * (zero-fulfillment ⇒ `FulfillmentSLA = 0`; no-orders ⇒ `null` score, no snapshot,
 * excluded from flagging), event-driven recalculation, threshold flagging
 * inclusion/exclusion, snapshot-history ordering, and Admin API permission
 * enforcement.
 *
 * It only ever READS core data and the plugin's own tables (it seeds by inserting
 * new rows and by publishing events) — no existing core behaviour, GraphQL
 * operation, or table is modified.
 *
 * @since 3.8.0
 */
import {
    EventBus,
    Fulfillment,
    FulfillmentStateTransitionEvent,
    mergeConfig,
    Order,
    OrderStateTransitionEvent,
    Permission,
    Refund,
    RefundStateTransitionEvent,
    RequestContextService,
    TransactionalConnection,
} from '@vendure/core';
import { createTestEnvironment, registerInitializer, SqljsInitializer } from '@vendure/testing';
import gql from 'graphql-tag';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { initialData } from '../../../e2e-common/e2e-initial-data';
import { TEST_SETUP_TIMEOUT_MS, testConfig } from '../../../e2e-common/test-config';
import { SellerScoringPlugin } from '../src/seller-scoring.plugin';

import { getSeededOrder, SeededSeller, seedSellerScenario } from './fixtures/seed-test-data';

// Register the sqljs initializer pointed at THIS suite's own on-disk cache directory
// (`e2e/__data__`, which is gitignored and generated at runtime) so that the schema —
// including the plugin's additive `seller_score` and `seller_score_snapshot` tables —
// is created on the first populate of this file's database.
registerInitializer('sqljs', new SqljsInitializer(path.join(__dirname, '__data__')));

/**
 * The flagging threshold the plugin is configured with for this suite. A seller is
 * flagged when its composite score is strictly below this value (a score exactly
 * equal to the threshold is NOT flagged).
 */
const FLAGGING_THRESHOLD = 70;

/** The fulfillment SLA (in hours) the plugin is configured with for this suite. */
const SLA_HOURS = 48;

const { server, adminClient } = createTestEnvironment(
    mergeConfig(testConfig(), {
        plugins: [SellerScoringPlugin.init({ slaHours: SLA_HOURS, flaggingThreshold: FLAGGING_THRESHOLD })],
    }),
);

// --- GraphQL documents (declared inline; no codegen for this self-contained suite) ---

const SELLER_SCORE_FRAGMENT = gql`
    fragment SellerScoreFields on SellerScore {
        id
        sellerId
        score
        fulfillmentSla
        cancellationReturnRate
        lastCalculatedAt
        flagged
    }
`;

const GET_SELLER_SCORE = gql`
    query GetSellerScore($sellerId: ID!) {
        sellerScore(sellerId: $sellerId) {
            ...SellerScoreFields
            history {
                id
                sellerId
                score
                fulfillmentSla
                cancellationReturnRate
                calculatedAt
            }
        }
    }
    ${SELLER_SCORE_FRAGMENT}
`;

const GET_FLAGGED_SELLERS = gql`
    query GetFlaggedSellers {
        flaggedSellers {
            ...SellerScoreFields
        }
    }
    ${SELLER_SCORE_FRAGMENT}
`;

const RECALCULATE_SELLER_SCORE = gql`
    mutation RecalculateSellerScore($sellerId: ID!) {
        recalculateSellerScore(sellerId: $sellerId) {
            ...SellerScoreFields
            history {
                id
                score
                calculatedAt
            }
        }
    }
    ${SELLER_SCORE_FRAGMENT}
`;

// Core admin operations used ONLY to set up the permission-enforcement test. These
// are unchanged core operations — the feature adds nothing to them.
const CREATE_ROLE = gql`
    mutation CreateSellerScoreTestRole($input: CreateRoleInput!) {
        createRole(input: $input) {
            id
            code
            permissions
        }
    }
`;

const CREATE_ADMINISTRATOR = gql`
    mutation CreateSellerScoreTestAdmin($input: CreateAdministratorInput!) {
        createAdministrator(input: $input) {
            id
            emailAddress
        }
    }
`;

// --- Local result types (loose; the API is not codegen-typed here) ---

interface SellerScoreSnapshotResult {
    id: string;
    sellerId?: string;
    score: number;
    fulfillmentSla?: number;
    cancellationReturnRate?: number;
    calculatedAt: string;
}

interface SellerScoreResult {
    id: string;
    sellerId: string;
    score: number | null;
    fulfillmentSla: number | null;
    cancellationReturnRate: number | null;
    lastCalculatedAt: string | null;
    flagged: boolean;
    history?: SellerScoreSnapshotResult[];
}

// --- Helpers (close over the module-level `server` / `adminClient`) ---

/**
 * Normalizes an id to its raw (database) form by stripping the `T_` prefix that the
 * test `EntityIdStrategy` adds to every GraphQL-exposed id on output. The fixtures
 * return raw ids while the API returns `T_`-prefixed ids, so comparisons are made on
 * the normalized value. Robust whether or not the value carries the prefix.
 */
function rawId(id: string | number): string {
    return String(id).replace(/^T_/, '');
}

/** Creates a fresh admin {@link RequestContext} on the default channel. */
function createAdminContext() {
    return server.app.get(RequestContextService).create({ apiType: 'admin' });
}

/**
 * Polls the `sellerScore` query until the seller has a materialized (non-null) score
 * with a `lastCalculatedAt` timestamp, or throws once the timeout elapses. Used by
 * the event-driven tests because the plugin's subscriber recalculates
 * fire-and-forget, so the score appears asynchronously after the event is published.
 */
async function pollForScore(
    sellerId: SeededSeller['sellerId'],
    { timeoutMs = 8000, intervalMs = 50 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<SellerScoreResult> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const { sellerScore } = await adminClient.query<{ sellerScore: SellerScoreResult | null }>(
            GET_SELLER_SCORE,
            { sellerId },
        );
        if (sellerScore && sellerScore.score !== null && sellerScore.lastCalculatedAt) {
            return sellerScore;
        }
        if (Date.now() > deadline) {
            throw new Error(`Timed out waiting for sellerScore(${String(sellerId)}) to materialize`);
        }
        await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
}

/**
 * Reloads a seeded order with the relations needed to publish a
 * {@link RefundStateTransitionEvent}: its `channels` (so the subscriber can resolve
 * the seller) and its `payments.refunds` (to obtain a real settled `Refund`).
 */
async function loadOrderWithRefund(
    orderId: SeededSeller['orderIds'][number],
): Promise<{ order: Order; refund: Refund }> {
    const connection = server.app.get(TransactionalConnection);
    const ctx = await createAdminContext();
    const order = await connection.getRepository(ctx, Order).findOne({
        where: { id: orderId as any },
        relations: { channels: true, payments: { refunds: true } },
    });
    if (!order) {
        throw new Error(`Seeded order ${String(orderId)} not found`);
    }
    const refund = (order.payments ?? [])
        .flatMap(payment => payment.refunds ?? [])
        .find(candidate => candidate.state === 'Settled');
    if (!refund) {
        throw new Error(`No settled refund found for seeded order ${String(orderId)}`);
    }
    return { order, refund };
}

/**
 * Loads the first {@link Fulfillment} attached to a seeded order, used to publish a
 * {@link FulfillmentStateTransitionEvent}. The subscriber re-hydrates the
 * fulfillment's `orders.channels` from the id, so only the fulfillment itself is
 * required here.
 */
async function loadFulfillment(orderId: SeededSeller['orderIds'][number]): Promise<Fulfillment> {
    const connection = server.app.get(TransactionalConnection);
    const ctx = await createAdminContext();
    const order = await connection.getRepository(ctx, Order).findOne({
        where: { id: orderId as any },
        relations: { fulfillments: true },
    });
    const fulfillment = order?.fulfillments?.[0];
    if (!fulfillment) {
        throw new Error(`No fulfillment found for seeded order ${String(orderId)}`);
    }
    return fulfillment;
}

describe('SellerScoringPlugin', () => {
    beforeAll(async () => {
        await server.init({
            initialData,
            productsCsvPath: path.join(__dirname, 'fixtures/e2e-products-empty.csv'),
            customerCount: 1,
        });
        await adminClient.asSuperAdmin();
    }, TEST_SETUP_TIMEOUT_MS);

    afterAll(async () => {
        await server.destroy();
    });

    describe('scoring', () => {
        it('computes composite 85.0 for the 8/10-within-SLA, 1/10-cancelled scenario (A)', async () => {
            const seller = await seedSellerScenario(server, {
                name: 'Seller A',
                ordersWithinSla: 8,
                ordersBeyondSla: 2,
                cancelledCount: 1,
            });

            const { recalculateSellerScore } = await adminClient.query<{
                recalculateSellerScore: SellerScoreResult;
            }>(RECALCULATE_SELLER_SCORE, { sellerId: seller.sellerId });

            expect(recalculateSellerScore.score).toBe(85);
            expect(recalculateSellerScore.fulfillmentSla).toBe(0.8);
            expect(recalculateSellerScore.cancellationReturnRate).toBe(0.1);
            expect(recalculateSellerScore.flagged).toBe(false);
        });

        it('computes composite 0.0 for the all-cancelled, zero-fulfillment scenario (B)', async () => {
            // Validates BOTH the zero-fulfillment domain rule (FulfillmentSLA = 0 when a
            // seller has in-window orders but no fulfillments) AND the all-cancelled edge.
            const seller = await seedSellerScenario(server, {
                name: 'Seller B',
                ordersNoFulfillment: 5,
                cancelledCount: 5,
            });

            const { recalculateSellerScore } = await adminClient.query<{
                recalculateSellerScore: SellerScoreResult;
            }>(RECALCULATE_SELLER_SCORE, { sellerId: seller.sellerId });

            expect(recalculateSellerScore.score).toBe(0);
            expect(recalculateSellerScore.fulfillmentSla).toBe(0);
            expect(recalculateSellerScore.cancellationReturnRate).toBe(1);
            expect(recalculateSellerScore.flagged).toBe(true);
        });

        it('returns a null score (not 0) and writes no snapshot for a seller with no orders (C)', async () => {
            const seller = await seedSellerScenario(server, { name: 'Seller C (no orders)' });

            const { recalculateSellerScore } = await adminClient.query<{
                recalculateSellerScore: SellerScoreResult;
            }>(RECALCULATE_SELLER_SCORE, { sellerId: seller.sellerId });

            expect(recalculateSellerScore.score).toBeNull();
            expect(recalculateSellerScore.fulfillmentSla).toBeNull();
            expect(recalculateSellerScore.cancellationReturnRate).toBeNull();
            expect(recalculateSellerScore.flagged).toBe(false);

            const { sellerScore } = await adminClient.query<{ sellerScore: SellerScoreResult }>(
                GET_SELLER_SCORE,
                { sellerId: seller.sellerId },
            );
            expect(sellerScore.score).toBeNull();
            expect(sellerScore.history).toEqual([]);
        });

        it('excludes orders older than the 90-day window, yielding a null score (C-window)', async () => {
            const seller = await seedSellerScenario(server, {
                name: 'Seller C (out of window)',
                ordersWithinSla: 3,
                outOfWindow: true,
            });

            const { recalculateSellerScore } = await adminClient.query<{
                recalculateSellerScore: SellerScoreResult;
            }>(RECALCULATE_SELLER_SCORE, { sellerId: seller.sellerId });

            expect(recalculateSellerScore.score).toBeNull();
            expect(recalculateSellerScore.fulfillmentSla).toBeNull();
            expect(recalculateSellerScore.cancellationReturnRate).toBeNull();
            expect(recalculateSellerScore.flagged).toBe(false);

            const { sellerScore } = await adminClient.query<{ sellerScore: SellerScoreResult }>(
                GET_SELLER_SCORE,
                { sellerId: seller.sellerId },
            );
            expect(sellerScore.history).toEqual([]);
        });

        it('computes composite 70.0 and does NOT flag a seller exactly at the threshold (D)', async () => {
            const seller = await seedSellerScenario(server, {
                name: 'Seller D',
                ordersWithinSla: 4,
                ordersBeyondSla: 6,
            });

            const { recalculateSellerScore } = await adminClient.query<{
                recalculateSellerScore: SellerScoreResult;
            }>(RECALCULATE_SELLER_SCORE, { sellerId: seller.sellerId });

            expect(recalculateSellerScore.score).toBe(70);
            expect(recalculateSellerScore.fulfillmentSla).toBe(0.4);
            expect(recalculateSellerScore.cancellationReturnRate).toBe(0);
            // Strict `<` threshold: a score exactly equal to the threshold is NOT flagged.
            expect(recalculateSellerScore.flagged).toBe(false);
        });
    });

    describe('event-driven recalculation', () => {
        it('recalculates automatically on an order state-transition event', async () => {
            const seller = await seedSellerScenario(server, {
                name: 'Seller E (order event)',
                ordersWithinSla: 8,
                ordersBeyondSla: 2,
                cancelledCount: 1,
            });

            // Do NOT force-recalculate; publish the very event the plugin subscribes to.
            const eventBus = server.app.get(EventBus);
            const ctx = await createAdminContext();
            const order = await getSeededOrder(server, seller.orderIds[0]);
            await eventBus.publish(
                new OrderStateTransitionEvent('ArrangingPayment', 'PaymentSettled', ctx, order),
            );

            const score = await pollForScore(seller.sellerId);
            expect(score.score).toBe(85);
            expect(score.fulfillmentSla).toBe(0.8);
            expect(score.cancellationReturnRate).toBe(0.1);
            expect(score.flagged).toBe(false);
        });

        it('recalculates automatically on a refund state-transition event', async () => {
            // 10 orders all shipped within SLA (SLA = 1.0), 2 refunded (CRR = 0.2):
            // composite = 100 * (0.5 * 1.0 + 0.5 * 0.8) = 90.0.
            const seller = await seedSellerScenario(server, {
                name: 'Seller F (refund event)',
                ordersWithinSla: 10,
                refundedCount: 2,
            });

            const eventBus = server.app.get(EventBus);
            const ctx = await createAdminContext();
            const { order, refund } = await loadOrderWithRefund(seller.orderIds[0]);
            await eventBus.publish(new RefundStateTransitionEvent('Pending', 'Settled', ctx, refund, order));

            const score = await pollForScore(seller.sellerId);
            expect(score.score).toBe(90);
            expect(score.fulfillmentSla).toBe(1);
            expect(score.cancellationReturnRate).toBe(0.2);
            expect(score.flagged).toBe(false);
        });

        it('recalculates automatically on a fulfillment state-transition event', async () => {
            const seller = await seedSellerScenario(server, {
                name: 'Seller G (fulfillment event)',
                ordersWithinSla: 8,
                ordersBeyondSla: 2,
                cancelledCount: 1,
            });

            const eventBus = server.app.get(EventBus);
            const ctx = await createAdminContext();
            const fulfillment = await loadFulfillment(seller.orderIds[0]);
            await eventBus.publish(
                new FulfillmentStateTransitionEvent('Pending', 'Shipped', ctx, fulfillment),
            );

            const score = await pollForScore(seller.sellerId);
            expect(score.score).toBe(85);
            expect(score.flagged).toBe(false);
        });
    });

    describe('flaggedSellers threshold flagging', () => {
        it('includes only sellers whose current score is below the threshold', async () => {
            const a = await seedSellerScenario(server, {
                name: 'Flag A85',
                ordersWithinSla: 8,
                ordersBeyondSla: 2,
                cancelledCount: 1,
            }); // 85 → not flagged
            const b = await seedSellerScenario(server, {
                name: 'Flag B0',
                ordersNoFulfillment: 5,
                cancelledCount: 5,
            }); // 0 → flagged
            const c = await seedSellerScenario(server, { name: 'Flag Cnull' }); // null → excluded
            const d = await seedSellerScenario(server, {
                name: 'Flag D70',
                ordersWithinSla: 4,
                ordersBeyondSla: 6,
            }); // 70 → not flagged (strict <)

            for (const seller of [a, b, c, d]) {
                await adminClient.query(RECALCULATE_SELLER_SCORE, { sellerId: seller.sellerId });
            }

            const { flaggedSellers } = await adminClient.query<{ flaggedSellers: SellerScoreResult[] }>(
                GET_FLAGGED_SELLERS,
            );
            const ids = flaggedSellers.map(row => rawId(row.sellerId));

            // Below-threshold seller appears; above-threshold / at-threshold / null are absent.
            expect(ids).toContain(rawId(b.sellerId));
            expect(ids).not.toContain(rawId(a.sellerId));
            expect(ids).not.toContain(rawId(c.sellerId));
            expect(ids).not.toContain(rawId(d.sellerId));

            // Every returned row is genuinely flagged and has a real (non-null) score.
            for (const row of flaggedSellers) {
                expect(row.flagged).toBe(true);
                expect(row.score).not.toBeNull();
            }
        });

        it('orders flagged sellers by ascending score (worst first)', async () => {
            // A second flagged seller with a higher-but-still-below score:
            // 3/10 within SLA (0.3), CRR 0 → composite = 100 * (0.5 * 0.3 + 0.5 * 1) = 65.0.
            const worst = await seedSellerScenario(server, {
                name: 'Order Worst0',
                ordersNoFulfillment: 4,
                cancelledCount: 4,
            }); // 0 → flagged
            const middling = await seedSellerScenario(server, {
                name: 'Order Mid65',
                ordersWithinSla: 3,
                ordersBeyondSla: 7,
            }); // 65 → flagged

            const midResult = await adminClient.query<{ recalculateSellerScore: SellerScoreResult }>(
                RECALCULATE_SELLER_SCORE,
                { sellerId: middling.sellerId },
            );
            expect(midResult.recalculateSellerScore.score).toBe(65);
            expect(midResult.recalculateSellerScore.flagged).toBe(true);
            await adminClient.query(RECALCULATE_SELLER_SCORE, { sellerId: worst.sellerId });

            const { flaggedSellers } = await adminClient.query<{ flaggedSellers: SellerScoreResult[] }>(
                GET_FLAGGED_SELLERS,
            );

            // The full result set is sorted by score ascending.
            const scores = flaggedSellers.map(row => row.score).filter((s): s is number => s !== null);
            expect(scores).toEqual([...scores].sort((x, y) => x - y));

            // The middling flagged seller is present, after any strictly-lower-scored sellers.
            const ids = flaggedSellers.map(row => rawId(row.sellerId));
            expect(ids).toContain(rawId(middling.sellerId));
            expect(ids).toContain(rawId(worst.sellerId));
            const worstIndex = ids.indexOf(rawId(worst.sellerId));
            const middlingIndex = ids.indexOf(rawId(middling.sellerId));
            expect(worstIndex).toBeLessThan(middlingIndex);
        });
    });

    describe('snapshot history', () => {
        it('writes exactly one ordered snapshot per non-null recalculation', async () => {
            const seller = await seedSellerScenario(server, {
                name: 'History S',
                ordersWithinSla: 8,
                ordersBeyondSla: 2,
                cancelledCount: 1,
            }); // 85

            // Recalculate three times, with small gaps so the millisecond-resolution
            // `calculatedAt` timestamps are strictly increasing.
            await adminClient.query(RECALCULATE_SELLER_SCORE, { sellerId: seller.sellerId });
            await new Promise(resolve => setTimeout(resolve, 10));
            await adminClient.query(RECALCULATE_SELLER_SCORE, { sellerId: seller.sellerId });
            await new Promise(resolve => setTimeout(resolve, 10));
            await adminClient.query(RECALCULATE_SELLER_SCORE, { sellerId: seller.sellerId });

            const { sellerScore } = await adminClient.query<{ sellerScore: SellerScoreResult }>(
                GET_SELLER_SCORE,
                { sellerId: seller.sellerId },
            );

            const history = sellerScore.history ?? [];
            expect(history.length).toBe(3);
            // Every snapshot reflects the same seeded data → score 85.
            for (const snapshot of history) {
                expect(snapshot.score).toBe(85);
            }
            // Ordered ascending by `calculatedAt`.
            const times = history.map(snapshot => new Date(snapshot.calculatedAt).getTime());
            expect(times).toEqual([...times].sort((x, y) => x - y));
        });

        it('writes NO snapshot for a null (no-orders) recalculation', async () => {
            const seller = await seedSellerScenario(server, { name: 'History Null' }); // no orders

            await adminClient.query(RECALCULATE_SELLER_SCORE, { sellerId: seller.sellerId });
            await adminClient.query(RECALCULATE_SELLER_SCORE, { sellerId: seller.sellerId });

            const { sellerScore } = await adminClient.query<{ sellerScore: SellerScoreResult }>(
                GET_SELLER_SCORE,
                { sellerId: seller.sellerId },
            );
            expect(sellerScore.score).toBeNull();
            expect(sellerScore.history).toEqual([]);
        });
    });

    // Kept LAST because it mutates the shared client's auth state (anonymous / limited
    // user). Each test restores SuperAdmin, and the `afterAll` below is a final safety net.
    describe('permissions', () => {
        afterAll(async () => {
            await adminClient.asSuperAdmin();
        });

        it('rejects unauthenticated access to all three operations', async () => {
            await adminClient.asAnonymousUser();
            const someId = 'T_1';

            await expect(adminClient.query(GET_SELLER_SCORE, { sellerId: someId })).rejects.toThrow();
            await expect(adminClient.query(GET_FLAGGED_SELLERS)).rejects.toThrow();
            await expect(adminClient.query(RECALCULATE_SELLER_SCORE, { sellerId: someId })).rejects.toThrow();

            await adminClient.asSuperAdmin();
        });

        it('allows a ReadSeller-only admin to query but rejects the recalculate mutation', async () => {
            await adminClient.asSuperAdmin();

            // Seed a real score to read back as the limited admin.
            const readable = await seedSellerScenario(server, {
                name: 'Perm Readable',
                ordersWithinSla: 8,
                ordersBeyondSla: 2,
                cancelledCount: 1,
            });
            await adminClient.query(RECALCULATE_SELLER_SCORE, { sellerId: readable.sellerId });

            // Create a role with ONLY ReadSeller. Omitting `channelIds` assigns the role
            // to the current (default) channel, which is where the queries run.
            const unique = Date.now();
            const { createRole } = await adminClient.query<{ createRole: { id: string } }>(CREATE_ROLE, {
                input: {
                    code: `seller-score-reader-${unique}`,
                    description: 'Seller score reader (ReadSeller only)',
                    permissions: [Permission.ReadSeller],
                },
            });

            const emailAddress = `seller-score-reader-${unique}@test.example`;
            const password = 'test-password';
            await adminClient.query(CREATE_ADMINISTRATOR, {
                input: {
                    firstName: 'Seller',
                    lastName: 'Reader',
                    emailAddress,
                    password,
                    roleIds: [createRole.id],
                },
            });

            await adminClient.asUserWithCredentials(emailAddress, password);

            // ReadSeller is sufficient for both queries.
            const { sellerScore } = await adminClient.query<{ sellerScore: SellerScoreResult }>(
                GET_SELLER_SCORE,
                { sellerId: readable.sellerId },
            );
            expect(sellerScore).not.toBeNull();
            expect(sellerScore.score).toBe(85);

            const { flaggedSellers } = await adminClient.query<{ flaggedSellers: SellerScoreResult[] }>(
                GET_FLAGGED_SELLERS,
            );
            expect(Array.isArray(flaggedSellers)).toBe(true);

            // The mutation requires UpdateSeller, which this admin does not have.
            await expect(
                adminClient.query(RECALCULATE_SELLER_SCORE, { sellerId: readable.sellerId }),
            ).rejects.toThrow();

            await adminClient.asSuperAdmin();
        });
    });
});
