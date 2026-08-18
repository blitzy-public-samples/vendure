import { Channel, Customer, DeepPartial, EntityId, getConfig, ID, VendureEntity } from '@vendure/core';
import { Check, Column, ColumnOptions, Entity, Index, ManyToOne, OneToMany, Unique } from 'typeorm';

import { ReorderListLine } from './reorder-list-line.entity';

/**
 * The collation each engine needs on {@link ReorderList.nameKey} for the *database* to compare canonical
 * keys the same way the canonicalisation pipeline defines them — case-insensitively but
 * accent-*preservingly* — keyed by the TypeORM engine identifier.
 *
 * **Only the MySQL family appears here, and its absence elsewhere is a fact rather than an oversight.**
 * PostgreSQL and the SQLite family compare `varchar` byte for byte by default, so a canonical key that
 * differs only by an accent is already two distinct values there and no clause is needed. The MySQL family
 * does not: the server default is an accent-*insensitive* collation on both engines the existing engine
 * jobs exercise — `utf8mb4_0900_ai_ci` on MySQL 8 and `utf8mb4_uca1400_ai_ci` on MariaDB 11.5 — under which
 * `café` and `cafe` compare equal, so the unique constraint refuses the second of the two as a duplicate.
 * That is measured rather than inferred: creating a database on the MariaDB 11.5 image with no collation
 * override, giving a `varchar(191)` column a unique index and inserting `cafe` then `café` fails with
 * `ERROR 1062 Duplicate entry 'café'`, while the same table with `COLLATE "utf8mb4_bin"` on that column
 * accepts both rows.
 *
 * **`utf8mb4_bin` rather than an accent-sensitive-but-case-insensitive collation, deliberately.** The
 * canonical key has already been lower-cased and NFC-normalised by the time it reaches the column, so the
 * only comparison the database still has to perform is exact equality — and a binary collation is the one
 * form of that which means the same thing on both engines and needs no server-version-specific name. Because
 * the named unique constraint is the *sole* authority for a name collision, this collation is the whole of the
 * database half of the rule: there is no service-level pre-count whose semantics could drift from it.
 * The character set is deliberately not overridden, so the column stays `utf8mb4` and its
 * declared length of 191 continues to count characters rather than bytes.
 *
 * @since 3.8.0
 */
const ACCENT_SENSITIVE_NAME_KEY_COLLATIONS: ReadonlyMap<string, string> = new Map([
    ['mysql', 'utf8mb4_bin'],
    ['mariadb', 'utf8mb4_bin'],
]);

/**
 * @description
 * Returns the collation {@link ReorderList.nameKey} must carry on the given database engine for the named
 * unique constraint over it to be accent-preserving, or `undefined` where the engine's own default already
 * is. It is exported so that the migration which creates the table — and any test asserting the shape of
 * that table — derives the value from this one declaration rather than restating it.
 *
 * @param engine - The TypeORM engine identifier. Defaults to the configured one, read through the
 * platform's own pre-bootstrap config accessor.
 *
 * @since 3.8.0
 */
export function resolveReorderListNameKeyCollation(
    engine: string = getConfig().dbConnectionOptions.type,
): string | undefined {
    return ACCENT_SENSITIVE_NAME_KEY_COLLATIONS.get(engine);
}

/**
 * The column declaration for {@link ReorderList.nameKey}, held as a named object because its collation
 * cannot be a literal: the correct value depends on the configured engine, and an entity class is defined
 * when its module is imported, which is long before any engine is known.
 *
 * **The `collation` accessor is what closes that gap, and it is load-bearing rather than clever.** TypeORM's
 * `@Column` decorator stores the options object it is given **by reference** rather than copying it
 * (`node_modules/typeorm/decorator/columns/Column.js`, which pushes `options: options` onto the metadata
 * args storage), and the value is read from that object only when column metadata is built
 * (`node_modules/typeorm/metadata/ColumnMetadata.js`, `if (options.args.options.collation)`) — which happens
 * during `DataSource` initialisation. Every platform entry point resolves the configuration *before* that
 * point: `bootstrap` calls `setConfig` and runs the plugin configuration hooks before the ORM module is
 * created, and both migration entry points call `preBootstrapConfig` before opening their connection. So by
 * the time this accessor is consulted the configured engine is known, and it is consulted once per column
 * rather than per query.
 *
 * Should the configuration somehow not have been resolved, the platform's accessor answers with its own
 * default, whose engine is `mysql` — which errs towards *applying* the clause rather than silently dropping
 * it, and dropping it is the failure this declaration exists to prevent.
 *
 * @since 3.8.0
 */
