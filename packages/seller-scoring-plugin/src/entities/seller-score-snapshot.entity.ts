import { DeepPartial } from '@vendure/common/lib/shared-types';
import { EntityId, ID, VendureEntity } from '@vendure/core';
import { Column, Entity, Index } from 'typeorm';

/**
 * @description
 * An immutable historical snapshot of a seller's composite score and per-metric values
 * at the moment of a (non-null) recalculation. Exactly one row is written per non-null
 * recalculation; null-score recalculations write none. Rows are only ever inserted,
 * never updated (write-once history).
 *
 * @since 3.8.0
 * @docsCategory core plugins/SellerScoringPlugin
 */
@Entity()
export class SellerScoreSnapshot extends VendureEntity {
    constructor(input?: DeepPartial<SellerScoreSnapshot>) {
        super(input);
    }

    // Reference to the core Seller. Stored as a plain scalar id column via @EntityId
    // (NOT an owning/cascading relation), so the read-only core `seller` table is never
    // altered. Non-unique index: many snapshots per seller, queried as ordered history.
    @Index()
    @EntityId()
    sellerId: ID;

    // Non-null: snapshots are only written for non-null recalculations.
    @Column({ type: 'double precision' })
    score: number;

    @Column({ type: 'double precision' })
    fulfillmentSla: number;

    @Column({ type: 'double precision' })
    cancellationReturnRate: number;

    // Timestamp at which this snapshot's recalculation occurred.
    @Column({ type: Date })
    calculatedAt: Date;
}
