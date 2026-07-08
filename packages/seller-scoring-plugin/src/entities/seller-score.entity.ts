import { DeepPartial } from '@vendure/common/lib/shared-types';
import { EntityId, ID, VendureEntity } from '@vendure/core';
import { Column, Entity, Index } from 'typeorm';

/**
 * @description
 * The current composite performance score for a single marketplace seller, plus the
 * per-metric values that produced it and whether the seller is currently flagged.
 * A `null` `score` (and `null` per-metric values) means the seller had no orders in
 * the rolling 90-day window. The full history of past calculations is kept separately
 * in {@link SellerScoreSnapshot}.
 *
 * @since 3.8.0
 * @docsCategory core plugins/SellerScoringPlugin
 */
@Entity()
export class SellerScore extends VendureEntity {
    constructor(input?: DeepPartial<SellerScore>) {
        super(input);
    }

    // Unique reference to the core Seller. Stored as a plain scalar id column via
    // @EntityId (NOT an owning/cascading relation), so the read-only core `seller`
    // table is never altered. Uniquely indexed: exactly one current-score row per seller.
    @Index({ unique: true })
    @EntityId()
    sellerId: ID;

    // Nullable composite score on a 0–100 scale; null when there are no orders in the window.
    @Column({ type: 'double precision', nullable: true })
    score: number | null;

    // Per-metric fractions (0–1), nullable for the no-orders case.
    @Column({ type: 'double precision', nullable: true })
    fulfillmentSla: number | null;

    @Column({ type: 'double precision', nullable: true })
    cancellationReturnRate: number | null;

    // Timestamp of the most recent recalculation; null if never calculated.
    @Column({ type: Date, nullable: true })
    lastCalculatedAt: Date | null;

    // true when the current composite score is below the configured flagging threshold.
    // Always false for a null (no-orders) score. The plugin only flags — never suspends/removes.
    @Column({ default: false })
    flagged: boolean;
}