const NAME_KEY_COLUMN_OPTIONS: ColumnOptions = {
    type: 'varchar',
    length: 191,
    nullable: false,
    get collation(): string | undefined {
        return resolveReorderListNameKeyCollation();
    },
};

/**
 * @description
 * A ReorderList is a named, buyer-curated collection of product variant references which a customer
 * keeps so that the same set can be purchased again later. One row is one list: it is owned by
 * exactly one {@link Customer} and scoped to exactly one {@link Channel}, and a customer may hold
 * several lists in the same channel — which is what separates a named reorder list from a single
 * unnamed saved collection. The lines, each carrying a positive integer quantity, live on
 * {@link ReorderListLine}.
 *
 * Three characteristics of this entity are load-bearing, and each is easy to undo by accident:
 *
 * 1. Uniqueness of a list name is a *database* constraint and never a service pre-check. It is
 *    enforced by `UQ_reorder_list_customer_channel_name_key` over `(customerId, channelId, nameKey)`.
 *    A "does this name exist yet?" read followed by an insert loses a race; the constraint does not.
 *    And because the constraint is *named*, a violation can be matched precisely and translated into
 *    a specific name-conflict error, instead of leaking a driver message to the caller.
 * 2. Ownership is a pair of columns, not an unguessable identifier. Under the platform's default id
 *    strategy identifiers are sequential and therefore guessable, so `customerId` and `channelId`
 *    taken together with the active session are the whole of the access control. Every read and
 *    every write filters on all three, and `IDX_reorder_list_customer_channel` is the index that
 *    predicate is served by.
 * 3. `lineCount` is stored rather than derived. See that property's own description.
 *
 * `id`, `createdAt` and `updatedAt` are inherited from {@link VendureEntity} and are deliberately not
 * re-declared here, though all three are part of this entity's published contract.
 *
 * This entity supports no custom fields by design, and so deliberately implements no custom-field
 * interface and declares no custom-field column of any kind. Nor does it carry any soft-delete,
 * archival, retention or purge column: the cascade on the owner relation is its only lifecycle
 * behaviour.
 *
 * @docsCategory core plugins/ReorderPlugin
 * @docsPage ReorderList
 * @since 3.8.0
 */
@Entity()
@Unique('UQ_reorder_list_customer_channel_name_key', ['customerId', 'channelId', 'nameKey'])
@Index('IDX_reorder_list_customer_channel', ['customerId', 'channelId'])
@Check('CHK_reorder_list_line_count_non_negative', '"lineCount" >= 0')
export class ReorderList extends VendureEntity {
    constructor(input?: DeepPartial<ReorderList>) {
        super(input);
    }

    /**
     * @description
     * The {@link Customer} who owns this list. The relation is declared `onDelete: 'CASCADE'` because a
     * saved list has no meaning without its owner and carries no audit purpose, so there is nothing to
     * retain once the owning row is gone.
     *
     * Note that the platform's ordinary customer deletion is a *soft* delete which merely flags the
     * customer row rather than removing it, so the cascade does not fire and a soft-deleted owner's
     * lists persist. That is why ownership is resolved against the authenticated session rather than
     * against row existence.
     *
     * @since 3.8.0
     */
    @ManyToOne(() => Customer, { onDelete: 'CASCADE', nullable: false })
    customer: Customer;

