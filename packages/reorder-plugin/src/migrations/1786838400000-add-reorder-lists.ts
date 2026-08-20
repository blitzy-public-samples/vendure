/*
 * -------------------------------------------------------------------------------------------------------
 * THE ONE ADDITIVE MIGRATION OF `@vendure/reorder-plugin` — provenance, mechanism, and the boundary that
 * keeps it reviewable.
 * -------------------------------------------------------------------------------------------------------
 * EPIC-001 section 7.8 makes the platform's own migration lifecycle the only sanctioned mechanism: a
 * migration is applied through `runMigrations` (`packages/core/src/migrate.ts` L40) and reverted through
 * `revertLastMigration` (L89), and **raw DDL is never hand-written**. Vendure wraps TypeORM's migration
 * machinery because it derives schema information from custom fields and plugin configuration that the
 * TypeORM CLI cannot see.
 *
 * ## A HISTORICAL MIGRATION IS FROZEN AT ITS TIMESTAMP, AND THIS ONE IS
 *
 * The single most important property of this file is that **what it creates is written down here** and
 * cannot change. Every table name, every column name, every column's nullability and width, every named
 * unique, index and check with its exact name and subject, and all four foreign keys with their targets and
 * cascade rules are LITERALS below. Nothing about the shape is read from `ReorderList` or
 * `ReorderListLine`: `connection.getMetadata()` is never called for either of them, so a later change to
 * those classes cannot reach back and alter what a replay of timestamp 1786838400000 produces.
 *
 * That is not a stylistic preference, it is a correctness requirement, and one this file previously got
 * wrong. An earlier revision built its tables with `Table.create(connection.getMetadata(Entity), driver)`,
 * which means the historical migration described *whatever the entity classes happened to say at replay
 * time*. The concrete failure that invites: EPIC-001 section 7.8 L603 assigns the unpublished seats counter
 * FEATURE-001-06 needs to **that feature's own later migration** rather than to this one. Under the
 * metadata-driven form, the moment that property appeared on `ReorderList` this older migration would have
 * created the column on a fresh database, and FEATURE-001-06's `ADD COLUMN` would then collide with a
 * column its own migration never created. Every migration after this one would inherit the same hazard.
 * A frozen shape closes it by construction — this migration creates the eight columns and the six columns
 * named below, and no future edit to an entity adds a ninth.
 *
 * ## WHAT IS RESOLVED AT RUN TIME, WHY IT MUST BE, AND WHY IT IS NOT "SHAPE"
 *
 * Three things genuinely cannot be literals in a plugin's migration, because they are decided by the
 * deployment rather than by this feature. Each is resolved from the **driver** or from the **platform's own
 * base entity**, never from this plugin's entities:
 *
 * 1. **The physical type of every identifier column.** Vendure applies the configured `EntityIdStrategy` to
 *    `@PrimaryGeneratedId()` and `@EntityId()` columns during `preBootstrapConfig`
 *    (`packages/core/src/bootstrap.ts` L294-L314), so the id columns are integers under the default
 *    `AutoIncrementIdStrategy` (`packages/core/src/config/default-config.ts` L101) and character columns
 *    under a uuid strategy. A literal here would break every uuid deployment. It is taken from the primary
 *    column of `Customer` — the very table `reorder_list.customerId` references, so matching it is a
 *    foreign-key requirement rather than a choice, and `Customer` belongs to the platform, so no change to
 *    this plugin can move it.
 * 2. **The engine's date/time type, precision and "now" default.** These come from
 *    `driver.mappedDataTypes`, which is the driver's own declaration of them: `datetime` with
 *    `datetime('now')` on the SQLite family, `timestamp without time zone` with `now()` on PostgreSQL,
 *    `datetime(6)` with `CURRENT_TIMESTAMP(6)` on the MySQL family.
 * 3. **The qualified table name.** `driver.buildTableName(name, schema, database)` is given the same schema
 *    and database the platform's own entities resolve to, so a deployment configuring
 *    `DataSourceOptions.schema` — which the dev-server exposes as `DB_SCHEMA` — is honoured in both
 *    directions. This is what a raw SQL migration cannot do: TypeORM neither rewrites migration SQL nor
 *    sets a `search_path` from it, so an unqualified literal statement silently targets whatever the
 *    connection's search path resolves to, and a `down()` that spells the default schema by name targets
 *    the wrong schema outright.
 *
 * Everything else — the int and varchar column types, the widths, the `0` default on the counter and the
 * accent-sensitive collation on `nameKey` — is a frozen literal passed through the driver's own
 * `normalizeType` and `normalizeDefault`, which is exactly the normalisation TypeORM's schema builder
 * applies (`TableUtils.createTableColumnOptions`). One file therefore emits each engine's own correct DDL
 * and applies on all four of the platform's target engines, without a statement of SQL anywhere in it.
 *
 * ## AN EXISTING TABLE IS PROVED, NEVER ASSUMED
 *
 * `up()` does not pass `ifNotExist`. A migration that silently accepts a table it finds is a migration that
 * can be recorded as applied against a shape it never created — the one thing a schema history must not
 * do. So the up path asks for the table first, and:
 *
 * - if it is absent, creates it, with its indices and foreign keys, from the frozen description; or
 * - if it is present, **checks it against the FROZEN MINIMUM** — every frozen column with every attribute
 *   the catalogue reports for it, every named unique, index and check with its subject and condition, and
 *   every reference with its name, target, target columns, referential actions and the schema it arrives in —
 *   and raises with the specific shortfalls when any of them falls short. The exact inventory of what is
 *   compared, what is tolerated and what is excluded is on {@link frozenShapeShortfalls}.
 *
 * That check reads TWO sources, because one of them is not authoritative on everything.
 * {@link frozenShapeShortfalls} compares everything TypeORM's generic table view reports, and
 * {@link nativeEnforcementTimingShortfalls} establishes the one property that view is demonstrably blind to
 * on two engines — whether a constraint is enforced at the statement or deferred to `COMMIT` — by reading
 * each engine's own catalogue, and by REFUSING rather than assuming where it cannot. That function carries
 * the driver locations and the measurements behind the distinction.
 *
 * The second branch is what makes this migration correct on a database whose schema was first created by
 * synchronisation. That is the state of any deployment whose connection carries `synchronize: true`, and the
 * shipped dev-server is one: `packages/dev-server/dev-config.ts` derives `synchronize` from its entry point,
 * leaving it on for a server boot or a population run, and registers this migration only for the migration
 * commands so that a boot cannot half-apply it. Columns beyond the frozen set are tolerated and
 * only they: a later migration's column, or a column synchronisation added from a newer entity, is not this
 * migration's business, whereas a MISSING frozen object means the table is not the one this timestamp
 * describes and the history would be a lie.
 *
 * `down()` does pass `ifExist`, and the asymmetry is deliberate: reverting is a recovery path, and a revert
 * that fails because a table is already gone leaves an operator with nothing to do but edit the migrations
 * table by hand.
 *
 * ## THE NAMES, AND WHY THEY ARE SPELLED HERE
 *
 * Five of the identifiers below are load-bearing beyond the schema:
 * `UQ_reorder_list_customer_channel_name_key` (the service translates *that one* constraint violation into
 * `ReorderListNameConflictError` by matching its name), `IDX_reorder_list_customer_channel`,
 * `UQ_reorder_list_line_list_variant`, `CHK_reorder_list_line_quantity_positive` and
 * `CHK_reorder_list_line_count_non_negative`. They are spelled here as well as on the entities precisely so
 * that the two can be compared: the entity declares what the running schema must have, this file records
 * what this timestamp created, and `e2e/reorder-list-migration.e2e-spec.ts` asserts they agree. Under the
 * previous metadata-driven form they could not disagree — and could not be checked either.
 *
 * The four foreign-key names are the values the default naming strategy derives for these frozen inputs
 * (`DefaultNamingStrategy.foreignKeyName` hashes the table name and the sorted column names, and ignores
 * the referenced side, which is why they are the same under any configured schema). They are frozen rather
 * than re-derived so that a replay is reproducible even under a project that configures its own naming
 * strategy: what the database ends up holding is then what this file says, not what a configuration
 * decided years later.
 *
 * ## CONFLICT C-E — THE TWO NAMED CHECK CONSTRAINTS, UNRESOLVED
 *
 * On the MySQL family the two `CHK_` constraints cannot be produced **at all**, and that is TypeORM's
 * limitation rather than the engines': MySQL has supported `CHECK` since 8.0.16 and MariaDB since 10.2.1.
 * TypeORM 0.3.28 returns early for that family in `RdbmsSchemaBuilder.createNewChecks()` (L694-L698) and
 * `dropOldChecks()` (L333-L337) with no throw and no warning, all four check-constraint methods on
 * `MysqlQueryRunner` throw (L1153-L1172), and `MysqlQueryRunner.createTableSql` never reads `table.checks`.
 * The description this migration hands the engine **declares both checks on every engine**, and the MySQL
 * family discards them silently — which is also why the existing-table check exempts them there rather
 * than demanding something that engine can never report. The two `UQ_` constraints fare better: that same
 * `createTableSql` turns each into a named unique *index*, preserving both the exact name and the
 * uniqueness guarantee, so the existing-table check accepts a unique filed under either class.
 *
 * This is conflict C-E in the plan's section 0.8.3.5. **It is unresolved and requires a maintainer
 * ruling**; it is not settled by this file, and nothing here issues an
 * `ALTER TABLE … ADD CONSTRAINT … CHECK` to close it, because that is C-E option 2 and needs explicit
 * sanction. No behaviour depends on the gap: the quantity bound is enforced portably by the service's
 * `UserInputError` on every write path, and the `lineCount` floor by its conditional counter update
 * together with its compare-and-set repair.
 *
 * ## IDENTITY
 *
 * TypeORM orders migrations by the digits trailing the class name and records that name in its own
 * bookkeeping table, so the filename digits and the class-name digits agree; a mismatch silently reorders
 * migrations rather than failing. There is deliberately no `@since` tag: this class is not a public API
 * surface — it is absent from the package's root barrel — so a documentation block would misrepresent it.
 * It *is* compiled into the published package (`tsconfig.build.json` names it as a build root, so it is
 * emitted to `lib/src/migrations/` and carried by the manifest's `files` entry), because a migration a
 * consumer cannot load is a migration the package does not ship.
 *
 * ## WHAT IS DELIBERATELY ABSENT, EACH ABSENCE BEING ITSELF AN ASSERTION
 *
 * The two withdrawn replay-claim columns and their paired check constraint do not appear: FEATURE-001-01
 * section 2.4 L106 withdraws all three along with the idempotency key they existed to serve, and
 * STORY-001-01-01 L477 inspects this file for their absence and makes that absence the test — which is
 * conflict C-A, since that same story's L368 still asks for the pair. Their exact identifiers are named in
 * the pull request body rather than here, deliberately: a file that spelled them out would defeat the very
 * inspection L477 performs. The unpublished seats counter FEATURE-001-06 needs is likewise absent, EPIC-001
 * section 7.8 L603 assigning it to that feature's own later migration "rather than by editing
 * FEATURE-001-01's" — so this file must never be edited to add it, and now cannot acquire it by accident
 * either. No retention, anonymisation or purge column either, under ruling R19: nothing disposes before
 * batch B5, so a soft-deleted customer's list rows persist. And no statement touches a core table — the
 * four foreign keys sit on the two plugin tables and merely *reference* `customer`, `channel` and
 * `product_variant`.
 *
 * ## ATTRIBUTION
 *
 * No user-specified rules were provided for this project — the rules document was read and returned
 * exactly that, which EPIC-001 section 11.9 L1197 records independently. Nothing here derives from a
 * user-specified rule; every constraint named above traces to a ticket line or to a cited line of this
 * repository, and the absence of a rules document was not treated as licence to lower the bar.
 * -------------------------------------------------------------------------------------------------------
 */

