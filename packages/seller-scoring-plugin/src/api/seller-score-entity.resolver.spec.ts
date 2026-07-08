/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { ID, RequestContext, Seller, TransactionalConnection } from '@vendure/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SellerScoreSnapshot } from '../entities/seller-score-snapshot.entity';
import { SellerScore } from '../entities/seller-score.entity';

import { SellerScoreEntityResolver } from './seller-score-entity.resolver';

/**
 * Unit tests for {@link SellerScoreEntityResolver}. The two field resolvers
 * (`history` and `seller`) are thin read-only lookups over `TransactionalConnection`,
 * so it is mocked and the resolver instantiated directly. The resolver dispatches on
 * the entity *class reference*, so the mock switches on `SellerScoreSnapshot` / `Seller`.
 */
type RepoMock = {
    findOne: ReturnType<typeof vi.fn>;
    find: ReturnType<typeof vi.fn>;
};

const SELLER_ID: ID = 'T_1';

function makeRepo(): RepoMock {
    return {
        findOne: vi.fn().mockResolvedValue(null),
        find: vi.fn().mockResolvedValue([]),
    };
}

describe('SellerScoreEntityResolver', () => {
    let resolver: SellerScoreEntityResolver;
    let snapshotRepo: RepoMock;
    let sellerRepo: RepoMock;
    let connection: TransactionalConnection;
    const ctx = RequestContext.empty();
    const parentScore = { sellerId: SELLER_ID } as unknown as SellerScore;

    beforeEach(() => {
        snapshotRepo = makeRepo();
        sellerRepo = makeRepo();
        connection = {
            getRepository: vi.fn((_ctx: any, entity: any) => {
                if (entity === SellerScoreSnapshot) {
                    return snapshotRepo;
                }
                if (entity === Seller) {
                    return sellerRepo;
                }
                throw new Error('Unexpected entity requested from the mock connection');
            }),
        } as unknown as TransactionalConnection;
        resolver = new SellerScoreEntityResolver(connection);
    });

    describe('history', () => {
        it('returns the seller snapshots ordered chronologically by calculatedAt ASC', async () => {
            const snapshots = [
                { id: 'T_1', sellerId: SELLER_ID, score: 60 },
                { id: 'T_2', sellerId: SELLER_ID, score: 72 },
            ] as unknown as SellerScoreSnapshot[];
            snapshotRepo.find.mockResolvedValue(snapshots);

            const result = await resolver.history(ctx, parentScore);

            expect(result).toBe(snapshots);
            expect(snapshotRepo.find).toHaveBeenCalledWith({
                where: { sellerId: SELLER_ID },
                order: { calculatedAt: 'ASC' },
            });
        });

        it('returns an empty history when the seller has no snapshots', async () => {
            snapshotRepo.find.mockResolvedValue([]);

            const result = await resolver.history(ctx, parentScore);

            expect(result).toEqual([]);
        });
    });

    describe('seller', () => {
        it('resolves the related core Seller by id', async () => {
            const seller = { id: SELLER_ID, name: 'Acme' } as unknown as Seller;
            sellerRepo.findOne.mockResolvedValue(seller);

            const result = await resolver.seller(ctx, parentScore);

            expect(result).toBe(seller);
            expect(sellerRepo.findOne).toHaveBeenCalledWith({ where: { id: SELLER_ID } });
        });

        it('returns undefined (not null) when the seller cannot be found', async () => {
            sellerRepo.findOne.mockResolvedValue(null);

            const result = await resolver.seller(ctx, parentScore);

            expect(result).toBeUndefined();
        });
    });
});
