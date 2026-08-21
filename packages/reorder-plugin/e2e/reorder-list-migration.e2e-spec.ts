/**
 * The **one additive migration** of `@vendure/reorder-plugin`, exercised end to end.
 *
 * `src/migrations/1786838400000-add-reorder-lists.ts` is the only migration this feature produces. This
 * suite owns its full lifecycle — the data-bearing cycle, the named objects and the engine-conditional
 * checks; `reorder-plugin-compatibility.e2e-spec.ts` additionally applies it once, to serve the published
 * operations against a schema the migration created rather than the schema builder. No functional suite
 * applies it, and that is a consequence of the harness rather than a division of convenience: **the
 * end-to-end schema is otherwise always built by the ORM's schema builder and never by a migration.**
 * `packages/testing/src/initializers/mysql-initializer.ts:L16` and
 * `packages/testing/src/initializers/postgres-initializer.ts:L15` both force `synchronize = true`, and
 * `e2e-common/test-config.ts:L110, L119, L128` set it per engine branch, while the sql.js initializer
 * enables it only while it populates. Every functional sibling suite therefore runs against a synchronised
 * schema and never touches the migration file. This suite constructs the migration path itself.
 *
 * **Every obligation in this file runs on every engine**, and the thing that differs between engines is the
 * artefact, not the coverage. The declaring halves read the CHECKED-IN file's own text, which is one
 * generation and therefore one dialect. The cycle and the catalogue and refusal halves EXECUTE a migration,
 * and the one they execute is chosen the way a deployment chooses it: the checked-in artefact where its
 * dialect matches the connection, and otherwise **the migration this engine's own lifecycle emits**, produced
 * through `generateMigration` from the same two entity classes. See {@link MIGRATION_UNDER_TEST_CITATION} for
 * why that is the honest shape of a four-engine obligation rather than a weakening of it, and
 * `describe('the migration this engine applies')` for the case that states which artefact ran and why.
 *
 * What they are not is concurrency evidence: these are sequential single writes rather than interleavings
 * (EPIC-001 section 11.6.3, whose ruling is that "the four-job list is the default for every sequential,
 * constraint-shape, migration and response-level claim"). **There is deliberately no barrier and no forced
 * interleaving anywhere in this file** — those belong to the create, add-item and mutate suites and run on
 * MariaDB, MySQL and PostgreSQL only.
 *
 * ## The schema under test is always the migration's own — read this before changing anything below
 *
 * **There is no schema-builder fallback in this file, on any engine.** The migration under test is always
 * the output of the platform migration generator, which serialises the statements the schema builder logged
 * into `queryRunner.query(<SQL>)` calls (`packages/core/src/migrate.ts:L127-L179`) — either the generation
 * that is checked in, or the generation this engine's own lifecycle produces at the top of the run. Every
 * executing assertion below reads a schema that `runMigrations` created from those statements, and the suite
 * fails rather than substituting anything if it did not. **Nothing here hand-writes DDL and nothing here may:
 * the lifecycle is the only sanctioned mechanism** (EPIC-001 section 7.8).
 *
 * **How the two connections hand the database over.** `runMigrations` builds its own data source
 * (`packages/core/src/migrate.ts:L42`), so the connection that applies a migration is never the connection
 * that reads the result. On the three server engines both address the same physical database and the apply is
 * observable immediately. On the SQLite family they do not: the in-process engine's "database" is a file, two
 * connections each hold their own copy of it in memory, and the harness's connection has auto-save disabled
 * once populating is finished — so an apply on one connection is invisible to the other unless the file itself
 * is the medium. This file therefore works against a **temporary copy of the seeded snapshot with auto-save
 * on**, and closes its own assertion connection around every migration entry-point call so the file is handed
 * over cleanly in both directions ({@link migrationTargetHandedOver}). Two consequences are deliberate: the
 * harness's cached snapshot under `e2e/__data__` is **never written to**, so a later run still starts from a
 * schema with no plugin table in it; and the copy is removed in `afterAll`.
 *
 * **Half one of each named-object claim reads the artefact's text, because the artefact IS the DDL.** An
 * emitted migration spells every column and its width, every named unique, index and check, every cascading
 * reference and the order of all of it, so the declaring half needs no database and runs wherever the file
 * does. That is also what makes the engine specificity visible rather than implicit: the statements are
 * PostgreSQL's, and asserting their PostgreSQL spellings is how the header's provenance claim is checked
 * instead of trusted.
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
 * MySQL family, and never skips the assertion. It also localises the gap precisely, and now measures the
 * localisation on each engine rather than inferring it: **the checked-in PostgreSQL emission carries both
 * named checks**, inline in its two `CREATE TABLE` statements, and the text assertions that read them run
 * wherever this file does — while the MySQL family's own emission, generated here at the top of the run,
 * carries neither, because a check never reaches the statement log there at all. Where the invariant is upheld
 * instead: the quantity bound by the service-level `UserInputError` on every write path, and the `lineCount`
 * floor by the service's conditional counter update together with its compare-and-set repair. Both are
 * portable and neither depends on a check constraint existing on any engine.
 *
 * Named `UNIQUE` constraints behave differently and better: the MySQL family turns each into a named unique
 * **index**, preserving both the exact name and the uniqueness guarantee. So the two `UQ_` names and the
 * `IDX_` name are asserted present under their exact names through the engine's own catalogue rather than
 * through one portable "constraint type" lookup, because the catalogue object class differs while the name
 * and the guarantee do not. A reader for each family is implemented — `pg_constraint` and `pg_indexes`,
 * `sqlite_master`, `information_schema.STATISTICS` and `information_schema.TABLE_CONSTRAINTS` — and **each
 * one runs on its own family**, against the schema that family's own migration built.
 *
 * ## Lifecycle and isolation (EPIC-001 section 11.6.1)
 *
 * One `TestServer`, created and initialised in `beforeAll` under `TEST_SETUP_TIMEOUT_MS`, with
 * `await server.destroy()` **attempted unconditionally** in `afterAll` — through `attemptEveryCleanup`, so
 * that a failure releasing the generated migration's directory or the snapshot copy cannot be what leaks a
 * listening port into the next file. Every query runner and every data
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
import os from 'os';
import path from 'path';
import {
    DataSource,
    DataSourceOptions,
    getMetadataArgsStorage,
    MigrationInterface,
    QueryRunner,
    Table,
    TableForeignKey,
} from 'typeorm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { initialData } from '../../../e2e-common/e2e-initial-data';
import { TEST_SETUP_TIMEOUT_MS, testConfig } from '../../../e2e-common/test-config';
import { ReorderList, ReorderListLine, ReorderPlugin, reorderPluginMigrations } from '../index';
import { AddReorderLists1786838400000 } from '../src/migrations/1786838400000-add-reorder-lists';

import {
    describeRowDifferences,
    NO_ROW_DIFFERENCE,
    redactTeardownDiagnostic,
} from './fixtures/diagnostic-redaction';
import {
    attemptEveryCleanup,
    committedMigrationApplies,
    extractGeneratedStatements,
    generateLifecycleMigration,
    LifecycleMigration,
} from './fixtures/migration-state';
import { resolveConfiguredEngine } from './fixtures/query-capture';

const MIGRATIONS_DIR = path.join(__dirname, '../src/migrations');

const MIGRATION_FILENAME = '1786838400000-add-reorder-lists.ts';

const MIGRATION_FILE_PATH = path.join(MIGRATIONS_DIR, MIGRATION_FILENAME);

/**
 * The compiled counterpart of {@link MIGRATION_FILE_PATH}, which is what an installed package offers.
 */
const BUILT_MIGRATION_GLOB_DIR = path.join(__dirname, '../lib/src/migrations');

/**
 * The dev-server configuration that registers this plugin and its migration.
 *
 * It is the one file outside this package the feature edits, and the only place the migration's registration
 * decision lives, so the decision is read out of it rather than restated here.
 */
const DEV_CONFIG_FILE_PATH = path.join(__dirname, '../../dev-server/dev-config.ts');

/**
 * The CHECKED-IN migration's class name, **derived from the imported class rather than restated as a
 * string**.
 *
 * A rename therefore breaks this file at compile time instead of silently weakening an assertion. This is the
 * name every assertion about the artefact's own TEXT uses; the name TypeORM records in its bookkeeping table
 * is {@link migrationUnderTestName}, which is this one on the engine the artefact was generated for and the
 * generated class's own name elsewhere.
 */
const SHIPPED_MIGRATION_CLASS_NAME = AddReorderLists1786838400000.name;

/**
 * The text of `dbConnectionOptions: { … }` as `packages/dev-server/dev-config.ts` declares it.
 *
 * Read as text rather than by importing the configuration, because the dev-server package cannot be imported
 * from here — it pulls in `@vendure/dashboard/plugin` and two other packages that need not be built in this
 * environment, so an import fails at module load for reasons that have nothing to do with migrations. What
 * the assertions want anyway is the DECLARATION rather than the resolved value: whether a key sits before or
 * after the engine spread is invisible once the object is evaluated, and it is precisely what decides which
 * of the two wins.
 *
 * @param devConfigSource - The whole file's text.
 * @returns The slice from `dbConnectionOptions: {` to the closing brace of that object.
 */
function dbConnectionOptionsBlockOf(devConfigSource: string): string {
    const optionsStart = devConfigSource.indexOf('dbConnectionOptions: {');
    expect(optionsStart, 'dev-config must declare dbConnectionOptions').toBeGreaterThan(-1);
    const optionsEnd = devConfigSource.indexOf('\n    },', optionsStart);
    expect(optionsEnd, 'the dbConnectionOptions object must be brace-balanced').toBeGreaterThan(optionsStart);
    return devConfigSource.slice(optionsStart, optionsEnd);
}

/**
 * Query-runner table-API calls that must appear **nowhere** in the migration's text.
 */
const TABLE_API_CALLS = ['createTable(', 'dropTable(', 'new Table(', 'new TableIndex('] as const;

/**
 * Spellings only PostgreSQL emits, which is how the generation engine is read off the file itself.
 *
 * `SERIAL`, `character varying` and `TIMESTAMP … DEFAULT now()` are PostgreSQL's; the MySQL family would have
 * emitted `int … AUTO_INCREMENT` and backticked identifiers, and the SQLite family
 * `integer PRIMARY KEY AUTOINCREMENT`. Asserting them makes the header's provenance claim checkable rather
 * than something the reader has to take on trust.
 */
const POSTGRES_EMISSION_MARKERS = ['SERIAL', 'character varying', 'DEFAULT now()'] as const;

/**
 * The schema the generation connection was configured with, which the emission bakes into one statement.
 *
 * `DataSourceOptions.schema` is configurable — the dev server exposes it as `DB_SCHEMA` — and TypeORM neither
 * rewrites raw migration SQL nor sets a `search_path` from it. The generator therefore writes the schema its
 * own connection used wherever a statement needs one, which for this delta is `down()`'s `DROP INDEX` alone,
 * PostgreSQL resolving an index by name rather than through its table. That is a property of the emitted form
 * rather than an editable choice, so it is asserted and bounded rather than forbidden: a deployment on
 * another schema regenerates the file against its own connection.
 */
const GENERATION_SCHEMA = 'public';

/** The SQL verbs that ADDRESS a table, as opposed to `REFERENCES`, which only names one. */
const ADDRESSING_VERBS = ['CREATE TABLE', 'ALTER TABLE', 'DROP TABLE'] as const;

const LIST_TABLE = 'reorder_list';

/** The child table, addressed **before** {@link LIST_TABLE} in every cleanup. */
const LINE_TABLE = 'reorder_list_line';

/** Both plugin tables, child first, which is the only order a cleanup may use. */
const PLUGIN_TABLES_CHILD_FIRST = [LINE_TABLE, LIST_TABLE] as const;

/** Both plugin tables, parent first, which is the order the migration must create them in. */
const PLUGIN_TABLES_PARENT_FIRST = [LIST_TABLE, LINE_TABLE] as const;

/**
 * Every column `reorder_list` carries and nothing else, sorted.
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
 * The declared width of both bounded name columns, `name` and `nameKey`.
 *
 * A MySQL and MariaDB key-size ceiling rather than a product choice: 191 four-byte UTF-8 characters keep the
 * composite unique index inside the engine's key-size limit. `nameKey` is the column that participates in
 * that index; `name` is in no index at all and is held at the same width because it stores the same value
 * before canonicalisation. The same number is the plugin's fixed name-length bound, which is why there is
 * deliberately no option to configure either.
 */
const BOUNDED_NAME_COLUMN_LENGTH = '191';

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

// The five named database objects — exact names, load-bearing
//
// The names are load-bearing rather than cosmetic: the service translates a violation of
// `UQ_reorder_list_customer_channel_name_key` into `ReorderListNameConflictError` by matching on that one
// name, so a rename silently turns a domain outcome into an internal error.

const UQ_LIST_OWNER_NAME_KEY = 'UQ_reorder_list_customer_channel_name_key';

/** Non-unique index over `(customerId, channelId)` on `reorder_list`, serving the ownership predicate. */
const IDX_LIST_OWNER = 'IDX_reorder_list_customer_channel';

