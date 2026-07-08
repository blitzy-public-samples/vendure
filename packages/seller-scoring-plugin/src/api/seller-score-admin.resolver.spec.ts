/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { ID, RequestContext, TransactionalConnection } from '@vendure/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SellerScore } from '../entities/seller-score.entity';
import { SellerScoringService } from '../services/seller-scoring.service';

import { SellerScoreAdminResolver } from './seller-score-admin.resolver';

/**
 * Unit tests for {@link SellerScoreAdminResolver}. The resolver is a thin delegation
 * layer over `TransactionalConnection` (for the two read queries) and the
 * {@link SellerScoringService} (for the forced-recalculation mutation), so both are
 * mocked and the resolver is instantiated directly — decorators (`@Resolver`,
 * `@Query`, `@Mutation`, `@Transaction`, `@Allow`) do not affect plain construction
 * under `swc.vite()` and are not exercised here (they are validated by the e2e suite).
 */
type RepoMock = {
    findOne: ReturnType<typeof vi.fn>;
    find: ReturnType<typeof vi.fn>;
};

const SELLER_ID: ID = 'T_1';

describe('SellerScoreAdminResolver', () => {
    let resolver: SellerScoreAdminResolver;
    let scoreRepo: RepoMock;
    let connection: TransactionalConnection;
    let sellerScoringService: { recalculate: ReturnType<typeof vi.fn> };
    const ctx = RequestContext.empty();

    beforeEach(() => {
        scoreRepo = {
            findOne: vi.fn().mockResolvedValue(null),
            find: vi.fn().mockResolvedValue([]),
        };
        connection = {
            getRepository: vi.fn((_ctx: any, entity: any) => {
                if (entity === SellerScore) {
                    return scoreRepo;
                }
                throw new Error('Unexpected entity requested from the mock connection');
            }),
        } as unknown as TransactionalConnection;
        sellerScoringService = { recalculate: vi.fn().mockResolvedValue(undefined) };
        resolver = new SellerScoreAdminResolver(
            connection,
            sellerScoringService as unknown as SellerScoringService,
        );
    });

    describe('sellerScore', () => {
        it('returns the persisted score row for the seller', async () => {
            const row = { id: 'T_10', sellerId: SELLER_ID, score: 85 } as unknown as SellerScore;
            scoreRepo.findOne.mockResolvedValue(row);

            const result = await resolver.sellerScore(ctx, { sellerId: SELLER_ID });

            expect(result).toBe(row);
            expect(scoreRepo.findOne).toHaveBeenCalledWith({ where: { sellerId: SELLER_ID } });
        });

        it('returns undefined (not null) when no score row exists', async () => {
            scoreRepo.findOne.mockResolvedValue(null);

            const result = await resolver.sellerScore(ctx, { sellerId: SELLER_ID });

            expect(result).toBeUndefined();
        });
    });

    describe('flaggedSellers', () => {
        it('returns only flagged rows, ordered worst-first by ascending score', async () => {
            const rows = [
                { id: 'T_1', sellerId: 'T_1', score: 10, flagged: true },
                { id: 'T_2', sellerId: 'T_2', score: 40, flagged: true },
            ] as unknown as SellerScore[];
            scoreRepo.find.mockResolvedValue(rows);

            const result = await resolver.flaggedSellers(ctx);

            expect(result).toBe(rows);
            // Fixed API semantics: only `flagged = true`, ordered by ascending score —
            // never a generic all-sellers list.
            expect(scoreRepo.find).toHaveBeenCalledWith({
                where: { flagged: true },
                order: { score: 'ASC' },
            });
        });

        it('returns an empty array when no sellers are flagged', async () => {
            scoreRepo.find.mockResolvedValue([]);

            const result = await resolver.flaggedSellers(ctx);

            expect(result).toEqual([]);
        });
    });

    describe('recalculateSellerScore', () => {
        it('delegates to SellerScoringService.recalculate and returns its result', async () => {
            const recalculated = { id: 'T_5', sellerId: SELLER_ID, score: 72 } as unknown as SellerScore;
            sellerScoringService.recalculate.mockResolvedValue(recalculated);

            const result = await resolver.recalculateSellerScore(ctx, { sellerId: SELLER_ID });

            expect(result).toBe(recalculated);
            expect(sellerScoringService.recalculate).toHaveBeenCalledWith(ctx, SELLER_ID);
        });

        it('propagates an undefined result (seller with no orders in the window)', async () => {
            sellerScoringService.recalculate.mockResolvedValue(undefined);

            const result = await resolver.recalculateSellerScore(ctx, { sellerId: SELLER_ID });

            expect(result).toBeUndefined();
        });
    });
});
