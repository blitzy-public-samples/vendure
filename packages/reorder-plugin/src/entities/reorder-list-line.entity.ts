import { DeepPartial, EntityId, ID, ProductVariant, VendureEntity } from '@vendure/core';
import { Check, Column, Entity, ManyToOne, Unique } from 'typeorm';

import { ReorderList } from './reorder-list.entity';

/**
 * @description
 * A ReorderListLine is one entry on a {@link ReorderList}: a reference to a single
 * {@link ProductVariant} together with the positive integer quantity the buyer keeps against it. One
 * row is one variant on one list, which is what lets a saved list express "two of this and six of
 * that" rather than merely "these things" — the per-line quantity is the whole reason this table
 * exists rather than a plain membership set.
 *
 * Four characteristics are load-bearing, and each is easy to undo by accident:
 *
 * 1. De-duplication is a *database* constraint and not a service convention. At most one row may
 *    exist for a given list-and-variant pair, and `UQ_reorder_list_line_list_variant` over
 *    `(reorderListId, productVariantId)` is what makes the rule unbypassable. Note what follows from
 *    that: adding a variant already present on the list is not an error and never reaches the
 *    constraint at all, because the add path resolves the existing row and accumulates onto its
 *    quantity instead of inserting a second one. The constraint therefore exists to make the rule
 *    enforceable rather than to produce a buyer-visible outcome, and a violation of it arriving at
 *    the service is an internal defect rather than something a caller can provoke.
 * 2. Quantity is guarded twice, deliberately, and the database is the *second* guard rather than the
 *    first. See {@link ReorderListLine.quantity}.
 * 3. The stored variant reference and the published one deliberately disagree on nullability. This is
 *    intentional and must not be "corrected" — see {@link ReorderListLine.productVariant}.
 * 4. A line does not know how many siblings it has. The line total a list reports is the stored
 *    counter on {@link ReorderList}, written in the same transaction as every insert and delete here,
 *    so nothing on this entity derives, caches or duplicates it.
 *
 * `id`, `createdAt` and `updatedAt` are inherited from {@link VendureEntity} and are deliberately not
 * re-declared here, though all three are part of this entity's published contract. `createdAt` is
 * also the only "when was this added" value there is; no separate timestamp column duplicates it.
 *
 * The column set is minimised rather than guessed, so every absence is a ruling rather than an
 * oversight. Three data columns are stored — the owning list, the variant and the quantity — and
 * nothing else: no free-text note, no explicit ordering column, no monetary column (a saved line is a
 * reference, valued when it is read rather than when it is written), no substitute-variant column, no
 * custom-field column of any kind, and no soft-delete, archival, retention or purge column. There is
 * likewise no replay-claim column, because the add operation publishes no caller-supplied replay
 * argument — so there would be nothing to store and no claim to pair it with, and a column retained
 * for a withdrawn input advertises a delivery guarantee the operation does not make. Delivery is
 * at-least-once, stated plainly, and the absolute-set adjust operation is the deterministic remedy.
 *
 * @docsCategory core plugins/ReorderPlugin
 * @docsPage ReorderListLine
 * @since 3.8.0
 */
@Entity()
@Unique('UQ_reorder_list_line_list_variant', ['reorderListId', 'productVariantId'])
@Check('CHK_reorder_list_line_quantity_positive', '"quantity" > 0')
export class ReorderListLine extends VendureEntity {
    constructor(input?: DeepPartial<ReorderListLine>) {
        super(input);
    }

    /**
     * @description
     * The {@link ReorderList} this line belongs to. This is the owning side of
     * {@link ReorderList.lines}, so the on-delete behaviour is declared here rather than on the
     * inverse side — and it is declared explicitly rather than left to the driver's default.
     *
     * `onDelete: 'CASCADE'` is what allows a list deletion to remove that list's lines in one
     * statement rather than in a loop: the delete is issued against the parent row and the engine
     * removes the children. A line has no meaning without the list it sits on and carries no audit
     * purpose, so there is nothing to retain once the parent row is gone.
     *
     * @since 3.8.0
     */
    @ManyToOne(() => ReorderList, list => list.lines, { onDelete: 'CASCADE', nullable: false })
    reorderList: ReorderList;