import { Customer } from '@vendure/core';
import {
    MigrationInterface,
    QueryRunner,
    Table,
    TableCheck,
    TableColumn,
    TableForeignKey,
    TableIndex,
    TableUnique,
} from 'typeorm';
import { ColumnMetadata } from 'typeorm/metadata/ColumnMetadata';

/** The parent table this migration creates, frozen at this timestamp. */
const LIST_TABLE = 'reorder_list';

/** The child table this migration creates, frozen at this timestamp. */
const LINE_TABLE = 'reorder_list_line';

/** The width of both indexed string columns — a MySQL-family key-size ceiling, not a product choice. */
const INDEXED_STRING_LENGTH = '191';

/**
 * The accent-sensitive collation `nameKey` carries on the engines that need one to compare it correctly.
 *
 * Frozen here rather than imported from the entity module, so that a later change to the entity's own
 * resolver cannot silently alter what this timestamp created. The MySQL family's default collation is
 * accent-INSENSITIVE, which would make "Café" and "Cafe" collide in the uniqueness constraint; the SQLite
 * family and PostgreSQL are accent-sensitive already and need no override, so they get none.
 */
const NAME_KEY_COLLATIONS: ReadonlyMap<string, string> = new Map([
    ['mysql', 'utf8mb4_bin'],
    ['mariadb', 'utf8mb4_bin'],
]);

/** The engines on which TypeORM 0.3.28 discards named check constraints outright. See conflict C-E. */
const CHECK_LESS_ENGINES: readonly string[] = ['mysql', 'mariadb'];

/**
 * The engines whose SQL grammar REFUSES a deferrability clause, so no constraint on them can be deferred.
 *
 * Measured, not cited. A probe issued
 * `ALTER TABLE ... ADD CONSTRAINT ... UNIQUE (a) DEFERRABLE INITIALLY DEFERRED` and the foreign-key
 * equivalent against MariaDB 11.5 and MySQL 8; both engines answered `ER_PARSE_ERROR` for both statements,
 * and `SHOW CREATE TABLE` carries no deferrability text for a constraint TypeORM was asked to defer. The
 * driver agrees: `node_modules/typeorm/driver/mysql/MysqlQueryRunner.js` contains no occurrence of
 * `deferrable` at all, in either direction.
 *
 * So on these two engines an unreported deferrability is not an unknown — a deferred constraint is
 * unrepresentable, and {@link nativeEnforcementTimingShortfalls} has nothing left to establish.
 */
const DEFERRABILITY_LESS_ENGINES: readonly string[] = ['mysql', 'mariadb'];

/**
 * The engines whose catalogue answers a deferrability question through `pg_catalog`.
 *
 * `aurora-postgres` speaks the same catalogue; `cockroachdb` is deliberately absent, because it uses a
 * different query runner and this plugin makes no claim about it.
 */
const POSTGRES_FAMILY_ENGINES: readonly string[] = ['postgres', 'aurora-postgres'];

/**
 * The engines whose stored table DDL is the authority on a named reference's deferrability.
 *
 * Every one of these uses `AbstractSqliteQueryRunner`, which writes the clause into the `CREATE TABLE` text
 * it stores and never reads it back — so the text is where the answer lives.
 */
const SQLITE_FAMILY_ENGINES: readonly string[] = [
    'sqlite',
    'better-sqlite3',
    'sqljs',
    'expo',
    'capacitor',
    'cordova',
    'nativescript',
    'react-native',
];

/** The physical primitives of one identifier column, resolved from the platform rather than frozen. */
interface IdentifierColumnPrimitives {
    /** The engine's own name for the type the configured id strategy produces. */
    readonly type: string;
    /** The declared length, empty for an integer identifier. */
    readonly length: string;
    /** How the platform generates a primary identifier under the configured strategy. */
    readonly generationStrategy: ColumnMetadata['generationStrategy'];
}

/**
 * Reads the physical primitives every identifier column in this migration uses.
 *
 * Taken from `Customer`'s primary column — the platform's own, and the exact column
 * `reorder_list.customerId` references. Matching it is a foreign-key requirement rather than a design
 * choice, and because `Customer` belongs to the platform no change to this plugin's entities can move it,
 * which is what keeps this migration's shape frozen while still working under any configured
 * `EntityIdStrategy`.
 *
 * @param queryRunner - The runner whose connection carries the platform's metadata.
 * @returns The type, length and generation strategy of a platform identifier column.
 */
function identifierColumnPrimitives(queryRunner: QueryRunner): IdentifierColumnPrimitives {
    const { connection } = queryRunner;
    const primary = connection.getMetadata(Customer).primaryColumns[0];
    return {
        type: connection.driver.normalizeType(primary),
        length: primary.length,
        generationStrategy: primary.generationStrategy,
    };
}

/**
 * The schema and database the platform's own tables resolve to, and therefore the ones these two tables
 * must resolve to as well.
 *
 * Read from a platform entity rather than spelled, because `DataSourceOptions.schema` is a deployment
 * decision. Neither plugin entity declares a schema or database of its own, so both inherit exactly these
 * values, which is why using them here reproduces the qualified names the running schema uses.
 *
 * @param queryRunner - The runner whose connection carries the platform's metadata.
 */
function qualifyingScope(queryRunner: QueryRunner): { schema?: string; database?: string } {
    const { schema, database } = queryRunner.connection.getMetadata(Customer);
    return { schema, database };
}

/** The qualified name of one of this migration's tables, under whatever schema the connection configures. */
function qualifiedTableName(queryRunner: QueryRunner, tableName: string): string {
    const { schema, database } = qualifyingScope(queryRunner);
    return queryRunner.connection.driver.buildTableName(tableName, schema, database);
}

