import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import {
    Allow,
    Ctx,
    ID,
    Permission,
    RequestContext,
    Transaction,
    TransactionalConnection,
} from '@vendure/core';

import { SellerScore } from '../entities/seller-score.entity';
import { SellerScoringService } from '../services/seller-scoring.service';

/**
 * @description
 * Admin API resolver exposing the fixed Seller Scoring API surface: the
 * `sellerScore` and `flaggedSellers` queries and the `recalculateSellerScore`
 * mutation. Queries require `Permission.ReadSeller`; the mutation runs inside a
 * transaction and requires `Permission.UpdateSeller`.
 *
 * @since 3.8.0
 */
@Resolver()
export class SellerScoreAdminResolver {
    constructor(
        private connection: TransactionalConnection,
        private sellerScoringService: SellerScoringService,
    ) {}

    @Query()
    @Allow(Permission.ReadSeller)
    async sellerScore(
        @Ctx() ctx: RequestContext,
        @Args() args: { sellerId: ID },
    ): Promise<SellerScore | undefined> {
        const sellerScore = await this.connection
            .getRepository(ctx, SellerScore)
            .findOne({ where: { sellerId: args.sellerId } });
        return sellerScore ?? undefined;
    }

    @Query()
    @Allow(Permission.ReadSeller)
    async flaggedSellers(@Ctx() ctx: RequestContext): Promise<SellerScore[]> {
        return this.connection.getRepository(ctx, SellerScore).find({
            where: { flagged: true },
            order: { score: 'ASC' },
        });
    }

    @Transaction()
    @Mutation()
    @Allow(Permission.UpdateSeller)
    async recalculateSellerScore(
        @Ctx() ctx: RequestContext,
        @Args() args: { sellerId: ID },
    ): Promise<SellerScore | undefined> {
        return this.sellerScoringService.recalculate(ctx, args.sellerId);
    }
}
