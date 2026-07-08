import { Parent, ResolveField, Resolver } from '@nestjs/graphql';
import { Ctx, RequestContext, Seller, TransactionalConnection } from '@vendure/core';

import { SellerScoreSnapshot } from '../entities/seller-score-snapshot.entity';
import { SellerScore } from '../entities/seller-score.entity';

/**
 * @description
 * Field resolvers for the `SellerScore` GraphQL type. Resolves the ordered
 * `history` of score snapshots and the related read-only core `Seller`. These
 * fields inherit the permission enforcement of the parent `sellerScore` /
 * `flaggedSellers` queries, so no additional `@Allow` is required here.
 *
 * @since 3.8.0
 */
@Resolver('SellerScore')
export class SellerScoreEntityResolver {
    constructor(private connection: TransactionalConnection) {}

    /**
     * @description
     * Resolves the seller's full score history as `SellerScoreSnapshot` rows
     * ordered chronologically by `calculatedAt` ascending.
     *
     * @since 3.8.0
     */
    @ResolveField()
    async history(@Ctx() ctx: RequestContext, @Parent() score: SellerScore): Promise<SellerScoreSnapshot[]> {
        return this.connection.getRepository(ctx, SellerScoreSnapshot).find({
            where: { sellerId: score.sellerId },
            order: { calculatedAt: 'ASC' },
        });
    }

    /**
     * @description
     * Resolves the related read-only core `Seller` for this score by id, or
     * `undefined` when the seller cannot be found.
     *
     * @since 3.8.0
     */
    @ResolveField()
    async seller(@Ctx() ctx: RequestContext, @Parent() score: SellerScore): Promise<Seller | undefined> {
        const seller = await this.connection
            .getRepository(ctx, Seller)
            .findOne({ where: { id: score.sellerId } });
        return seller ?? undefined;
    }
}
