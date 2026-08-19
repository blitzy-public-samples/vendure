/**
 * The **one additive migration** of `@vendure/reorder-plugin`, exercised here and nowhere else.
 *
 * `src/migrations/1786838400000-add-reorder-lists.ts` is the only migration this feature produces, and no
 * other suite in this directory applies it. That is not a division of convenience but a consequence of the
 * harness: **the end-to-end schema is always built by the ORM's schema builder and never by a migration.**
 * `packages/testing/src/initializers/mysql-initializer.ts:L16` and
 * `packages/testing/src/initializers/postgres-initializer.ts:L15` both force `synchronize = true`, and
 * `e2e-common/test-config.ts:L110, L119, L128` set it per engine branch, while the sql.js initializer
 * enables it only while it populates. Every sibling suite therefore runs against a synchronised schema and
 * the migration file is never touched. This suite constructs the migration path itself.
 *
 * ## What it proves — four obligations, and nothing else
 *
 * 1. A **data-bearing up → down → up cycle** against a known-good baseline of seeded core rows.
 * 2. **Every one of the five named database objects asserted twice** — once as present in the migration
 *    *file*, and once by **attempting the write it forbids**, issued directly through the repository and
 *    never through a GraphQL mutation, because the mutation's own validation would refuse first and a
 *    passing test would then prove nothing about the database.
 * 3. The **withdrawn objects asserted absent** (conflict C-A).
 * 4. **Engine-conditional `CHECK` assertions** (conflict C-E), reported as unresolved and requiring a
 *    maintainer ruling — never as settled.
 *
 * These are sequential single writes rather than interleavings, so all four engine jobs carry them,
 * sql.js included: applying, reverting and violating a constraint are not concurrency behaviours
 * (EPIC-001 section 11.6.3, whose ruling is that "the four-job list is the default for every sequential,
 * constraint-shape, migration and response-level claim"). **There is deliberately no barrier and no forced
 * interleaving anywhere in this file** — those belong to the create, add-item and mutate suites and run on
 * MariaDB, MySQL and PostgreSQL only.
 *
 * ## Attribution — where these obligations come from
 *
 * **No user-specified rules were provided for this project.** The rules document was read in full and
 * returned exactly that, and EPIC-001 reaches the same finding independently in its own section 11.9. **No
 * user-specified rule governs this file and no rule forced it into scope**, so nothing below may be
 * presented as one. Every obligation here is either prompt-derived (the plan's sections 0.5.1.8 and 0.7.2)
 * or ticket-derived (STORY-001-01-01 section 2.1 checkpoint 2 and Definition-of-Done item 7; EPIC-001
 * sections 7.8, 11.6.1 and 11.6.3), and each is cited inline as such. The absence of a rules document has
 * not been treated as licence to lower the bar: the standard applied instead is the epic's own testing
 * contract, which is stricter than a general convention would have been.
 *
 * ## THE ENGINE SCOPE OF THE CHECKED-IN MIGRATION — read this before changing anything below
 *
 * **A generated migration carries the DDL of one engine, and this one carries PostgreSQL's.** Its own
 * header records that it was generated live against PostgreSQL 16.15, and its text is unambiguous:
 * `TIMESTAMP NOT NULL DEFAULT now()`, `character varying(191)`, `"id" SERIAL NOT NULL`,
 * `ALTER TABLE … ADD CONSTRAINT … FOREIGN KEY`, and a schema-qualified `DROP INDEX "public"."IDX_…"`. The
 * plan states the same thing in general terms in its section 0.2.3.1 — the exact query depends on the
 * database in use, so one generated file is not portable across the four target engines, and that is to be
 * stated as a known limitation rather than discovered in continuous integration.
 *
 * This suite states it, by measurement rather than by assertion of belief. On the engine the file was
 * generated for, the whole cycle runs and the schema under test is the one the migration built. On the
 * other three the very first statement is refused — SQLite answers `near "(": syntax error` at
 * `DEFAULT now()`, and both MySQL-family engines answer `ERROR 1064` at the double-quoted table name — so
 * the suite asserts that refusal **positively**, including the platform's own silent-failure signal, and
 * then obtains the schema under test from the platform's schema builder instead.
 *
 * **Why the schema builder is the right substitute, and not a weaker one.** `generateMigration` does not
 * invent SQL: it serialises `connection.driver.createSchemaBuilder().log()`
 * (`packages/core/src/migrate.ts:L127`) into the file it writes. The statements the builder executes on a
 * given engine are therefore exactly the statements that engine's own generated migration would contain.
 * Asserting the five named objects against a builder-created schema is asserting what a deployment on that
 * engine gets from its own migration — which is also precisely how the conflict C-E gap becomes visible
 * rather than hidden. Every assertion below states which of the two provenances produced the schema it read.
 *
 * ## Conflict C-E — the named check constraints, UNRESOLVED
 *
 * EPIC-001 section 7.8 requires a cross-field invariant to be a **named check constraint**, requires
 * constraint-shape evidence on **all four engines**, and forbids hand-written raw DDL. **TypeORM 0.3.28
 * cannot satisfy all three at once.** `RdbmsSchemaBuilder.createNewChecks()` returns early for the MySQL
 * family (`node_modules/typeorm/schema-builder/RdbmsSchemaBuilder.js:L694-L698`), `dropOldChecks()` carries
 * the identical guard (`:L333-L337`), all four check-constraint methods on `MysqlQueryRunner` throw
 * (`node_modules/typeorm/driver/mysql/MysqlQueryRunner.js:L1153-L1172`), and `createTableSql` never reads
 * `table.checks`. No throw and no warning reaches the caller — the constraints are simply absent.
 *
 * **This is conflict C-E in the plan's section 0.8.3.5, it requires a maintainer ruling, and it is NOT
 * settled.** This suite therefore records the gap as the positive statement of a known limitation on the
 * MySQL family, and never skips the assertion. Where the invariant is upheld instead: the quantity bound by
 * the service-level `UserInputError` on every write path, and the `lineCount` floor by the service's
 * conditional counter update together with its compare-and-set repair. Both are portable and neither
 * depends on a check constraint existing on any engine.
 *
 * Named `UNIQUE` constraints behave differently and better: the MySQL family turns each into a named unique
 * **index**, preserving both the exact name and the uniqueness guarantee. So the two `UQ_` names and the
 * `IDX_` name are asserted present under their exact names on all four engines, through the engine's own
 * catalogue — `pg_constraint` and `pg_indexes`, `sqlite_master`, `information_schema.STATISTICS` — and never
 * through one portable "constraint type" lookup, because the catalogue object class differs while the name
 * and the guarantee do not.
 *
 * ## Conflict C-A — the withdrawn replay-claim objects
 *
 * One stale sub-task of STORY-001-01-01 still asks for a nullable `varchar(64)` pair on the line table and a
 * paired check constraint. The feature contract withdraws all three, and the same story's own migration
 * sub-task and Definition-of-Done item make their **absence** the assertion. This suite inspects the
 * migration file and both created tables for them and asserts they are not there. The unpublished seats
 * counter FEATURE-001-06 will add in its own later migration is asserted absent for the same reason.
 *
 * ## Native SQLite is UNVERIFIED, and is not claimed anywhere
 *
 * `@vendure/testing` exports MySQL, PostgreSQL and sql.js initializers only
 * (`packages/testing/src/index.ts:L10-L12`) and no continuous-integration job exercises the native SQLite
 * driver, while the contribution guide lists SQLite as supported. Nothing in this file claims it.
 *
 * ## Scope fences this file observes
 *
 * The **empty-generation assertions are not this suite's** — the plan's section 0.7.1 assigns them to the
 * add-item, mutate and read suites, and they are neither duplicated nor claimed here. **No migration file is
 * written, no DDL is hand-authored and no generated file is left behind**: the suite only applies, reverts
 * and inspects the artefact its owning story generated. In particular nothing here issues an
 * `ALTER TABLE … ADD CONSTRAINT CHECK` to close the C-E gap — that is conflict C-E option 2 and it requires
 * explicit maintainer sanction. **No statement-count claim is made**, so the canonical query-capture
 * instrument is deliberately not installed; only its engine resolver is borrowed, so that this file and its
 * five siblings agree on what "the configured engine" means. And **no latency, throughput, service-level,
 * conversion or revenue figure appears anywhere** — the two millisecond constants below are abort guards,
 * asserted against by nothing.
 *
 * ## Lifecycle and isolation (EPIC-001 section 11.6.1)
 *
 * One `TestServer`, created and initialised in `beforeAll` under `TEST_SETUP_TIMEOUT_MS`, with
 * `await server.destroy()` called **unconditionally** in `afterAll`. Every query runner and every data
 * source this file opens is released in a `finally`. Each test seeds only its own fixture and `afterEach`
 * removes every row it created, `reorder_list_line` **before** `reorder_list`, so a foreign key is never
 * what fails a cleanup. `process.exitCode` and the platform's module-level configuration are both mutated by
 * the migration entry points and both are restored. The harness's wholesale `clearAllTables` is **never**
 * used between tests, because it runs `connection.synchronize(true)`
 * (`packages/testing/src/data-population/clear-all-tables.ts:L18`) and would drop the very schema this
 * suite is about. **No test consumes a sibling's state**: the cycle is one self-contained case and each
 * forbidden write builds its own precondition, which is what makes running the file in reverse order, or any
 * single case alone, give the same result.
 */
import {
    mergeConfig,
    resetConfig,
    revertLastMigration,
    runMigrations,
    TransactionalConnection,
    VendureConfig,
} from '@vendure/core';
import { preBootstrapConfig } from '@vendure/core/dist/bootstrap';
import { createTestEnvironment } from '@vendure/testing';
import fs from 'fs-extra';
import path from 'path';
import { DataSource, DataSourceOptions, QueryRunner, Table } from 'typeorm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { initialData } from '../../../e2e-common/e2e-initial-data';
import { TEST_SETUP_TIMEOUT_MS, testConfig } from '../../../e2e-common/test-config';
import { ReorderList, ReorderListLine, ReorderPlugin } from '../index';
import { AddReorderLists1786838400000 } from '../src/migrations/1786838400000-add-reorder-lists';

import { resolveConfiguredEngine } from './fixtures/query-capture';

// ═════════════════════════════════════════════════════════════════════════════════════════════════════
// The artefact under test
// ═════════════════════════════════════════════════════════════════════════════════════════════════════

/** The directory the plugin's migrations live in. Resolved from this file, never from a dev-server path. */
const MIGRATIONS_DIR = path.join(__dirname, '../src/migrations');

/** The one migration file's basename. The suite asserts the directory holds this and nothing else. */
const MIGRATION_FILENAME = '1786838400000-add-reorder-lists.ts';

/** Its absolute path, for the file-text assertions. */
const MIGRATION_FILE_PATH = path.join(MIGRATIONS_DIR, MIGRATION_FILENAME);

/**
 * The migration's class name, **derived from the imported class rather than restated as a string**.
 *
 * A rename therefore breaks this file at compile time instead of silently weakening an assertion, and the
 * name TypeORM records in its own bookkeeping table is by construction the name asserted here.
 */
const MIGRATION_CLASS_NAME = AddReorderLists1786838400000.name;

/**
 * The engine the checked-in migration was generated for.
 *
 * It is not taken on trust: {@link detectGenerationEngineFromDdl} reads the file's own dialect markers and
 * the first assertion below compares the two, so a migration regenerated against another engine fails here
 * with a diagnostic rather than failing obscurely three assertions later.
 */
const GENERATION_ENGINE = 'postgres';

