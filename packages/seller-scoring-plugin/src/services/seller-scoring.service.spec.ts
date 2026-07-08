/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { ID, Order, RequestContext, Seller, TransactionalConnection } from '@vendure/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SellerScoreSnapshot } from '../entities/seller-score-snapshot.entity';
import { SellerScore } from '../entities/seller-score.entity';
import { SellerScoringPluginOptions } from '../types';

import { SellerScoringService } from './seller-scoring.service';

/**
 * Minimal shape of a mocked TypeORM repository. The {@link SellerScoringService}
 * resolves repositories via `TransactionalConnection.getRepository` and calls
 * `findOne`/`find` (reads), `save` (the immutable snapshot insert), and — for the
 * single current-score row — the atomic `upsert(entity, ['sellerId'])` followed by
 * `findOneOrFail({ where: { sellerId } })`. Those are the methods the fakes expose.
 */
type RepoMock = {
    findOne: ReturnType<typeof vi.fn>;
    findOneOrFail: ReturnType<typeof vi.fn>;
    find: ReturnType<typeof vi.fn>;
    save: ReturnType<typeof vi.fn>;
    upsert: ReturnType<typeof vi.fn>;
};

/**
 * Creates a fresh repository mock with safe defaults: `findOne` resolves `null`,
 * `find` resolves an empty array, and `save` echoes back the entity it was given
 * (so a returned {@link SellerScore} carries the fields the service set on it).
 *
 * The current-score row is persisted with an atomic `upsert(entity, ['sellerId'])`
 * (returning a TypeORM InsertResult) followed by `findOneOrFail({ where: { sellerId } })`.
 * The fake records the entity handed to `upsert` and has `findOneOrFail` resolve that
 * same entity, so the value the service returns still carries exactly the score,
 * per-metric, flag and timestamp fields it just computed — preserving the exact-value
 * assertions below.
 */
function createRepoMock(): RepoMock {
    let lastUpserted: any;
    return {
        findOne: vi.fn().mockResolvedValue(null),
        findOneOrFail: vi.fn().mockImplementation(() => Promise.resolve(lastUpserted)),
        find: vi.fn().mockResolvedValue([]),
        save: vi.fn().mockImplementation((entity: any) => Promise.resolve(entity)),
        upsert: vi.fn().mockImplementation((entity: any) => {
            lastUpserted = entity;
            return Promise.resolve({ identifiers: [], generatedMaps: [], raw: [] });
        }),
    };
}

/** The seller under test. */
const SELLER_ID: ID = 'T_1';
/** Default plugin options: 48h SLA and a flagging threshold of 70. */
const OPTIONS: SellerScoringPluginOptions = { slaHours: 48, flaggingThreshold: 70 };
/** A fixed order-placement instant so the fulfillment-SLA math is fully deterministic. */
const BASE = new Date('2024-06-01T00:00:00.000Z');

/** Returns a new Date `h` hours after `base`. */
const hoursAfter = (base: Date, h: number): Date => new Date(base.getTime() + h * 60 * 60 * 1000);

/**
 * Builds a fake in-window order shaped exactly as the service reads it. Each entry in
 * `fulfillmentOffsetsH` produces one fulfillment whose `createdAt` is that many hours
 * after order placement; each entry in `refundStates` produces one refund on the
 * order's single payment. The result is a plain object cast to `any` — the service
 * only reads `state`, `orderPlacedAt`, `fulfillments[].createdAt`, and
 * `payments[].refunds[].state`, so no real entity instance is required.
 */
function makeOrder(opts: {
    state?: string;
    placedAt?: Date;
    fulfillmentOffsetsH?: number[];
    refundStates?: string[];
}): any {
    const placedAt = opts.placedAt ?? BASE;
    return {
        state: opts.state ?? 'PaymentSettled',
        orderPlacedAt: placedAt,
        fulfillments: (opts.fulfillmentOffsetsH ?? []).map(off => ({ createdAt: hoursAfter(placedAt, off) })),
        payments: [{ refunds: (opts.refundStates ?? []).map(s => ({ state: s })) }],
    };
}

