import { gql } from 'graphql-tag';

/**
 * @description
 * The Admin API schema extension for the {@link SellerScoringPlugin}. Declares the
 * `SellerScore` and `SellerScoreSnapshot` types plus the fixed Admin API surface:
 * the `sellerScore` and `flaggedSellers` queries and the `recalculateSellerScore`
 * mutation. This `DocumentNode` is wired into the plugin via
 * `adminApiExtensions: { schema: adminApiExtensions, ... }`.
 *
 * @since 3.8.0
 */
export const adminApiExtensions = gql`
    type SellerScore {
        id: ID!
        sellerId: ID!
        score: Float
        fulfillmentSla: Float
        cancellationReturnRate: Float
        lastCalculatedAt: DateTime
        flagged: Boolean!
        seller: Seller
        history: [SellerScoreSnapshot!]!
    }

    type SellerScoreSnapshot {
        id: ID!
        sellerId: ID!
        score: Float!
        fulfillmentSla: Float!
        cancellationReturnRate: Float!
        calculatedAt: DateTime!
    }

    extend type Query {
        sellerScore(sellerId: ID!): SellerScore
        flaggedSellers: [SellerScore!]!
    }

    extend type Mutation {
        recalculateSellerScore(sellerId: ID!): SellerScore
    }
`;