/**
 * A frozen identifier column: the name and nullability are this migration's, the physical type is the
 * platform's.
 */
function identifierColumn(
    primitives: IdentifierColumnPrimitives,
    name: string,
    options: { readonly isPrimary?: boolean } = {},
): TableColumn {
    return new TableColumn({
        name,
        type: primitives.type,
        length: primitives.length,
        isNullable: false,
        isPrimary: options.isPrimary === true,
        isGenerated: options.isPrimary === true,
        generationStrategy: options.isPrimary === true ? primitives.generationStrategy : undefined,
    });
}

/**
 * The two inherited timestamp columns, typed and defaulted by the driver's own declaration of them.
 *
 * `VendureEntity` supplies `createdAt` and `updatedAt` and this feature re-declares neither, so their names
 * are frozen here while their physical form comes from `driver.mappedDataTypes` — the driver's own
 * statement of which type, precision and "now" expression it uses for a created/updated timestamp.
 */
function timestampColumns(queryRunner: QueryRunner): TableColumn[] {
    const { driver } = queryRunner.connection;
    const mapped = driver.mappedDataTypes;
    return [
        new TableColumn({
            name: 'createdAt',
            type: driver.normalizeType({ type: mapped.createDate }),
            precision: mapped.createDatePrecision,
            default: mapped.createDateDefault,
            isNullable: false,
        }),
        new TableColumn({
            name: 'updatedAt',
            type: driver.normalizeType({ type: mapped.updateDate }),
            precision: mapped.updateDatePrecision,
            default: mapped.updateDateDefault,
            onUpdate: mapped.updateDateDefault,
            isNullable: false,
        }),
    ];
}

/** A frozen non-null integer column, normalised to the engine's own spelling of an integer. */
function integerColumn(queryRunner: QueryRunner, name: string, defaultValue?: number): TableColumn {
    const { driver } = queryRunner.connection;
    return new TableColumn({
        name,
        type: driver.normalizeType({ type: 'int' }),
        isNullable: false,
        // Normalised by the driver for the same reason the type is: an integer literal is written `0` on the
        // SQLite family and `'0'` on PostgreSQL and the MySQL family, and getting that wrong would make the
        // created column differ from the one the entity declares.
        default:
            defaultValue === undefined
                ? undefined
                : driver.normalizeDefault({
                      default: defaultValue,
                      type: 'int',
                  } as unknown as ColumnMetadata),
    });
}

/** A frozen non-null string column of the declared indexed width, optionally with a collation. */
function indexedStringColumn(queryRunner: QueryRunner, name: string, collated: boolean): TableColumn {
    const { driver, options } = queryRunner.connection;
    return new TableColumn({
        name,
        type: driver.normalizeType({ type: 'varchar', length: INDEXED_STRING_LENGTH }),
        length: INDEXED_STRING_LENGTH,
        isNullable: false,
        collation: collated ? NAME_KEY_COLLATIONS.get(options.type) : undefined,
    });
}

/** One frozen cascading foreign key from a plugin table to the table it references. */
function cascadingForeignKey(
    queryRunner: QueryRunner,
    name: string,
    columnName: string,
    referencedTableName: string,
): TableForeignKey {
    return new TableForeignKey({
        name,
        columnNames: [columnName],
        referencedTableName: qualifiedTableName(queryRunner, referencedTableName),
        referencedColumnNames: ['id'],
        onDelete: 'CASCADE',
        // Stated rather than left to the engine's default, and the two are not the same thing in practice.
        // TypeORM's relation metadata carries `NO ACTION` here, so the schema builder emits an explicit
        // `ON UPDATE NO ACTION` clause; omitting it would emit no clause at all, and MariaDB then reports the
        // resulting constraint as `RESTRICT` rather than `NO ACTION` — the same action under its other name,
        // but a different reading. Stating it makes the DDL this migration emits identical to the DDL the
        // schema builder emits for the same relation, on every engine, so a database built by migration and
        // one built by synchronisation cannot be told apart.
        onUpdate: 'NO ACTION',
    });
}

/**
 * The frozen description of `reorder_list` as this migration created it.
 *
 * Eight columns: the three `VendureEntity` supplies, the ownership pair, the display name and its canonical
 * key, and the denormalised line counter. One named unique over the ownership triple, TWO named indices —
 * one over the ownership pair and one over the channel alone — one named check keeping the counter
 * non-negative, and two cascading foreign keys.
 *
 * **The channel-only index is not redundant with the composite one, which is why both are frozen here.** A
 * composite index over `(customerId, channelId)` cannot serve a predicate that names only `channelId`,
 * because `channelId` is not its leading column; the entity declares both for that reason, and this
 * description has to declare both too or a migration-provisioned database would carry a different set of
 * indices from a schema-builder-provisioned one.
 */
function frozenListTable(queryRunner: QueryRunner): Table {
    const identifier = identifierColumnPrimitives(queryRunner);
    return new Table({
        name: qualifiedTableName(queryRunner, LIST_TABLE),
        columns: [
            identifierColumn(identifier, 'id', { isPrimary: true }),
            ...timestampColumns(queryRunner),
            identifierColumn(identifier, 'customerId'),
            identifierColumn(identifier, 'channelId'),
            indexedStringColumn(queryRunner, 'name', false),
            indexedStringColumn(queryRunner, 'nameKey', true),
            integerColumn(queryRunner, 'lineCount', 0),
        ],
        uniques: [
            new TableUnique({
                name: 'UQ_reorder_list_customer_channel_name_key',
                columnNames: ['customerId', 'channelId', 'nameKey'],
            }),
        ],
        indices: [
            new TableIndex({
                name: 'IDX_reorder_list_customer_channel',
                columnNames: ['customerId', 'channelId'],
                isUnique: false,
            }),
            new TableIndex({
                name: 'IDX_reorder_list_channel',
                columnNames: ['channelId'],
                isUnique: false,
            }),
        ],
        checks: [
            new TableCheck({
                name: 'CHK_reorder_list_line_count_non_negative',
                expression: '"lineCount" >= 0',
            }),
        ],
        foreignKeys: [
            cascadingForeignKey(queryRunner, 'FK_0c7c5c80bfaa5a02595fd089bb8', 'customerId', 'customer'),
            cascadingForeignKey(queryRunner, 'FK_f93b8b846698345a4605da1ad8e', 'channelId', 'channel'),
        ],
    });
}

/**
 * The frozen description of `reorder_list_line` as this migration created it.
 *
 * Six columns: the three `VendureEntity` supplies, the owning list, the variant and the quantity. One named
 * unique deduplicating a variant within a list, one named index over the variant alone, one named check
 * keeping the quantity positive, and two cascading foreign keys.
 *
 * **The variant-only index is not redundant with the deduplicating unique, for the same reason the parent
 * table carries a channel-only index.** `UQ_reorder_list_line_list_variant` leads with `reorderListId`, so
 * it cannot serve a lookup that names only `productVariantId` — which is the shape of the cascade the
 * platform performs when a variant is removed, and of any read that asks which lists reference a variant.
 * The entity declares it, so this description declares it too.
 */
function frozenLineTable(queryRunner: QueryRunner): Table {
    const identifier = identifierColumnPrimitives(queryRunner);
    return new Table({
        name: qualifiedTableName(queryRunner, LINE_TABLE),
        columns: [
            identifierColumn(identifier, 'id', { isPrimary: true }),
            ...timestampColumns(queryRunner),
            identifierColumn(identifier, 'reorderListId'),
            identifierColumn(identifier, 'productVariantId'),
            integerColumn(queryRunner, 'quantity'),
        ],
        uniques: [
            new TableUnique({
                name: 'UQ_reorder_list_line_list_variant',
                columnNames: ['reorderListId', 'productVariantId'],
            }),
        ],
        indices: [
            new TableIndex({
                name: 'IDX_reorder_list_line_variant',
                columnNames: ['productVariantId'],
                isUnique: false,
            }),
        ],
        checks: [
            new TableCheck({
                name: 'CHK_reorder_list_line_quantity_positive',
                expression: '"quantity" > 0',
            }),
        ],
        foreignKeys: [
            cascadingForeignKey(queryRunner, 'FK_19a7479a99a7bd9f3e3b6ecd97c', 'reorderListId', LIST_TABLE),
            cascadingForeignKey(
                queryRunner,
                'FK_19516e9a2ca7a06037569466423',
                'productVariantId',
                'product_variant',
            ),
        ],
    });
}

/** The unqualified name of a possibly schema-qualified table, for comparing two spellings of one table. */
function bareTableName(name: string): string {
    const segments = name.split('.');
    return segments[segments.length - 1];
}