describe('SellerScoringService', () => {
    let service: SellerScoringService;
    let sellerRepo: RepoMock;
    let orderRepo: RepoMock;
    let scoreRepo: RepoMock;
    let snapshotRepo: RepoMock;
    let connection: TransactionalConnection;
    const ctx = RequestContext.empty();

    beforeEach(() => {
        sellerRepo = createRepoMock();
        orderRepo = createRepoMock();
        scoreRepo = createRepoMock();
        snapshotRepo = createRepoMock();
        // Default: the seller exists and is active (not soft-deleted).
        sellerRepo.findOne.mockResolvedValue({ id: SELLER_ID, deletedAt: null });
        // Dispatch on the entity *class reference*. Because the spec and the service
        // import these classes from the same modules, `Seller`/`Order`/`SellerScore`/
        // `SellerScoreSnapshot` are the very same instances the service passes in. The
        // `default` throw asserts the read-only-core boundary: the service must never
        // touch any entity other than these four.
        connection = {
            getRepository: vi.fn((_ctx: any, entity: any) => {
                switch (entity) {
                    case Seller:
                        return sellerRepo;
                    case Order:
                        return orderRepo;
                    case SellerScore:
                        return scoreRepo;
                    case SellerScoreSnapshot:
                        return snapshotRepo;
                    default:
                        throw new Error('Unexpected entity requested from the mock connection');
                }
            }),
            // The service wraps the current-score upsert + snapshot insert in a single
            // transaction via `withTransaction(ctx, work)` ('auto' mode). The fake runs the
            // work callback immediately with the same ctx, so the wrapped writes still resolve
            // against these same repository mocks (getRepository ignores the ctx argument).
            withTransaction: vi.fn((ctxArg: any, work: (c: any) => Promise<any>) => work(ctxArg)),
        } as unknown as TransactionalConnection;
        // Direct instantiation — decorators do not block construction under swc.vite().
        service = new SellerScoringService(connection, OPTIONS);
    });

    it('computes composite 85.0 for SLA=0.8 and CRR=0.1 (AAP worked example)', async () => {
        const orders: any[] = [
            // 7 orders shipped within SLA (24h < 48h), none refunded.
            ...Array.from({ length: 7 }, () => makeOrder({ fulfillmentOffsetsH: [24] })),
            // 1 order shipped within SLA that is ALSO refunded (Settled) — drives CRR.
            makeOrder({ fulfillmentOffsetsH: [24], refundStates: ['Settled'] }),
            // 2 orders shipped beyond SLA (72h > 48h).
            makeOrder({ fulfillmentOffsetsH: [72] }),
            makeOrder({ fulfillmentOffsetsH: [72] }),
        ];
        orderRepo.find.mockResolvedValue(orders);

        const result = await service.recalculate(ctx, SELLER_ID);

        expect(result).toBeDefined();
        expect(result!.fulfillmentSla).toBe(0.8);
        expect(result!.cancellationReturnRate).toBe(0.1);
        expect(result!.score).toBe(85.0);
        expect(result!.flagged).toBe(false);
        expect(scoreRepo.upsert).toHaveBeenCalledTimes(1);
        expect(snapshotRepo.save).toHaveBeenCalledTimes(1);
    });

    it('computes composite 0.0 when all orders are cancelled with zero fulfillments (all-cancelled edge)', async () => {
        const orders: any[] = Array.from({ length: 4 }, () => makeOrder({ state: 'Cancelled' }));
        orderRepo.find.mockResolvedValue(orders);

        const result = await service.recalculate(ctx, SELLER_ID);

        expect(result!.fulfillmentSla).toBe(0);
        expect(result!.cancellationReturnRate).toBe(1);
        expect(result!.score).toBe(0.0);
        expect(result!.flagged).toBe(true);
        expect(scoreRepo.upsert).toHaveBeenCalledTimes(1);
        expect(snapshotRepo.save).toHaveBeenCalledTimes(1);
    });

    it('returns a null score and writes no snapshot when the seller has no orders in the window', async () => {
        orderRepo.find.mockResolvedValue([]);

        const result = await service.recalculate(ctx, SELLER_ID);

        expect(result!.score).toBeNull();
        expect(result!.fulfillmentSla).toBeNull();
        expect(result!.cancellationReturnRate).toBeNull();
        expect(result!.flagged).toBe(false);
        expect(result!.lastCalculatedAt).toBeInstanceOf(Date);
        expect(scoreRepo.upsert).toHaveBeenCalledTimes(1);
        expect(snapshotRepo.save).not.toHaveBeenCalled();
    });

    it('sets FulfillmentSLA to 0 when there are orders but zero fulfillments (domain rule)', async () => {
        const orders: any[] = Array.from({ length: 2 }, () => makeOrder({}));
        orderRepo.find.mockResolvedValue(orders);

        const result = await service.recalculate(ctx, SELLER_ID);

        expect(result!.fulfillmentSla).toBe(0);
        expect(result!.cancellationReturnRate).toBe(0);
        expect(result!.score).toBe(50.0);
    });

    it('counts a refunded-but-not-cancelled order toward CancellationReturnRate (Settled only)', async () => {
        const orders: any[] = [
            makeOrder({ fulfillmentOffsetsH: [1], refundStates: ['Settled'] }),
            // A Pending refund must NOT count toward the cancellation/return rate.
            makeOrder({ fulfillmentOffsetsH: [1], refundStates: ['Pending'] }),
            makeOrder({ fulfillmentOffsetsH: [1] }),
            makeOrder({ fulfillmentOffsetsH: [1] }),
        ];
        orderRepo.find.mockResolvedValue(orders);

        const result = await service.recalculate(ctx, SELLER_ID);

        expect(result!.fulfillmentSla).toBe(1);
        expect(result!.cancellationReturnRate).toBe(0.25);
        expect(result!.score).toBe(87.5);
    });

    it('flags strictly below the threshold: composite 90.0 is unflagged at 90 but flagged at 90.01', async () => {
        const orders: any[] = [
            ...Array.from({ length: 8 }, () => makeOrder({ fulfillmentOffsetsH: [24] })),
            makeOrder({ fulfillmentOffsetsH: [72] }),
            makeOrder({ fulfillmentOffsetsH: [72] }),
        ];
        orderRepo.find.mockResolvedValue(orders);

        const atThreshold = new SellerScoringService(connection, { slaHours: 48, flaggingThreshold: 90 });
        const unflagged = await atThreshold.recalculate(ctx, SELLER_ID);
        expect(unflagged!.score).toBe(90.0);
        expect(unflagged!.flagged).toBe(false);

        const aboveThreshold = new SellerScoringService(connection, {
            slaHours: 48,
            flaggingThreshold: 90.01,
        });
        const flaggedResult = await aboveThreshold.recalculate(ctx, SELLER_ID);
        expect(flaggedResult!.score).toBe(90.0);
        expect(flaggedResult!.flagged).toBe(true);
    });

    it('writes exactly one snapshot per non-null recalculation (two rapid recalcs => two snapshots)', async () => {
        orderRepo.find.mockResolvedValue([makeOrder({ fulfillmentOffsetsH: [1] })]);

        await service.recalculate(ctx, SELLER_ID);
        await service.recalculate(ctx, SELLER_ID);

        expect(scoreRepo.upsert).toHaveBeenCalledTimes(2);
        expect(snapshotRepo.save).toHaveBeenCalledTimes(2);
    });

    it('skips a soft-deleted seller: retains the existing score, performing no writes or order query', async () => {
        sellerRepo.findOne.mockResolvedValue({ id: SELLER_ID, deletedAt: new Date() });
        const existing: any = { sellerId: SELLER_ID, score: 42, flagged: true };
        scoreRepo.findOne.mockResolvedValue(existing);

        const result = await service.recalculate(ctx, SELLER_ID);

        expect(result).toBe(existing);
        expect(orderRepo.find).not.toHaveBeenCalled();
        expect(scoreRepo.upsert).not.toHaveBeenCalled();
        expect(scoreRepo.save).not.toHaveBeenCalled();
        expect(snapshotRepo.save).not.toHaveBeenCalled();
    });

    it('returns undefined for a non-existent seller and never queries orders', async () => {
        sellerRepo.findOne.mockResolvedValue(null);
        scoreRepo.findOne.mockResolvedValue(null);

        const result = await service.recalculate(ctx, SELLER_ID);

        expect(result).toBeUndefined();
        expect(orderRepo.find).not.toHaveBeenCalled();
    });

    it('honors the slaHours option rather than hardcoding it', async () => {
        const orders: any[] = Array.from({ length: 2 }, () => makeOrder({ fulfillmentOffsetsH: [36] }));
        orderRepo.find.mockResolvedValue(orders);

        // slaHours 48 => a 36h fulfillment is within SLA => 2/2 = 1.
        const within = await service.recalculate(ctx, SELLER_ID);
        expect(within!.fulfillmentSla).toBe(1);

        // slaHours 24 => a 36h fulfillment is beyond SLA => 0/2 = 0.
        const svc24 = new SellerScoringService(connection, { slaHours: 24, flaggingThreshold: 70 });
        const beyond = await svc24.recalculate(ctx, SELLER_ID);
        expect(beyond!.fulfillmentSla).toBe(0);
    });

    it('upserts the single current SellerScore row keyed on sellerId (one row per seller, never a duplicate insert)', async () => {
        // 1 order, 1 fulfillment within the 48h SLA, none cancelled/refunded ⇒ SLA=1, CRR=0,
        // composite = 100 (>= threshold 70 ⇒ not flagged).
        orderRepo.find.mockResolvedValue([makeOrder({ fulfillmentOffsetsH: [1] })]);

        const result = await service.recalculate(ctx, SELLER_ID);

        // The current-score row is written with a single atomic upsert — never the legacy
        // findOne + read-modify-write save path — so concurrent first recalculations cannot
        // both insert and collide on the unique sellerId constraint (AAP §0.9.3).
        expect(scoreRepo.upsert).toHaveBeenCalledTimes(1);
        expect(scoreRepo.save).not.toHaveBeenCalled();

        // The upsert's conflict target is the unique `sellerId` column, guaranteeing exactly
        // one current row per seller (an existing row is updated in place, not duplicated).
        const [upsertedEntity, conflictPaths] = scoreRepo.upsert.mock.calls[0];
        expect(conflictPaths).toEqual(['sellerId']);
        expect(upsertedEntity.sellerId).toBe(SELLER_ID);
        expect(upsertedEntity.score).toBe(100);
        expect(upsertedEntity.flagged).toBe(false);

        // The returned value is the current row re-read after the upsert (findOneOrFail),
        // carrying the freshly-computed score.
        expect(result!.score).toBe(100);
        expect(result!.flagged).toBe(false);
    });

    it('defensively handles orders with a null orderPlacedAt and missing fulfillments/payments', async () => {
        const orders: any[] = [
            // orderPlacedAt is null: its fulfillment still counts toward the denominator
            // but can never be "within SLA"; the payment carries no refunds array.
            {
                state: 'PaymentSettled',
                orderPlacedAt: null,
                fulfillments: [{ createdAt: BASE }],
                payments: [{}],
            },
            // fulfillments and payments are absent entirely — exercised via the `?? []` guards.
            { state: 'PaymentSettled' },
        ];
        orderRepo.find.mockResolvedValue(orders);

        const result = await service.recalculate(ctx, SELLER_ID);

        // One fulfillment in the denominator, none within SLA => 0/1 = 0.
        expect(result!.fulfillmentSla).toBe(0);
        expect(result!.cancellationReturnRate).toBe(0);
        expect(result!.score).toBe(50.0);
    });

    it('getScore returns the row when present and undefined when absent', async () => {
        const row: any = { sellerId: SELLER_ID, score: 55, flagged: false };
        scoreRepo.findOne.mockResolvedValue(row);
        await expect(service.getScore(ctx, SELLER_ID)).resolves.toBe(row);

        scoreRepo.findOne.mockResolvedValue(null);
        await expect(service.getScore(ctx, SELLER_ID)).resolves.toBeUndefined();
    });

    it('getFlaggedSellers returns only flagged rows, queried by flagged=true', async () => {
        const rows: any[] = [{ sellerId: SELLER_ID, score: 20, flagged: true }];
        scoreRepo.find.mockResolvedValue(rows);

        const result = await service.getFlaggedSellers(ctx);

        expect(result).toBe(rows);
        expect(scoreRepo.find).toHaveBeenCalledWith(
            expect.objectContaining({ where: { flagged: true }, order: { score: 'ASC' } }),
        );
    });

    it('getHistory returns snapshots for the seller ordered by calculatedAt ascending', async () => {
        const rows: any[] = [{ sellerId: SELLER_ID, score: 80, calculatedAt: BASE }];
        snapshotRepo.find.mockResolvedValue(rows);

        const result = await service.getHistory(ctx, SELLER_ID);

        expect(result).toBe(rows);
        expect(snapshotRepo.find).toHaveBeenCalledWith(
            expect.objectContaining({ where: { sellerId: SELLER_ID }, order: { calculatedAt: 'ASC' } }),
        );
    });
});