    /**
     * @description
     * The id of the owning list. A line is only ever addressed through this column together with the
     * owning list's own ownership predicate, so it is never reachable except by way of a list the
     * caller owns in the active channel.
     *
     * Declared with `@EntityId()` rather than an ordinary column decorator because the physical data
     * type of an id column is not known until run time, when the configured `EntityIdStrategy` has
     * been read: it resolves to an integer column under the default auto-increment strategy and to a
     * string column under a uuid strategy. A hand-typed column declaration would be frozen to one of
     * the two and would break under the other.
     *
     * This is also the leading column of `UQ_reorder_list_line_list_variant`, which already serves a
     * lookup by list alone, and no separate index on it is therefore declared.
     *
     * @since 3.8.0
     */
    @EntityId({ nullable: false })
    reorderListId: ID;

    /**
     * @description
     * The {@link ProductVariant} this line refers to.
     *
     * **This column and the published GraphQL field deliberately disagree on nullability, and the
     * pair is what makes a stale line readable rather than fatal. Do not "align" them.** The column
     * stays non-nullable because a retained line always points at a variant row that still exists:
     * the platform's ordinary variant deletion is a *soft* delete which flags the row rather than
     * removing it, and being disabled is likewise a flag on a row that remains present. The published
     * `productVariant` field — declared in the plugin's own SDL in `src/api/api-extensions.ts` and
     * served by the field resolver in `src/api/reorder-list-entity.resolver.ts` — is nullable
     * instead, because that resolver returns `null` when the variant is no longer resolvable in the
     * active channel. Were the published field non-null it could only expose a withdrawn catalogue
     * object or null-bubble the whole line out of its page, and the buyer would then be unable to see
     * the line at all, let alone act on it.
     *
     * `onDelete: 'CASCADE'` covers the one remaining case, a *hard* delete of the variant row, since
     * a line pointing at a variant that genuinely no longer exists is unusable. Be aware that this is
     * also the single path which can leave {@link ReorderList.lineCount} disagreeing with the rows it
     * counts, because those rows are removed by the engine rather than by the service; the
     * single-list read carries a compare-and-set repair for precisely that reason.
     *
     * @since 3.8.0
     */
    @ManyToOne(() => ProductVariant, { onDelete: 'CASCADE', nullable: false })
    productVariant: ProductVariant;

    /**
     * @description
     * The id of the referenced variant, and the second column of
     * `UQ_reorder_list_line_list_variant`. Unlike {@link ReorderListLine.productVariant} it is
     * non-null on both the stored column and the published field, so a buyer looking at a line whose
     * variant can no longer be resolved can still identify that line and remove it.
     *
     * Declared with `@EntityId()` for the run-time id-type reason given on
     * {@link ReorderListLine.reorderListId}.
     *
     * @since 3.8.0
     */
    @EntityId({ nullable: false })
    productVariantId: ID;

    /**
     * @description
     * How many of the referenced variant this line stands for: a strictly positive integer. Zero is
     * not the way to express "none of this" — removing the line is — and a negative count has no
     * meaning on a saved list at all.
     *
     * Stored with no default, so every insert supplies a value explicitly, and kept at 32-bit `int`
     * width rather than widened, because that ceiling is what the plugin's configured upper bound is
     * validated against when the plugin initialises.
     *
     * Two guards apply, and which of them comes first matters. The service is the primary guard: a
     * non-positive value, or a *resulting* value above the configured `maxQuantityPerLine`, is a
     * malformed request and is refused with the platform's own input error before any statement is
     * issued — which is why such a request surfaces as a single top-level error entry rather than as
     * a member of an operation's result union. `CHK_reorder_list_line_quantity_positive` is the
     * second guard, so that a further code path cannot bypass the first. Treat that check as defence
     * in depth rather than as a portable guarantee: TypeORM emits check constraints on PostgreSQL and
     * the SQLite family but skips them silently on MySQL and MariaDB, so the invariant has to be
     * upheld by the service on every write path whatever the engine.
     *
     * Note also that the add path accumulates onto this value with a single atomic statement rather
     * than reading it, computing a new total and saving that back. Read-then-save loses one of two
     * concurrent adds, because both can observe the same starting value and both then store the same
     * total, leaving the buyer holding fewer units than they asked for.
     *
     * @since 3.8.0
     */
    @Column({ type: 'int', nullable: false })
    quantity: number;
}