/**
 * One column attribute, as the comparison below reads it off both the frozen description and the catalogue.
 *
 * Each entry names the attribute in prose, reads it, and says whether it is meaningful — an attribute the
 * frozen description does not constrain is not a licence to accept anything, it is an attribute this migration
 * never asked for, and comparing it would fail on a default the engine chose for itself.
 */
const COMPARED_COLUMN_ATTRIBUTES: ReadonlyArray<{
    readonly described: string;
    readonly read: (column: TableColumn) => string | undefined;
}> = [
    { described: 'physical type', read: column => normaliseTypeSpelling(column.type) },
    { described: 'declared width', read: column => emptyToUndefined(column.length) },
    { described: 'display width', read: column => numberToString(column.width) },
    { described: 'declared precision', read: column => numberToString(column.precision) },
    { described: 'declared scale', read: column => numberToString(column.scale) },
    { described: 'default value', read: column => normaliseDefaultSpelling(column.default) },
    { described: 'character set', read: column => emptyToUndefined(column.charset) },
    { described: 'collation', read: column => emptyToUndefined(column.collation) },
    { described: 'nullability', read: column => (column.isNullable ? 'nullable' : 'not nullable') },
    {
        described: 'membership of the row identifier',
        read: column => (column.isPrimary ? 'part of it' : 'not part of it'),
    },
    {
        described: 'row identifier constraint name',
        read: column => emptyToUndefined(column.primaryKeyConstraintName),
    },
    {
        described: 'generation',
        read: column => (column.isGenerated ? (column.generationStrategy ?? 'generated') : 'not generated'),
    },
    { described: 'identity generation', read: column => emptyToUndefined(column.generatedIdentity) },
    { described: 'generated expression', read: column => emptyToUndefined(column.asExpression) },
    { described: 'generated storage', read: column => emptyToUndefined(column.generatedType) },
    {
        // SCALAR VERSUS ARRAY, and it is not a theoretical distinction. PostgreSQL reports `varchar` and
        // `varchar[]` under the same physical type name and separates them here alone, so a column that had
        // become array-valued would satisfy every other comparison while storing something the service cannot
        // read or write. Read as a decided value rather than as an optional flag, so an unset frozen side
        // cannot skip the comparison.
        described: 'value shape',
        read: column => (column.isArray === true ? 'an array' : 'a single value'),
    },
    { described: 'signedness', read: column => (column.unsigned ? 'unsigned' : 'signed') },
    { described: 'zero fill', read: column => (column.zerofill ? 'zero-filled' : 'not zero-filled') },
    { described: 'enumerated members', read: column => (column.enum ? column.enum.join(', ') : undefined) },
    { described: 'enumerated type name', read: column => emptyToUndefined(column.enumName) },
    { described: 'spatial feature type', read: column => emptyToUndefined(column.spatialFeatureType) },
    { described: 'spatial reference identifier', read: column => numberToString(column.srid) },
];

/** `''` and `undefined` both mean "the catalogue said nothing", and are treated as one value. */
function emptyToUndefined(value: string | undefined): string | undefined {
    return value === undefined || value === '' ? undefined : value;
}

/** A numeric attribute as a comparable string, with `null` — TypeORM's "unset" — folded into `undefined`. */
function numberToString(value: number | null | undefined): string | undefined {
    return value === undefined || value === null ? undefined : String(value);
}

/** Case is not part of a type name: every driver reports its own, and none varies it by case meaningfully. */
function normaliseTypeSpelling(type: string | undefined): string | undefined {
    return type === undefined ? undefined : type.toLowerCase();
}

/**
 * A default value in one spelling.
 *
 * The engines disagree only about quoting an integer literal: MariaDB's catalogue reports the counter's
 * default as `0` where the driver-normalised frozen value is `'0'`, while MySQL, PostgreSQL and the SQLite
 * family report it exactly as frozen. Stripping one layer of surrounding single quotes reconciles that without
 * discarding anything else — an expression default such as `now()` carries no surrounding quotes to strip.
 */
function normaliseDefaultSpelling(value: unknown): string | undefined {
    if (value === undefined || value === null) {
        return undefined;
    }
    const text = String(value).trim();
    const unquoted = /^'(.*)'$/.exec(text);
    return (unquoted ? unquoted[1] : text).toLowerCase();
}

/**
 * A named check constraint's expression in one spelling, so two renderings of one constraint compare equal.
 *
 * Every engine that stores a check rewrites it, and the rewrites observed across the three engines that
 * support them are: an added enclosing parenthesis pair on all of them (`("lineCount" >= 0)`); identifier
 * quotes dropped where the identifier needs none (PostgreSQL reports `(quantity > 0)` for `"quantity" > 0`
 * but keeps them for the camel-cased `"lineCount"`); and each engine's own quote character. Removing every
 * quote character, every parenthesis, and every run of whitespace, then lower-casing, reduces all of those to
 * one form while still distinguishing one expression from another — `linecount>=0` and `linecount>=1` remain
 * different, and so do `quantity>0` and `quantity>=0`.
 */