/**
 * Dialect markers that appear in PostgreSQL-generated DDL and in no other engine's.
 *
 * `SERIAL` is PostgreSQL's auto-increment pseudo-type, `character varying` its canonical spelling of
 * `varchar`, `DEFAULT now()` a function call no SQLite column default may hold, and a schema-qualified
 * index name in a `DROP INDEX` is PostgreSQL-only.
 */
const POSTGRES_DDL_MARKERS = ['SERIAL', 'character varying(191)', 'DEFAULT now()', '"public"."IDX_'];

/** Dialect markers that appear in MySQL-family-generated DDL: backticked identifiers and a storage engine. */
const MYSQL_DDL_MARKERS = ['`reorder_list`', 'ENGINE=InnoDB'];

// ═════════════════════════════════════════════════════════════════════════════════════════════════════
// The two plugin tables, their column sets and the core tables they reference
// ═════════════════════════════════════════════════════════════════════════════════════════════════════

/** The parent table. */
const LIST_TABLE = 'reorder_list';

/** The child table, addressed **before** {@link LIST_TABLE} in every cleanup. */
const LINE_TABLE = 'reorder_list_line';

/** Both plugin tables, child first, which is the only order a cleanup may use. */
const PLUGIN_TABLES_CHILD_FIRST = [LINE_TABLE, LIST_TABLE] as const;

/** Both plugin tables, parent first, which is the order the migration must create them in. */
const PLUGIN_TABLES_PARENT_FIRST = [LIST_TABLE, LINE_TABLE] as const;

/**
 * Every column `reorder_list` carries and nothing else, sorted.
 *
 * `id`, `createdAt` and `updatedAt` are inherited from `VendureEntity`
 * (`packages/core/src/entity/base/base.entity.ts:L28-L33`) and are part of the contract even though the
 * entity re-declares none of them. The remaining five are the whole of the stored state: the owning
 * customer, the owning channel, the display name, the canonical name key and the denormalised line count.
 * No contact detail, no free-text note, no serialised request context, no monetary column.
 */
const EXPECTED_LIST_COLUMNS = [
    'channelId',
    'createdAt',
    'customerId',
    'id',
    'lineCount',
    'name',
    'nameKey',
    'updatedAt',
].sort();

/** Every column `reorder_list_line` carries and nothing else, sorted. Three data columns beyond the three inherited. */
const EXPECTED_LINE_COLUMNS = [
    'createdAt',
    'id',
    'productVariantId',
    'quantity',
    'reorderListId',
    'updatedAt',
].sort();

/**
 * The declared width of both indexed string columns.
 *
 * A MySQL and MariaDB key-size ceiling rather than a product choice: 191 four-byte UTF-8 characters keep the
 * composite unique index inside the engine's key-size limit. The same number is the plugin's fixed
 * name-length bound, which is why there is deliberately no option to configure either.
 */
const INDEXED_STRING_COLUMN_LENGTH = '191';

/** The three core tables the plugin's four foreign keys reference. Not one of them may be altered. */
const REFERENCED_CORE_TABLES = ['customer', 'channel', 'product_variant'] as const;

/**
 * The four foreign keys, each declared `ON DELETE CASCADE`, and each pointing **from** a plugin table
 * **to** a core table or to the plugin's own parent.
 *
 * The direction is the whole point of the additive-boundary claim: nothing here adds a column to a core
 * table or makes a core table depend on a plugin table.
 */
const EXPECTED_FOREIGN_KEYS = [
    { table: LIST_TABLE, column: 'customerId', references: 'customer' },
    { table: LIST_TABLE, column: 'channelId', references: 'channel' },
    { table: LINE_TABLE, column: 'reorderListId', references: LIST_TABLE },
    { table: LINE_TABLE, column: 'productVariantId', references: 'product_variant' },
] as const;

// ═════════════════════════════════════════════════════════════════════════════════════════════════════
// The five named database objects — exact names, load-bearing
//
// The names are load-bearing rather than cosmetic: the service translates a violation of
// `UQ_reorder_list_customer_channel_name_key` into `ReorderListNameConflictError` by matching on that one
// name, so a rename silently turns a domain outcome into an internal error.
// ═════════════════════════════════════════════════════════════════════════════════════════════════════

/** Unique over `(customerId, channelId, nameKey)` on `reorder_list`. */
const UQ_LIST_OWNER_NAME_KEY = 'UQ_reorder_list_customer_channel_name_key';

/** Non-unique index over `(customerId, channelId)` on `reorder_list`, serving the ownership predicate. */
const IDX_LIST_OWNER = 'IDX_reorder_list_customer_channel';

/** Unique over `(reorderListId, productVariantId)` on `reorder_list_line`. */
const UQ_LINE_LIST_VARIANT = 'UQ_reorder_list_line_list_variant';

/** Check `quantity > 0` on `reorder_list_line`. */
const CHK_LINE_QUANTITY_POSITIVE = 'CHK_reorder_list_line_quantity_positive';

/** Check `lineCount >= 0` on `reorder_list`. */
const CHK_LIST_LINE_COUNT_NON_NEGATIVE = 'CHK_reorder_list_line_count_non_negative';

/** How a named object materialises in an engine catalogue, which decides which catalogue view is read. */
type NamedObjectKind = 'unique' | 'index' | 'check';

/** One named database object, with the table it sits on and the columns it spans. */
interface NamedObject {
    readonly name: string;
    readonly table: string;
    readonly kind: NamedObjectKind;
    readonly columns: readonly string[];
}

/**
 * The three named objects that exist under their exact names on **all four** engines.
 *
 * On PostgreSQL and the SQLite family a `UQ_` is a named unique constraint; on the MySQL family TypeORM
 * turns it into a named unique *index* instead, keeping the name and the uniqueness guarantee and changing
 * only the catalogue object class. `IDX_` is an ordinary index everywhere.
 */
const PORTABLE_NAMED_OBJECTS: readonly NamedObject[] = [
    {
        name: UQ_LIST_OWNER_NAME_KEY,
        table: LIST_TABLE,
        kind: 'unique',
        columns: ['customerId', 'channelId', 'nameKey'],
    },
    { name: IDX_LIST_OWNER, table: LIST_TABLE, kind: 'index', columns: ['customerId', 'channelId'] },
    {
        name: UQ_LINE_LIST_VARIANT,
        table: LINE_TABLE,
        kind: 'unique',
        columns: ['reorderListId', 'productVariantId'],
    },
];

/**
 * The two named check constraints, which exist on PostgreSQL and the SQLite family and **cannot** exist on
 * the MySQL family under TypeORM 0.3.28. See the conflict C-E discussion in this file's header.
 */
const CHECK_NAMED_OBJECTS: readonly NamedObject[] = [
    { name: CHK_LINE_QUANTITY_POSITIVE, table: LINE_TABLE, kind: 'check', columns: ['quantity'] },
    { name: CHK_LIST_LINE_COUNT_NON_NEGATIVE, table: LIST_TABLE, kind: 'check', columns: ['lineCount'] },
];

/** All five, for the file-level inspection that reads them out of the migration's own text. */
const ALL_NAMED_OBJECTS: readonly NamedObject[] = [...PORTABLE_NAMED_OBJECTS, ...CHECK_NAMED_OBJECTS];

// ═════════════════════════════════════════════════════════════════════════════════════════════════════
// The objects whose ABSENCE is the assertion
// ═════════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * The two withdrawn replay-claim columns and the withdrawn paired check constraint (conflict C-A), plus the
 * unpublished seats counter that belongs to FEATURE-001-06's own later migration.
 *
 * Every one of these is searched for, in the migration text and in both created tables, and its absence is
 * what is asserted. `AddItemToReorderListInput` declares exactly three fields and no idempotency key, so
 * there is nothing for a claim column to store; delivery is at-least-once, stated plainly, with the
 * absolute-set adjust operation as the deterministic remedy.
 */
const WITHDRAWN_COLUMNS = ['lastAddIdempotencyKey', 'lastAddRequestFingerprint', 'activeGrantCount'] as const;

/** The withdrawn paired check constraint, named here because its absence has to be searched for by name. */
const WITHDRAWN_CHECK_CONSTRAINT = 'CHK_reorder_list_line_add_claim_paired';

/**
 * The full statement of conflict C-E, carried into every assertion message that depends on it.
 *
 * It is a constant rather than a comment so that the citation reaches the **test output** when one of those
 * assertions fails, which is what makes the limitation reported rather than merely commented. It says in
 * terms that the conflict is unresolved and needs a maintainer ruling, and it names where each invariant is
 * upheld instead, so nobody reading a failure concludes the invariant itself is missing.
 */
const C_E_CITATION =
    'Conflict C-E (plan section 0.8.3.5). EPIC-001 section 7.8 requires a cross-field invariant to be a ' +
    'NAMED CHECK CONSTRAINT and requires constraint-shape evidence on all four engines, while forbidding ' +
    'hand-written raw DDL. TypeORM 0.3.28 cannot satisfy all three: RdbmsSchemaBuilder.createNewChecks() ' +
    'returns early for the MySQL family (L694-L698), dropOldChecks() carries the same guard (L333-L337), ' +
    'all four check-constraint methods on MysqlQueryRunner throw (L1153-L1172), and createTableSql never ' +
    'reads table.checks — with no throw and no warning reaching the caller. THIS CONFLICT IS UNRESOLVED ' +
    'AND REQUIRES A MAINTAINER RULING; it is not settled. The engines are not the limitation: MySQL has ' +
    'supported CHECK since 8.0.16 and MariaDB since 10.2.1. Both invariants are upheld portably ' +
    'regardless — the quantity bound by the service-level UserInputError on every write path, and the ' +
    'lineCount floor by the service conditional counter update together with its compare-and-set repair.';

/**
 * Why a migration file is not portable across the four engines, carried into the messages that depend on it.
 *
 * The same reasoning as the header's engine-scope section, in the form an assertion failure can print.
 */
const ENGINE_SCOPE_CITATION =
    'A generated migration carries the DDL of one engine (plan section 0.2.3.1: the exact query depends on ' +
    'the database in use), and this one was generated against PostgreSQL — its own header records that, and ' +
    'its SERIAL, character varying, DEFAULT now() and schema-qualified DROP INDEX confirm it. On another ' +
    'engine the schema under test is built by the platform schema builder instead, which is the same ' +
    'builder generateMigration serialises into a file (packages/core/src/migrate.ts:L127), so the objects ' +
    'asserted are the objects that engine own generated migration would carry.';

// ═════════════════════════════════════════════════════════════════════════════════════════════════════
// Engine classification
// ═════════════════════════════════════════════════════════════════════════════════════════════════════

/** The TypeORM engine identifiers of the MySQL family, on which TypeORM 0.3.28 skips check constraints. */
const MYSQL_FAMILY_ENGINES: readonly string[] = ['mysql', 'mariadb'];

/** The TypeORM engine identifiers of the SQLite family, whose DDL carries named checks inline. */
const SQLITE_FAMILY_ENGINES: readonly string[] = ['sqljs', 'sqlite', 'better-sqlite3'];

/** Whether the given engine is one TypeORM refuses to create check constraints on. */
function isMysqlFamily(engine: string): boolean {
    return MYSQL_FAMILY_ENGINES.indexOf(engine) !== -1;
}

/** Whether the given engine stores its schema as parseable DDL text in `sqlite_master`. */
function isSqliteFamily(engine: string): boolean {
    return SQLITE_FAMILY_ENGINES.indexOf(engine) !== -1;
}

/**
 * Whether TypeORM emits named `CHECK` constraints on the given engine.
 *
 * True for PostgreSQL and the SQLite family; false for the MySQL family, and false there because of
 * TypeORM rather than because of the engine — MySQL has supported `CHECK` since 8.0.16 and MariaDB since
 * 10.2.1, and both continuous-integration images are well past those floors. This is conflict C-E.
 */