const UQ_LINE_LIST_VARIANT = 'UQ_reorder_list_line_list_variant';

const CHK_LINE_QUANTITY_POSITIVE = 'CHK_reorder_list_line_quantity_positive';

const CHK_LIST_LINE_COUNT_NON_NEGATIVE = 'CHK_reorder_list_line_count_non_negative';

/**
 * The frozen names of the two cascading references whose referent is not implied by their own column.
 *
 * TypeORM derives a foreign-key name by hashing the table and column it is declared on, so the name is
 * deterministic rather than arbitrary and identical in every engine's emission — which is exactly why it is
 * worth pinning: a rename of either column silently produces a different name, and a migration whose `down()`
 * drops a constraint by a name the `up()` no longer creates fails only when someone reverts. These two are
 * pinned rather than all four because they are the two the down-path names explicitly.
 */
const FK_LIST_CUSTOMER = 'FK_0c7c5c80bfaa5a02595fd089bb8';

const FK_LINE_LIST = 'FK_19a7479a99a7bd9f3e3b6ecd97c';

/** One named cascading reference of a catalogue reading, failing the case when it is absent. */
function referenceOf(table: Table, name: string): TableForeignKey {
    const reference = table.foreignKeys.find(candidate => candidate.name === name);
    expect(reference, `"${bareTableName(table.name)}" carries no reference named "${name}"`).toBeDefined();
    return reference as TableForeignKey;
}

/** How a named object materialises in an engine catalogue, which decides which catalogue view is read. */
type NamedObjectKind = 'unique' | 'index' | 'check';

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

const ALL_NAMED_OBJECTS: readonly NamedObject[] = [...PORTABLE_NAMED_OBJECTS, ...CHECK_NAMED_OBJECTS];

/**
 * The number of named objects the feature contract authorises across both plugin tables, asserted as a
 * number rather than left implicit in the length of the array above.
 *
 * **The count is itself a contract term, not a summary of one.** The feature's definition of done requires
 * "exactly five, and the count is asserted so an addition is visible rather than absorbed"
 * [tickets/EPIC-001/FEATURE-001-01-named-reorder-lists.md:§5], and the reason is the failure mode this file
 * once had: every named-object claim below was a *presence* check, so an object nobody authorised satisfied
 * every assertion in the suite while being invisible to all of them. A sixth index really was declared on
 * the entities and frozen into the migration, and nothing here failed. So the assertions that follow are
 * EXACT-SET rather than presence: they compare a whole inventory against this list and report an addition as
 * loudly as an omission. Asserting this literal as well means a future editor who adds a row to
 * {@link ALL_NAMED_OBJECTS} to make an addition "pass" has to change this number too, which is the point at
 * which the contract has to be reopened rather than the test relaxed.
 */
const AUTHORIZED_NAMED_OBJECT_COUNT = 5;

/**
 * Every named object the contract authorises on one plugin table, sorted, whatever class an engine files it
 * under.
 *
 * Derived from {@link ALL_NAMED_OBJECTS} rather than restated per table, so the allow-list has exactly one
 * source: a second literal would be a second thing to keep in step, which is how the extra index survived.
 */
function authorizedNamedObjectsOn(table: string): string[] {
    return ALL_NAMED_OBJECTS.filter(namedObject => namedObject.table === table)
        .map(namedObject => namedObject.name)
        .sort();
}

/**
 * Every named object the contract authorises on one plugin table that the given engine can actually
 * MATERIALISE, sorted.
 *
 * The difference from {@link authorizedNamedObjectsOn} is conflict C-E and nothing else: TypeORM 0.3.28
 * cannot create a named check constraint on the MySQL family, so a catalogue there holds the two `UQ_`
 * objects and the `IDX_` object and cannot hold either `CHK_`. Expressing that as a filter over the same
 * allow-list — rather than as a second list, or as a skipped assertion — is what keeps the MySQL-family
 * expectation exact instead of merely weaker: three names on those engines, five on PostgreSQL and the
 * SQLite family, and no extras on any of them.
 */
function materialisedNamedObjectsOn(table: string, engine: string): string[] {
    return ALL_NAMED_OBJECTS.filter(
        namedObject =>
            namedObject.table === table &&
            (namedObject.kind !== 'check' || emitsNamedCheckConstraints(engine)),
    )
        .map(namedObject => namedObject.name)
        .sort();
}

/**
 * Every distinct `UQ_`, `IDX_` and `CHK_` token in a piece of the migration's own source, sorted.
 *
 * This is the file-text half of the exact-set proof, and it catches what the recorded `Table` descriptions
 * cannot: a named object spelled in a branch this engine's run never takes. `FK_` names are deliberately
 * outside the pattern — the four cascading references are asserted by name and direction elsewhere, and they
 * are not part of the five-object count the contract fixes.
 */
function namedObjectTokensIn(source: string): string[] {
    return [...new Set(source.match(/\b(?:UQ|IDX|CHK)_[A-Za-z0-9_]+/g) ?? [])].sort();
}

/**
 * The two withdrawn replay-claim columns and the withdrawn paired check constraint (conflict C-A), plus the
 * unpublished seats counter that belongs to FEATURE-001-06's own later migration.
 */
const WITHDRAWN_COLUMNS = ['lastAddIdempotencyKey', 'lastAddRequestFingerprint', 'activeGrantCount'] as const;

/** The withdrawn paired check constraint, named here because its absence has to be searched for by name. */
const WITHDRAWN_CHECK_CONSTRAINT = 'CHK_reorder_list_line_add_claim_paired';

/**
 * The full statement of conflict C-E, carried into every assertion message that depends on it.
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
 * What the migration is and which engine it applies to, carried into the messages that depend on it.
 *
 * A constant rather than a comment so that the reasoning reaches the **test output** when one of those
 * assertions fails: a reader looking at a failure needs to know the engine scope is documented rather than
 * accidental, or they will file the scope itself as the defect.
 */
const GENERATED_FORM_CITATION =
    'The shipped migration is the output of the platform migration generator, run plugin-locally as ' +
    "generateMigration(devConfig, { name: 'add-reorder-lists', outputDir: '../reorder-plugin/src/migrations' }) " +
    'against PostgreSQL (DB=postgres), the designated generation engine because it is the only server ' +
    'engine of the four on which TypeORM 0.3.28 emits both CHK_ objects. generateMigration serialises the ' +
    'statements the schema builder logged into queryRunner.query(<SQL>) calls ' +
    '(packages/core/src/migrate.ts:L127-L179), so the artefact is PostgreSQL DDL and is bound to that ' +
    'engine. Plan section 0.2.3.1 records that engine specificity as a known limitation of the form ' +
    'section 0.5.2.2 prescribes.';

/**
 * Which artefact this run executes, and why that is the whole four-engine obligation rather than part of it.
 *
 * Carried into the messages of every executing assertion, so a reader looking at a failure knows which file's
 * statements produced the schema being complained about — the two answers are spelled differently and fail
 * differently, and guessing between them is the one thing a failure here must not require.
 *
 * The reasoning: one generation carries the DDL of exactly one engine, so the checked-in artefact applies on
 * the engine it was generated for and nowhere else ({@link GENERATED_FORM_CITATION}). Skipping the executing
 * evidence elsewhere would leave plan section 0.7.5's four-engine cycle claim unmeasured on three engines.
 * Hand-adding dialect branches to the artefact is forbidden outright (EPIC-001 section 7.8: the lifecycle is
 * the only sanctioned mechanism). What remains is what a DEPLOYMENT on another engine does — generate its own
 * file from the same two entity classes through the same `generateMigration` entry point, and run that. So
 * this suite does exactly that, at the top of the run, against the same core-only schema the assertions then
 * read. What differs by engine is therefore the serialisation under test and never the coverage.
 */
const MIGRATION_UNDER_TEST_CITATION =
    'The migration under test is chosen the way a deployment chooses it: the CHECKED-IN artefact where its ' +
    "dialect matches this connection, and otherwise the migration THIS ENGINE'S OWN LIFECYCLE emits, " +
    'generated at the top of this run by generateMigration from the same two entity classes and applied ' +
    'through the same runMigrations entry point. Nothing here hand-writes DDL. See the provenance case in ' +
    "describe('the migration this engine applies') for which of the two ran.";

const activeConfiguredEngine = String((testConfig().dbConnectionOptions as unknown as { type: string }).type);

/**
 * Whether this run executes the CHECKED-IN artefact, as opposed to the one this engine's lifecycle emits.
 *
 * Read through the predicate five sibling suites share, so the dialect question has exactly one authority in
 * the package rather than a second spelling here. It no longer gates anything — every executing describe runs
 * on every engine — and is asserted against the observed provenance instead.
 */
const appliesShippedMigration = committedMigrationApplies(activeConfiguredEngine);

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
 * The executable text of a TypeScript source, with every comment removed.
 */
function executableTextOf(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

function countOccurrences(haystack: string, needle: string): number {
    return haystack.split(needle).length - 1;
}

/**
 * Every quoted identifier inside the first parenthesised group after a marker, in declaration order.
 *
 * Both spellings the generator uses are covered: an inline `CONSTRAINT "<name>" UNIQUE ("a", "b")` and a
 * standalone `CREATE INDEX "<name>" ON "<table>" ("a", "b")`.
 */
function columnsSpannedBy(statement: string, marker: string): string[] {
    const after = statement.slice(statement.indexOf(marker) + marker.length);
    const parenthesised = /\(([^)]*)\)/.exec(after);
    if (parenthesised === null) {
        return [];
    }
    const quoted = /"([^"]+)"/g;
    const columns: string[] = [];
    let match = quoted.exec(parenthesised[1]);
    while (match !== null) {
        columns.push(match[1]);
        match = quoted.exec(parenthesised[1]);
    }
    return columns;
}

/**
 * The SQL statements one direction of the migration issues, in the order the generator serialised them.
 *
 * @param source - The migration file's text.
 * @param direction - `up` or `down`.
 */
function emittedStatements(source: string, direction: 'up' | 'down'): string[] {
    const opener = `public async ${direction}(queryRunner: QueryRunner): Promise<any> {`;
    const start = source.indexOf(opener);
    expect(
        start,
        `the migration declares no ${direction}() in the shape the generator emits. ` +
            GENERATED_FORM_CITATION,
    ).toBeGreaterThan(-1);
    const rest = source.slice(start + opener.length);
    const end = rest.indexOf('\n    }');
    const body = end === -1 ? rest : rest.slice(0, end);
    const literal = /`([^`]*)`/g;
    const statements: string[] = [];
    let match = literal.exec(body);
    while (match !== null) {
        statements.push(match[1]);
        match = literal.exec(body);
    }
    return statements;
}

/**
 * The tables one verb addresses, in the order the statements were serialised, **whatever quotes them**.
 *
 * The quoting has to be part of the pattern rather than assumed, because this reads two different emissions.
 * PostgreSQL and the SQLite family quote an identifier with `"`; the MySQL family quotes it with a backtick,
 * and a pattern that only knew about `"` would silently match nothing there and report an empty list — which
 * reads as "the migration creates no table" rather than as "this helper cannot read this dialect".
 *
 * @param statements - The serialised statements, in order.
 * @param verb - The addressing verb, e.g. `CREATE TABLE`.
 */
function tablesInOrder(statements: readonly string[], verb: string): string[] {
    const names: string[] = [];
    for (const statement of statements) {
        const match = new RegExp(`${verb} (?:IF (?:NOT )?EXISTS )?(?:"([^"]+)"|\`([^\`]+)\`)`).exec(
            statement,
        );
        if (match !== null) {
            names.push(match[1] ?? match[2]);
        }
    }
    return names;
}

function statementDeclaring(source: string, name: string): string | undefined {
    const matches = emittedStatements(source, 'up').filter(statement => statement.indexOf(name) !== -1);
    expect(matches.length, `${name} must be declared by exactly one emitted statement`).toBe(1);
    return matches[0];
}

function statementCreating(source: string, table: string): string | undefined {
    const matches = emittedStatements(source, 'up').filter(
        statement => statement.indexOf(`CREATE TABLE "${table}"`) !== -1,
    );
    expect(matches.length, `"${table}" must be created by exactly one emitted statement`).toBe(1);
    return matches[0];
}

type NormalisedRow = Record<string, unknown>;

/**
 * Reduces one cell to a form two reads of the same engine compare equal on.
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

/**
 * The five plugin options, at their declared defaults.
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
    indexNames: string[];
    /** Names filed as check constraints. Empty on the MySQL family, which is conflict C-E. */
    checkNames: string[];
    /** The catalogue view or views actually read, quoted in assertion messages so a failure names its source. */
    source: string;
}