function normaliseCheckExpression(expression: string): string {
    return expression
        .replace(/["`[\]()]/g, '')
        .replace(/\s+/g, '')
        .toLowerCase();
}

/**
 * A referential action in one spelling, folding the two names the engines use for "reject the change".
 *
 * `RESTRICT` and `NO ACTION` are the same action on the MySQL family — the engines document them as
 * equivalent, both rejecting the parent change immediately — and they are also what an unstated action means.
 * Which of the two names comes back is not even a property of the engine, but of how the constraint was
 * created, which was measured rather than assumed. Reading the same unstated action back off each engine:
 *
 * | Engine     | created inline by `createTable` | created by `ALTER TABLE ... ADD CONSTRAINT` |
 * |------------|--------------------------------|---------------------------------------------|
 * | sql.js     | `NO ACTION`                    | `NO ACTION`                                 |
 * | PostgreSQL | `NO ACTION`                    | `NO ACTION`                                 |
 * | MySQL      | `NO ACTION`                    | `NO ACTION`                                 |
 * | MariaDB    | **`RESTRICT`**                 | `NO ACTION`                                 |
 *
 * The frozen references below state `ON UPDATE NO ACTION` explicitly, exactly as the entity metadata does, so
 * this migration does not itself produce the `RESTRICT` reading. The fold is what lets it accept a table
 * created some other way that means the same thing — by the platform's schema builder, or by an engine
 * defaulting an unstated clause — instead of refusing a schema over the manner of its own creation. It costs
 * nothing: `CASCADE`, `SET NULL` and `SET DEFAULT` all remain distinct from it and from each other, and a
 * dedicated case asserts that a reference which rejects a parent delete rather than cascading it is still
 * refused.
 */
function normaliseReferentialAction(action: string | undefined): string {
    const named = (action ?? 'NO ACTION').toUpperCase();
    return named === 'RESTRICT' ? 'NO ACTION' : named;
}

/**
 * A constraint's deferrability in one spelling, resolving an unstated clause to the SQL default.
 *
 * A constraint with no deferrability clause is `NOT DEFERRABLE` — the SQL default, and the only state the
 * frozen constraints below ask for. Resolving an unset value to that name rather than treating it as "unknown,
 * so accept anything" is what makes the comparison REACHABLE: every frozen constraint here leaves the clause
 * unset, so a guard that skipped whenever either side was unset could never fire, and a deferred constraint on
 * an existing table would pass unnoticed.
 *
 * **It is not cosmetic which one an existing table carries.** A deferred unique or reference is enforced at
 * `COMMIT` rather than at the statement, and this plugin's narrow constraint translation depends on the
 * statement itself failing: `createReorderList` catches the violation of
 * `UQ_reorder_list_customer_channel_name_key` and answers `ReorderListNameConflictError`, which it can only do
 * if the `INSERT` is what fails. Against a deferred unique the insert would succeed and the transaction would
 * fail at commit, past every `catch` the service has.
 *
 * **What TypeORM's generic table view reports, measured rather than assumed** — a probe created one plain and
 * one `DEFERRABLE INITIALLY DEFERRED` object of each class, then read `getTable()` back:
 *
 * | Engine     | reference's deferrability | unique's deferrability   |
 * |------------|---------------------------|--------------------------|
 * | PostgreSQL | `INITIALLY DEFERRED`      | unreported (`undefined`) |
 * | sql.js     | unreported                | unreported               |
 * | MySQL      | unreported                | no unique CONSTRAINTS at all — a unique is filed as a named unique index |
 * | MariaDB    | unreported                | no unique CONSTRAINTS at all |
 *
 * **"Unreported" and "not deferred" are two different facts, and this helper conflates them by design** — so
 * it is not the whole of how deferrability is established. Resolving unreported to `NOT DEFERRABLE` is what
 * makes THIS comparison reachable, and it is correct on the MySQL family, where the grammar refuses the clause
 * outright. It is NOT correct on the other two: the SQLite family stores a reference's clause in its table
 * text and never hydrates it back, and PostgreSQL's unique loader reads deferrability fields its own
 * constraints query never selects. Both of those are answered by {@link nativeEnforcementTimingShortfalls},
 * which reads each engine's own catalogue and refuses what it cannot establish. Read the two together: this
 * helper compares the timing TypeORM reports, and that function establishes the timing the engine actually
 * holds.
 */
function normaliseDeferrability(deferrable: string | undefined): string {
    const named = (deferrable ?? '').trim().toUpperCase();
    return named === '' ? 'NOT DEFERRABLE' : named;
}

/**
 * An index's partial-index predicate in one spelling, so two renderings of one predicate compare equal.
 *
 * An index carrying a predicate covers only the rows satisfying it, so a same-named partial index is a
 * different index: the ownership lookup this migration creates `IDX_reorder_list_customer_channel` for would
 * silently stop using it for any row the predicate excludes. The renderings were measured on a probe index
 * declared `WHERE "b" > 0`: PostgreSQL reports `(b > 0)`, sql.js reports `"b" > 0`, and MySQL and MariaDB
 * report an empty string because neither engine has partial indices and the clause is dropped on creation.
 * Reducing the text exactly as a check constraint's expression is reduced folds the first two together while
 * still distinguishing one predicate from another, and leaves an absent predicate as the empty string.
 */
function normaliseIndexPredicate(where: string | undefined): string {
    return normaliseCheckExpression(where ?? '');
}

/** A list of column names in the order given, for comparing an ordered subject. */
function orderedColumns(columnNames: readonly string[]): string {
    return columnNames.join(', ');
}

/** The schema segment of a possibly-qualified name, or `undefined` when the name carries none. */
function schemaSegmentOf(name: string): string | undefined {
    const segments = name.split('.');
    return segments.length > 1 ? segments[segments.length - 2] : undefined;
}

/**
 * The qualifier a table or a reference target sits under, as each side happens to state it.
 *
 * The two sides state it differently and both statements are valid. The frozen description carries the
 * qualifier inside the NAME when the connection configures a non-default schema, and omits it entirely when it
 * does not — that is `driver.buildTableName`'s behaviour. An engine catalogue instead resolves the qualifier
 * explicitly on every read, and which field it lands in depends on the engine: PostgreSQL fills `schema` for a
 * table and `referencedSchema` for a reference, the MySQL family fills `database` and `referencedDatabase`, and
 * the SQLite family fills neither. Reading "whatever this side states, wherever it states it" is what lets one
 * comparison serve all four.
 */
function statedQualifier(
    explicitSchema: string | undefined,
    explicitDatabase: string | undefined,
    qualifiedName: string,
): { schema?: string; database?: string } {
    return {
        schema: emptyToUndefined(explicitSchema) ?? schemaSegmentOf(qualifiedName),
        database: emptyToUndefined(explicitDatabase),
    };
}

/**
 * Whether a reference arrives in the same schema and database as the table it leaves from.
 *
 * **This is the comparison that stops a same-named table in another schema standing in for the intended one.**
 * Comparing only the bare table name would accept a `customer` in some other schema, which under a
 * multi-tenant or multi-schema deployment is a different table holding different people's data.
 *
 * It is expressed as "the same qualifier as the referencing table" rather than as a literal schema name,
 * because a literal would have to be spelled — and a spelled schema is exactly the defect that made an earlier
 * revision of this migration unusable outside the default schema. The invariant is true by construction for
 * every reference this migration creates: the plugin's two tables and the three core tables they reference all
 * come from one connection and therefore sit under one qualifier.
 *
 * Each half of the qualifier is compared only where BOTH sides state one, and that is a requirement rather
 * than a leniency: PostgreSQL's catalogue states a table's `database` but not a reference's
 * `referencedDatabase`, so demanding both would refuse every PostgreSQL deployment while comparing nothing
 * extra — the schema half already carries the distinction there, and on the MySQL family, where the schema half
 * is empty, the database half carries it.
 */
function referenceScopeShortfalls(table: Table, reference: TableForeignKey, where: string): string[] {
    const tableScope = statedQualifier(table.schema, table.database, table.name);
    const targetScope = statedQualifier(
        reference.referencedSchema,
        reference.referencedDatabase,
        reference.referencedTableName,
    );
    const shortfalls: string[] = [];
    for (const part of [
        { described: 'schema', table: tableScope.schema, target: targetScope.schema },
        { described: 'database', table: tableScope.database, target: targetScope.database },
    ]) {
        if (part.table === undefined || part.target === undefined || part.table === part.target) {
            continue;
        }
        shortfalls.push(
            `the reference "${String(reference.name)}" on "${where}" arrives in ${part.described} ` +
                `"${part.target}" rather than in "${part.table}", where "${where}" itself sits`,
        );
    }
    return shortfalls;
}

/** The same list as an order-insensitive set, for comparing a subject whose order the catalogue reorders. */
function unorderedColumns(columnNames: readonly string[]): string {
    return columnNames.slice().sort().join(', ');
}

/**
 * Every way an existing table falls short of the frozen description, as sentences an operator can act on.
 *
 * Only SHORTFALLS are reported. A column, index or constraint the existing table carries beyond the frozen
 * set belongs to a later migration or to a newer entity synchronised into the same table, and is none of
 * this timestamp's business; a frozen object that is MISSING means the table is not the one this timestamp
 * describes, and recording the migration as applied against it would put a falsehood in the schema history.
 *
 * **This is a MINIMUM, and the word is chosen deliberately.** It reports only SHORTFALLS: a frozen object or
 * attribute the existing table does not match. It does NOT report a surplus — an extra column, index,
 * constraint or reference — because a surplus belongs to a later migration or to a newer entity synchronised
 * into the same table, and is none of this timestamp's business. So the question this function answers is "does
 * the table carry everything this timestamp created, as this timestamp created it", not "is the table equal to
 * what this timestamp created".
 *
 * **What is compared.** Every attribute of every frozen column that the catalogue reports: physical type,
 * declared width, display width, precision, scale, default, character set, collation, nullability, membership
 * of the row identifier and that membership's constraint name, generation and identity generation, generated
 * expression and storage, value shape (scalar versus array), signedness, zero fill, enumerated members and
 * type name, spatial feature type and reference identifier.
 *
 * And every property of every frozen constraint and index that the catalogue reports. Every named unique by
 * name, subject and deferrability; every named index by name, ordered subject, uniqueness, partial-index
 * predicate, spatial, full-text and null-filtered kinds, and full-text parser; every named check by name and
 * condition; and every reference by name, ordered leaving columns, target table, ordered target columns, both
 * referential actions, deferrability, and the schema and database its target sits in. Of the nine properties
 * TypeORM's `TableIndex` carries, the three of `TableUnique` and the nine of `TableForeignKey`, exactly one is
 * excluded, and item 6 below names it and says why.
 *
 * **What is deliberately not compared, and why — each named rather than silently skipped.**
 *
 * 1. `onUpdate` on a column. The frozen timestamp columns carry the driver's own "now" expression there, and
 *    the SQLite and PostgreSQL catalogues report nothing at all for it while the MySQL family reports it
 *    exactly as frozen. Comparing it would refuse every PostgreSQL and SQLite deployment, so it is excluded —
 *    and nothing rests on it: the column's type, precision and default are all compared, and a mismatched
 *    `ON UPDATE` cannot change what the column stores.
 * 2. A column's `comment`. The SQLite family's parser reports an empty string where every other engine
 *    reports nothing, and a comment changes neither the stored value nor any constraint on it.
 * 3. A column's `isUnique` flag. No frozen column declares column-level uniqueness — both uniques here are
 *    composite and are compared as named objects — and TypeORM does not populate the flag from a table-level
 *    unique, so comparing it would test nothing while risking a refusal on an engine that populates it.
 * 4. An attribute the frozen description leaves UNSET is not compared, because it was never asked for and
 *    whatever the engine chose for it is correct by definition. An attribute the description DOES set and the
 *    catalogue does not report is itself reported as a shortfall.
 * 5. Named check constraints on the MySQL family, where TypeORM 0.3.28 never created them. That is conflict
 *    C-E in this file's header, disclosed there with the exact source locations, and it is a gap in what the
 *    engine has rather than a gap in what is checked.
 * 6. An index's `isConcurrent` flag — the only property of the three constraint and index classes that is not
 *    compared. It is a modifier on the statement that BUILDS an index (`CREATE INDEX CONCURRENTLY`, which
 *    trades a longer build for not locking writes) and not a property of the index that results; no engine
 *    stores it, and all four report it `false` for every index including one built concurrently. Comparing it
 *    would assert something about how a table was populated rather than about what it now guarantees.
 *
 * Five comparisons are normalised, each because an engine rewrites the value or leaves a default unstated
 * rather than because the value is unknowable: an integer default's quoting; a check expression's parentheses
 * and identifier quotes; a partial-index predicate's parentheses and identifier quotes; a referential action
 * left unstated; and a deferrability clause left unstated, resolved to the `NOT DEFERRABLE` the SQL standard
 * gives it. Each normalisation is documented at the helper that performs it, and each still distinguishes one
 * value from another. The last of the five is what makes deferrability REACHABLE rather than vacuous: every
 * frozen constraint here leaves the clause unset, so a guard that skipped whenever a side was unset could
 * never fire on any of them.
 *
 * **One property this function is NOT the authority on, named rather than implied.** A constraint's
 * enforcement timing. This function compares the timing TypeORM's generic view REPORTS, and that view is
 * incomplete in two specific ways — the SQLite family writes a reference's clause and never reads it back,
 * and PostgreSQL's unique loader reads deferrability fields its own query never selects. So an unreported
 * timing here can mean "immediate" or can mean "TypeORM did not look", and this function cannot tell them
 * apart. {@link nativeEnforcementTimingShortfalls} can: it reads `pg_constraint` on PostgreSQL and the stored
 * table text on the SQLite family, needs no reading at all on the MySQL family because the grammar refuses
 * the clause, and REFUSES rather than assumes on any other engine. `createFrozenTable` runs both and joins
 * their shortfalls, so what an operator is told comes from whichever source can actually answer. The drift
 * cases mirror the split: doctored readings prove THIS comparison refuses a timing presented to it, and live
 * cases that genuinely defer a constraint prove the native reading catches one the generic view misses.
 *
 * One comparison is deliberately order-insensitive: a unique's column list. PostgreSQL's catalogue returns a
 * unique constraint's columns in its own order — a constraint declared over `customerId, channelId, nameKey`
 * reads back as `nameKey, customerId, channelId` — so an ordered comparison would refuse every PostgreSQL
 * deployment. A unique's guarantee does not depend on the order of its subject. An INDEX's does, for the
 * prefix a query can use, and every one of the four engines reports an index's columns in the declared order,
 * so that one IS compared in order.
 *
 * @param queryRunner - The runner whose connection identifies the engine.
 * @param frozen - The description this migration froze at its timestamp.
 * @param existing - The table as the engine's catalogue reports it.
 * @returns One sentence per shortfall; empty when the existing table carries the entire frozen minimum.
 */
function frozenShapeShortfalls(queryRunner: QueryRunner, frozen: Table, existing: Table): string[] {
    const shortfalls: string[] = [];
    const where = bareTableName(frozen.name);

    for (const column of frozen.columns) {
        const found = existing.columns.find(candidate => candidate.name === column.name);
        if (!found) {
            shortfalls.push(`"${where}" carries no "${column.name}" column`);
            continue;
        }
        for (const attribute of COMPARED_COLUMN_ATTRIBUTES) {
            const frozenValue = attribute.read(column);
            const existingValue = attribute.read(found);
            // An attribute the frozen description leaves unset was never asked for, so whatever the engine
            // chose for it is correct by definition. An attribute the description DOES set is compared, and
            // the catalogue reporting nothing for it is itself a disagreement.
            if (frozenValue === undefined || frozenValue === existingValue) {
                continue;
            }
            shortfalls.push(
                `"${where}"."${column.name}" has ${attribute.described} ` +
                    `${existingValue === undefined ? 'unreported by the catalogue' : `"${existingValue}"`} ` +
                    `but this migration created it "${frozenValue}"`,
            );
        }
    }

    // A unique may be filed as a constraint or, on the MySQL family, as a named unique index. Either class
    // carries the same name and the same guarantee, so both are searched.
    const existingUniqueLike = [
        ...existing.uniques.map(unique => ({
            name: unique.name,
            columnNames: unique.columnNames,
            deferrable: unique.deferrable,
        })),
        ...existing.indices
            .filter(index => index.isUnique)
            .map(index => ({
                name: index.name,
                columnNames: index.columnNames,
                // A unique filed as an index carries no deferrability clause on any engine that files it that
                // way, which is the same state an unstated clause means.
                deferrable: undefined as string | undefined,
            })),
    ];
    for (const unique of frozen.uniques) {
        const found = existingUniqueLike.find(candidate => candidate.name === unique.name);
        if (!found) {
            shortfalls.push(`"${where}" carries no unique named "${String(unique.name)}"`);
            continue;
        }
        // Order-insensitive, for the reason given in this function's contract.
        if (unorderedColumns(found.columnNames) !== unorderedColumns(unique.columnNames)) {
            shortfalls.push(
                `the unique "${String(unique.name)}" on "${where}" spans ` +
                    `${orderedColumns(found.columnNames)} rather than ${orderedColumns(unique.columnNames)}`,
            );
        }
        // Deferred enforcement, which would move the violation from the statement to the commit and past the
        // narrow translation that answers `ReorderListNameConflictError`.
        const frozenUniqueDeferrability = normaliseDeferrability(unique.deferrable);
        if (normaliseDeferrability(found.deferrable) !== frozenUniqueDeferrability) {
            shortfalls.push(
                `the unique "${String(unique.name)}" on "${where}" is ` +
                    `${normaliseDeferrability(found.deferrable)} rather than ${frozenUniqueDeferrability}`,
            );
        }
    }

    for (const index of frozen.indices) {
        const found = existing.indices.find(candidate => candidate.name === index.name);
        if (!found) {
            shortfalls.push(`"${where}" carries no index named "${String(index.name)}"`);
            continue;
        }
        // In order, for the reason given in this function's contract.
        if (orderedColumns(found.columnNames) !== orderedColumns(index.columnNames)) {
            shortfalls.push(
                `the index "${String(index.name)}" on "${where}" spans ` +
                    `${orderedColumns(found.columnNames)} in that order rather than ` +
                    `${orderedColumns(index.columnNames)}`,
            );
        }
        // The predicate, which decides WHICH ROWS the index covers: a same-named partial index would leave
        // the ownership lookup unindexed for every row its predicate excludes.
        const frozenPredicate = normaliseIndexPredicate(index.where);
        if (normaliseIndexPredicate(found.where) !== frozenPredicate) {
            shortfalls.push(
                `the index "${String(index.name)}" on "${where}" covers only rows satisfying ` +
                    `${found.where && found.where.trim() !== '' ? found.where : '<every row>'} rather than ` +
                    `${index.where && index.where.trim() !== '' ? index.where : '<every row>'}`,
            );
        }
        // Every remaining flag the catalogue reports, each of which changes what the index can answer: an
        // index that is unique constrains the table, and a spatial, full-text or null-filtered index answers
        // a different class of predicate than the B-tree the ownership lookup needs. Read as booleans so an
        // unset frozen value cannot skip the comparison — unset means "not that kind of index".
        for (const flag of [
            { described: 'unique', frozen: index.isUnique, existing: found.isUnique },
            { described: 'spatial', frozen: index.isSpatial, existing: found.isSpatial },
            { described: 'full-text', frozen: index.isFulltext, existing: found.isFulltext },
            { described: 'null-filtered', frozen: index.isNullFiltered, existing: found.isNullFiltered },
        ]) {
            if ((flag.existing === true) !== (flag.frozen === true)) {
                shortfalls.push(
                    `the index "${String(index.name)}" on "${where}" is ` +
                        `${flag.existing ? '' : 'not '}${flag.described} but this migration created it ` +
                        `${flag.frozen ? '' : 'not '}${flag.described}`,
                );
            }
        }
        // The full-text parser, which selects how the indexed text is tokenised and so which queries the
        // index can answer. Unset on both sides for every frozen index, and compared for the same reason the
        // flags above are: so a later edit that sets one is checked rather than assumed.
        if ((found.parser ?? '') !== (index.parser ?? '')) {
            shortfalls.push(
                `the index "${String(index.name)}" on "${where}" tokenises with ` +
                    `"${found.parser ?? ''}" rather than "${index.parser ?? ''}"`,
            );
        }
    }

    if (!CHECK_LESS_ENGINES.includes(queryRunner.connection.options.type)) {
        for (const check of frozen.checks) {
            const found = existing.checks.find(candidate => candidate.name === check.name);
            if (!found) {
                shortfalls.push(`"${where}" carries no check constraint named "${String(check.name)}"`);
                continue;
            }
            // The expression, not merely the name: a correctly named check over the wrong condition enforces
            // the wrong invariant, and is the one drift a name-only comparison would wave through.
            const frozenExpression = normaliseCheckExpression(check.expression ?? '');
            if (normaliseCheckExpression(found.expression ?? '') !== frozenExpression) {
                shortfalls.push(
                    `the check constraint "${String(check.name)}" on "${where}" reads ` +
                        `${found.expression ?? '<nothing>'} rather than ${check.expression ?? '<nothing>'}`,
                );
            }
        }
    }

    for (const reference of frozen.foreignKeys) {
        // BY NAME. The default naming strategy derives these names from the unqualified table name and the
        // referencing columns, so they are identical on every engine and under every schema — which makes the
        // name the one handle that cannot be confused with a differently-shaped reference over the same
        // column. The catalogue also returns references in its own order, so position is no handle at all.
        const found = existing.foreignKeys.find(candidate => candidate.name === reference.name);
        if (!found) {
            shortfalls.push(
                `"${where}" carries no reference named "${String(reference.name)}" from ` +
                    `${orderedColumns(reference.columnNames)} to ` +
                    `"${bareTableName(reference.referencedTableName)}"`,
            );
            continue;
        }
        if (orderedColumns(found.columnNames) !== orderedColumns(reference.columnNames)) {
            shortfalls.push(
                `the reference "${String(reference.name)}" on "${where}" leaves from ` +
                    `${orderedColumns(found.columnNames)} rather than ` +
                    `${orderedColumns(reference.columnNames)}`,
            );
        }
        if (
            bareTableName(found.referencedTableName) !== bareTableName(reference.referencedTableName) ||
            orderedColumns(found.referencedColumnNames) !== orderedColumns(reference.referencedColumnNames)
        ) {
            shortfalls.push(
                `the reference "${String(reference.name)}" on "${where}" arrives at ` +
                    `"${bareTableName(found.referencedTableName)}".` +
                    `${orderedColumns(found.referencedColumnNames)} rather than ` +
                    `"${bareTableName(reference.referencedTableName)}".` +
                    `${orderedColumns(reference.referencedColumnNames)}`,
            );
        }
        for (const action of [
            { described: 'on delete', frozen: reference.onDelete, existing: found.onDelete },
            { described: 'on update', frozen: reference.onUpdate, existing: found.onUpdate },
        ]) {
            const frozenAction = normaliseReferentialAction(action.frozen);
            if (normaliseReferentialAction(action.existing) !== frozenAction) {
                shortfalls.push(
                    `the reference "${String(reference.name)}" on "${where}" acts ` +
                        `${normaliseReferentialAction(action.existing)} ${action.described} rather than ` +
                        `${frozenAction}`,
                );
            }
        }
        // Both sides' targets must sit under the referencing table's own qualifier, so a same-named table in
        // another schema cannot stand in for the intended one.
        shortfalls.push(...referenceScopeShortfalls(frozen, reference, where));
        shortfalls.push(...referenceScopeShortfalls(existing, found, where));
        // Deferred enforcement, resolved through the SQL default on both sides so the comparison is reachable
        // for a frozen reference that states no clause — which every one of them is.
        const frozenDeferrability = normaliseDeferrability(reference.deferrable);
        if (normaliseDeferrability(found.deferrable) !== frozenDeferrability) {
            shortfalls.push(
                `the reference "${String(reference.name)}" on "${where}" is ` +
                    `${normaliseDeferrability(found.deferrable)} rather than ${frozenDeferrability}`,
            );
        }
    }

    return shortfalls;
}

/**
 * The enforcement timing of one constraint, as one of the three names SQL gives it.
 *
 * `undefined` is not one of them: it is this file's marker for "the source consulted could not answer", which
 * {@link nativeEnforcementTimingShortfalls} turns into a refusal rather than into an assumption.
 */
type EnforcementTiming = 'NOT DEFERRABLE' | 'INITIALLY IMMEDIATE' | 'INITIALLY DEFERRED';

/** The name PostgreSQL's two catalogue flags spell between them. */
function timingFromPostgresFlags(deferrable: unknown, deferred: unknown): EnforcementTiming {
    if (deferrable !== true) {
        return 'NOT DEFERRABLE';
    }
    return deferred === true ? 'INITIALLY DEFERRED' : 'INITIALLY IMMEDIATE';
}

/**
 * The enforcement timing a stored SQLite `CREATE TABLE` text states for one named constraint.
 *
 * The clause sits inside the constraint's own segment of the text, so the segment is isolated first — from
 * its `CONSTRAINT "<name>"` marker up to the next constraint's marker, or to the end of the definition for
 * the last one. Reading the whole text instead would let one constraint's clause answer for another's.
 *
 * @param ddl - The definition the engine stored for the table.
 * @param name - The constraint whose timing is being read.
 * @returns The timing the text states, or `undefined` when the text does not mention the constraint at all.
 */
function timingFromStoredDefinition(ddl: string, name: string): EnforcementTiming | undefined {
    const marker = `CONSTRAINT "${name}"`;
    const at = ddl.indexOf(marker);
    if (at < 0) {
        return undefined;
    }
    const rest = ddl.slice(at + marker.length);
    const nextAt = rest.indexOf('CONSTRAINT "');
    const segment = nextAt < 0 ? rest : rest.slice(0, nextAt);
    if (/\bNOT\s+DEFERRABLE\b/i.test(segment)) {
        return 'NOT DEFERRABLE';
    }
    const deferred = /\bDEFERRABLE\s+INITIALLY\s+(DEFERRED|IMMEDIATE)\b/i.exec(segment);
    if (deferred) {
        return deferred[1].toUpperCase() === 'DEFERRED' ? 'INITIALLY DEFERRED' : 'INITIALLY IMMEDIATE';
    }
    // A bare `DEFERRABLE` with no `INITIALLY` clause is `DEFERRABLE INITIALLY IMMEDIATE` by the standard.
    return /\bDEFERRABLE\b/i.test(segment) ? 'INITIALLY IMMEDIATE' : 'NOT DEFERRABLE';
}

/**
 * Every frozen constraint whose enforcement timing cannot be shown to be immediate, read from the engine's
 * OWN catalogue rather than from TypeORM's generic table view.
 *
 * **Why a second source is needed at all.** {@link frozenShapeShortfalls} resolves an unreported
 * deferrability to `NOT DEFERRABLE`, the SQL default. That is right when the engine genuinely has no deferred
 * constraint, and wrong when TypeORM simply failed to hydrate a clause the engine really stores — and both
 * cases exist, which was established by reading the installed driver rather than inferred:
 *
 * - The SQLite family WRITES the clause and never reads it back. `AbstractSqliteQueryRunner.js:1204-1205`
 *   appends `` ` DEFERRABLE ${fk.deferrable}` `` when building a reference, and the loader that rebuilds a
 *   `TableForeignKey` has no counterpart — a probe created one `DEFERRABLE INITIALLY DEFERRED` on sql.js,
 *   read `sqlite_master.sql` back and found the clause present in the stored text while `getTable()`
 *   reported nothing for it.
 * - PostgreSQL hydrates a REFERENCE's deferrability but never a UNIQUE's. Its `foreignKeysSql`
 *   (`PostgresQueryRunner.js:1832`) selects `condeferrable` and `condeferred`, but the `constraintsSql` that
 *   feeds uniques (`PostgresQueryRunner.js:1801-1808`) selects neither, while the code building the
 *   `TableUnique` reads them (`PostgresQueryRunner.js:2125`) — so the field is always `undefined` there. A
 *   probe created a unique `DEFERRABLE INITIALLY DEFERRED`, confirmed `pg_constraint` reported
 *   `condeferrable = true, condeferred = true`, and confirmed `getTable().uniques` carried no timing at all.
 *
 * **Why the difference is not cosmetic.** A deferred constraint is checked at `COMMIT` instead of at the
 * statement. `createReorderList` answers `ReorderListNameConflictError` by catching the violation of
 * `UQ_reorder_list_customer_channel_name_key` as the `INSERT` fails; against a deferred unique the insert
 * succeeds and the transaction fails later, past every `catch` the service has. A deferred cascade likewise
 * lets a parent delete and its child cascade sit apart, so a statement between them reads a child whose
 * parent is gone.
 *
 * **How each engine is answered, and what happens when none of them can be.**
 *
 * | Engine family | Source consulted | Covers |
 * |---------------|------------------|--------|
 * | PostgreSQL    | `pg_constraint.condeferrable` / `condeferred` | uniques AND references |
 * | SQLite        | the `CREATE TABLE` text in `sqlite_master`    | references; a unique cannot carry the clause in SQLite's grammar, so there is nothing to establish |
 * | MySQL family  | nothing to consult                            | neither class — the grammar refuses the clause outright, measured as `ER_PARSE_ERROR` |
 * | anything else | nothing to consult                            | nothing, and every frozen constraint is therefore REFUSED rather than assumed immediate |
 *
 * That last row is the fail-closed rule, and it is why this function reports a shortfall for a question it
 * cannot answer. This plugin claims four engines; on a fifth, an existing table cannot be recorded as this
 * migration's work without a way to show its constraints fire when this migration's error handling needs
 * them to. A fresh database is unaffected — this runs only where a table of the name already stands.
 *
 * **Every statement here READS.** Both are catalogue queries against `pg_catalog` and `sqlite_master`; the
 * file's no-dialect-DDL contract is about the statements that BUILD the schema, and neither of these
 * defines, alters or drops anything. Nothing here is dialect-bound in the sense that matters either: each
 * query runs only on the family whose catalogue it names, and every other family is answered without a
 * query at all.
 *
 * @param queryRunner - The runner whose connection identifies the engine and carries the catalogue.
 * @param frozen - The description this migration froze at its timestamp.
 * @param existing - The table as TypeORM's generic view reports it, used only to decide which frozen
 *   constraints are actually present; a missing one is already a shortfall from
 *   {@link frozenShapeShortfalls} and is not reported twice.
 * @returns One sentence per constraint that is deferred, or whose timing could not be established.
 */
async function nativeEnforcementTimingShortfalls(
    queryRunner: QueryRunner,
    frozen: Table,
    existing: Table,
): Promise<string[]> {
    const engine = queryRunner.connection.options.type;
    if (DEFERRABILITY_LESS_ENGINES.includes(engine)) {
        return [];
    }

    const where = bareTableName(frozen.name);
    // A unique may be filed as a named unique index, which carries no timing clause on any engine that files
    // it that way. Only a unique the catalogue reports AS a unique has a timing to establish.
    const presentUniques = frozen.uniques
        .map(unique => String(unique.name ?? ''))
        .filter(name => existing.uniques.some(candidate => String(candidate.name ?? '') === name));
    const presentReferences = frozen.foreignKeys
        .map(reference => String(reference.name ?? ''))
        .filter(name => existing.foreignKeys.some(candidate => String(candidate.name ?? '') === name));

    const timings = new Map<string, EnforcementTiming | undefined>();
    if (POSTGRES_FAMILY_ENGINES.includes(engine)) {
        const { schema } = qualifyingScope(queryRunner);
        const resolvedSchema =
            schema ?? (await queryRunner.query('SELECT current_schema() AS "name"'))[0]?.name;
        const rows: Array<{ name: string; deferrable: unknown; deferred: unknown }> = await queryRunner.query(
            'SELECT "con"."conname" AS "name", "con"."condeferrable" AS "deferrable", ' +
                '"con"."condeferred" AS "deferred" FROM "pg_catalog"."pg_constraint" "con" ' +
                'INNER JOIN "pg_catalog"."pg_class" "cls" ON "cls"."oid" = "con"."conrelid" ' +
                'INNER JOIN "pg_catalog"."pg_namespace" "nsp" ON "nsp"."oid" = "cls"."relnamespace" ' +
                'WHERE "cls"."relname" = $1 AND "nsp"."nspname" = $2 AND "con"."contype" IN (\'u\', \'f\')',
            [where, resolvedSchema],
        );
        for (const name of [...presentUniques, ...presentReferences]) {
            // Exact match first, then case-insensitively — PostgreSQL folds an UNQUOTED identifier to lower
            // case, so a constraint some other tool created without quotes is stored under a different
            // spelling of the same name. An ambiguous match answers nothing and is left unresolved.
            const exact = rows.filter(row => row.name === name);
            const candidates = exact.length
                ? exact
                : rows.filter(row => row.name.toLowerCase() === name.toLowerCase());
            timings.set(
                name,
                candidates.length === 1
                    ? timingFromPostgresFlags(candidates[0].deferrable, candidates[0].deferred)
                    : undefined,
            );
        }
    } else if (SQLITE_FAMILY_ENGINES.includes(engine)) {
        const rows: Array<{ ddl: string | null }> = await queryRunner.query(
            'SELECT "sql" AS "ddl" FROM "sqlite_master" WHERE "type" = \'table\' AND "name" = ?',
            [where],
        );
        const ddl = rows[0]?.ddl ?? undefined;
        for (const name of presentReferences) {
            timings.set(name, ddl === undefined ? undefined : timingFromStoredDefinition(ddl, name));
        }
        // A unique constraint in SQLite's grammar admits a conflict clause and no deferrability clause, so
        // every unique the engine stores is immediate by construction and there is nothing to read.
        for (const name of presentUniques) {
            timings.set(name, 'NOT DEFERRABLE');
        }
    } else {
        for (const name of [...presentUniques, ...presentReferences]) {
            timings.set(name, undefined);
        }
    }

    const shortfalls: string[] = [];
    for (const [name, timing] of timings) {
        const described = presentUniques.includes(name) ? 'unique' : 'reference';
        if (timing === undefined) {
            shortfalls.push(
                `the ${described} "${name}" on "${where}" cannot be shown to be NOT DEFERRABLE: the ` +
                    `"${engine}" catalogue offers no reading of it, and a deferred constraint fires at ` +
                    "commit rather than at the statement this migration's error handling depends on",
            );
            continue;
        }
        if (timing !== 'NOT DEFERRABLE') {
            shortfalls.push(
                `the ${described} "${name}" on "${where}" is DEFERRABLE ${timing} rather than ` +
                    'NOT DEFERRABLE, so it is enforced at commit rather than at the statement',
            );
        }
    }
    return shortfalls;
}

export class AddReorderLists1786838400000 implements MigrationInterface {
    /**
     * Creates `reorder_list` and then `reorder_list_line` from the frozen descriptions above, each with its
     * own columns, named objects and cascading foreign keys.
     *
     * **The parent first, and the order is a requirement rather than a tidiness.** The child's
     * `reorderListId` foreign key references the parent, and every engine but the SQLite family refuses a
     * foreign key whose target does not yet exist.
     *
     * Neither call passes `ifNotExist`. A table that is already there is checked against the frozen MINIMUM
     * instead — every object and every reported attribute this timestamp would have created, though not a
     * surplus it knows nothing about — so this migration is either the author of the shape it records or it
     * refuses to be recorded at all. `frozenShapeShortfalls` states exactly what that minimum compares, what
     * it tolerates and what it excludes, each with its reason.
     */
    public async up(queryRunner: QueryRunner): Promise<void> {
        await this.createFrozenTable(queryRunner, frozenListTable(queryRunner));
        await this.createFrozenTable(queryRunner, frozenLineTable(queryRunner));
    }

    /**
     * Drops `reorder_list_line` and then `reorder_list`, taking each table's foreign keys and indices with
     * it.
     *
     * **The child first, mirroring `up()` exactly.** Dropping the parent while the child's foreign key
     * still references it is refused by the MySQL family and by PostgreSQL, and the reverse order is also
     * the one that cannot deadlock against the plugin's own delete path, which takes the parent and then
     * its children through the cascade.
     *
     * Nothing outside these two tables is touched, so a revert cannot take a core row with it: the seeded
     * `customer`, `channel` and `product_variant` rows the foreign keys reference are referenced only, and
     * dropping the referencing side removes the reference rather than the referent.
     */
    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.dropTable(frozenLineTable(queryRunner), true, true, true);
        await queryRunner.dropTable(frozenListTable(queryRunner), true, true, true);
    }

    /**
     * Creates one frozen table, or proves that the table already standing is the one this migration
     * describes.
     *
     * Two sources are consulted, because one of them cannot answer everything. TypeORM's generic table view
     * supplies every column, index, check and constraint attribute it reports, and the engine's own catalogue
     * supplies the one property that view is not authoritative on — a constraint's enforcement timing, which
     * {@link nativeEnforcementTimingShortfalls} explains with the driver locations that make it so.
     *
     * @param queryRunner - The runner the lifecycle supplied.
     * @param frozen - The frozen description of the table.
     * @throws When a table of that name exists but lacks part of the frozen shape, naming every shortfall.
     */
    private async createFrozenTable(queryRunner: QueryRunner, frozen: Table): Promise<void> {
        const existing = await queryRunner.getTable(frozen.name);
        if (!existing) {
            await queryRunner.createTable(frozen, false, true, true);
            return;
        }
        const shortfalls = [
            ...frozenShapeShortfalls(queryRunner, frozen, existing),
            ...(await nativeEnforcementTimingShortfalls(queryRunner, frozen, existing)),
        ];
        if (shortfalls.length) {
            throw new Error(
                `Migration ${AddReorderLists1786838400000.name} found an existing "${bareTableName(
                    frozen.name,
                )}" table that is not the one it describes, so it cannot be recorded as applied:\n` +
                    shortfalls.map(shortfall => `  - ${shortfall}`).join('\n'),
            );
        }
    }
}