function emitsNamedCheckConstraints(engine: string): boolean {
    return !isMysqlFamily(engine);
}

/**
 * Reads the engine a migration's text was generated for out of its own dialect markers.
 *
 * Returns `'postgres'`, one of the MySQL-family identifiers, or `'unknown'`. Detecting rather than trusting
 * is what lets the `CHECK`-presence assertion on the file be aligned with reality: a file generated on the
 * MySQL family would not contain the two `CHK_` names at all, and that absence has to be *recorded* as the
 * conflict C-E gap rather than silently skipped.
 */
function detectGenerationEngineFromDdl(source: string): string {
    if (POSTGRES_DDL_MARKERS.every(marker => source.includes(marker))) {
        return 'postgres';
    }
    if (MYSQL_DDL_MARKERS.some(marker => source.includes(marker))) {
        return 'mysql';
    }
    return 'unknown';
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════
// Normalisation — how "identical, field for field" and "identical, column for column" are decided
// ═════════════════════════════════════════════════════════════════════════════════════════════════════

/** One row read back with `SELECT *`, after normalisation. */
type NormalisedRow = Record<string, unknown>;

/**
 * Reduces one cell to a form two reads of the same engine compare equal on.
 *
 * `Date` instances are distinct objects for the same instant, so they become ISO strings; a `Buffer` becomes
 * hex; a `bigint` becomes its decimal string, since a driver may return the same integer as either. Nothing
 * else is touched, and in particular a numeric string a driver returns for a `decimal` column is left
 * exactly as it came back — both sides of every comparison in this file are read through the same driver, so
 * coercing further would only hide a difference.
 */
function normaliseCellValue(value: unknown): unknown {
    if (value instanceof Date) {
        return value.toISOString();
    }
    if (Buffer.isBuffer(value)) {
        return value.toString('hex');
    }
    if (typeof value === 'bigint') {
        return value.toString();
    }
    if (value === undefined) {
        return null;
    }
    return value;
}

/** Reduces a whole result set, sorting each row's keys so column order cannot make two equal rows differ. */
function normaliseRows(rows: unknown): NormalisedRow[] {
    const asArray = Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : [];
    return asArray.map(row => {
        const normalised: NormalisedRow = {};
        for (const key of Object.keys(row).sort()) {
            normalised[key] = normaliseCellValue(row[key]);
        }
        return normalised;
    });
}

/** One column of a table, reduced to the properties that are stable across two reads of the same engine. */
interface ColumnSnapshot {
    name: string;
    type: string;
    isNullable: boolean;
    isPrimary: boolean;
    isGenerated: boolean;
    length: string;
    default: string;
}

/** One table, reduced to a structure two snapshots can be deep-compared on. */
interface TableSnapshot {
    name: string;
    columns: ColumnSnapshot[];
    uniques: string[];
    indices: string[];
    checks: string[];
    foreignKeys: string[];
}

/**
 * Strips the schema or database qualifier off a table path.
 *
 * PostgreSQL reports a referenced table as `public.customer` while the SQLite family reports `customer`, and
 * neither difference is a difference in what the foreign key points at.
 */
function bareTableName(tablePath: string): string {
    const segments = tablePath.split('.');
    return segments[segments.length - 1].replace(/"/g, '').replace(/`/g, '');
}

/**
 * Reduces a `Table` read from an engine catalogue to a normalised, engine-noise-tolerant snapshot.
 *
 * Everything is sorted, so a catalogue that returns its columns or indices in a different order on a second
 * read cannot fail the comparison. A column default is reduced to its own text rather than parsed, because
 * the two snapshots being compared always come from the same engine; the only normalisation applied is
 * `String(...)`, so `0` and `'0'` compare equal while `'0'` and `'1'` still do not.
 */
function describeTable(table: Table): TableSnapshot {
    return {
        name: bareTableName(table.name),
        columns: table.columns
            .map(column => ({
                name: column.name,
                type: column.type,
                isNullable: column.isNullable,
                isPrimary: column.isPrimary,
                isGenerated: column.isGenerated,
                length: String(column.length ?? ''),
                default:
                    column.default === undefined || column.default === null ? '' : String(column.default),
            }))
            .sort((a, b) => a.name.localeCompare(b.name)),
        uniques: table.uniques.map(unique => String(unique.name ?? '')).sort(),
        indices: table.indices.map(index => String(index.name ?? '')).sort(),
        checks: table.checks.map(check => String(check.name ?? '')).sort(),
        foreignKeys: table.foreignKeys
            .map(
                key =>
                    `${key.columnNames.slice().sort().join(',')}->${bareTableName(key.referencedTableName)}` +
                    `(${key.referencedColumnNames.slice().sort().join(',')}) ON DELETE ${String(
                        key.onDelete ?? '',
                    ).toUpperCase()}`,
            )
            .sort(),
    };
}

/** Every named object a table's catalogue entry carries, whatever class the engine filed it under. */
function namedObjectsOf(table: Table): string[] {
    return [
        ...table.uniques.map(unique => String(unique.name ?? '')),
        ...table.indices.map(index => String(index.name ?? '')),
        ...table.checks.map(check => String(check.name ?? '')),
    ].filter(name => name.length > 0);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════
// Values this suite drives
// ═════════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * The five plugin options, at their declared defaults.
 *
 * None of them affects a table, an index or a constraint, so no assertion below depends on a value. They are
 * named in full anyway, because `ReorderPlugin.init` is the registration path a deployment uses and
 * registering the plugin the way a deployment does is what puts its two entities into the metadata the
 * migration lifecycle reads.
 */
const DECLARED_OPTIONS = {
    maxListsPerCustomer: 25,
    maxLinesPerList: 200,
    maxQuantityPerLine: 999,
    defaultReorderListsPageSize: 25,
    defaultReorderListLinesPageSize: 50,
};

/** Two buyers, so the unique constraint's scope can be shown to be per customer rather than global. */
const SEEDED_CUSTOMER_COUNT = 2;

/** The canonical name key the duplicate-row case collides on. Already lower-cased, as the pipeline produces. */
const SEEDED_NAME_KEY = 'migration suite fixture list';

/** Its display form, which the pipeline would have produced from the same input. */
const SEEDED_DISPLAY_NAME = 'Migration Suite Fixture List';

/**
 * A generous budget for the whole up, down and up cycle, which opens three migration connections of its own.
 *
 * An **abort guard and not a measurement**: nothing compares an elapsed time against it, and no
 * service-level, latency or throughput figure is asserted anywhere in this file. Without it the cycle would
 * exhaust the runner's own default budget and fail with a timeout instead of with the assertion that
 * explains what went wrong.
 */
const MIGRATION_CYCLE_ABORT_AFTER_MS = 240_000;

/**
 * The same kind of guard for a case that opens one data-source connection or reads a catalogue view.
 *
 * The e2e runner's default is 15 seconds locally and 30 in continuous integration
 * (`e2e-common/vitest.config.mts`), which is ample for a single statement but not for a catalogue read on a
 * cold connection against a containerised engine.
 */
const CATALOGUE_READ_ABORT_AFTER_MS = 60_000;

// ═════════════════════════════════════════════════════════════════════════════════════════════════════
// Outcomes of the two migration entry points, and why each is wrapped
// ═════════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * What one guarded call of a migration entry point yielded.
 *
 * **Neither entry point throws on failure**, and that is the single most important fact about testing them.
 * `runMigrations` catches, logs, and sets `process.exitCode = 1` unless it is running from the Vendure CLI
 * (`packages/core/src/migrate.ts:L52-L59`); `revertLastMigration` does the same and returns nothing at all
 * (`:L96-L103`). A test that merely awaited either and asserted no rejection would pass while the migration
 * had failed outright. So each call is wrapped: the ambient exit code is saved and cleared, the call is made,
 * the exit code the platform left behind is *read* as evidence, and the ambient value is put back.
 */
interface GuardedMigrationOutcome {
    /** The migration names the platform reported as applied. Empty when nothing ran or the run failed. */
    migrationsRan: string[];
    /**
     * The value the platform left in `process.exitCode`, read before it was restored.
     *
     * `undefined` means the platform signalled no failure. `1` is its failure signal.
     */
    observedExitCode: number | string | undefined;
}

/** The names an engine's own catalogue holds, gathered through the view appropriate to that engine. */
interface EngineCatalogue {
    /** Names filed as unique constraints or as unique indices — the two classes are engine-dependent. */
    uniqueNames: string[];
    /** Names filed as indices. */
    indexNames: string[];
    /** Names filed as check constraints. Empty on the MySQL family, which is conflict C-E. */
    checkNames: string[];
    /** The catalogue view or views actually read, quoted in assertion messages so a failure names its source. */
    source: string;
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════
// The configuration and the environment
// ═════════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * The harness configuration, built at the **top level of this spec file** and deliberately **without
 * `ReorderPlugin` registered**.
 *
 * Both halves of that sentence are load-bearing.
 *
 * `testConfig()` must be called from here rather than from a helper module: it derives this file's port as
 * `getBasePort() + <index of the calling file in its own directory listing>`, reading the caller off the
 * stack (`e2e-common/test-config.ts:L37-L48, L71-L77`). Called from `fixtures/` it would index against the
 * wrong directory and hand two suites the same port.
 *
 * The plugin is **absent** so that the initializer synchronises the **core schema only** and seeds it. Were
 * the plugin registered, `synchronize: true` would create `reorder_list` and `reorder_list_line` during
 * population and the migration would then have nothing to create — its first statement would fail on an
 * object that already exists, and the up-path assertion would be meaningless. This is the whole reason the
 * suite is arranged the way it is.
 *
 * `importExportOptions.importAssetsDir` is overridden because the shared configuration points it at this
 * package's own `e2e/fixtures/assets`, which this package does not ship and may not add; the seeded
 * catalogue's assets live in core's fixtures and the shipped cross-package precedent for reaching them is
 * `packages/dashboard/e2e/global-setup.ts:L105, L122`.
 *
 * The canonical query-capture instrument is deliberately **not** installed: this suite makes no
 * statement-count claim, and installing a logger it never reads would only invite one.
 */
const serverConfig = mergeConfig(testConfig(), {
    importExportOptions: {
        importAssetsDir: path.join(__dirname, '../../core/e2e/fixtures/assets'),
    },
});

const { server } = createTestEnvironment(serverConfig);

describe('STORY-001-01-01 the one additive reorder-list migration', () => {
    /** The engine the running data source actually is, read off it rather than inferred from an env var. */
    let activeEngine: string;

    /** Whether the checked-in migration's DDL is applicable to {@link activeEngine}. */
    let migrationApplies: boolean;

    /** The migration file's text, read once. Every file-level assertion reads this and never the disk again. */
    let migrationSource: string;

    /** The engine {@link migrationSource}'s own dialect markers identify it as having been generated for. */
    let detectedGenerationEngine: string;

    /** The plugin tables that existed before any apply. Expected empty — the precondition the up-path needs. */
    let pluginTablesBeforeAnyApply: string[];

    /** The plugin tables that existed immediately after the first apply attempt and before any fallback. */
    let pluginTablesAfterFirstAttempt: string[];

    /** The outcome of the first apply attempt, recorded in `beforeAll` and asserted by the cycle case. */
    let firstApply: GuardedMigrationOutcome;

    /** Which mechanism created the schema every shape and forbidden-write assertion below reads. */
    let schemaProvenance: 'migration' | 'schema-builder';

    /**
     * The known-good baseline: every row of each referenced core table, field for field, captured **before**
     * the migration was applied and compared again after the revert.
     *
     * A schema-only cycle cannot detect a down-path that takes a core row with it, which is exactly why this
     * is captured row by row rather than as a set of table shapes.
     */
    const baselineCoreRows: Record<string, NormalisedRow[]> = {};

    /** The shape of each referenced core table before anything touched the database, for the no-alteration claim. */
    const baselineCoreTableShapes: Record<string, TableSnapshot> = {};

    /** The identifiers of the seeded buyers, decoded to the values the columns actually hold. */
    let seededCustomerIds: number[];

    /** The identifier of the seeded default channel. */
    let seededChannelId: number;

    /** The identifiers of the seeded catalogue variants. At least two, so a per-list-and-variant pair can differ. */
    let seededVariantIds: number[];

    /** The configuration the migration lifecycle is driven with. Built in `beforeAll`, never at module load. */
    let migrationConfig: Required<VendureConfig>;

    /** The data source this file owns. Every shape read, raw read and direct write below goes through it. */
    let assertionDataSource: DataSource;

    /** Portable identifier quoting for the raw reads, taken from {@link assertionDataSource}'s own driver. */
    let esc: (name: string) => string;

    /** The ambient `process.exitCode`, saved once and restored after every case. */
    let ambientExitCode: number | string | undefined;

    // -----------------------------------------------------------------------------------------------
    // Connection and catalogue helpers
    // -----------------------------------------------------------------------------------------------

    /**
     * Runs work with a query runner and releases it in a `finally`, however the work ends.
     *
     * A leaked query runner holds a pooled connection open, which on PostgreSQL is enough to make a later
     * `DROP TABLE` in the revert step block rather than fail — a hang instead of a diagnostic.
     */
    async function withQueryRunner<T>(work: (queryRunner: QueryRunner) => Promise<T>): Promise<T> {
        const queryRunner = assertionDataSource.createQueryRunner();
        try {
            return await work(queryRunner);
        } finally {
            if (!queryRunner.isReleased) {
                await queryRunner.release();
            }
        }
    }

    /** Which of the two plugin tables currently exist, child first, asked of the engine rather than assumed. */
    async function existingPluginTables(): Promise<string[]> {
        return withQueryRunner(async queryRunner => {
            const present: string[] = [];
            for (const table of PLUGIN_TABLES_CHILD_FIRST) {
                if (await queryRunner.hasTable(table)) {
                    present.push(table);
                }
            }
            return present;
        });
    }

    /**
     * Reads one table's catalogue entry, failing with a named diagnostic when the engine has no such table.
     *
     * `getTable` is used rather than a per-engine `information_schema` query because TypeORM parses each
     * engine's own catalogue back into one `Table` shape, which is what makes the column and foreign-key
     * assertions portable across all four engines.
     */
    async function readTable(name: string): Promise<Table> {
        const table = await withQueryRunner(queryRunner => queryRunner.getTable(name));
        expect(table, `the engine reports no table named "${name}"`).toBeDefined();
        return table as Table;
    }

    /** Every row of a table, ordered by identifier and normalised, for a field-for-field comparison. */
    async function selectAllRows(table: string): Promise<NormalisedRow[]> {
        const rows = await assertionDataSource.query(`SELECT * FROM ${esc(table)} ORDER BY ${esc('id')} ASC`);
        return normaliseRows(rows);
    }

    /** How many rows a table holds. Read through `COUNT(*)`, so no driver returns a page instead of a total. */
    async function countRows(table: string): Promise<number> {
        const rows: Array<Record<string, unknown>> = await assertionDataSource.query(
            `SELECT COUNT(*) AS ${esc('rowCount')} FROM ${esc(table)}`,
        );
        return Number(rows[0].rowCount);
    }

    /**
     * Gathers every named object the engine's own catalogue holds, through the view appropriate to it.
     *
     * Three different catalogues, deliberately, because the object *class* differs between engines while the
     * name and the guarantee do not. A single portable "constraint type" lookup would report a `UQ_` as
     * missing on the MySQL family, where it exists as a named unique index and enforces exactly the same
     * rule.
     */
    async function readEngineCatalogue(): Promise<EngineCatalogue> {
        if (isSqliteFamily(activeEngine)) {
            const rows: Array<{ type: string; name: string; sql: string | null }> =
                await assertionDataSource.query(`SELECT type, name, sql FROM sqlite_master`);
            const tableDdl = rows
                .filter(row => row.type === 'table' && typeof row.sql === 'string')
                .map(row => String(row.sql))
                .join('\n');
            const namedClauses = (keyword: string): string[] => {
                const pattern = new RegExp(`CONSTRAINT\\s+"([^"]+)"\\s+${keyword}`, 'gi');
                const found: string[] = [];
                let match = pattern.exec(tableDdl);
                while (match !== null) {
                    found.push(match[1]);
                    match = pattern.exec(tableDdl);
                }
                return found;
            };
            return {
                uniqueNames: namedClauses('UNIQUE'),
                indexNames: rows.filter(row => row.type === 'index').map(row => row.name),
                checkNames: namedClauses('CHECK'),
                source: 'sqlite_master (table DDL text for named CONSTRAINT clauses, index rows for indices)',
            };
        }
        if (isMysqlFamily(activeEngine)) {
            const statistics: Array<{ name: string; nonUnique: number | string }> =
                await assertionDataSource.query(
                    `SELECT INDEX_NAME AS name, NON_UNIQUE AS nonUnique FROM information_schema.STATISTICS
                      WHERE TABLE_SCHEMA = DATABASE()`,
                );
            const checkConstraints: Array<{ name: string }> = await assertionDataSource.query(
                `SELECT CONSTRAINT_NAME AS name FROM information_schema.CHECK_CONSTRAINTS
                  WHERE CONSTRAINT_SCHEMA = DATABASE()`,
            );
            return {
                uniqueNames: statistics
                    .filter(row => Number(row.nonUnique) === 0 && row.name !== 'PRIMARY')
                    .map(row => row.name),
                indexNames: statistics.map(row => row.name),
                checkNames: checkConstraints.map(row => row.name),
                source: 'information_schema.STATISTICS and information_schema.CHECK_CONSTRAINTS',
            };
        }
        const constraints: Array<{ name: string; kind: string }> = await assertionDataSource.query(
            `SELECT c.conname AS name, c.contype AS kind
               FROM pg_constraint c
               JOIN pg_namespace n ON n.oid = c.connamespace
              WHERE n.nspname = current_schema()`,
        );
        const indexes: Array<{ name: string }> = await assertionDataSource.query(
            `SELECT indexname AS name FROM pg_indexes WHERE schemaname = current_schema()`,
        );
        return {
            uniqueNames: constraints.filter(row => row.kind === 'u').map(row => row.name),
            indexNames: indexes.map(row => row.name),
            checkNames: constraints.filter(row => row.kind === 'c').map(row => row.name),
            source: 'pg_constraint and pg_indexes, both scoped to current_schema()',
        };
    }

    /** Both plugin tables reduced to normalised snapshots, parent first, for the up/down/up comparison. */
    async function snapshotPluginSchema(): Promise<TableSnapshot[]> {
        const snapshots: TableSnapshot[] = [];
        for (const table of PLUGIN_TABLES_PARENT_FIRST) {
            snapshots.push(describeTable(await readTable(table)));
        }
        return snapshots;
    }

    // -----------------------------------------------------------------------------------------------
    // Seeding and cleanup — plugin rows only, written directly through the repository
    // -----------------------------------------------------------------------------------------------

    /**
     * Inserts one list row **directly through the repository** and returns the identifier the engine assigned.
     *
     * Directly through the repository is required rather than convenient: the published mutation's own
     * validation would refuse most of the writes below before they reached the engine, and a test that passed
     * because the service refused would prove nothing about the database. Going through the repository also
     * keeps the statement TypeORM's own, so no parameter placeholder is written by hand for any engine.
     */
    async function insertList(
        overrides: { customerId?: number; name?: string; nameKey?: string; lineCount?: number } = {},
    ): Promise<number> {
        const inserted = await assertionDataSource.getRepository(ReorderList).insert({
            customerId: overrides.customerId ?? seededCustomerIds[0],
            channelId: seededChannelId,
            name: overrides.name ?? SEEDED_DISPLAY_NAME,
            nameKey: overrides.nameKey ?? SEEDED_NAME_KEY,
            lineCount: overrides.lineCount ?? 0,
        });
        return Number(inserted.identifiers[0].id);
    }

    /** Inserts one line row directly through the repository and returns the identifier the engine assigned. */
    async function insertLine(listId: number, productVariantId: number, quantity: number): Promise<number> {
        const inserted = await assertionDataSource
            .getRepository(ReorderListLine)
            .insert({ reorderListId: listId, productVariantId, quantity });
        return Number(inserted.identifiers[0].id);
    }

    /** One list row and two line rows on two distinct variants, which is what makes the cycle data-bearing. */
    async function seedPluginRows(): Promise<{ listId: number; lineIds: number[] }> {
        const listId = await insertList({ lineCount: 2 });
        const lineIds = [
            await insertLine(listId, seededVariantIds[0], 3),
            await insertLine(listId, seededVariantIds[1], 7),
        ];
        return { listId, lineIds };
    }

    /**
     * Removes every plugin row, **child table before parent**, so a foreign key is never what fails a cleanup.
     *
     * Deleting every row rather than tracking identifiers is exact here rather than lax: this file is the only
     * writer these two tables ever have. The harness server is bootstrapped without the plugin, so no
     * resolver, service or job can reach them, and every row present is one a case in this file inserted.
     *
     * The harness's wholesale `clearAllTables` is deliberately not used, here or anywhere: it runs
     * `connection.synchronize(true)` (`packages/testing/src/data-population/clear-all-tables.ts:L18`), which
     * would drop and recreate the very schema this suite exists to assert.
     */
    async function deleteAllPluginRows(): Promise<void> {
        const present = await existingPluginTables();
        for (const table of PLUGIN_TABLES_CHILD_FIRST) {
            if (present.indexOf(table) !== -1) {
                await assertionDataSource.query(`DELETE FROM ${esc(table)}`);
            }
        }
    }

    /**
     * Attempts a write and reports whether the database refused it, without letting a refusal fail the case.
     *
     * The raw driver error is *expected* on this path and is returned rather than asserted against: the write
     * is issued straight through the repository, so there is no service layer between the engine and the
     * caller to translate anything. Where a refusal must reach an API caller carrying no driver text, no
     * statement fragment and no constraint name, that is a service-level claim and the create, add-item and
     * mutate suites own it.
     */
    async function attemptWrite(
        work: () => Promise<unknown>,
    ): Promise<{ refused: boolean; message: string }> {
        try {
            await work();
            return { refused: false, message: '' };
        } catch (e) {
            return { refused: true, message: e instanceof Error ? e.message : String(e) };
        }
    }

    // -----------------------------------------------------------------------------------------------
    // The two migration entry points, each wrapped so a silent failure is evidence rather than a pass
    // -----------------------------------------------------------------------------------------------

    /** Applies pending migrations, reading the exit code the platform leaves behind and then restoring it. */
    async function applyMigrationsGuarded(): Promise<GuardedMigrationOutcome> {
        const saved = process.exitCode;
        process.exitCode = undefined;
        let migrationsRan: string[] = [];
        let observedExitCode: number | string | undefined;
        try {
            migrationsRan = await runMigrations(migrationConfig);
        } finally {
            observedExitCode = process.exitCode;
            process.exitCode = saved;
        }
        return { migrationsRan, observedExitCode };
    }

    /**
     * Reverts the last applied migration under the same guard.
     *
     * `revertLastMigration` returns nothing at all (`packages/core/src/migrate.ts:L89`), so the exit code is
     * the *only* signal it offers and `migrationsRan` is always empty here.
     */
    async function revertLastMigrationGuarded(): Promise<GuardedMigrationOutcome> {
        const saved = process.exitCode;
        process.exitCode = undefined;
        let observedExitCode: number | string | undefined;
        try {
            await revertLastMigration(migrationConfig);
        } finally {
            observedExitCode = process.exitCode;
            process.exitCode = saved;
        }
        return { migrationsRan: [], observedExitCode };
    }

    // -----------------------------------------------------------------------------------------------
    // Lifecycle
    // -----------------------------------------------------------------------------------------------

    beforeAll(async () => {
        ambientExitCode = process.exitCode;

        // The migration's own text, read once. Every file-level assertion reads this string.
        migrationSource = await fs.readFile(MIGRATION_FILE_PATH, 'utf-8');
        detectedGenerationEngine = detectGenerationEngineFromDdl(migrationSource);

        await server.init({
            initialData,
            customerCount: SEEDED_CUSTOMER_COUNT,
            productsCsvPath: path.join(__dirname, '../../core/e2e/fixtures/e2e-products-minimal.csv'),
        });

        const rawConnection = server.app.get(TransactionalConnection).rawConnection;
        activeEngine = rawConnection.options.type;
        migrationApplies = activeEngine === detectedGenerationEngine;
        const escapeOnServer = (name: string): string => rawConnection.driver.escape(name);

        const queryRunner = rawConnection.createQueryRunner();
        try {
            // THE PRECONDITION THE UP-PATH NEEDS, observed rather than assumed. The harness configuration
            // registers no plugin, so the initializer synchronised the core schema alone and neither plugin
            // table can exist yet. If one did, the apply below would fail on an object that already exists and
            // every assertion after it would be measuring the wrong thing.
            pluginTablesBeforeAnyApply = [];
            for (const table of PLUGIN_TABLES_CHILD_FIRST) {
                if (await queryRunner.hasTable(table)) {
                    pluginTablesBeforeAnyApply.push(table);
                }
            }

            // THE KNOWN-GOOD BASELINE. Whole rows, not counts: the revert assertion is that every seeded core
            // row survives field for field, and a count survives a down-path that corrupted a column.
            for (const table of REFERENCED_CORE_TABLES) {
                baselineCoreRows[table] = normaliseRows(
                    await queryRunner.query(
                        `SELECT * FROM ${escapeOnServer(table)} ORDER BY ${escapeOnServer('id')} ASC`,
                    ),
                );
                const coreTable = await queryRunner.getTable(table);
                expect(coreTable, `the seeded schema carries no "${table}" table`).toBeDefined();
                baselineCoreTableShapes[table] = describeTable(coreTable as Table);
            }
        } finally {
            if (!queryRunner.isReleased) {
                await queryRunner.release();
            }
        }

        seededCustomerIds = baselineCoreRows.customer.map(row => Number(row.id));
        seededChannelId = Number(baselineCoreRows.channel[0].id);
        seededVariantIds = baselineCoreRows.product_variant.map(row => Number(row.id));

        // From this point the plugin-less server is NOT USED AGAIN — every statement below goes through the
        // data source this file owns. The plan permits "destroy or stop using", and stopping using it is the
        // choice taken deliberately: `afterAll` owes the contract exactly one unconditional
        // `await server.destroy()`, and destroying here as well would run every module's shutdown hook twice.
        // On sql.js the two connections then hold independent in-memory copies of the same snapshot file,
        // which is harmless precisely because neither writes to it: the initializer leaves `autoSave` false
        // after populating (`packages/testing/src/initializers/sqljs-initializer.ts:L41-L42`), so the cached
        // snapshot is never modified by this suite and a second run of it starts from the same core-only
        // schema.
        migrationConfig = {
            ...serverConfig,
            plugins: [ReorderPlugin.init(DECLARED_OPTIONS)],
            dbConnectionOptions: {
                ...serverConfig.dbConnectionOptions,
                synchronize: false,
                // THE MIGRATION CLASS RATHER THAN A GLOB, and the reason is environmental rather than
                // stylistic. TypeORM resolves a directory glob with `PlatformTools.load`, which is Node's own
                // `require`; under this runner TypeORM is an externalised CommonJS dependency, so its `require`
                // has no TypeScript loader registered and a `*.ts` glob resolves to nothing. The shipped
                // command-line suite gets away with one only because it registers `ts-node` first
                // (`packages/cli/src/shared/load-vendure-config-file.ts`), which this file must not do — it is a
                // process-wide require hook every sibling suite in the worker would inherit. The class
                // reference is also the stronger evidence: it is imported from the very path under test, so the
                // artefact applied is provably that file's export, where a glob could match a second file or
                // none. The glob's own contract is asserted separately, against the directory listing.
                migrations: [AddReorderLists1786838400000],
            } as DataSourceOptions,
        };

        // THE FIRST APPLY. Recorded rather than asserted here, because an assertion in `beforeAll` reports as a
        // suite-wide setup error rather than as the named case that owns the claim.
        firstApply = await applyMigrationsGuarded();

        // `preBootstrapConfig` must run immediately before the data source is built. It resolves the plugin's
        // entities into `dbConnectionOptions.entities` and applies the configured `EntityIdStrategy` to their
        // `@EntityId()` columns (`packages/core/src/bootstrap.ts:L294-L314`). It also re-establishes the
        // platform's module-level configuration, which `runMigrations` resets in its own `finally`
        // (`packages/core/src/migrate.ts:L63`) — and that matters here for one specific reason:
        // `ReorderList.nameKey` carries an engine-resolved collation read through `getConfig()` when column
        // metadata is built, so a data source created while the configuration sat at its default would ask for
        // a MySQL collation on every engine.
        const resolved = await preBootstrapConfig(migrationConfig);
        assertionDataSource = new DataSource({
            ...resolved.dbConnectionOptions,
            synchronize: false,
            migrationsRun: false,
            dropSchema: false,
            // The same four overrides the platform's own migration entry points apply
            // (`packages/core/src/migrate.ts:L197-L205`). Subscribers are dropped because they are Vendure's
            // dependency-injected entity subscribers and nothing here resolves a Nest container.
            subscribers: [],
            logging: false,
        } as DataSourceOptions);
        await assertionDataSource.initialize();
        esc = (name: string): string => assertionDataSource.driver.escape(name);

        pluginTablesAfterFirstAttempt = await existingPluginTables();
        if (pluginTablesAfterFirstAttempt.length === PLUGIN_TABLES_CHILD_FIRST.length) {
            schemaProvenance = 'migration';
        } else {
            // The checked-in migration was generated for another engine and this one refused it. The schema
            // under test therefore comes from the platform's own schema builder, which is the same builder
            // `generateMigration` serialises into a file (`packages/core/src/migrate.ts:L127`) — so what is
            // asserted below is what this engine's own generated migration would carry. The refusal itself is
            // asserted, positively and with its citations, by the cycle case.
            schemaProvenance = 'schema-builder';
            await assertionDataSource.synchronize();
        }

        // Nothing may be inherited by the first case: a previous run against a server engine is impossible
        // (the initializer drops and recreates the database) but a partially applied migration is not, so the
        // tables start empty by assertion of this call rather than by assumption.
        await deleteAllPluginRows();
    }, TEST_SETUP_TIMEOUT_MS);

    afterEach(async () => {
        try {
            await deleteAllPluginRows();
        } finally {
            // Two things this file mutates that it did not create, both put back in the same hook. The
            // migration entry points write `process.exitCode` on failure and reset the platform's module-level
            // configuration on every call; the data source's column metadata was built before the first reset,
            // so resetting again here cannot affect a later assertion.
            process.exitCode = ambientExitCode;
            resetConfig();
        }
    });

    afterAll(async () => {
        try {
            if (assertionDataSource !== undefined && assertionDataSource.isInitialized) {
                await assertionDataSource.destroy();
            }
        } finally {
            process.exitCode = ambientExitCode;
            resetConfig();
            // UNCONDITIONAL, and reached however the teardown above ends. A suite that destroys the server
            // only on its success path leaks a listening port into the next file.
            await server.destroy();
        }
    });

    // ═══════════════════════════════════════════════════════════════════════════════════════════════
    // HALF ONE OF EVERY NAMED-OBJECT CLAIM — the migration file itself
    //
    // Reading the file proves only that a line was written. Issuing the write it forbids proves the database
    // enforces it. The two are different claims and STORY-001-01-01's Definition-of-Done item 7 requires both,
    // which is why every named object appears twice in this file: once here and once below.
    // ═══════════════════════════════════════════════════════════════════════════════════════════════

    describe('the checked-in migration file', () => {
        it('is the only migration this feature produces', async () => {
            const entries = (await fs.readdir(MIGRATIONS_DIR)).sort();

            // Exactly one file, and the one the lifecycle is pointed at. This is also the assertion behind the
            // "glob" contract: the pattern `src/migrations/*.ts` resolves to this single artefact, so applying
            // the imported class applies the same thing the pattern would have.
            expect(entries, `${MIGRATIONS_DIR} must hold exactly one migration`).toEqual([
                MIGRATION_FILENAME,
            ]);
        });

        it('declares the migration class the lifecycle applies, under the name TypeORM records', () => {
            expect(migrationSource).toContain(
                `export class ${MIGRATION_CLASS_NAME} implements MigrationInterface`,
            );

            // TypeORM orders migrations by the digits trailing the class name and records that name in its own
            // bookkeeping table, so the filename digits and the class-name digits must agree. A mismatch
            // silently reorders migrations rather than failing.
            expect(MIGRATION_CLASS_NAME).toMatch(/\d+$/);
            expect(MIGRATION_FILENAME.startsWith(MIGRATION_CLASS_NAME.replace(/^\D+/, ''))).toBe(true);
        });

        it('was generated for the engine its own dialect markers name, and for no other', () => {
            expect(
                detectedGenerationEngine,
                `the migration DDL does not read as ${GENERATION_ENGINE}. ${ENGINE_SCOPE_CITATION}`,
            ).toBe(GENERATION_ENGINE);

            // Stated as the positive, checkable form of the engine-scope limitation rather than left implicit:
            // these four tokens are PostgreSQL's and no other engine accepts them.
            for (const marker of POSTGRES_DDL_MARKERS) {
                expect(migrationSource, `${marker} is the marker that pins the generation engine`).toContain(
                    marker,
                );
            }
            for (const marker of MYSQL_DDL_MARKERS) {
                expect(migrationSource).not.toContain(marker);
            }
        });

        it('creates the parent table first and drops the child table first', () => {
            const upBody = migrationSource.slice(
                migrationSource.indexOf('public async up('),
                migrationSource.indexOf('public async down('),
            );
            const downBody = migrationSource.slice(migrationSource.indexOf('public async down('));

            const createsList = upBody.indexOf(`CREATE TABLE "${LIST_TABLE}"`);
            const createsLine = upBody.indexOf(`CREATE TABLE "${LINE_TABLE}"`);
            expect(createsList, `up() must create "${LIST_TABLE}"`).toBeGreaterThan(-1);
            expect(createsLine, `up() must create "${LINE_TABLE}"`).toBeGreaterThan(-1);

            // The parent first, because the child's foreign key references it.
            expect(createsList).toBeLessThan(createsLine);

            const dropsLine = downBody.indexOf(`DROP TABLE "${LINE_TABLE}"`);
            const dropsList = downBody.indexOf(`DROP TABLE "${LIST_TABLE}"`);
            expect(dropsLine, `down() must drop "${LINE_TABLE}"`).toBeGreaterThan(-1);
            expect(dropsList, `down() must drop "${LIST_TABLE}"`).toBeGreaterThan(-1);
            expect(dropsLine).toBeLessThan(dropsList);
        });

        it('carries the three engine-portable named objects under their exact names', () => {
            for (const namedObject of PORTABLE_NAMED_OBJECTS) {
                expect(
                    migrationSource,
                    `the migration must name ${namedObject.name} on ${namedObject.table}`,
                ).toContain(namedObject.name);
                for (const column of namedObject.columns) {
                    expect(migrationSource).toContain(`"${column}"`);
                }
            }
        });

        it('carries the two named check constraints, the file having been generated on an engine that emits them', () => {
            // ALIGNED WITH THE FILE RATHER THAN WITH AN EXPECTATION. Where the checked-in migration was
            // generated on an engine TypeORM emits named checks for, both names must be present. Where it was
            // generated on the MySQL family they cannot be, and that absence is RECORDED as the conflict C-E
            // gap rather than skipped — either way an assertion runs and either way the outcome is stated.
            if (emitsNamedCheckConstraints(detectedGenerationEngine)) {
                for (const namedObject of CHECK_NAMED_OBJECTS) {
                    expect(
                        migrationSource,
                        `the migration was generated on ${detectedGenerationEngine}, which emits named ` +
                            `checks, so it must name ${namedObject.name}`,
                    ).toContain(namedObject.name);
                }
                expect(migrationSource).toContain('CHECK ("quantity" > 0)');
                expect(migrationSource).toContain('CHECK ("lineCount" >= 0)');
            } else {
                for (const namedObject of CHECK_NAMED_OBJECTS) {
                    expect(
                        migrationSource,
                        `the migration was generated on ${detectedGenerationEngine}, so ${namedObject.name} ` +
                            `CANNOT appear in it. ${C_E_CITATION}`,
                    ).not.toContain(namedObject.name);
                }
            }
        });

        it('carries the denormalised line counter and both indexed string columns at their declared width', () => {
            expect(migrationSource).toContain('"lineCount"');
            expect(migrationSource).toContain('"name"');
            expect(migrationSource).toContain('"nameKey"');

            // 191 twice, once for each string column. A key-size ceiling on the MySQL family rather than a
            // product choice, which is why the same number is the plugin's fixed name-length bound.
            const widthOccurrences = migrationSource.split(`(${INDEXED_STRING_COLUMN_LENGTH})`).length - 1;
            expect(widthOccurrences, 'both "name" and "nameKey" are declared at 191').toBeGreaterThanOrEqual(
                2,
            );
        });

        it('carries four ON DELETE CASCADE foreign keys, every one declared on a plugin table', () => {
            for (const foreignKey of EXPECTED_FOREIGN_KEYS) {
                const clause = `ALTER TABLE "${foreignKey.table}" ADD CONSTRAINT`;
                expect(
                    migrationSource,
                    `${foreignKey.table}.${foreignKey.column} needs a foreign key`,
                ).toContain(clause);
                expect(migrationSource).toContain(`FOREIGN KEY ("${foreignKey.column}")`);
                expect(migrationSource).toContain(
                    `REFERENCES "${foreignKey.references}"("id") ON DELETE CASCADE`,
                );
            }

            const cascadeCount = migrationSource.split('ON DELETE CASCADE').length - 1;
            expect(cascadeCount, 'exactly four foreign keys, each cascading').toBe(
                EXPECTED_FOREIGN_KEYS.length,
            );
        });

        it('alters no core table and drops no core object', () => {
            // Every ALTER TABLE in the file names a PLUGIN table. The core tables appear only as the target of
            // a REFERENCES clause, which adds nothing to them.
            const alterTargets = Array.from(migrationSource.matchAll(/ALTER TABLE "([^"]+)"/g)).map(
                match => match[1],
            );
            expect(alterTargets.length, 'the foreign keys are added by ALTER TABLE').toBeGreaterThan(0);
            for (const target of alterTargets) {
                expect(
                    PLUGIN_TABLES_PARENT_FIRST.indexOf(target as (typeof PLUGIN_TABLES_PARENT_FIRST)[number]),
                    `"${target}" is not a plugin table, so this migration is not additive`,
                ).toBeGreaterThan(-1);
            }

            for (const coreTable of REFERENCED_CORE_TABLES) {
                expect(migrationSource).not.toContain(`DROP TABLE "${coreTable}"`);
                expect(migrationSource).not.toContain(`ALTER TABLE "${coreTable}"`);
            }
            expect(migrationSource).not.toContain('DROP COLUMN');
        });

        it('carries neither withdrawn claim column, nor the withdrawn claim constraint, nor a seats counter', () => {
            // CONFLICT C-A. One stale sub-task of STORY-001-01-01 still asks for the claim pair; the feature
            // contract withdraws all three objects and the story's own migration sub-task and Definition-of-Done
            // item make their ABSENCE the assertion. The seats counter belongs to FEATURE-001-06's own later
            // migration, so this file must never be edited to add it either.
            for (const column of WITHDRAWN_COLUMNS) {
                expect(migrationSource, `${column} is withdrawn and must not appear`).not.toContain(column);
            }
            expect(
                migrationSource,
                `${WITHDRAWN_CHECK_CONSTRAINT} is withdrawn and must not appear`,
            ).not.toContain(WITHDRAWN_CHECK_CONSTRAINT);
        });
    });

    // ═══════════════════════════════════════════════════════════════════════════════════════════════
    // The schema under test, and which mechanism produced it
    // ═══════════════════════════════════════════════════════════════════════════════════════════════

    /** One table's normalised snapshot, read from the engine's own catalogue through TypeORM's parser. */
    async function readTableSnapshot(name: string): Promise<TableSnapshot> {
        return describeTable(await readTable(name));
    }

    /** One named column of a snapshot, failing with a diagnostic naming the table when it is absent. */
    function columnNamed(snapshot: TableSnapshot, name: string): ColumnSnapshot {
        const column = snapshot.columns.find(candidate => candidate.name === name);
        expect(column, `"${snapshot.name}" carries no column named "${name}"`).toBeDefined();
        return column as ColumnSnapshot;
    }

    describe('the schema under test', () => {
        it(
            'states its own provenance, and both plugin tables exist under it',
            async () => {
                // THE ENGINE UNDER TEST IS THE ENGINE THE RUN WAS CONFIGURED FOR. Read off the running data
                // source rather than off an environment variable, and cross-checked against the resolver the
                // five sibling suites share (`./fixtures/query-capture`, which mirrors the shared
                // configuration's own `process.env.DB || 'sqljs'`). Every engine-conditional branch in this file
                // turns on `activeEngine`, so a disagreement here would silently take one of them on the wrong
                // engine and report a limitation that did not apply.
                expect(
                    activeEngine,
                    'the running data source is not the engine this e2e run was configured for',
                ).toBe(resolveConfiguredEngine());
                expect(assertionDataSource.options.type).toBe(activeEngine);

                // NEITHER TABLE EXISTED BEFORE ANY APPLY. This is the precondition that makes the up-path's effect
                // attributable to the migration rather than to the harness's synchronisation.
                expect(
                    pluginTablesBeforeAnyApply,
                    'the harness registers no plugin, so the initializer must have synchronised the core schema alone',
                ).toEqual([]);

                if (migrationApplies) {
                    expect(
                        schemaProvenance,
                        `the active engine is ${activeEngine}, which is the engine the migration was generated ` +
                            `for, so the schema under test must be the migration's own`,
                    ).toBe('migration');
                    expect(pluginTablesAfterFirstAttempt.slice().sort()).toEqual(
                        PLUGIN_TABLES_CHILD_FIRST.slice().sort(),
                    );
                } else {
                    expect(
                        schemaProvenance,
                        `the active engine is ${activeEngine} and the migration was generated for ` +
                            `${detectedGenerationEngine}. ${ENGINE_SCOPE_CITATION}`,
                    ).toBe('schema-builder');
                    // The refusal left NOTHING behind, which is what makes the builder-created schema clean rather
                    // than a partial application dressed up as one.
                    expect(pluginTablesAfterFirstAttempt).toEqual([]);
                }

                expect((await existingPluginTables()).slice().sort()).toEqual(
                    PLUGIN_TABLES_CHILD_FIRST.slice().sort(),
                );
            },
            CATALOGUE_READ_ABORT_AFTER_MS,
        );

        it(
            'gives reorder_list exactly the eight columns the entity declares and nothing else',
            async () => {
                const snapshot = await readTableSnapshot(LIST_TABLE);

                expect(snapshot.columns.map(column => column.name).sort()).toEqual(EXPECTED_LIST_COLUMNS);

                // The three inherited columns, which `VendureEntity` supplies and the entity re-declares none of.
                expect(columnNamed(snapshot, 'id').isPrimary).toBe(true);
                expect(columnNamed(snapshot, 'id').isGenerated).toBe(true);
                expect(columnNamed(snapshot, 'createdAt').isNullable).toBe(false);
                expect(columnNamed(snapshot, 'updatedAt').isNullable).toBe(false);

                // Both indexed string columns at 191 — the MySQL-family key-size ceiling.
                expect(columnNamed(snapshot, 'name').length).toBe(INDEXED_STRING_COLUMN_LENGTH);
                expect(columnNamed(snapshot, 'nameKey').length).toBe(INDEXED_STRING_COLUMN_LENGTH);
                expect(columnNamed(snapshot, 'name').isNullable).toBe(false);
                expect(columnNamed(snapshot, 'nameKey').isNullable).toBe(false);

                // The ownership pair. Both are `@EntityId()` columns, so their physical type is whatever the
                // configured `EntityIdStrategy` resolved to rather than a hand-typed one.
                expect(columnNamed(snapshot, 'customerId').isNullable).toBe(false);
                expect(columnNamed(snapshot, 'channelId').isNullable).toBe(false);

                // The stored counter, not nullable and defaulting to exactly zero, which is what lets a freshly
                // created list report a count of zero without reading the line table at all. The default is
                // compared digit for digit rather than string for string, because one engine writes `0`, another
                // `'0'` and a third `(0)` for the same value.
                const lineCount = columnNamed(snapshot, 'lineCount');
                expect(lineCount.isNullable).toBe(false);
                expect(lineCount.default.replace(/[^0-9-]/g, ''), 'lineCount defaults to exactly 0').toBe(
                    '0',
                );
            },
            CATALOGUE_READ_ABORT_AFTER_MS,
        );

        it(
            'gives reorder_list_line exactly the six columns the entity declares and nothing else',
            async () => {
                const snapshot = await readTableSnapshot(LINE_TABLE);

                expect(snapshot.columns.map(column => column.name).sort()).toEqual(EXPECTED_LINE_COLUMNS);

                expect(columnNamed(snapshot, 'id').isPrimary).toBe(true);
                expect(columnNamed(snapshot, 'id').isGenerated).toBe(true);
                expect(columnNamed(snapshot, 'createdAt').isNullable).toBe(false);
                expect(columnNamed(snapshot, 'updatedAt').isNullable).toBe(false);

                expect(columnNamed(snapshot, 'reorderListId').isNullable).toBe(false);

                // The stored variant reference stays NOT NULL while the published GraphQL field is nullable. The
                // pair is deliberate: platform variant deletion is soft and being disabled is a flag on a row that
                // remains present, so a retained line always points at a row that still exists.
                expect(columnNamed(snapshot, 'productVariantId').isNullable).toBe(false);

                expect(columnNamed(snapshot, 'quantity').isNullable).toBe(false);
            },
            CATALOGUE_READ_ABORT_AFTER_MS,
        );

        it(
            'points all four foreign keys from a plugin table, each ON DELETE CASCADE',
            async () => {
                const snapshots = new Map<string, TableSnapshot>();
                for (const table of PLUGIN_TABLES_PARENT_FIRST) {
                    snapshots.set(table, await readTableSnapshot(table));
                }

                for (const foreignKey of EXPECTED_FOREIGN_KEYS) {
                    const snapshot = snapshots.get(foreignKey.table) as TableSnapshot;
                    expect(
                        snapshot.foreignKeys,
                        `${foreignKey.table}.${foreignKey.column} must cascade to ${foreignKey.references}.id`,
                    ).toContain(`${foreignKey.column}->${foreignKey.references}(id) ON DELETE CASCADE`);
                }

                // Four in total and not one more, so nothing has quietly acquired a second reference.
                const total = Array.from(snapshots.values()).reduce(
                    (count, snapshot) => count + snapshot.foreignKeys.length,
                    0,
                );
                expect(total).toBe(EXPECTED_FOREIGN_KEYS.length);
            },
            CATALOGUE_READ_ABORT_AFTER_MS,
        );

        it(
            'leaves every referenced core table exactly as the baseline found it',
            async () => {
                // Establishing the plugin schema — by either mechanism — must add nothing to a core table and alter
                // no column of one. Compared shape for shape against the snapshot taken before anything ran.
                for (const coreTable of REFERENCED_CORE_TABLES) {
                    expect(
                        await readTableSnapshot(coreTable),
                        `"${coreTable}" was altered while the plugin schema was established`,
                    ).toEqual(baselineCoreTableShapes[coreTable]);
                }
            },
            CATALOGUE_READ_ABORT_AFTER_MS,
        );

        it(
            'carries neither withdrawn claim column nor a seats counter nor the claim constraint',
            async () => {
                // CONFLICT C-A again, this time against the created tables rather than against the file. A column
                // absent from the migration but present in the database would mean the entity declares something the
                // migration does not — the divergence this half catches and the file half cannot.
                for (const tableName of PLUGIN_TABLES_PARENT_FIRST) {
                    const table = await readTable(tableName);
                    const columnNames = table.columns.map(column => column.name);
                    for (const withdrawn of WITHDRAWN_COLUMNS) {
                        expect(columnNames, `"${tableName}" must not carry ${withdrawn}`).not.toContain(
                            withdrawn,
                        );
                    }
                    expect(
                        namedObjectsOf(table),
                        `"${tableName}" must not carry ${WITHDRAWN_CHECK_CONSTRAINT}`,
                    ).not.toContain(WITHDRAWN_CHECK_CONSTRAINT);
                }

                // And nowhere in the engine's whole catalogue either, so a stray object on a table this suite does
                // not inspect is still a finding.
                const catalogue = await readEngineCatalogue();
                const everyName = [
                    ...catalogue.uniqueNames,
                    ...catalogue.indexNames,
                    ...catalogue.checkNames,
                ];
                expect(everyName, `read from ${catalogue.source}`).not.toContain(WITHDRAWN_CHECK_CONSTRAINT);
            },
            CATALOGUE_READ_ABORT_AFTER_MS,
        );
    });

    // ═══════════════════════════════════════════════════════════════════════════════════════════════
    // HALF TWO, PART ONE — the named objects, present in the engine's own catalogue under their exact names
    //
    // Three catalogues, deliberately, because the object CLASS differs between engines while the name and the
    // guarantee do not: a `UQ_` is a unique constraint on PostgreSQL and the SQLite family and a named unique
    // INDEX on the MySQL family. A single portable "constraint type" lookup would report it missing on two of
    // the four engine jobs while it was enforcing exactly the same rule.
    // ═══════════════════════════════════════════════════════════════════════════════════════════════

    describe("the named objects, in the engine's own catalogue", () => {
        for (const namedObject of PORTABLE_NAMED_OBJECTS) {
            it(
                `${namedObject.name} exists on ${namedObject.table} on every engine`,
                async () => {
                    const catalogue = await readEngineCatalogue();
                    const namesForKind =
                        namedObject.kind === 'unique' ? catalogue.uniqueNames : catalogue.indexNames;

                    expect(
                        namesForKind,
                        `${namedObject.name} is missing from ${catalogue.source} on ${activeEngine}, where the ` +
                            `schema was created by the ${schemaProvenance}`,
                    ).toContain(namedObject.name);

                    // And under the same name in TypeORM's own parse of that catalogue, spanning the declared
                    // columns. Two reads of one fact through two mechanisms, because the name is what the service's
                    // narrow violation match depends on.
                    const table = await readTable(namedObject.table);
                    expect(namedObjectsOf(table)).toContain(namedObject.name);
                    const spans = [...table.uniques, ...table.indices].find(
                        candidate => candidate.name === namedObject.name,
                    );
                    expect(
                        spans,
                        `${namedObject.name} is not parsed back off ${namedObject.table}`,
                    ).toBeDefined();
                    expect(spans?.columnNames.slice().sort()).toEqual(namedObject.columns.slice().sort());
                },
                CATALOGUE_READ_ABORT_AFTER_MS,
            );
        }

        for (const namedObject of CHECK_NAMED_OBJECTS) {
            it(
                `${namedObject.name} exists on ${namedObject.table}, or is recorded as the conflict C-E gap`,
                async () => {
                    const catalogue = await readEngineCatalogue();
                    const table = await readTable(namedObject.table);

                    if (emitsNamedCheckConstraints(activeEngine)) {
                        expect(
                            catalogue.checkNames,
                            `${namedObject.name} is missing from ${catalogue.source} on ${activeEngine}, which ` +
                                `TypeORM does emit named checks for`,
                        ).toContain(namedObject.name);
                        expect(table.checks.map(check => String(check.name ?? ''))).toContain(
                            namedObject.name,
                        );
                    } else {
                        // THE GAP, STATED POSITIVELY. Not skipped, not tolerated silently: the constraint is
                        // asserted ABSENT here, because on this engine family TypeORM 0.3.28 cannot create it and
                        // an assertion that it existed would be asserting a falsehood.
                        expect(
                            catalogue.checkNames,
                            `${namedObject.name} CANNOT exist on ${activeEngine}. ${C_E_CITATION}`,
                        ).not.toContain(namedObject.name);
                        expect(
                            table.checks,
                            `TypeORM parses no check constraint off ${namedObject.table} on ${activeEngine}. ` +
                                C_E_CITATION,
                        ).toEqual([]);
                    }
                },
                CATALOGUE_READ_ABORT_AFTER_MS,
            );
        }
    });

    // ═══════════════════════════════════════════════════════════════════════════════════════════════
    // HALF TWO, PART TWO — the write each named object forbids
    //
    // Each case in its own `it`, each building its own precondition, each issued straight through the
    // repository. Every one of them runs on all four engine jobs, sql.js included: these are sequential single
    // writes rather than interleavings, and EPIC-001 section 11.6.3 keeps the migration and constraint
    // obligations on all four jobs for exactly that reason. There is no barrier anywhere in this file.
    // ═══════════════════════════════════════════════════════════════════════════════════════════════

    describe('the write each named object forbids', () => {
        it(
            `${UQ_LIST_OWNER_NAME_KEY} refuses a second row for one customer, channel and canonical name`,
            async () => {
                expect(seededCustomerIds.length, 'the fixture seeds two buyers').toBeGreaterThanOrEqual(2);
                const lists = assertionDataSource.getRepository(ReorderList);
                await insertList();
                expect(await lists.count({ where: { nameKey: SEEDED_NAME_KEY } })).toBe(1);

                // The same owner, the same channel and the same canonical key, differing only in the display name —
                // which is not part of the constraint and so cannot rescue the row.
                const attempt = await attemptWrite(() =>
                    insertList({ name: 'A different display spelling of the same canonical name' }),
                );

                expect(
                    attempt.refused,
                    `the database must refuse the duplicate through ${UQ_LIST_OWNER_NAME_KEY}; the write was ` +
                        `accepted instead, so uniqueness rests on the service alone and a race defeats it`,
                ).toBe(true);
                // WHAT IS READ TO OBSERVE THE REFUSAL: the row count, unchanged. "An error occurred" would not
                // distinguish a refusal from a write that landed and then failed on something else.
                expect(await lists.count({ where: { nameKey: SEEDED_NAME_KEY } })).toBe(1);

                // AND THE SCOPE IS THE TRIPLE, not the name alone: the second buyer holds the same canonical name
                // in the same channel without collision, which is what makes the constraint per owner.
                const otherBuyer = await attemptWrite(() => insertList({ customerId: seededCustomerIds[1] }));
                expect(
                    otherBuyer.refused,
                    `${UQ_LIST_OWNER_NAME_KEY} spans (customerId, channelId, nameKey), so a second buyer's row ` +
                        `must be accepted: ${otherBuyer.message}`,
                ).toBe(false);
                expect(await lists.count({ where: { nameKey: SEEDED_NAME_KEY } })).toBe(2);
            },
            CATALOGUE_READ_ABORT_AFTER_MS,
        );

        it(
            `${UQ_LINE_LIST_VARIANT} refuses a second line for one list and variant`,
            async () => {
                expect(
                    seededVariantIds.length,
                    'the fixture seeds two catalogue variants',
                ).toBeGreaterThanOrEqual(2);
                const lines = assertionDataSource.getRepository(ReorderListLine);
                const listId = await insertList();
                await insertLine(listId, seededVariantIds[0], 4);
                expect(await lines.count({ where: { reorderListId: listId } })).toBe(1);

                const attempt = await attemptWrite(() => insertLine(listId, seededVariantIds[0], 9));

                expect(
                    attempt.refused,
                    `the database must refuse the duplicate pair through ${UQ_LINE_LIST_VARIANT}; accepted ` +
                        `instead, so per-variant de-duplication rests on the add path's own read and two ` +
                        `simultaneous adds would each insert`,
                ).toBe(true);
                expect(await lines.count({ where: { reorderListId: listId } })).toBe(1);

                // A DIFFERENT variant on the same list is accepted, so the constraint spans the pair rather than
                // limiting a list to one line.
                const secondVariant = await attemptWrite(() => insertLine(listId, seededVariantIds[1], 9));
                expect(secondVariant.refused, secondVariant.message).toBe(false);
                expect(await lines.count({ where: { reorderListId: listId } })).toBe(2);
            },
            CATALOGUE_READ_ABORT_AFTER_MS,
        );

        it(
            `${CHK_LINE_QUANTITY_POSITIVE} refuses a zero and a negative quantity, or records the C-E gap`,
            async () => {
                const lines = assertionDataSource.getRepository(ReorderListLine);
                const listId = await insertList();

                const zero = await attemptWrite(() => insertLine(listId, seededVariantIds[0], 0));
                const negative = await attemptWrite(() => insertLine(listId, seededVariantIds[1], -1));
                const stored = await lines.count({ where: { reorderListId: listId } });

                if (emitsNamedCheckConstraints(activeEngine)) {
                    expect(
                        zero.refused,
                        `${CHK_LINE_QUANTITY_POSITIVE} must refuse a quantity of 0 on ${activeEngine}`,
                    ).toBe(true);
                    expect(
                        negative.refused,
                        `${CHK_LINE_QUANTITY_POSITIVE} must refuse a quantity of -1 on ${activeEngine}`,
                    ).toBe(true);
                    expect(stored, 'neither forbidden row may have landed').toBe(0);
                } else {
                    // THE GAP, OBSERVED RATHER THAN ASSUMED. Both writes land, because the constraint does not
                    // exist on this engine family. The invariant is not therefore unguarded: the service refuses a
                    // non-positive quantity with a top-level `UserInputError` before any statement is issued, on
                    // every engine, and the create, add-item and mutate suites assert that.
                    expect(
                        zero.refused,
                        `a quantity of 0 is NOT refused on ${activeEngine}. ${C_E_CITATION}`,
                    ).toBe(false);
                    expect(
                        negative.refused,
                        `a quantity of -1 is NOT refused on ${activeEngine}. ${C_E_CITATION}`,
                    ).toBe(false);
                    expect(stored, `both forbidden rows land on ${activeEngine}. ${C_E_CITATION}`).toBe(2);
                }
            },
            CATALOGUE_READ_ABORT_AFTER_MS,
        );

        it(
            `${CHK_LIST_LINE_COUNT_NON_NEGATIVE} refuses a negative stored line count, or records the C-E gap`,
            async () => {
                const lists = assertionDataSource.getRepository(ReorderList);
                const listId = await insertList({ lineCount: 0 });

                const attempt = await attemptWrite(() => lists.update({ id: listId }, { lineCount: -1 }));

                const reloaded = await lists.findOne({ where: { id: listId } });
                expect(
                    reloaded,
                    'the list row must still be present whichever way the write went',
                ).not.toBeNull();

                if (emitsNamedCheckConstraints(activeEngine)) {
                    expect(
                        attempt.refused,
                        `${CHK_LIST_LINE_COUNT_NON_NEGATIVE} must refuse a stored count of -1 on ${activeEngine}`,
                    ).toBe(true);
                    // WHAT IS READ TO OBSERVE THE REFUSAL: the stored counter, still zero.
                    expect(
                        Number(reloaded?.lineCount),
                        'the counter must be unchanged by a refused update',
                    ).toBe(0);
                } else {
                    expect(
                        attempt.refused,
                        `a stored count of -1 is NOT refused on ${activeEngine}. ${C_E_CITATION}`,
                    ).toBe(false);
                    expect(Number(reloaded?.lineCount), `the negative value lands on ${activeEngine}`).toBe(
                        -1,
                    );
                }
            },
            CATALOGUE_READ_ABORT_AFTER_MS,
        );

        it(
            `${IDX_LIST_OWNER} forbids no write, and is therefore asserted present only`,
            async () => {
                // Stated rather than omitted, so the five named objects are five cases here as well as five names in
                // the file. An index constrains no value, so there is no write for it to refuse; a test that
                // invented one would be asserting a behaviour the object does not have. Its presence is asserted by
                // the catalogue case above, and re-read here so this case carries its own evidence.
                const catalogue = await readEngineCatalogue();
                expect(catalogue.indexNames, `read from ${catalogue.source}`).toContain(IDX_LIST_OWNER);

                // A write the index does not forbid: two lists for one owner in one channel, differing only in
                // canonical name. The index serves the ownership predicate rather than restricting it.
                const lists = assertionDataSource.getRepository(ReorderList);
                await insertList({ nameKey: 'first list for this owner', name: 'First list for this owner' });
                const second = await attemptWrite(() =>
                    insertList({ nameKey: 'second list for this owner', name: 'Second list for this owner' }),
                );
                expect(second.refused, second.message).toBe(false);
                expect(await lists.count({ where: { customerId: seededCustomerIds[0] } })).toBe(2);
            },
            CATALOGUE_READ_ABORT_AFTER_MS,
        );
    });

    // ═══════════════════════════════════════════════════════════════════════════════════════════════
    // The data-bearing up → down → up cycle
    //
    // Applied once and reverted once cannot detect a non-idempotent up-path or a down-path that takes a core
    // row with it, which is why the sequence is whole and why it carries data. Both cases below are
    // self-contained: each builds its own precondition and leaves the schema as it found it, so running either
    // alone, or the file in reverse order, gives the same result.
    // ═══════════════════════════════════════════════════════════════════════════════════════════════

    describe('the data-bearing up, down and up cycle', () => {
        // Synchronous deliberately: the apply itself happened in `beforeAll`, because an assertion made there
        // reports as a suite-wide setup error rather than as the named case that owns the claim. This case reads
        // the recorded outcome, so it issues no statement of its own and needs no abort guard.
        it('applied cleanly through the platform lifecycle, or refused with the engine scope it declares', () => {
            if (migrationApplies) {
                expect(
                    firstApply.migrationsRan,
                    `runMigrations must report ${MIGRATION_CLASS_NAME} as applied on ${activeEngine}`,
                ).toContain(MIGRATION_CLASS_NAME);

                // THE SILENT-FAILURE PATH, CLOSED. `runMigrations` does not throw: it logs and sets
                // `process.exitCode = 1` unless it is running from the Vendure CLI
                // (`packages/core/src/migrate.ts:L52-L59`). An assertion that only awaited the call would pass
                // on a migration that had failed outright, so the exit code the platform left behind is read.
                expect(
                    firstApply.observedExitCode,
                    'runMigrations signalled a failure through process.exitCode',
                ).toBeUndefined();

                // AND THE EFFECT, read off the engine: exactly the two tables, created by that apply and by
                // nothing else, since neither existed beforehand.
                expect(pluginTablesAfterFirstAttempt.slice().sort()).toEqual(
                    PLUGIN_TABLES_CHILD_FIRST.slice().sort(),
                );
                expect(schemaProvenance).toBe('migration');
            } else {
                // THE ENGINE-SCOPE LIMITATION, STATED AS AN OBSERVATION. The active engine is not the one this
                // file's DDL was generated for, so the first statement is refused and nothing is created. This
                // is reported rather than skipped, and it is the same fact the plan requires be stated rather
                // than discovered in continuous integration.
                expect(
                    firstApply.migrationsRan,
                    `${MIGRATION_CLASS_NAME} cannot apply on ${activeEngine}. ${ENGINE_SCOPE_CITATION}`,
                ).not.toContain(MIGRATION_CLASS_NAME);
                expect(firstApply.migrationsRan).toEqual([]);

                // The platform's failure signal, read rather than inferred — which is also how this suite
                // covers the silent-failure path on three of the four engine jobs.
                expect(
                    firstApply.observedExitCode,
                    'runMigrations must set process.exitCode to 1 when a migration fails outside the CLI',
                ).toBe(1);

                // NOTHING PARTIALLY APPLIED: not one of the two tables exists after the refusal, so the schema
                // the rest of this suite reads is wholly the schema builder's.
                expect(pluginTablesAfterFirstAttempt).toEqual([]);
                expect(schemaProvenance).toBe('schema-builder');
            }
        });

        it(
            'reverts without taking a core row with it, and re-applies to an identical schema',
            async () => {
                // DATA-BEARING. One list row and two line rows on two distinct variants, alongside the seeded core
                // rows they reference. A schema-only cycle cannot detect collateral data loss, which is the whole
                // point of seeding before the revert rather than after it.
                const seeded = await seedPluginRows();
                expect(seeded.lineIds).toHaveLength(2);
                const afterFirstApply = await snapshotPluginSchema();

                if (!migrationApplies) {
                    // On an engine the checked-in migration was refused by, there is nothing recorded to revert.
                    // That is asserted rather than skipped: `revertLastMigration` finds an empty bookkeeping table,
                    // reports no failure, and leaves both tables and both seeded rows exactly where they were.
                    const revertWithNothingApplied = await revertLastMigrationGuarded();
                    expect(
                        revertWithNothingApplied.observedExitCode,
                        `reverting with nothing applied is not a failure. ${ENGINE_SCOPE_CITATION}`,
                    ).toBeUndefined();

                    expect((await existingPluginTables()).slice().sort()).toEqual(
                        PLUGIN_TABLES_CHILD_FIRST.slice().sort(),
                    );
                    expect(await countRows(LIST_TABLE)).toBe(1);
                    expect(await countRows(LINE_TABLE)).toBe(2);
                    expect(await snapshotPluginSchema()).toEqual(afterFirstApply);

                    // And the core baseline is intact, which is the same claim the reverting branch makes and is
                    // worth making here too: nothing this suite did to establish the schema touched a seeded row.
                    for (const coreTable of REFERENCED_CORE_TABLES) {
                        expect(
                            await selectAllRows(coreTable),
                            `every seeded row of "${coreTable}" must survive field for field`,
                        ).toEqual(baselineCoreRows[coreTable]);
                    }
                    return;
                }

                // ── DOWN ────────────────────────────────────────────────────────────────────────────────
                const revert = await revertLastMigrationGuarded();
                let secondApply: GuardedMigrationOutcome;
                try {
                    expect(
                        revert.observedExitCode,
                        'revertLastMigration signalled a failure through process.exitCode',
                    ).toBeUndefined();

                    // BOTH PLUGIN TABLES GONE. Asserted by asking the engine, not by catching an error from a read.
                    expect(
                        await existingPluginTables(),
                        'the down-path must drop both plugin tables',
                    ).toEqual([]);

                    // AND EVERY SEEDED CORE ROW SURVIVES, FIELD FOR FIELD. This is the assertion a destructive
                    // down-path fails and the one a schema-only cycle cannot make. The plugin rows are expected to
                    // be gone with their tables — a down-path that preserved them would be keeping rows whose table
                    // it dropped.
                    for (const coreTable of REFERENCED_CORE_TABLES) {
                        expect(
                            await selectAllRows(coreTable),
                            `the down-path took a row from "${coreTable}"`,
                        ).toEqual(baselineCoreRows[coreTable]);
                    }

                    // No core table was reshaped either, so the revert removed only what the up-path added.
                    for (const coreTable of REFERENCED_CORE_TABLES) {
                        expect(await readTableSnapshot(coreTable)).toEqual(
                            baselineCoreTableShapes[coreTable],
                        );
                    }
                } finally {
                    // ── UP, THE SECOND TIME ─────────────────────────────────────────────────────────────
                    // In a `finally` so that the schema is restored however the assertions above ended. Leaving a
                    // reverted schema behind would make every sibling case in this file fail for a reason that had
                    // nothing to do with it.
                    secondApply = await applyMigrationsGuarded();
                }

                expect(
                    secondApply.migrationsRan,
                    `the second apply must succeed rather than failing on an object it believes already exists`,
                ).toContain(MIGRATION_CLASS_NAME);
                expect(
                    secondApply.observedExitCode,
                    'the second apply signalled a failure through process.exitCode',
                ).toBeUndefined();

                // IDENTICAL, TABLE BY TABLE AND COLUMN BY COLUMN, against the snapshot taken after the first apply.
                // The comparison is a normalised deep-equality over ordered column descriptors together with the
                // unique, index and check names, so a catalogue that returns its objects in another order cannot
                // fail it while a column, a width, a nullability, a default or a named object that changed does.
                expect(await snapshotPluginSchema()).toEqual(afterFirstApply);

                // The plugin rows went with their tables, and are re-seeded before anything else reads them.
                expect(await countRows(LIST_TABLE)).toBe(0);
                expect(await countRows(LINE_TABLE)).toBe(0);
                const reseeded = await seedPluginRows();
                expect(await countRows(LIST_TABLE)).toBe(1);
                expect(await countRows(LINE_TABLE)).toBe(2);

                // And the re-created schema is writable and readable through the same repository the forbidden-write
                // cases use, which is what makes "identical" a claim about a working schema rather than about a
                // catalogue listing.
                const reloaded = await assertionDataSource
                    .getRepository(ReorderList)
                    .findOne({ where: { id: reseeded.listId } });
                expect(reloaded, 're-seeding after the second apply must be readable back').not.toBeNull();
                expect(reloaded?.name).toBe(SEEDED_DISPLAY_NAME);
                expect(Number(reloaded?.lineCount)).toBe(2);
            },
            MIGRATION_CYCLE_ABORT_AFTER_MS,
        );
    });
});