/**
 * One plugin table's whole named-object inventory as the engine's own catalogue holds it, reduced to the
 * objects this feature is answerable for.
 *
 * **This exists because a whole-schema reading cannot answer "and nothing else".** {@link EngineCatalogue}
 * gathers every name in the database, which is the right instrument for asking whether a withdrawn object is
 * absent anywhere, and the wrong one for asking whether a table carries exactly the objects the contract
 * authorises: the seeded core schema contributes hundreds of names, and MariaDB adds implicit check
 * constraints of its own for JSON columns, so an exact comparison at that scope is impossible. Scoping to one
 * table is what makes the comparison exact.
 *
 * Two classes of name are then removed, and each removal is a claim asserted elsewhere rather than a
 * convenience:
 *
 *  * **The row identifier.** Every engine files an object for it — `PRIMARY` on the MySQL family, a
 *    `PK_`-prefixed constraint and its backing index on PostgreSQL — and the identifier itself is asserted as
 *    an inherited primary-key COLUMN by the column-shape cases. It is not one of the five.
 *  * **The four cascading references.** They are asserted by name, direction and referential action by their
 *    own case. Removing them here is also REQUIRED rather than tidy: the MySQL family creates an index for a
 *    foreign key of its own accord when no declared index already leads with that column, and names it after
 *    the constraint — so once the unauthorised channel-only and variant-only indices were withdrawn, two
 *    such indices appear under the two `FK_` names. Counting them would report a contract breach that is
 *    really the engine doing its own bookkeeping.
 *
 * SQLite's internal `sqlite_autoindex_*` entries are removed for the same reason: they are the storage for
 * the named `UNIQUE` constraint, which is counted under its own name.
 */
interface TableCatalogueReading {
    /** The plugin table this reading is scoped to. */
    table: string;
    /** Every named object the engine files for this table, minus the identifier and reference artefacts. */
    names: string[];
    /** The identifier artefacts removed, reported so a failure can show what was discounted and why. */
    identifierArtefacts: string[];
    /** The reference artefacts removed, likewise reported. */
    referenceArtefacts: string[];
    /** The catalogue view or views actually read, quoted in assertion messages so a failure names its source. */
    source: string;
}