    /**
     * @description
     * The id of the owning customer, and the first half of the ownership predicate that guards every
     * operation on this table.
     *
     * Declared with `@EntityId()` rather than an ordinary column decorator because the physical data
     * type of an id column is not known until run time, when the configured `EntityIdStrategy` has
     * been read: it resolves to an integer column under the default auto-increment strategy and to a
     * string column under a uuid strategy. A hand-typed column declaration would be frozen to one of
     * the two and would break under the other.
     *
     * @since 3.8.0
     */
    @EntityId({ nullable: false })
    customerId: ID;

    /**
     * @description
     * The {@link Channel} this list belongs to. A list is reachable only from the channel it was
     * created in, so channel scoping is a stored column rather than an assumption. Declared
     * `onDelete: 'CASCADE'` for the same reason as {@link ReorderList.customer}.
     *
     * @since 3.8.0
     */
    @ManyToOne(() => Channel, { onDelete: 'CASCADE', nullable: false })
    channel: Channel;

    /**
     * @description
     * The id of the owning channel, and the second half of the ownership predicate. It is resolved
     * from the active channel on the request rather than from any client-supplied argument, so a
     * caller cannot address a list in a channel their token does not select.
     *
     * Declared with `@EntityId()` for the run-time id-type reason given on
     * {@link ReorderList.customerId}.
     *
     * @since 3.8.0
     */
    @EntityId({ nullable: false })
    channelId: ID;

    /**
     * @description
     * The display form of the buyer-supplied list name — the value a buyer is shown, and never the
     * value a comparison uses.
     *
     * It is *not* the raw input: leading and trailing whitespace is removed and internal whitespace
     * runs are collapsed to a single space. Nothing else is altered. In particular there is no case
     * folding and no Unicode normalisation here; both of those belong to {@link ReorderList.nameKey}.
     * Beyond that whitespace canonicalisation the value round-trips byte for byte, so
     * markup-significant characters are stored exactly as submitted and are neither escaped, stripped
     * nor entity-encoded at rest — presentation is the consumer's responsibility.
     *
     * The canonicalisation itself is not performed here; this property only declares the column. It
     * lives in the plugin's own name helper alongside the length and emptiness checks, so that the one
     * service owning this table applies it before any uniqueness comparison.
     *
     * The declared width of 191 is an engine constraint rather than a product choice, and the
     * constraint is inherited rather than direct: it is `nameKey` — and only `nameKey` — that
     * participates in `UQ_reorder_list_customer_channel_name_key`, and 191 four-byte UTF-8
     * characters is the length that keeps that composite index inside the key-size limit on the
     * MySQL and MariaDB engines. This column participates in no index at all; it is held at the
     * same width because it stores the same buyer input as the value `nameKey` is derived from, so
     * a width that admitted a longer display name than its own canonical form could be stored under
     * would make the pair unstorable rather than merely asymmetric.
     * The plugin's `MAX_LIST_NAME_LENGTH` constant is the same number by requirement and not by
     * coincidence — the two must be changed together or not at all, and there is deliberately no
     * option to configure either. It is not imported here, because an entity must not depend on the
     * plugin's own configuration module.
     *
     * @since 3.8.0
     */
    @Column({ type: 'varchar', length: 191, nullable: false })
    name: string;

