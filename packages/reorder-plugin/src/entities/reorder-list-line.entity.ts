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
 *    `(reorderListId, productVariantId)` is what makes the rule unbypassable. Two consequences
 *    follow, and the second is the one that is easy to remove by mistake. In the ordinary case —
 *    adding a variant the list already holds — nothing reaches the constraint: the add path resolves
 *    the existing row and accumulates onto its quantity instead of inserting a second one, so the add
 *    succeeds and no violation occurs. But two ordinary callers adding the *same* variant to a list
 *    that holds neither of them can both find no existing row and both insert, and then the loser
 *    reaches this constraint — legitimately, provoked by nothing more than simultaneity. That
 *    violation is an **expected signal rather than a fault**: `ReorderListService` recognises this one
 *    named object, lets the failure unwind its transaction, and retries the whole add against the
 *    winner's now-committed row, accumulating onto it instead of inserting. Exactly one row survives
 *    either way — that part is unconditional, and it is what the constraint guarantees. What the
 *    retry's *outcome* depends on is the quantity that results: where the two increments together stay
 *    within `maxQuantityPerLine` the loser succeeds as well, the surviving row holds the sum, and no
 *    error reaches either buyer; where they do not, the retry re-validates against the winner's
 *    committed value and refuses the loser with the same top-level `UserInputError` that a single
 *    over-maximum add receives — two adds of 600 against a maximum of 999 leave the winner's 600
 *    intact and refuse the second, because a resulting quantity of 1200 cannot be stored and being
 *    concurrent does not make it storable. Treating a violation of this constraint as an internal
 *    defect — or removing the reconciliation because "the add path already checks first" —
 *    reintroduces a buyer-visible failure in the one case the constraint exists to arbitrate.
 * 2. Quantity is guarded twice, deliberately, and the database is the *second* guard rather than the
 *    first. See {@link ReorderListLine.quantity}.
 * 3. The stored variant reference and the published one deliberately disagree on nullability. This is
 *    intentional and must not be "corrected" — see {@link ReorderListLine.productVariant}.
 * 4. A line does not know how many siblings it has. The line total a list reports is the stored
 *    counter on {@link ReorderList}, written in the same transaction as every insert and delete here,
 *    so nothing on this entity derives, caches or duplicates it.
 *
 * **This entity declares exactly two named database objects, and a third is not a free addition.**
 * The feature contract enumerates five named objects across the two plugin tables — two here and
 * three on {@link ReorderList} — and requires the count itself to be asserted "so an addition is
 * visible rather than absorbed" [tickets/EPIC-001/FEATURE-001-01-named-reorder-lists.md:§2.4, §5].
 * A variant-only index for the cascade that fires when a variant is hard-deleted is the obvious
 * candidate for a third, and it is deliberately absent: it would be a sixth object across the two
 * tables that the contract does not authorise, and nothing this plugin does needs it.
 * `UQ_reorder_list_line_list_variant` leads with
 * `reorderListId` and therefore already serves every lookup the service performs — a list's own
 * lines, and the one line a list holds for a variant — no operation issues a predicate led by
 * `productVariantId` alone, the MySQL family creates an index for a foreign key of its own accord,
 * and the platform's own variant deletion is a *soft* delete, so the cascade fires only for a hard
 * delete issued outside the shipped operations. That path is also the one drift the stored line
 * counter's repair exists to correct, so it is covered rather than ignored. An index this feature
 * genuinely needs belongs in the contract first, so that the entity, the migration and the tests all
 * move together.
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
     * **Three of the four automated engines make that width a real ceiling and the SQLite family does
     * not**, so the half of the rationale that holds everywhere is the published one rather than the
     * stored one: the GraphQL `Int` this value is returned as is a signed 32-bit integer on every engine,
     * while the column enforces the range only where the engine enforces a declared integer width.
     * `2147483648` is refused by PostgreSQL 16.15 with `22003 integer out of range` and by MariaDB 11.5.2
     * and MySQL 8.0.43 with errno 1264 `ER_WARN_DATA_OUT_OF_RANGE`; on the SQLite family TypeORM renders
     * `int` as SQLite `integer`, a 64-bit storage class, and the same value is accepted and stored
     * unchanged, reading back as given — measured on sql.js 1.13.0 (SQLite 3.49.1) and native SQLite
     * 3.49.2. `2147483647` is accepted on all four. `maxQuantityPerLine` is what keeps a stored quantity
     * inside the 32-bit range in process on every engine, and on the SQLite family it is the only thing
     * that does — the same shape of gap the MySQL family has on the named check constraint discussed just
     * below, and the package README states the two together. There is nothing narrower to declare here,
     * SQLite offering no 32-bit integer type.
     *
     * Two guards apply, and which of them comes first matters. The service is the primary guard: a
     * non-positive value, or a *resulting* value above the configured `maxQuantityPerLine`, is a
     * malformed request and is refused with the platform's own input error before any write is issued
     * — which is why such a request surfaces as a single top-level error entry rather than as a
     * member of an operation's result union. Before that refusal the service does read: it resolves
     * who is asking, and on the add path the list, the variant and any line the variant already has,
     * because a bound on the *resulting* quantity cannot be applied without knowing the current one.
     * The guarantee is that no row is written on a refused path, not that no statement is
     * issued. `CHK_reorder_list_line_quantity_positive` is the second guard, so that a further code
     * path cannot bypass the first. Treat that check as defence
     * in depth rather than as a portable guarantee: TypeORM emits check constraints on PostgreSQL and
     * the SQLite family but skips them silently on MySQL and MariaDB, so the invariant has to be
     * upheld by the service on every write path whatever the engine.
     *
     * It is, and the enforcement divides into two kinds that are worth keeping apart rather than summing.
     * On the ACCUMULATING path the bound is carried by the statement's own `WHERE` — the increment is
     * predicated on `quantity <= maxQuantityPerLine - increment`, so the database declines a write whose
     * resulting value would breach the maximum, on every engine. The other two writes that set this
     * column — the insert of a new line, and the absolute set of `adjustReorderListLine` — carry ownership
     * and identity conjuncts only, with no value bound: an insert has no value to predicate on, and the
     * absolute set is refused before the statement is built. What refuses a bad quantity there is
     * therefore an IN-PROCESS guard, run before any write on both paths. On PostgreSQL and the SQLite
     * family the check constraint stands behind that guard; on MySQL and MariaDB the guard is the only
     * thing standing.
     *
     * So what the missing constraint costs on MySQL and MariaDB is two things, not one: the defence
     * against a write that does not come through this plugin at all — direct SQL, or another application
     * sharing the schema — which those two engines will accept, storing a zero or negative quantity; and,
     * for the insert and the absolute set, the database-side backstop behind an in-process check. That gap
     * is conflict C-E, it is unresolved, and it is stated in the package README rather than left to be
     * discovered.
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