/**
 * The harness configuration, built at the **top level of this spec file** and deliberately **without
 * `ReorderPlugin` registered**.
 *
 * The plugin is **absent** so that the initializer synchronises the **core schema only** and seeds it. Were
 * the plugin registered, `synchronize: true` would create `reorder_list` and `reorder_list_line` during
 * population and the migration would then have nothing to create — its first statement would fail on an
 * object that already exists, and the up-path assertion would be meaningless. This is the whole reason the
 * suite is arranged the way it is.
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

    /** The migration file's text, read once. Every file-level assertion reads this and never the disk again. */
    let migrationSource: string;

    /** The plugin tables that existed before any apply. Expected empty — the precondition the up-path needs. */
    let pluginTablesBeforeAnyApply: string[];

    let pluginTablesAfterFirstAttempt: string[];

    let firstApply: GuardedMigrationOutcome;

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

    let seededChannelId: number;

    /** The identifiers of the seeded catalogue variants. At least two, so a per-list-and-variant pair can differ. */
    let seededVariantIds: number[];

    /** The configuration the migration lifecycle is driven with. Built in `beforeAll`, never at module load. */
    let migrationConfig: Required<VendureConfig>;

    /**
     * The migration class this run applies — the checked-in artefact, or this engine's own emission.
     *
     * See {@link MIGRATION_UNDER_TEST_CITATION}. Held as a class rather than as a glob for the reason
     * `beforeAll` states, and named by {@link migrationUnderTestName} wherever an assertion needs the string
     * TypeORM records in its bookkeeping table.
     */
    let migrationUnderTest: new () => MigrationInterface;

    /** The name TypeORM records as applied, which is {@link migrationUnderTest}'s own class name. */
    let migrationUnderTestName: string;

    /** Which of the two artefacts {@link migrationUnderTest} is, observed rather than assumed. */
    let migrationProvenance: 'committed-migration' | 'lifecycle-generated';

    /**
     * The generated migration, on the engines that need one — its class, its text and its temporary directory.
     *
     * `undefined` where the checked-in artefact applied, which is the same fact
     * {@link migrationProvenance} carries and is why the provenance case asserts the two agree.
     */
    let generatedMigration: LifecycleMigration | undefined;

    /** The data source this file owns. Every shape read, raw read and direct write below goes through it. */
    let assertionDataSource: DataSource;

    /**
     * The temporary directory holding the SQLite-family snapshot copy, or `undefined` on a server engine.
     *
     * Removed in `afterAll`. Its existence is what keeps the harness's cached snapshot under `e2e/__data__`
     * unwritten — see the file header.
     */
    let migrationTargetDirectory: string | undefined;

    /** Portable identifier quoting for the raw reads, taken from {@link assertionDataSource}'s own driver. */
    let esc: (name: string) => string;

    /** The ambient `process.exitCode`, saved once and restored after every case. */
    let ambientExitCode: number | string | undefined;

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

    /**
     * Reads ONE plugin table's named-object inventory out of the engine's own catalogue, scoped to that table
     * and reduced to the objects this feature is answerable for. See {@link TableCatalogueReading} for why the
     * scope and the two exclusions are what they are.
     *
     * The three catalogues are read the same way {@link readEngineCatalogue} reads them, and for the same
     * reason: the object CLASS differs between engines while the name and the guarantee do not, so a single
     * portable "constraint type" lookup would report a `UQ_` as missing on the MySQL family while it was
     * enforcing exactly the same rule. What differs here is only the scope — every query carries the table
     * name — and the reference names, which are read from the same catalogue rather than assumed, so an engine
     * that files a foreign-key index under a name of its own choosing is still discounted correctly.
     *
     * The table name is compared in TypeScript rather than bound as a parameter, because the three engines
     * spell a placeholder three ways and this file writes no engine-specific SQL beyond the catalogue views
     * themselves.
     */
    async function readTableCatalogue(table: string): Promise<TableCatalogueReading> {
        const distinct = (names: Array<string | null | undefined>): string[] => [
            ...new Set(names.filter((name): name is string => typeof name === 'string' && name.length > 0)),
        ];
        const reduce = (
            gathered: string[],
            identifierArtefacts: string[],
            referenceArtefacts: string[],
            source: string,
        ): TableCatalogueReading => {
            const discounted = new Set([...identifierArtefacts, ...referenceArtefacts]);
            return {
                table,
                names: distinct(gathered)
                    .filter(name => !discounted.has(name))
                    .sort(),
                identifierArtefacts: distinct(identifierArtefacts).sort(),
                referenceArtefacts: distinct(referenceArtefacts).sort(),
                source,
            };
        };

        if (isSqliteFamily(activeEngine)) {
            const rows: Array<{ type: string; name: string; tableName: string; sql: string | null }> =
                await assertionDataSource.query(
                    `SELECT type, name, tbl_name AS tableName, sql FROM sqlite_master`,
                );
            const forThisTable = rows.filter(row => row.tableName === table);
            const tableDdl = forThisTable
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
            const indexNames = forThisTable.filter(row => row.type === 'index').map(row => row.name);
            return reduce(
                [...namedClauses('UNIQUE'), ...indexNames, ...namedClauses('CHECK')],
                // The identifier is a rowid alias here, so the engine files nothing for it; the internal
                // entries below are the UNIQUE constraint's own storage rather than the identifier's.
                indexNames.filter(name => name.startsWith('sqlite_autoindex_')),
                namedClauses('FOREIGN\\s+KEY'),
                `sqlite_master scoped to "${table}" (table DDL text for named CONSTRAINT clauses, index rows for indices)`,
            );
        }

        if (isMysqlFamily(activeEngine)) {
            const statistics: Array<{ tableName: string; name: string; nonUnique: number | string }> =
                await assertionDataSource.query(
                    `SELECT TABLE_NAME AS tableName, INDEX_NAME AS name, NON_UNIQUE AS nonUnique
                       FROM information_schema.STATISTICS
                      WHERE TABLE_SCHEMA = DATABASE()`,
                );
            // TABLE_CONSTRAINTS rather than CHECK_CONSTRAINTS, because MySQL 8 does not carry a table name on
            // the latter while MariaDB does; the former is scoped by table on both and reports every class.
            const tableConstraints: Array<{ tableName: string; name: string; kind: string }> =
                await assertionDataSource.query(
                    `SELECT TABLE_NAME AS tableName, CONSTRAINT_NAME AS name, CONSTRAINT_TYPE AS kind
                       FROM information_schema.TABLE_CONSTRAINTS
                      WHERE CONSTRAINT_SCHEMA = DATABASE()`,
                );
            const mysqlIndexRows = statistics.filter(row => row.tableName === table);
            const mysqlConstraintRows = tableConstraints.filter(row => row.tableName === table);
            const named = (kind: string): string[] =>
                mysqlConstraintRows.filter(row => row.kind.toUpperCase() === kind).map(row => row.name);
            return reduce(
                [...mysqlIndexRows.map(row => row.name), ...named('UNIQUE'), ...named('CHECK')],
                mysqlIndexRows.map(row => row.name).filter(name => name === 'PRIMARY'),
                named('FOREIGN KEY'),
                `information_schema.STATISTICS and information_schema.TABLE_CONSTRAINTS, both scoped to "${table}" in DATABASE()`,
            );
        }

        const constraints: Array<{ tableName: string; name: string; kind: string }> =
            await assertionDataSource.query(
                `SELECT rel.relname AS "tableName", c.conname AS "name", c.contype AS "kind"
                   FROM pg_constraint c
                   JOIN pg_class rel ON rel.oid = c.conrelid
                   JOIN pg_namespace n ON n.oid = c.connamespace
                  WHERE n.nspname = current_schema()`,
            );
        const indexes: Array<{ tableName: string; name: string }> = await assertionDataSource.query(
            `SELECT tablename AS "tableName", indexname AS "name" FROM pg_indexes
              WHERE schemaname = current_schema()`,
        );
        const constraintRows = constraints.filter(row => row.tableName === table);
        const indexRows = indexes.filter(row => row.tableName === table);
        const ofKind = (kind: string): string[] =>
            constraintRows.filter(row => row.kind === kind).map(row => row.name);
        // A unique constraint and its backing index share one name here, which the set collapses; the
        // identifier's constraint and its index likewise, which is why both are discounted by name.
        const identifierNames = ofKind('p');
        return reduce(
            [...ofKind('u'), ...indexRows.map(row => row.name), ...ofKind('c')],
            [
                ...identifierNames,
                ...indexRows.map(row => row.name).filter(name => identifierNames.includes(name)),
            ],
            ofKind('f'),
            `pg_constraint and pg_indexes scoped to "${table}" in current_schema()`,
        );
    }

    /** Both plugin tables reduced to normalised snapshots, parent first, for the up/down/up comparison. */
    async function snapshotPluginSchema(): Promise<TableSnapshot[]> {
        const snapshots: TableSnapshot[] = [];
        for (const table of PLUGIN_TABLES_PARENT_FIRST) {
            snapshots.push(describeTable(await readTable(table)));
        }
        return snapshots;
    }

    /**
     * Inserts one list row **directly through the repository** and returns the identifier the engine assigned.
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
     * The harness's wholesale `clearAllTables` is deliberately not used, here or anywhere: it runs
     * `connection.synchronize(true)` (`packages/testing/src/data-population/clear-all-tables.ts:L18`), which
     * would drop and recreate the very schema this suite exists to assert.
     */
    async function deleteAllPluginRows(): Promise<void> {
        if (assertionDataSource === undefined || !assertionDataSource.isInitialized) {
            return;
        }
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
     * A refusal is *expected* on this path: the write is issued straight through the repository, so there is
     * no service layer between the engine and the caller to translate anything. Where a refusal must reach an
     * API caller carrying no driver text, no statement fragment and no constraint name, that is a
     * service-level claim and the create, add-item and mutate suites own it.
     *
     * ★ WHAT IS RETURNED IS A DESCRIPTION, NOT THE DRIVER'S OWN WORDS. An earlier revision returned
     * `e.message` and three assertions below interpolated it, so a write the database refused for a reason
     * nobody expected published whatever the driver said — on MySQL that is `Duplicate entry '<the value>'
     * for key '<the name>'`, and on PostgreSQL a `Key (column)=(value)` detail. The refusal is a BOOLEAN, and
     * that is what every assertion here reads; the description exists only to say why an ACCEPTED write was
     * refused instead, and the shared redactor's classification answers that without reproducing anything.
     * See `e2e/fixtures/diagnostic-redaction.ts`.
     */
    async function attemptWrite(
        work: () => Promise<unknown>,
    ): Promise<{ refused: boolean; diagnostic: string }> {
        try {
            await work();
            return { refused: false, diagnostic: '' };
        } catch (e) {
            return { refused: true, diagnostic: redactTeardownDiagnostic(e) };
        }
    }

    /**
     * The configuration this file drives the migration lifecycle with, pointed at the migration target.
     *
     * The plugin is always registered, because everything asked of this configuration is a question about its
     * two entity declarations. Only `migrations` varies: the generator must not be handed the migration it is
     * being asked to decide the need for, and the apply must be handed exactly one.
     *
     * **The migration is a CLASS rather than a glob, and the reason is environmental rather than stylistic.**
     * TypeORM resolves a directory glob with `PlatformTools.load`, which is Node's own `require`; under this
     * runner TypeORM is an externalised CommonJS dependency, so its `require` has no TypeScript loader
     * registered and a `*.ts` glob resolves to nothing. The shipped command-line suite gets away with one only
     * because it registers `ts-node` first (`packages/cli/src/shared/load-vendure-config-file.ts`), which this
     * file must not do — it is a process-wide require hook every sibling suite in the worker would inherit.
     * The class reference is also the stronger evidence: where it is the checked-in artefact it is imported
     * from the very path under test, so what applied is provably that file's export, and where it is a
     * generated one it is the class loaded out of the file the generator just wrote. A glob could match a
     * second file or none. The glob's own contract is asserted separately, against the directory listing.
     *
     * @param targetConnectionOptions - The migration target's connection options, resolved in `beforeAll`.
     * @param migrations - The migration classes to register, which is none or exactly one.
     */
    function migrationTargetConfig(
        targetConnectionOptions: Record<string, unknown>,
        migrations: Array<new () => MigrationInterface>,
    ): Required<VendureConfig> {
        return {
            ...serverConfig,
            plugins: [ReorderPlugin.init(DECLARED_OPTIONS)],
            dbConnectionOptions: {
                ...targetConnectionOptions,
                synchronize: false,
                migrations,
            } as unknown as DataSourceOptions,
        };
    }

    /**
     * Opens the data source this file reads and writes the migration target through.
     *
     * `preBootstrapConfig` must run immediately before the data source is built. It resolves the plugin's
     * entities into `dbConnectionOptions.entities` and applies the configured `EntityIdStrategy` to their
     * `@EntityId()` columns (`packages/core/src/bootstrap.ts:L294-L314`). It also re-establishes the
     * platform's module-level configuration, which every migration entry point resets in its own `finally`
     * (`packages/core/src/migrate.ts:L63`) — and that matters here for one specific reason:
     * `ReorderList.nameKey` carries an engine-resolved collation read through `getConfig()` when column
     * metadata is built, so a data source created while the configuration sat at its default would ask for a
     * MySQL collation on every engine.
     */
    async function openAssertionDataSource(): Promise<void> {
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
    }

    /**
     * Hands the migration target over to a migration entry point and takes it back afterwards.
     *
     * **Required on the SQLite family and harmless everywhere else, so it is applied everywhere.** An
     * in-process SQLite database is a FILE that each connection loads its own copy of, so two connections
     * only ever agree through the file: this file's own connection has to be closed — flushing whatever it
     * wrote — before the entry point's connection loads it, and reopened afterwards so it loads what the entry
     * point wrote. On the three server engines both connections address the same physical database and no
     * arrangement is needed, but closing is still worth doing there: a pooled connection held open across a
     * revert is enough to make the `DROP TABLE` block rather than fail, which is a hang instead of a
     * diagnostic.
     *
     * @param work - The entry-point call. Runs with this file's connection closed.
     */
    async function migrationTargetHandedOver<T>(work: () => Promise<T>): Promise<T> {
        const wasOpen = assertionDataSource !== undefined && assertionDataSource.isInitialized;
        if (wasOpen) {
            await assertionDataSource.destroy();
        }
        try {
            return await work();
        } finally {
            if (wasOpen) {
                await openAssertionDataSource();
            }
        }
    }

    /** Applies pending migrations, reading the exit code the platform leaves behind and then restoring it. */
    async function applyMigrationsGuarded(): Promise<GuardedMigrationOutcome> {
        const saved = process.exitCode;
        process.exitCode = undefined;
        let migrationsRan: string[] = [];
        let observedExitCode: number | string | undefined;
        try {
            migrationsRan = await migrationTargetHandedOver(() => runMigrations(migrationConfig));
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
            await migrationTargetHandedOver(() => revertLastMigration(migrationConfig));
        } finally {
            observedExitCode = process.exitCode;
            process.exitCode = saved;
        }
        return { migrationsRan: [], observedExitCode };
    }

    beforeAll(async () => {
        ambientExitCode = process.exitCode;

        // The migration's own text, read once. Every file-level assertion reads this string.
        migrationSource = await fs.readFile(MIGRATION_FILE_PATH, 'utf-8');

        await server.init({
            initialData,
            customerCount: SEEDED_CUSTOMER_COUNT,
            productsCsvPath: path.join(__dirname, '../../core/e2e/fixtures/e2e-products-minimal.csv'),
        });

        const rawConnection = server.app.get(TransactionalConnection).rawConnection;
        activeEngine = rawConnection.options.type;

        // STEP ONE — THE MIGRATION TARGET, which is the database every executing assertion below reads.
        //
        // On the three server engines it is the suite's own database, addressed exactly as the harness left
        // it: a migration connection and this file's connection reach the same physical database, so there is
        // nothing to arrange.
        //
        // On the SQLite family it CANNOT be. The engine's "database" is a file that each connection loads its
        // own copy of, and the initializer disables auto-save once populating is finished
        // (`packages/testing/src/initializers/sqljs-initializer.ts`), so a migration applied on the entry
        // point's own connection would be discarded when that connection closed and this file would observe
        // nothing. Turning auto-save on for the harness's own `location` is worse than useless: it would write
        // the plugin tables into the CACHED SNAPSHOT under `e2e/__data__`, and the next run of this file would
        // load a schema that already carried them — failing the up-path precondition below for a reason
        // nothing in the file explains. So the seeded snapshot is COPIED to a temporary file, auto-save is
        // enabled on the copy, and the copy is what both connections address and what `afterAll` removes.
        const harnessConnectionOptions = serverConfig.dbConnectionOptions as unknown as Record<
            string,
            unknown
        >;
        let targetConnectionOptions: Record<string, unknown> = {
            ...harnessConnectionOptions,
            logging: false,
        };
        if (isSqliteFamily(activeEngine)) {
            migrationTargetDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'reorder-migration-target-'));
            const snapshotCopy = path.join(migrationTargetDirectory, 'migration-target.sqlite');
            await fs.copy(String(harnessConnectionOptions.location), snapshotCopy);
            targetConnectionOptions = {
                ...targetConnectionOptions,
                location: snapshotCopy,
                autoSave: true,
            };
        }

        // STEP TWO — THE PRECONDITION AND THE KNOWN-GOOD BASELINE, both read off the TARGET rather than off
        // the server, so that on the SQLite family they describe the copy the cycle will actually run against
        // rather than the snapshot it was taken from.
        const baselineConfig = migrationTargetConfig(targetConnectionOptions, []);
        const baselineResolved = await preBootstrapConfig(baselineConfig);
        const baselineDataSource = new DataSource({
            ...baselineResolved.dbConnectionOptions,
            synchronize: false,
            migrationsRun: false,
            dropSchema: false,
            subscribers: [],
            logging: false,
        } as DataSourceOptions);
        await baselineDataSource.initialize();
        try {
            const escapeOnTarget = (name: string): string => baselineDataSource.driver.escape(name);
            const queryRunner = baselineDataSource.createQueryRunner();
            try {
                // THE PRECONDITION THE UP-PATH NEEDS, observed rather than assumed. The harness configuration
                // registers no plugin, so the initializer synchronised the core schema alone and neither
                // plugin table can exist yet. If one did, the apply below would fail on an object that already
                // exists — and the generator would find nothing to emit — so every assertion after it would be
                // measuring the wrong thing.
                pluginTablesBeforeAnyApply = [];
                for (const table of PLUGIN_TABLES_CHILD_FIRST) {
                    if (await queryRunner.hasTable(table)) {
                        pluginTablesBeforeAnyApply.push(table);
                    }
                }

                // THE KNOWN-GOOD BASELINE. Whole rows, not counts: the revert assertion is that every seeded
                // core row survives field for field, and a count survives a down-path that corrupted a column.
                for (const table of REFERENCED_CORE_TABLES) {
                    baselineCoreRows[table] = normaliseRows(
                        await queryRunner.query(
                            `SELECT * FROM ${escapeOnTarget(table)} ORDER BY ${escapeOnTarget('id')} ASC`,
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
        } finally {
            await baselineDataSource.destroy();
        }

        seededCustomerIds = baselineCoreRows.customer.map(row => Number(row.id));
        seededChannelId = Number(baselineCoreRows.channel[0].id);
        seededVariantIds = baselineCoreRows.product_variant.map(row => Number(row.id));

        // STEP THREE — THE MIGRATION UNDER TEST. See {@link MIGRATION_UNDER_TEST_CITATION}: the checked-in
        // artefact where its dialect matches this connection, and otherwise the one this engine's own
        // lifecycle emits — generated from the core-only schema just observed above, which is the same
        // precondition a deployment generating its first migration has. The generator is handed a
        // configuration WITHOUT the migration registered, or it would be diffing against a schema it is
        // about to be asked to create.
        if (committedMigrationApplies(activeEngine)) {
            migrationUnderTest = AddReorderLists1786838400000;
            migrationProvenance = 'committed-migration';
        } else {
            generatedMigration = await generateLifecycleMigration(baselineConfig, 'add-reorder-lists');
            migrationUnderTest = generatedMigration.migrationClass;
            migrationProvenance = 'lifecycle-generated';
        }
        migrationUnderTestName = migrationUnderTest.name;

        // From this point the plugin-less server is NOT USED AGAIN — every statement below goes through the
        // data source this file owns, addressing the target resolved in step one. The plan permits "destroy or
        // stop using", and stopping using it is the choice taken deliberately: `afterAll` owes the contract
        // exactly one `server.destroy()`, attempted however the rest of the teardown ends, and destroying here
        // as well would run every module's shutdown hook twice.
        migrationConfig = migrationTargetConfig(targetConnectionOptions, [migrationUnderTest]);

        // THE FIRST APPLY. Recorded rather than asserted here, because an assertion in `beforeAll` reports as a
        // suite-wide setup error rather than as the named case that owns the claim.
        firstApply = await applyMigrationsGuarded();

        await openAssertionDataSource();

        pluginTablesAfterFirstAttempt = await existingPluginTables();

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
        // EVERY STEP IS ATTEMPTED, rather than awaited in a chain. This teardown now releases five
        // independent things — a data source, the generated migration's temporary directory, the snapshot
        // copy's temporary directory, two pieces of mutated process state, and a listening server — and a
        // chain of awaits would let the least important of them decide whether the most important one is
        // released. The server is LAST and is still reached however the four before it end, which is the
        // property that keeps a leaked port out of the next file.
        await attemptEveryCleanup([
            {
                what: "closing this file's own data source",
                run: async () => {
                    if (assertionDataSource !== undefined && assertionDataSource.isInitialized) {
                        await assertionDataSource.destroy();
                    }
                },
            },
            {
                what: "removing the generated migration's output directory",
                run: async () => generatedMigration?.dispose(),
            },
            {
                what: 'removing the migration target directory',
                run: async () => {
                    if (migrationTargetDirectory !== undefined) {
                        await fs.remove(migrationTargetDirectory);
                    }
                },
            },
            {
                what: 'restoring the process exit code and the platform configuration',
                run: () => {
                    process.exitCode = ambientExitCode;
                    resetConfig();
                },
            },
            { what: 'destroying the test server', run: () => server.destroy() },
        ]);
    });

    // Half one of every named-object claim — what the migration itself asks the engine for
    //
    // Reading the migration proves only what it asked for; observing the engine's own behaviour proves it is
    // enforced. The two are different claims and STORY-001-01-01's Definition-of-Done item 7 requires both,
    // which is why every named object appears twice in this file: once here and once below. The four
    // constraints are evidenced by the writes they forbid. `IDX_reorder_list_customer_channel` is evidenced by
    // an engine-catalogue read instead, because it is non-unique and so forbids no write.

    describe('the checked-in migration file', () => {
        it('is the only migration this feature produces', async () => {
            const entries = (await fs.readdir(MIGRATIONS_DIR)).sort();

            // Exactly one file, and the one the lifecycle is pointed at. This is also half of the "glob"
            // contract: the pattern `src/migrations/*.ts` resolves to this single artefact, so applying the
            // imported class applies the same thing the pattern would have.
            expect(entries, `${MIGRATIONS_DIR} must hold exactly one migration`).toEqual([
                MIGRATION_FILENAME,
            ]);
        });

        it('is emitted into the published package, at the path a consumer registers', async () => {
            // THE OTHER HALF OF THE GLOB CONTRACT, and the reason it is asserted at all: an installed package
            // has no `src` tree, so a consumer's `migrations` entry has to name the COMPILED file. The migration
            // is a named build root in `tsconfig.build.json` precisely so that it lands here, inside the one
            // path the manifest's `files` entry publishes. The class itself is not a named export of the
            // package root; it reaches a consumer through the root's `reorderPluginMigrations` array.
            const built = (await fs.pathExists(BUILT_MIGRATION_GLOB_DIR))
                ? (await fs.readdir(BUILT_MIGRATION_GLOB_DIR)).filter(entry => entry.endsWith('.js'))
                : [];
            expect(
                built,
                `${BUILT_MIGRATION_GLOB_DIR} carries no compiled migration; run the package build first, ` +
                    'because a migration a consumer cannot load is a migration this package does not ship',
            ).toEqual([MIGRATION_FILENAME.replace(/\.ts$/, '.js')]);
        });

        it('declares the migration class the lifecycle applies, under the name TypeORM records', () => {
            expect(migrationSource).toContain(
                `export class ${SHIPPED_MIGRATION_CLASS_NAME} implements MigrationInterface`,
            );

            // TypeORM orders migrations by the digits trailing the class name and records that name in its own
            // bookkeeping table, so the filename digits and the class-name digits must agree. A mismatch
            // silently reorders migrations rather than failing.
            expect(SHIPPED_MIGRATION_CLASS_NAME).toMatch(/\d+$/);
            expect(MIGRATION_FILENAME.startsWith(SHIPPED_MIGRATION_CLASS_NAME.replace(/^\D+/, ''))).toBe(
                true,
            );
        });

        it('is the generator emitted form, every statement issued through queryRunner.query', () => {
            // The form is what identifies the artefact as generated rather than transcribed.
            // `generateMigration` writes one `queryRunner.query(<SQL>, undefined)` call per logged statement
            // and nothing else, so a file that reached its shape through the query-runner table API — or
            // through entity metadata — would not look like this.
            const body = executableTextOf(migrationSource);
            expect(countOccurrences(body, 'queryRunner.query(')).toBe(
                emittedStatements(migrationSource, 'up').length +
                    emittedStatements(migrationSource, 'down').length,
            );
            for (const absent of TABLE_API_CALLS) {
                expect(
                    body,
                    `${absent} belongs to the query-runner table API; the shipped migration is the ` +
                        `generator serialised SQL. ${GENERATED_FORM_CITATION}`,
                ).not.toContain(absent);
            }

            // PostgreSQL's own spellings, which is how the generation engine is evidenced from the file rather
            // than taken on trust from the header.
            const up = emittedStatements(migrationSource, 'up').join('\n');
            for (const spelling of POSTGRES_EMISSION_MARKERS) {
                expect(
                    up,
                    `"${spelling}" is how PostgreSQL spells this, and its absence would mean the file was ` +
                        'generated against a different engine than the header records',
                ).toContain(spelling);
            }
        });

        it('freezes its shape rather than reading it from the plugin entities', () => {
            // THE PROPERTY A HISTORICAL MIGRATION LIVES OR DIES BY. A migration that builds its tables from
            // `getMetadata(ReorderList)` describes whatever that class says at REPLAY time, not what this
            // timestamp created — so the moment a later feature adds a column to the entity, this older
            // migration starts creating it on a fresh database and that feature's own `ADD COLUMN` collides
            // with a column its migration never created. EPIC-001 section 7.8 L603 assigns exactly such a
            // column to FEATURE-001-06's later migration, so the hazard is scheduled rather than theoretical.
            const body = executableTextOf(migrationSource);
            for (const entityClass of ['ReorderList', 'ReorderListLine']) {
                expect(
                    body,
                    `the migration must not read ${entityClass}'s metadata; its shape is frozen at this ` +
                        'timestamp and a later change to that class must not alter what a replay creates',
                ).not.toContain(`getMetadata(${entityClass})`);
                expect(body, `the migration must not import ${entityClass}`).not.toContain(
                    `${entityClass} }`,
                );
            }

            // The positive half: every column, and every named object, is spelled HERE. That is what makes
            // the shape auditable against the entities rather than derived from them.
            const up = emittedStatements(migrationSource, 'up').join('\n');
            for (const column of [...EXPECTED_LIST_COLUMNS, ...EXPECTED_LINE_COLUMNS]) {
                expect(
                    up,
                    `the migration must spell the "${column}" column it created, so that a reader can see ` +
                        'the frozen shape without resolving entity metadata',
                ).toContain(`"${column}"`);
            }
            // And the named objects EXACTLY, not merely present. A loop that asserted each authorised name
            // appeared could not see a name that also appeared and should not have, which is precisely how a
            // sixth index reached this file's own frozen description unnoticed. Comparing the whole token set
            // reports an addition and an omission alike.
            expect(
                namedObjectTokensIn(body),
                'the migration must spell every authorised named object and no other: an object frozen here ' +
                    'that the contract does not enumerate is created on every deployment that replays this ' +
                    'timestamp, and the contract fixes the count at ' +
                    `${AUTHORIZED_NAMED_OBJECT_COUNT} so that an addition is visible rather than absorbed`,
            ).toEqual(ALL_NAMED_OBJECTS.map(namedObject => namedObject.name).sort());
        });

        it(`freezes exactly the ${AUTHORIZED_NAMED_OBJECT_COUNT} named objects the contract authorises`, () => {
            // THE ALLOW-LIST IS ITSELF ASSERTED FIRST, because every other exact-set claim in this file
            // compares against it: an editor who "fixes" a failure by adding a row to ALL_NAMED_OBJECTS has to
            // change this number as well, and changing it means reopening the contract rather than relaxing a
            // test. Five across two tables — three on the parent, two on the child.
            expect(ALL_NAMED_OBJECTS.map(namedObject => namedObject.name).sort()).toEqual(
                [...authorizedNamedObjectsOn(LIST_TABLE), ...authorizedNamedObjectsOn(LINE_TABLE)].sort(),
            );
            expect(ALL_NAMED_OBJECTS).toHaveLength(AUTHORIZED_NAMED_OBJECT_COUNT);
            expect(new Set(ALL_NAMED_OBJECTS.map(namedObject => namedObject.name)).size).toBe(
                AUTHORIZED_NAMED_OBJECT_COUNT,
            );

            // BOTH DIRECTIONS OF THE EMITTED TEXT, which is what this artefact hands the engine. `up()` must
            // spell every authorised name and no other, and `down()` must spell no name the contract does not
            // authorise — a name in one direction alone would be a divergence between what a deployment
            // creates and what it drops. The counts are engine-independent, because the emitted statements are
            // frozen literals: conflict C-E is about what a MySQL-family driver discards between here and the
            // catalogue, which the catalogue cases assert separately.
            const emittedUp = emittedStatements(migrationSource, 'up').join('\n');
            const emittedDown = emittedStatements(migrationSource, 'down').join('\n');
            expect(
                namedObjectTokensIn(emittedUp),
                `up() must create exactly the ${AUTHORIZED_NAMED_OBJECT_COUNT} authorised named objects and ` +
                    'no others, because an unauthorised object here materialises on every deployment ' +
                    'provisioned by this migration and diverges from the entity declarations the schema ' +
                    'builder provisions from',
            ).toEqual(ALL_NAMED_OBJECTS.map(namedObject => namedObject.name).sort());
            expect(namedObjectTokensIn(emittedUp)).toHaveLength(AUTHORIZED_NAMED_OBJECT_COUNT);
            for (const token of namedObjectTokensIn(emittedDown)) {
                expect(
                    ALL_NAMED_OBJECTS.map(namedObject => namedObject.name),
                    `down() names ${token}, which the contract does not authorise`,
                ).toContain(token);
            }
        });

        it('names a schema in one statement only, which is the emitted form known limitation', () => {
            // `DataSourceOptions.schema` is configurable and the dev server exposes it as `DB_SCHEMA`, while
            // TypeORM neither rewrites raw migration SQL nor sets a `search_path` from it. The generator
            // therefore bakes in whatever schema its own connection used, wherever a statement needs one —
            // which for this delta is `down()`'s `DROP INDEX` alone, PostgreSQL resolving an index by name
            // rather than through its table. It is asserted and bounded here rather than forbidden, because it
            // is a property of the emitted artefact and not a defect in a transcription: a deployment on
            // another schema regenerates the file against its own connection, exactly as the header describes.
            for (const statement of emittedStatements(migrationSource, 'up')) {
                expect(
                    statement,
                    'up() must carry no schema qualifier, so that applying the migration lands wherever the ' +
                        'connection search path points',
                ).not.toContain(`"${GENERATION_SCHEMA}".`);
            }

            const qualified = emittedStatements(migrationSource, 'down').filter(
                statement => statement.indexOf(`"${GENERATION_SCHEMA}".`) !== -1,
            );
            expect(qualified).toHaveLength(1);
            expect(qualified[0]).toContain('DROP INDEX');
            expect(qualified[0]).toContain(IDX_LIST_OWNER);
        });

        it(`declares on the entities exactly the ${AUTHORIZED_NAMED_OBJECT_COUNT} authorised named objects`, () => {
            // THE ENTITY SIDE OF THE EXACT-SET PROOF, and no case above implies it. Those cases compare the
            // MIGRATION's frozen text against the contract, and the entity declarations are the other,
            // independent provisioning path — the schema builder reads them, which is how every synchronised
            // deployment and every e2e suite here gets its schema. Comparing the two sides against EACH OTHER
            // would not close this, because a named object added to both agrees with itself and passes: that is
            // exactly what happened, an unauthorised index was declared on both sides and the addition was
            // invisible. So each side is compared against the CONTRACT, which is the only comparison an editor
            // cannot satisfy by changing the other side.
            //
            // The inventory is read from the metadata TypeORM itself collected off the decorators, rather than
            // from their source text, because metadata is what the schema builder provisions a database from:
            // `@Unique`, `@Index` and `@Check` each land in their own collection on it, and nothing else does
            // — a relation adds no index of its own, and the row identifier is a primary-key column rather
            // than a named object.
            //
            // It is read from the ARGS STORAGE rather than off a connection's built `EntityMetadata`, and that
            // is what makes the claim hold wherever it is run. This claim is about the two entity CLASSES, so
            // it is engine-independent, but neither data source in this file can answer it on every engine:
            // the booted server deliberately registers no plugin at all, so it holds no metadata for these
            // classes, and this file's own `assertionDataSource` is not open at collection time. The args
            // storage is the input `EntityMetadataBuilder` reads to produce that
            // metadata, so it is the same declarations one step earlier, available with no connection open.
            // Its collections carry an unnamed entry as `undefined` where a built metadata would have
            // substituted a generated name, so the absence of one is asserted first — otherwise an unnamed
            // object would be invisible to an exact-set comparison, which is the very failure this case exists
            // to prevent.
            const storage = getMetadataArgsStorage();
            for (const [table, entityClass] of [
                [LIST_TABLE, ReorderList],
                [LINE_TABLE, ReorderListLine],
            ] as const) {
                const entries = [
                    ...storage.filterUniques(entityClass).map(unique => unique.name),
                    ...storage.filterIndices(entityClass).map(index => index.name),
                    ...storage.filterChecks(entityClass).map(check => check.name),
                ];
                expect(
                    entries.filter(name => name === undefined || name.length === 0).length,
                    `${entityClass.name} declares a unique, index or check with no name of its own. An ` +
                        'object the contract cannot enumerate by name is also one the error mapping cannot ' +
                        'match on, and an exact-set comparison cannot see it at all',
                ).toBe(0);
                const declared = entries.map(name => String(name)).sort();
                const authorized = authorizedNamedObjectsOn(table);
                expect(
                    declared,
                    `${entityClass.name} must declare exactly the ${authorized.length} named objects the ` +
                        `contract authorises on "${table}" and no others. A sixth object is created by the ` +
                        'schema builder on every synchronised deployment and by this migration on every ' +
                        'provisioned one, and the contract fixes the count so that an addition is visible ' +
                        'rather than absorbed',
                ).toEqual(authorized);
            }
        });

        it('creates the parent table first and drops the child table first', () => {
            // The parent first, because the child's foreign key references it; the child first on the way down,
            // because a parent still referenced cannot be dropped. Read off the emitted statements in the
            // order the generator serialised them.
            expect(tablesInOrder(emittedStatements(migrationSource, 'up'), 'CREATE TABLE')).toEqual([
                ...PLUGIN_TABLES_PARENT_FIRST,
            ]);
            expect(tablesInOrder(emittedStatements(migrationSource, 'down'), 'DROP TABLE')).toEqual([
                ...PLUGIN_TABLES_CHILD_FIRST,
            ]);

            // And each foreign key is added only after both of its tables exist, which is the constraint the
            // ordering exists to satisfy.
            const up = emittedStatements(migrationSource, 'up');
            for (const key of EXPECTED_FOREIGN_KEYS) {
                const added = up.findIndex(
                    statement =>
                        statement.indexOf('ADD CONSTRAINT') !== -1 &&
                        statement.indexOf(`"${key.column}"`) !== -1 &&
                        statement.indexOf(`"${key.table}"`) !== -1,
                );
                const referentCreated = up.findIndex(
                    statement =>
                        statement.indexOf('CREATE TABLE') !== -1 &&
                        statement.indexOf(`"${key.references}"`) !== -1,
                );
                expect(added, `${key.table}.${key.column} must be added by some statement`).toBeGreaterThan(
                    -1,
                );
                expect(added).toBeGreaterThan(referentCreated);
            }
        });

        it('carries the three engine-portable named objects under their exact names', () => {
            for (const namedObject of PORTABLE_NAMED_OBJECTS) {
                const statement = String(statementDeclaring(migrationSource, namedObject.name));
                expect(
                    statement,
                    `the migration must name ${namedObject.name} on ${namedObject.table}`,
                ).toContain(`"${namedObject.table}"`);

                // And spanning exactly the declared columns, so a name cannot be right while its subject is
                // wrong. The name is load-bearing — the service translates a violation of
                // `UQ_reorder_list_customer_channel_name_key` into `ReorderListNameConflictError` by matching
                // it — and so is what it covers.
                expect(columnsSpannedBy(statement, namedObject.name).slice().sort()).toEqual(
                    namedObject.columns.slice().sort(),
                );
            }
        });

        it('carries both named check constraints, which generating against PostgreSQL is what buys', () => {
            // CONFLICT C-E, LOCATED RATHER THAN ASSUMED. Both checks are here, inline in the `CREATE TABLE`
            // statements, because the generation engine is PostgreSQL. A file generated for MySQL or MariaDB
            // carries neither: TypeORM 0.3.28 returns early for that family before a check reaches the
            // statement log at all, so the gap is upstream of the migration rather than inside it. That is not
            // left as a claim either — the provenance case above reads it off THAT family's own emission when
            // the run is on it, and the catalogue half below reads the same objects back out of the engine.
            const up = emittedStatements(migrationSource, 'up').join('\n');
            for (const namedObject of CHECK_NAMED_OBJECTS) {
                expect(
                    up,
                    `the migration must declare ${namedObject.name} on ${namedObject.table}. ${C_E_CITATION}`,
                ).toContain(`CONSTRAINT "${namedObject.name}" CHECK`);
            }

            // The expressions themselves, so a check cannot be present under the right name while guarding
            // nothing.
            expect(up).toContain(`CONSTRAINT "${CHK_LINE_QUANTITY_POSITIVE}" CHECK ("quantity" > 0)`);
            expect(up).toContain(`CONSTRAINT "${CHK_LIST_LINE_COUNT_NON_NEGATIVE}" CHECK ("lineCount" >= 0)`);
        });

        it('carries the denormalised line counter and both bounded name columns at their declared width', () => {
            const listTable = String(statementCreating(migrationSource, LIST_TABLE));
            for (const column of ['lineCount', 'name', 'nameKey']) {
                expect(listTable).toContain(`"${column}"`);
            }

            // 191 on both name columns. A key-size ceiling on the MySQL family rather than a product choice,
            // which is why the same number is the plugin's fixed name-length bound. Only `nameKey` is in the
            // index the ceiling is about; `name` shares the width because it holds the same value before
            // canonicalisation.
            for (const stringColumn of ['name', 'nameKey']) {
                expect(listTable, `"${stringColumn}" must be declared at 191 and NOT NULL`).toContain(
                    `"${stringColumn}" character varying(${BOUNDED_NAME_COLUMN_LENGTH}) NOT NULL`,
                );
            }

            expect(listTable).toContain(`"lineCount" integer NOT NULL DEFAULT '0'`);
        });

        it('carries four ON DELETE CASCADE foreign keys, every one declared on a plugin table', () => {
            const added = emittedStatements(migrationSource, 'up').filter(
                statement => statement.indexOf('FOREIGN KEY') !== -1,
            );
            expect(added).toHaveLength(EXPECTED_FOREIGN_KEYS.length);

            const declared: string[] = [];
            for (const statement of added) {
                expect(
                    statement,
                    `${statement} must cascade, so that deleting the referent removes the referencing row`,
                ).toContain('ON DELETE CASCADE');
                const [, table] = /ALTER TABLE "([^"]+)"/.exec(statement) ?? [];
                const [, column] = /FOREIGN KEY \("([^"]+)"\)/.exec(statement) ?? [];
                const [, references] = /REFERENCES "([^"]+)"/.exec(statement) ?? [];
                expect(
                    PLUGIN_TABLES_PARENT_FIRST.indexOf(
                        String(table) as (typeof PLUGIN_TABLES_PARENT_FIRST)[number],
                    ),
                    `"${String(table)}" is not a plugin table, so this key is not additive`,
                ).toBeGreaterThan(-1);
                declared.push(`${String(table)}.${String(column)}->${String(references)}`);
            }

            // Exactly the four the entity declarations carry, each FROM a plugin table TO a core table or to
            // the plugin's own parent. The direction is the whole point of the additive-boundary claim: nothing
            // here adds a column to a core table or makes a core table depend on a plugin table.
            expect(declared.slice().sort()).toEqual(
                EXPECTED_FOREIGN_KEYS.map(key => `${key.table}.${key.column}->${key.references}`)
                    .slice()
                    .sort(),
            );

            // AND THE TWO NAMES THE DOWN-PATH WILL LOOK FOR AGAIN, pinned. A constraint name TypeORM derives
            // by hashing the table and column is deterministic but invisible in the entity source, so a
            // renamed column changes it silently — and a `down()` that drops a constraint by a name its own
            // `up()` no longer creates fails only when someone reverts, which is the worst moment to discover
            // it. The reverse direction is asserted for the same two names below.
            for (const [name, direction] of [
                [FK_LIST_CUSTOMER, 'up'],
                [FK_LINE_LIST, 'up'],
                [FK_LIST_CUSTOMER, 'down'],
                [FK_LINE_LIST, 'down'],
            ] as const) {
                expect(
                    emittedStatements(migrationSource, direction).filter(
                        statement => statement.indexOf(name) !== -1,
                    ),
                    `${direction}() must name ${name} exactly once, or the two directions disagree`,
                ).toHaveLength(1);
            }
        });

        it('alters no core table and drops no core object', () => {
            // Every table the migration ADDRESSES is a plugin table, on both directions: whatever follows
            // `CREATE TABLE`, `ALTER TABLE` or `DROP TABLE` is one of the two. A core table appears only after
            // `REFERENCES`, which adds nothing to it.
            for (const direction of ['up', 'down'] as const) {
                for (const statement of emittedStatements(migrationSource, direction)) {
                    for (const verb of ADDRESSING_VERBS) {
                        const match = new RegExp(`${verb} "([^"]+)"`).exec(statement);
                        if (match === null) {
                            continue;
                        }
                        expect(
                            PLUGIN_TABLES_PARENT_FIRST.indexOf(
                                match[1] as (typeof PLUGIN_TABLES_PARENT_FIRST)[number],
                            ),
                            `${direction}() addresses "${match[1]}", which is not a plugin table, so this ` +
                                'migration is not additive',
                        ).toBeGreaterThan(-1);
                    }
                }
            }

            // Each core table IS named — that is what a frozen foreign-key target means — and the assertion is
            // therefore about HOW. It is named only as a reference target, which is what makes naming
            // `customer` create nothing and alter nothing. A core table absent from the text would mean the
            // reference had been derived from live metadata, which is the very thing that would make this
            // migration's shape mutable.
            const up = emittedStatements(migrationSource, 'up').join('\n');
            for (const coreTable of REFERENCED_CORE_TABLES) {
                expect(
                    up,
                    `"${coreTable}" must be named as a frozen foreign-key target rather than resolved from ` +
                        'entity metadata at replay time',
                ).toContain(`REFERENCES "${coreTable}"`);
            }
        });

        it('carries neither withdrawn claim column, nor the withdrawn claim constraint, nor a seats counter', () => {
            // CONFLICT C-A. One stale sub-task of STORY-001-01-01 still asks for the claim pair; the feature
            // contract withdraws all three objects and the story's own migration sub-task and Definition-of-Done
            // item make their ABSENCE the assertion. The seats counter belongs to FEATURE-001-06's own later
            // migration, so this file must never be edited to add it either.
            const emitted = [
                ...emittedStatements(migrationSource, 'up'),
                ...emittedStatements(migrationSource, 'down'),
            ].join('\n');
            for (const column of WITHDRAWN_COLUMNS) {
                expect(migrationSource, `${column} is withdrawn and must not appear`).not.toContain(column);
                expect(emitted, `${column} is withdrawn and must not be created`).not.toContain(column);
            }
            expect(
                migrationSource,
                `${WITHDRAWN_CHECK_CONSTRAINT} is withdrawn and must not appear`,
            ).not.toContain(WITHDRAWN_CHECK_CONSTRAINT);
            expect(emitted).not.toContain(WITHDRAWN_CHECK_CONSTRAINT);
        });
    });

    // How the dev server registers this plugin's migration
    //
    // The package ships its migration in two layouts — `src/migrations/*.ts` in a checkout and
    // `lib/src/migrations/*.js` in the published artefact — and a built checkout carries BOTH. Registering a
    // glob for each is not a harmless superset: TypeORM loads every pattern and then refuses the whole
    // configuration, because both files declare the same class
    // (`MigrationExecutor.checkForDuplicateMigrations`). Registering the CLASS instead is what makes one
    // registration correct in both layouts, and it is what the shipped configuration does.

    describe('the registration the dev server carries', () => {
        it('registers the migration class this package exports, not a per-layout glob', async () => {
            const devConfigSource = await fs.readFile(DEV_CONFIG_FILE_PATH, 'utf-8');
            const options = dbConnectionOptionsBlockOf(devConfigSource);

            // ONE APPENDED CLAUSE, and the pattern that was already there is still first. AAP section
            // 0.4.1.1 permits exactly three changes to this file — an import line, the plugin registration,
            // and one appended clause on this array — so the assertion is over the whole array rather than
            // over the presence of the new member alone.
            expect(
                options,
                "dev-config must append the plugin's own migration classes to the existing array",
            ).toContain("migrations: [path.join(__dirname, 'migrations/*.ts'), ...reorderPluginMigrations],");

            // And the symbol it appends is imported from the PACKAGE ROOT, which is the same specifier the
            // plugin class itself arrives through. A deep path into this package's source tree would be a
            // route the manifest resolves and the package makes no promise about.
            expect(devConfigSource).toContain(
                "import { ReorderPlugin, reorderPluginMigrations } from '@vendure/reorder-plugin';",
            );
            expect(
                devConfigSource,
                'the registration must not be built from a path relative to the dev server',
            ).not.toContain("'../reorder-plugin");
            expect(
                devConfigSource,
                'a class registration needs no filesystem probe, so no such probe may appear',
            ).not.toContain("import fs from 'fs'");
            expect(
                devConfigSource,
                'the registration must not vary by which script Node was handed',
            ).not.toContain('process.argv');
        });

        it('registers a class per layout that resolves to exactly one migration file', async () => {
            // WHY a class rather than two globs, stated as evidence rather than as a comment: both artefacts
            // declare `AddReorderLists1786838400000`, so a configuration naming both hands TypeORM two
            // migrations of one name and is rejected in full.
            expect(migrationSource, 'the source layout must declare the migration class').toContain(
                `export class ${SHIPPED_MIGRATION_CLASS_NAME}`,
            );
            const builtFile = path.join(BUILT_MIGRATION_GLOB_DIR, MIGRATION_FILENAME.replace(/\.ts$/, '.js'));
            expect(
                await fs.pathExists(builtFile),
                `${builtFile} must exist; run the package build first`,
            ).toBe(true);
            expect(
                await fs.readFile(builtFile, 'utf-8'),
                'the compiled layout must declare the same migration class, which is why two globs could ' +
                    'not both be registered',
            ).toContain(SHIPPED_MIGRATION_CLASS_NAME);

            // And what the package publishes for a deployment to register is that one class, so the
            // duplicate-name rejection is unreachable by construction rather than by a layout choice.
            expect(reorderPluginMigrations).toEqual([AddReorderLists1786838400000]);
            expect(reorderPluginMigrations.map(migration => migration.name)).toEqual([
                SHIPPED_MIGRATION_CLASS_NAME,
            ]);
        });
    });

    // The configuration that drives the migration
    //
    // A migration-driven connection must not synchronise. If it does, the schema builder creates this
    // plugin's two tables from entity metadata before the migration runs, and the migration then validates a
    // schema it did not author instead of owning it — which is the difference between a schema history that
    // records what happened and one that merely records that something did.

    describe('the configuration that drives the migration', () => {
        it('is synchronization-free because the platform forces it, on every entry point', async () => {
            // THE GUARANTEE THAT HOLDS REGARDLESS OF ANY CONFIGURATION. `generateMigration`, `runMigrations`
            // and `revertLastMigration` each build their own data source through one helper, which assigns
            // these four keys OVER whatever the caller's `dbConnectionOptions` said — the third argument to
            // `Object.assign` wins. Read out of the platform's own source rather than trusted from a comment.
            const migrateSource = await fs.readFile(
                path.join(__dirname, '../../core/src/migrate.ts'),
                'utf-8',
            );
            const helper = migrateSource.slice(migrateSource.indexOf('function createConnectionOptions'));
            const body = helper.slice(0, helper.indexOf('\n}'));
            expect(
                body,
                'the platform must force synchronization off on every migration connection',
            ).toContain('synchronize: false');
            expect(body).toContain('userConfig.dbConnectionOptions');
            expect(body.indexOf('synchronize: false')).toBeGreaterThan(
                body.indexOf('userConfig.dbConnectionOptions'),
            );
            for (const entryPoint of ['generateMigration', 'runMigrations', 'revertLastMigration']) {
                expect(migrateSource, `${entryPoint} must route through createConnectionOptions`).toMatch(
                    new RegExp(`${entryPoint}[\\s\\S]{0,4000}createConnectionOptions`),
                );
            }

            // And where this file drives the lifecycle itself, its own configuration says the same thing
            // explicitly, so the apply every executing case below measures cannot have been a synchronization
            // pass wearing a migration's name. Asserted on every engine, because on every engine this file
            // builds that configuration and applies a migration through it; the platform guarantee above is
            // what covers a deployment that configures something else.
            expect(migrationConfig.dbConnectionOptions.synchronize).toBe(false);
            expect(
                (migrationConfig.dbConnectionOptions as { migrations?: unknown[] }).migrations,
                'exactly one migration is registered, and it is the one under test',
            ).toEqual([migrationUnderTest]);
        });

        it("leaves the dev server's own synchronization declaration exactly as it found it", async () => {
            const devConfigSource = await fs.readFile(DEV_CONFIG_FILE_PATH, 'utf-8');
            const options = dbConnectionOptionsBlockOf(devConfigSource);

            // ★ THE DECLARATION IS THE HARNESS'S, NOT THIS FEATURE'S, AND THAT IS THE ASSERTION. AAP section
            // 0.4.1.1 permits three changes to this file and a `synchronize` of its own is not one of them,
            // so the key stays where the harness put it — first in the object, ABOVE the engine spread —
            // and this feature adds none of its own. A second declaration after the spread would be a
            // behavioural change to an existing value: `getDbConfig()`'s server branches each return
            // `synchronize: true` and its `sqljs` branch returns no such key at all, so a derived value
            // placed after the spread silently flips a `DB=sqljs` boot from the harness's `false` to `true`.
            expect(options, 'dbConnectionOptions must spread the engine configuration').toContain(
                '...getDbConfig()',
            );
            const beforeSpread = options.slice(0, options.indexOf('...getDbConfig()'));
            const afterSpread = options.slice(options.indexOf('...getDbConfig()'));
            expect(beforeSpread, "the harness's own synchronize declaration must be left in place").toContain(
                'synchronize: false',
            );
            expect(
                afterSpread,
                'this feature declares no synchronize of its own, so nothing may follow the spread',
            ).not.toContain('synchronize');

            // AND THE SEQUENCING PROBLEM THAT DECLARATION LEAVES OPEN IS ANSWERED OPERATIONALLY, WHICH IS
            // WHAT THE PLAN PRESCRIBES. On every engine branch that declares it the spread wins and a dev
            // boot synchronizes, so the schema this plugin's migration must be the author of is created by
            // THIS SUITE, on a connection this suite configures with synchronization off, rather than by
            // asking the harness to boot differently. That connection is asserted by the case above; the
            // platform's own force-assignment is what holds in production.
        });

        it('carries the plugin registration and adds no custom field or permission', async () => {
            const devConfigSource = await fs.readFile(DEV_CONFIG_FILE_PATH, 'utf-8');

            // The registration itself, with the five declared option values. This is the second of the three
            // changes AAP section 0.4.1.1 sanctions, and the values are the ones the plan supplies.
            const registration = devConfigSource.slice(devConfigSource.indexOf('ReorderPlugin.init({'));
            expect(
                registration.slice(0, registration.indexOf('}')),
                'the dev server must register the plugin with the five declared option values',
            ).toContain('maxListsPerCustomer: 25');
            for (const declaration of [
                'maxLinesPerList: 200',
                'maxQuantityPerLine: 999',
                'defaultReorderListsPageSize: 25',
                'defaultReorderListLinesPageSize: 50',
            ]) {
                expect(registration.slice(0, registration.indexOf('}'))).toContain(declaration);
            }

            // AND THE TWO NEIGHBOURING VALUES THAT MUST NOT MOVE. Ruling R1 forbids a custom field on any
            // core entity and this feature registers no permission of its own, which is why the published
            // `Permission` enum stays at its baseline width — a zero delta the read suite asserts rather
            // than omits. Both are read here as the empty declarations the harness already had.
            expect(devConfigSource, 'no custom field may be registered').toContain('customFields: {},');
            expect(devConfigSource, 'no custom permission may be registered').toContain(
                'customPermissions: [],',
            );
        });
    });

    // WHICH ARTEFACT THIS RUN EXECUTED, AND WHY
    //
    // Everything below this point reads a schema a migration built. Which migration that was differs by
    // engine — see {@link MIGRATION_UNDER_TEST_CITATION} — and a reader of a failure two hundred lines further
    // down cannot tell which without being told. So the choice is not left implicit in a helper: it is
    // asserted, against the same predicate five sibling suites read the dialect question through, and the
    // generated artefact is checked to be a lifecycle emission rather than anything else.

    describe('the migration this engine applies', () => {
        it("applied the checked-in artefact where its dialect matches, and this engine's own emission otherwise", () => {
            // THE CHOICE, OBSERVED AGAINST THE SHARED PREDICATE. `appliesShippedMigration` is read from
            // `committedMigrationApplies` in `e2e/fixtures/migration-state.ts`, which is the one authority in
            // the package for "can the checked-in file run here" and is what the create, add-item, mutate,
            // read and compatibility suites branch on too. A second spelling of the same rule in this file is
            // exactly how the two could drift apart, so there is not one.
            expect(
                migrationProvenance,
                `${activeEngine} must apply ${
                    appliesShippedMigration ? 'the checked-in artefact' : 'its own lifecycle emission'
                }. ${MIGRATION_UNDER_TEST_CITATION}`,
            ).toBe(appliesShippedMigration ? 'committed-migration' : 'lifecycle-generated');
            expect(appliesShippedMigration).toBe(committedMigrationApplies(activeEngine));

            // AND THE CLASS THAT RAN IS THE ONE THAT CHOICE NAMES, not merely a class of the right shape.
            if (migrationProvenance === 'committed-migration') {
                expect(migrationUnderTest).toBe(AddReorderLists1786838400000);
                expect(migrationUnderTestName).toBe(SHIPPED_MIGRATION_CLASS_NAME);
                expect(generatedMigration, 'nothing was generated on this engine').toBeUndefined();
            } else {
                expect(generatedMigration, 'this engine needed an emission of its own').toBeDefined();
                expect(migrationUnderTest).toBe(generatedMigration?.migrationClass);
                expect(migrationUnderTestName).toBe(generatedMigration?.className);
                // TypeORM orders migrations by the trailing timestamp in the class name and refuses one
                // without it, so this is the property that makes the emission runnable at all.
                expect(migrationUnderTestName).toMatch(/^AddReorderLists\d+$/);
            }

            // AND WHAT `runMigrations` ITSELF RECORDED, which is the only name that reaches TypeORM's
            // bookkeeping table and therefore the only one a revert can find again.
            expect(
                firstApply.migrationsRan,
                `runMigrations recorded a different migration than the one this file registered. ${MIGRATION_UNDER_TEST_CITATION}`,
            ).toEqual([migrationUnderTestName]);
        });

        it('generated that emission through the platform lifecycle, outside this repository', async () => {
            if (generatedMigration === undefined) {
                // STATED RATHER THAN SKIPPED. On the engine the checked-in artefact was generated for there is
                // nothing to generate, and the assertion that nothing was is the evidence — a run that
                // quietly generated a second migration here would be measuring an artefact nobody reviewed.
                expect(migrationProvenance).toBe('committed-migration');
                expect(await fs.readdir(MIGRATIONS_DIR)).toEqual([MIGRATION_FILENAME]);
                return;
            }

            // OUTSIDE THE REPOSITORY, so `git status --porcelain` is clean after a run on any engine and no
            // unreviewed migration can be left under this package's own migrations directory.
            expect(path.isAbsolute(generatedMigration.filePath)).toBe(true);
            expect(generatedMigration.filePath.startsWith(path.join(__dirname, '..'))).toBe(false);
            expect(await fs.readdir(MIGRATIONS_DIR)).toEqual([MIGRATION_FILENAME]);

            // AND IT IS THE GENERATOR'S OWN OUTPUT, in the shape `generateMigration` writes: a class
            // implementing `MigrationInterface` whose two directions issue nothing but
            // `queryRunner.query(<SQL>)` calls (`packages/core/src/migrate.ts:L127-L179`). Nothing here is
            // hand-written and nothing here may be — EPIC-001 section 7.8 makes the lifecycle the only
            // sanctioned mechanism, on every engine.
            expect(generatedMigration.source).toContain(
                `export class ${migrationUnderTestName} implements MigrationInterface`,
            );
            for (const call of TABLE_API_CALLS) {
                expect(
                    generatedMigration.source,
                    `a lifecycle emission issues serialised SQL, never ${call}`,
                ).not.toContain(call);
            }

            // THE STATEMENTS IT WILL ACTUALLY EXECUTE, read by undoing precisely the escaping the generator
            // applied — a double-quoted literal with `"` escaped on the MySQL family and a template literal
            // with a backtick escaped elsewhere. A source-text search cannot do this job on the MySQL family
            // at all: its identifier quoting IS the backtick, so every statement is full of them.
            const statements = extractGeneratedStatements(generatedMigration.source);
            expect(tablesInOrder(statements.up, 'CREATE TABLE').slice(0, 2)).toEqual([
                ...PLUGIN_TABLES_PARENT_FIRST,
            ]);
            expect(
                tablesInOrder(statements.down, 'DROP TABLE').slice(-2),
                'the parent may only be dropped once nothing references it',
            ).toEqual([...PLUGIN_TABLES_CHILD_FIRST]);

            // AND EVERY NAMED OBJECT THIS ENGINE CAN MATERIALISE IS IN THAT EMISSION, under its exact name —
            // which is where conflict C-E becomes a measurement rather than a citation: the MySQL family's own
            // emission carries the three `UQ_`/`IDX_` names and NEITHER `CHK_`, because TypeORM returns early
            // before a check ever reaches the statement log there.
            const emitted = statements.up.join('\n');
            for (const namedObject of ALL_NAMED_OBJECTS) {
                const materialises = namedObject.kind !== 'check' || emitsNamedCheckConstraints(activeEngine);
                expect(
                    emitted.indexOf(namedObject.name) !== -1,
                    `${activeEngine} must ${materialises ? 'emit' : 'NOT emit'} ${namedObject.name}. ${
                        materialises ? '' : C_E_CITATION
                    }`,
                ).toBe(materialises);
            }

            // And neither withdrawn object, in the emission any engine produces — conflict C-A holds wherever
            // the file came from, not only in the one that is checked in.
            for (const withdrawn of [...WITHDRAWN_COLUMNS, WITHDRAWN_CHECK_CONSTRAINT]) {
                expect(emitted, `a generated emission must not carry ${withdrawn}`).not.toContain(withdrawn);
            }
        });
    });

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
            'was created by the migration itself rather than by any schema builder',
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

                // AND THE MIGRATION IS WHAT CREATED THEM, on whichever engine this run configured. There is
                // no schema-builder fallback on any of them: the schema every shape, catalogue and
                // forbidden-write assertion below reads is the one `runMigrations` built, and if it did not
                // build it this case fails rather than substituting something that resembles it.
                expect(
                    pluginTablesAfterFirstAttempt.slice().sort(),
                    `the migration did not create both plugin tables on ${activeEngine}. ` +
                        MIGRATION_UNDER_TEST_CITATION,
                ).toEqual(PLUGIN_TABLES_CHILD_FIRST.slice().sort());

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

                expect(columnNamed(snapshot, 'id').isPrimary).toBe(true);
                expect(columnNamed(snapshot, 'id').isGenerated).toBe(true);
                expect(columnNamed(snapshot, 'createdAt').isNullable).toBe(false);
                expect(columnNamed(snapshot, 'updatedAt').isNullable).toBe(false);

                // Both bounded name columns at 191 — the MySQL-family key-size ceiling, which `nameKey` is
                // indexed under and `name` merely shares the width of.
                expect(columnNamed(snapshot, 'name').length).toBe(BOUNDED_NAME_COLUMN_LENGTH);
                expect(columnNamed(snapshot, 'nameKey').length).toBe(BOUNDED_NAME_COLUMN_LENGTH);
                expect(columnNamed(snapshot, 'name').isNullable).toBe(false);
                expect(columnNamed(snapshot, 'nameKey').isNullable).toBe(false);

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

                const total = Array.from(snapshots.values()).reduce(
                    (count, snapshot) => count + snapshot.foreignKeys.length,
                    0,
                );
                expect(total).toBe(EXPECTED_FOREIGN_KEYS.length);

                // AND THE TWO PINNED NAMES EXIST IN THE ENGINE'S OWN CATALOGUE, not only in the migration's
                // text. The name is what a revert addresses, so a constraint that enforces the right rule
                // under a name nothing will look for again is a defect the shape assertions above cannot see.
                // These two are portable because TypeORM derives a foreign-key name from the table and column
                // rather than from the dialect, so every engine's emission spells them identically.
                for (const [table, name, column, references] of [
                    [LIST_TABLE, FK_LIST_CUSTOMER, 'customerId', 'customer'],
                    [LINE_TABLE, FK_LINE_LIST, 'reorderListId', LIST_TABLE],
                ] as const) {
                    const reference = referenceOf(await readTable(table), name);
                    expect(reference.columnNames).toEqual([column]);
                    expect(bareTableName(reference.referencedTableName)).toBe(references);
                    expect(String(reference.onDelete ?? '').toUpperCase()).toBe('CASCADE');
                }
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

    // HALF TWO, PART ONE — the named objects, present in the engine's own catalogue under their exact names
    //
    // Three catalogue readers, because the object CLASS differs between engines while the name and the
    // guarantee do not: a `UQ_` is a unique constraint on PostgreSQL and the SQLite family and a named unique
    // INDEX on the MySQL family, so a single "constraint type" lookup would report it missing while it was
    // enforcing exactly the same rule. **Each reader runs on its own family**, against the schema that
    // family's own migration built — PostgreSQL's on PostgreSQL, `sqlite_master` on the SQLite family, and
    // `information_schema` on the MySQL family — which is what makes the C-E gap a measurement per engine
    // rather than an inference from one.

    describe("the named objects, in the engine's own catalogue", () => {
        for (const namedObject of PORTABLE_NAMED_OBJECTS) {
            it(
                `${namedObject.name} exists on ${namedObject.table} in the engine's own catalogue`,
                async () => {
                    const catalogue = await readEngineCatalogue();
                    const namesForKind =
                        namedObject.kind === 'unique' ? catalogue.uniqueNames : catalogue.indexNames;

                    expect(
                        namesForKind,
                        `${namedObject.name} is missing from ${catalogue.source} on ${activeEngine}, where ` +
                            'the schema was created by the migration under test',
                    ).toContain(namedObject.name);

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

        it(
            'carries exactly the authorised named objects on each plugin table, and no others',
            async () => {
                // THE ASSERTION THE CASES ABOVE CANNOT MAKE. Each of them asks whether one authorised name is
                // present, and a presence check is blind in one direction: an object nobody authorised is
                // present in the catalogue, absent from every expectation, and reported by nothing. That is not
                // hypothetical — a channel-only index on the parent and a variant-only index on the child were
                // declared on the entities, frozen into the migration and created on all four engines, and
                // every case in this suite stayed green. This case is the one that fails for it.
                //
                // The comparison is per table and exact, over the catalogue scoped to that table with the row
                // identifier's and the four references' own artefacts discounted — see
                // {@link TableCatalogueReading} for why each exclusion is a claim asserted elsewhere rather
                // than a convenience.
                let materialisedTotal = 0;
                for (const table of PLUGIN_TABLES_PARENT_FIRST) {
                    const reading = await readTableCatalogue(table);
                    const expected = materialisedNamedObjectsOn(table, activeEngine);
                    materialisedTotal += expected.length;
                    expect(
                        reading.names,
                        `"${table}" must carry exactly the ${expected.length} named objects the contract ` +
                            `authorises and materialises on ${activeEngine}, and no others. Read from ` +
                            `${reading.source}. Discounted as the row identifier's own artefacts: ` +
                            `[${reading.identifierArtefacts.join(', ')}]; as the cascading references' own: ` +
                            `[${reading.referenceArtefacts.join(', ')}] — the MySQL family creates an index ` +
                            'for a foreign key of its own accord and names it after the constraint, which is ' +
                            'the engine keeping its own books rather than a contract breach. Anything left ' +
                            `over is an object this feature created and the contract does not authorise. ${
                                emitsNamedCheckConstraints(activeEngine) ? '' : C_E_CITATION
                            }`,
                    ).toEqual(expected);
                }

                // AND THE TOTAL, which is the number that differs between the engine families and the reason
                // this claim is engine-conditional rather than one number everywhere: five materialised on
                // PostgreSQL and the SQLite family, three on the MySQL family, where the two named checks are
                // declared by the migration and then silently discarded by the driver.
                expect(
                    materialisedTotal,
                    `${activeEngine} must materialise ${materialisedTotal} of the ` +
                        `${AUTHORIZED_NAMED_OBJECT_COUNT} authorised named objects. ${
                            emitsNamedCheckConstraints(activeEngine)
                                ? 'This engine emits named check constraints, so all five exist.'
                                : `This engine emits none, so the two CHK_ objects cannot. ${C_E_CITATION}`
                        }`,
                ).toBe(emitsNamedCheckConstraints(activeEngine) ? AUTHORIZED_NAMED_OBJECT_COUNT : 3);
            },
            CATALOGUE_READ_ABORT_AFTER_MS,
        );
    });

    // HALF TWO, PART TWO — the engine's own enforcement of each named object
    //
    // The four constraints are evidenced by the writes they forbid; `IDX_reorder_list_customer_channel` is
    // evidenced by an engine-catalogue read, because a non-unique index constrains no value and forbids no
    // write.
    //
    // Each case in its own `it`, each building its own precondition, each issued straight through the
    // repository. They are sequential single writes rather than interleavings, so there is no barrier
    // anywhere in this file. They run against the schema the migration under test built — the checked-in
    // artefact where its dialect matches this connection, and this engine's own emission otherwise — so a
    // refusal observed here is that engine's own enforcement of that engine's own DDL.

    // THE MIGRATION-OWNED DEPLOYMENT, AND WHERE ITS EXECUTED PROOF LIVES
    //
    // Everything above establishes that the migration BUILT this schema, on the engine the checked-in
    // artefact was generated for. The other half of the claim — that a deployment provisioned that way SERVES the published
    // contract — is executed in `reorder-plugin-compatibility.e2e-spec.ts` ("a deployment provisioned by the
    // migration alone"), which is the one other suite that applies this migration. It has to be there rather
    // than here for a platform reason worth stating exactly, because it looks at first like something this
    // file could simply do.

    describe('the write each named constraint forbids', () => {
        it(
            `${UQ_LIST_OWNER_NAME_KEY} refuses a second row for one customer, channel and canonical name`,
            async () => {
                expect(seededCustomerIds.length, 'the fixture seeds two buyers').toBeGreaterThanOrEqual(2);
                const lists = assertionDataSource.getRepository(ReorderList);
                await insertList();
                expect(await lists.count({ where: { nameKey: SEEDED_NAME_KEY } })).toBe(1);

                const attempt = await attemptWrite(() =>
                    insertList({ name: 'A different display spelling of the same canonical name' }),
                );

                expect(
                    attempt.refused,
                    `the database must refuse the duplicate through ${UQ_LIST_OWNER_NAME_KEY}; the write was ` +
                        `accepted instead, so uniqueness rests on the service alone and a race defeats it`,
                ).toBe(true);
                expect(await lists.count({ where: { nameKey: SEEDED_NAME_KEY } })).toBe(1);

                // AND THE SCOPE IS THE TRIPLE, not the name alone: the second buyer holds the same canonical name
                // in the same channel without collision, which is what makes the constraint per owner.
                const otherBuyer = await attemptWrite(() => insertList({ customerId: seededCustomerIds[1] }));
                expect(
                    otherBuyer.refused,
                    `${UQ_LIST_OWNER_NAME_KEY} spans (customerId, channelId, nameKey), so a second buyer's row ` +
                        `must be accepted: ${otherBuyer.diagnostic}`,
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

                const secondVariant = await attemptWrite(() => insertLine(listId, seededVariantIds[1], 9));
                expect(secondVariant.refused, secondVariant.diagnostic).toBe(false);
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

                const lists = assertionDataSource.getRepository(ReorderList);
                await insertList({ nameKey: 'first list for this owner', name: 'First list for this owner' });
                const second = await attemptWrite(() =>
                    insertList({ nameKey: 'second list for this owner', name: 'Second list for this owner' }),
                );
                expect(second.refused, second.diagnostic).toBe(false);
                expect(await lists.count({ where: { customerId: seededCustomerIds[0] } })).toBe(2);
            },
            CATALOGUE_READ_ABORT_AFTER_MS,
        );
    });

    // The data-bearing up → down → up cycle
    //
    // Applied once and reverted once cannot detect a non-idempotent up-path or a down-path that takes a core
    // row with it, which is why the sequence is whole and why it carries data. Both cases below are
    // self-contained: each builds its own precondition and leaves the schema as it found it, so running either
    // alone, or the file in reverse order, gives the same result.

    describe('the data-bearing up, down and up cycle', () => {
        it('applied cleanly through the platform lifecycle, on the engine the run configured', () => {
            expect(
                firstApply.migrationsRan,
                `runMigrations must report ${migrationUnderTestName} as applied on ${activeEngine}. ` +
                    MIGRATION_UNDER_TEST_CITATION,
            ).toContain(migrationUnderTestName);

            // THE SILENT-FAILURE PATH, CLOSED. `runMigrations` does not throw: it logs and sets
            // `process.exitCode = 1` unless it is running from the Vendure CLI
            // (`packages/core/src/migrate.ts:L52-L59`). An assertion that only awaited the call would pass on a
            // migration that had failed outright, so the exit code the platform left behind is read. This is
            // also the assertion that would catch an engine refusing the migration, which is why the suite can
            // state portability as a measurement rather than as a belief.
            expect(
                firstApply.observedExitCode,
                'runMigrations signalled a failure through process.exitCode',
            ).toBeUndefined();

            // AND THE EFFECT, read off the engine: exactly the two tables, created by that apply and by nothing
            // else, since neither existed beforehand.
            expect(pluginTablesAfterFirstAttempt.slice().sort()).toEqual(
                PLUGIN_TABLES_CHILD_FIRST.slice().sort(),
            );
        });

        it(
            'reverts without taking a core row with it, and re-applies to an identical schema',
            async () => {
                const seeded = await seedPluginRows();
                expect(seeded.lineIds).toHaveLength(2);
                const afterFirstApply = await snapshotPluginSchema();

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
                    //
                    // ★ THE COMPARISON IS OVER FULL VALUES; THE ASSERTION IS OVER A REDACTED DESCRIPTION OF THE
                    // RESULT. Those are two separate things, and handing the two arrays to `toEqual` conflated
                    // them: `REFERENCED_CORE_TABLES` includes `customer`, so the arrays hold every seeded buyer's
                    // name and contact fields, and a matcher prints its actual AND its expected — meaning the one
                    // failure this assertion exists to report is also the one that publishes the whole seeded
                    // customer table into the build log. `describeRowDifferences` compares every column of every
                    // row through the same canonicalisation, reports a vanished row and an arrived row by
                    // identifier, and renders each side of a moved cell by SHAPE — so the check is exactly as
                    // strict and both sides of the assertion are short value-free strings.
                    for (const coreTable of REFERENCED_CORE_TABLES) {
                        const survivors = await selectAllRows(coreTable);
                        expect(
                            describeRowDifferences(baselineCoreRows[coreTable], survivors),
                            `the down-path took or changed a row in "${coreTable}"; the difference is reported ` +
                                'by row id, column name and value SHAPE only, deliberately — see ' +
                                'describeCellForDiagnostic in e2e/fixtures/diagnostic-redaction.ts',
                        ).toBe(NO_ROW_DIFFERENCE);
                        // AND THE ROW COUNT, which the description above already covers through its
                        // missing/added entries and which is restated here so a future edit to that
                        // description cannot quietly weaken this to a per-column check over a shorter table.
                        // Two NUMBERS compared by hand rather than `expect(survivors).toHaveLength(n)`,
                        // because that matcher prints the RECEIVED ARRAY on failure — and for `customer` that
                        // array is every seeded buyer's name and contact fields.
                        expect(
                            survivors.length,
                            `the down-path changed how many rows "${coreTable}" holds`,
                        ).toBe(baselineCoreRows[coreTable].length);
                    }

                    // No core table was reshaped either, so the revert removed only what the up-path added.
                    for (const coreTable of REFERENCED_CORE_TABLES) {
                        expect(await readTableSnapshot(coreTable)).toEqual(
                            baselineCoreTableShapes[coreTable],
                        );
                    }
                } finally {
                    // In a `finally` so that the schema is restored however the assertions above ended. Leaving a
                    // reverted schema behind would make every sibling case in this file fail for a reason that had
                    // nothing to do with it.
                    secondApply = await applyMigrationsGuarded();
                }

                expect(
                    secondApply.migrationsRan,
                    `the second apply must succeed rather than failing on an object it believes already exists`,
                ).toContain(migrationUnderTestName);
                expect(
                    secondApply.observedExitCode,
                    'the second apply signalled a failure through process.exitCode',
                ).toBeUndefined();

                // IDENTICAL, TABLE BY TABLE AND COLUMN BY COLUMN, against the snapshot taken after the first apply.
                // The comparison is a normalised deep-equality over ordered column descriptors together with the
                // unique, index and check names, so a catalogue that returns its objects in another order cannot
                // fail it while a column, a width, a nullability, a default or a named object that changed does.
                expect(await snapshotPluginSchema()).toEqual(afterFirstApply);

                expect(await countRows(LIST_TABLE)).toBe(0);
                expect(await countRows(LINE_TABLE)).toBe(0);
                const reseeded = await seedPluginRows();
                expect(await countRows(LIST_TABLE)).toBe(1);
                expect(await countRows(LINE_TABLE)).toBe(2);

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