    /**
     * @description
     * The canonical form of the list name, and the only value uniqueness is tested against. It is
     * produced from the buyer's input by a fixed four-step pipeline applied in this order: trim,
     * collapse internal whitespace runs, normalise to Unicode NFC, then lower-case.
     *
     * The order is what gives the comparison its two intended properties. Lower-casing makes it
     * case-insensitive, so "Weekly Order" and "weekly order" are the same list. NFC normalisation
     * makes it insensitive to how an accent was encoded, so a decomposed and a precomposed spelling
     * of one name collide. But normalisation is not decomposition-and-stripping, so the comparison
     * remains accent-*preserving*: "Café" and "Cafe" are different canonical forms and therefore
     * remain two distinct lists.
     *
     * Stored at the same 191-character width as {@link ReorderList.name} because it is the column
     * that actually participates in `UQ_reorder_list_customer_channel_name_key`.
     *
     * **Canonicalising the value is only half of what makes the comparison engine-independent, and the other
     * half is this column's collation.** The pipeline decides which two names *ought* to collide; the
     * database decides which two stored values *do*, and it decides that under the collation of the column
     * the constraint indexes. On the MySQL family the server default is accent-insensitive, so without an
     * explicit collation `café` and `cafe` would collide there and not on PostgreSQL — the same buyer getting
     * different behaviour on different engine jobs, which is precisely what the canonical column exists to
     * prevent. The column therefore carries an engine-resolved binary collation on those engines and none on
     * the engines whose default is already binary; see {@link resolveReorderListNameKeyCollation} for the
     * measurement behind that and for why the value cannot be a literal. Since
     * `UQ_reorder_list_customer_channel_name_key` indexes this column and is the only thing that decides a
     * collision, this clause is not one input to the rule among several — it *is* the comparison the rule
     * performs.
     *
     * One consequence belongs to whoever writes the migration rather than to this file: the clause is part of
     * this column's declaration, so a table this plugin creates carries it, but TypeORM does not compare
     * column collations when it diffs an *existing* MySQL-family table, so a table created before this
     * declaration existed would keep its old collation until altered explicitly.
     *
     * @since 3.8.0
     */
    @Column(NAME_KEY_COLUMN_OPTIONS)
    nameKey: string;

    /**
     * @description
     * The denormalised count of lines on this list, and the single authority for the published line
     * count. It is written in the same transaction as every line insert and every line delete, and
     * defaults to exactly `0`, which is what makes a freshly created list report a count of zero
     * without reading the line table at all.
     *
     * It exists to make the per-list line bound enforceable atomically. The bound is applied by a
     * conditional counter update — incrementing the counter only while it is still below the
     * configured maximum and inserting the line only if that update affected a row — so two
     * concurrent adds cannot both observe room for the last line. A count-then-insert cannot offer
     * that guarantee.
     *
     * Because the value is stored, deriving it anywhere else is forbidden: it must not be produced by
     * a per-entry counting resolver, nor by a grouped count issued alongside a page, nor from the
     * length of a loaded {@link ReorderList.lines} relation. The stored column arrives with the row.
     *
     * `CHK_reorder_list_line_count_non_negative` guards the floor, so a defect that decremented the
     * counter past zero is refused by the database rather than silently raising the effective bound.
     * Be aware that the constraint is a defence in depth and not a portable guarantee: TypeORM emits
     * check constraints on PostgreSQL and the SQLite family but skips them silently on MySQL and
     * MariaDB, so the invariant must also be upheld by the service on every write path.
     *
     * @since 3.8.0
     */
    @Column({ type: 'int', nullable: false, default: 0 })
    lineCount: number;

    /**
     * @description
     * The lines belonging to this list. This is the inverse side of the relation, so it declares no
     * on-delete behaviour of its own: the cascade that removes a list's lines is declared on the
     * owning side, which lets a list deletion remove its lines in one statement rather than in a loop.
     *
     * The relation is **not eager**, so it is not loaded by default and this array is undefined on an
     * arbitrarily obtained instance: it is populated only where a query explicitly asks for it — by
     * naming the relation in a find operation or joining it in a query builder. Every read the plugin
     * publishes resolves it explicitly, as its own bounded page, by the service member the published
     * `lines` field is served from, rather than loading it wholesale. Note that "not eager" is not the
     * same as a TypeORM *lazy* relation, which would require the relation to be configured as lazy and
     * this property to be typed as a `Promise`; it is neither, and describing it as lazy would tell a
     * reader to await something that is simply absent. Consumers must therefore not assume it is
     * populated, and in particular must not derive {@link ReorderList.lineCount} from its length.
     *
     * @since 3.8.0
     */
    @OneToMany(() => ReorderListLine, line => line.reorderList)
    lines: ReorderListLine[];
}
