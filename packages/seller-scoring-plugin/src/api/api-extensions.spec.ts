import { print } from 'graphql';
import { describe, expect, it } from 'vitest';

import { adminApiExtensions } from './api-extensions';

/**
 * Unit test for the Admin API schema extension. Asserts the exported `gql`
 * `DocumentNode` declares exactly the fixed Seller Scoring API surface — the
 * `SellerScore` / `SellerScoreSnapshot` types plus the `sellerScore` and
 * `flaggedSellers` queries and the `recalculateSellerScore` mutation — and does not
 * expand it with any additional operation.
 */
describe('adminApiExtensions', () => {
    it('is a GraphQL DocumentNode', () => {
        expect(adminApiExtensions.kind).toBe('Document');
        expect(Array.isArray(adminApiExtensions.definitions)).toBe(true);
        expect(adminApiExtensions.definitions.length).toBeGreaterThan(0);
    });

    it('declares the SellerScore and SellerScoreSnapshot object types', () => {
        const sdl = print(adminApiExtensions);
        expect(sdl).toContain('type SellerScore');
        expect(sdl).toContain('type SellerScoreSnapshot');
        // The nullable current-score fields and the non-null history relation.
        expect(sdl).toContain('score: Float');
        expect(sdl).toContain('flagged: Boolean!');
        expect(sdl).toContain('history: [SellerScoreSnapshot!]!');
        expect(sdl).toContain('seller: Seller');
    });

    it('extends Query with exactly sellerScore and flaggedSellers', () => {
        const sdl = print(adminApiExtensions);
        expect(sdl).toContain('sellerScore(sellerId: ID!): SellerScore');
        expect(sdl).toContain('flaggedSellers: [SellerScore!]!');
    });

    it('extends Mutation with exactly recalculateSellerScore', () => {
        const sdl = print(adminApiExtensions);
        expect(sdl).toContain('recalculateSellerScore(sellerId: ID!): SellerScore');
    });
});
