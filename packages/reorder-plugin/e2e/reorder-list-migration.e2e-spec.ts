/**
 * The **one additive migration** of `@vendure/reorder-plugin`, exercised end to end.
 */
import { CurrencyCode, LanguageCode } from '@vendure/common/lib/generated-types';
import {
    Channel,
    Customer,
    DefaultEntityAccessControlStrategy,
    mergeConfig,
    Product,
    ProductVariant,
    RequestContext,
    RequestContextCacheService,
    resetConfig,
    revertLastMigration,
    runMigrations,
    TransactionalConnection,
    User,
    VendureConfig,
} from '@vendure/core';
import { preBootstrapConfig } from '@vendure/core/dist/bootstrap';
import { TransactionWrapper } from '@vendure/core/dist/connection/transaction-wrapper';
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
import { ReorderList, ReorderListLine, ReorderPlugin } from '../index';
import { AddReorderLists1786838400000 } from '../src/migrations/1786838400000-add-reorder-lists';
// Deliberately a deep import: the root barrel publishes exactly the four symbols a deployment configures this
// plugin through (AAP §0.2.4.1), and the migration constant is not one of them — a deployment registers the
// emitted file by glob, which is what the dev-server assertions below read back. This suite needs the class as
// a value, so it reaches the module that declares it.
import { reorderPluginMigrations } from '../src/reorder.plugin';
import { ReorderListService } from '../src/service/reorder-list.service';
import { ReorderPluginOptions } from '../src/types';

import {
    describeRowDifferences,
    NO_ROW_DIFFERENCE,
    redactTeardownDiagnostic,
} from './fixtures/concurrency-barrier';
import {
    attemptEveryCleanup,
    CleanupStep,
    committedMigrationApplies,
    createIsolatedDatabase,
    extractGeneratedStatements,
    generateLifecycleMigration,
    IsolatedDatabase,
    LifecycleMigration,
    openDataSource,
    resolveConfiguredEngine,
    restorePlatformConfig,
} from './fixtures/query-capture';

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
 * The CHECKED-IN migration's class name, **derived from the imported class rather than restated as a string**.
 */
const SHIPPED_MIGRATION_CLASS_NAME = AddReorderLists1786838400000.name;

/**
 * The text of `dbConnectionOptions: { … }` as `packages/dev-server/dev-config.ts` declares it.
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
 */
const POSTGRES_EMISSION_MARKERS = ['SERIAL', 'character varying', 'DEFAULT now()'] as const;

/**
 * The schema the generation connection was configured with, which the emission bakes into one statement.
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

const UQ_LIST_OWNER_NAME_KEY = 'UQ_reorder_list_customer_channel_name_key';

/** Non-unique index over `(customerId, channelId)` on `reorder_list`, serving the ownership predicate. */
const IDX_LIST_OWNER = 'IDX_reorder_list_customer_channel';

const UQ_LINE_LIST_VARIANT = 'UQ_reorder_list_line_list_variant';

const CHK_LINE_QUANTITY_POSITIVE = 'CHK_reorder_list_line_quantity_positive';

const CHK_LIST_LINE_COUNT_NON_NEGATIVE = 'CHK_reorder_list_line_count_non_negative';

/**
 * The frozen names of the two cascading references whose referent is not implied by their own column.
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
 * The number of named objects the feature contract authorises across both plugin tables, asserted as a number rather
 * than left implicit in the length of the array above.
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
 * Every named object the contract authorises on one plugin table that the given engine can actually MATERIALISE,
 * sorted.
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
const DECLARED_OPTIONS: Readonly<Required<ReorderPluginOptions>> = {
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
    migrationsRan: string[];
    observedExitCode: number | string | undefined;
}

/** The names an engine's own catalogue holds, gathered through the view appropriate to that engine. */
interface EngineCatalogue {
    /** Names filed as unique constraints or as unique indices — the two classes are engine-dependent. */
    uniqueNames: string[];
    indexNames: string[];
    /** Names filed as check constraints. Empty on the MySQL family, which is conflict C-E. */
    checkNames: string[];
    source: string;
}

/**
 * One plugin table's whole named-object inventory as the engine's own catalogue holds it, reduced to the objects
 * this feature is answerable for.
 */
interface TableCatalogueReading {
    table: string;
    /** Every named object the engine files for this table, minus the identifier and reference artefacts. */
    names: string[];
    identifierArtefacts: string[];
    referenceArtefacts: string[];
    source: string;
}

/**
 * The harness configuration, built at the **top level of this spec file** and deliberately **without `ReorderPlugin`
 * registered**.
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
     * Reads ONE plugin table's named-object inventory out of the engine's own catalogue, scoped to that table and
     * reduced to the objects this feature is answerable for. See {@link TableCatalogueReading} for why the scope and
     * the two exclusions are what they are.
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

        migrationSource = await fs.readFile(MIGRATION_FILE_PATH, 'utf-8');

        await server.init({
            initialData,
            customerCount: SEEDED_CUSTOMER_COUNT,
            productsCsvPath: path.join(__dirname, '../../core/e2e/fixtures/e2e-products-minimal.csv'),
        });

        const rawConnection = server.app.get(TransactionalConnection).rawConnection;
        activeEngine = rawConnection.options.type;

        // STEP ONE — THE MIGRATION TARGET, which is the database every executing assertion below reads. On the
        // three server engines it is the suite's own database, addressed exactly as the harness left it: a
        // migration connection and this file's connection reach the same physical database, so there is nothing
        // to arrange. On the SQLite family it CANNOT be.
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

        // Step two — the precondition and the known-good baseline, both read off the TARGET rather than off the
        // server, so that on the SQLite family they describe the copy the cycle will actually run against
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
                pluginTablesBeforeAnyApply = [];
                for (const table of PLUGIN_TABLES_CHILD_FIRST) {
                    if (await queryRunner.hasTable(table)) {
                        pluginTablesBeforeAnyApply.push(table);
                    }
                }

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

        // STEP THREE — THE MIGRATION UNDER TEST.
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
        // data source this file owns, addressing the target resolved in step one.
        migrationConfig = migrationTargetConfig(targetConnectionOptions, [migrationUnderTest]);

        firstApply = await applyMigrationsGuarded();

        await openAssertionDataSource();

        pluginTablesAfterFirstAttempt = await existingPluginTables();

        // Nothing may be inherited by the first case: a previous run against a server engine is impossible (the
        // initializer drops and recreates the database) but a partially applied migration is not, so the tables
        // start empty by assertion of this call rather than by assumption.
        await deleteAllPluginRows();
    }, TEST_SETUP_TIMEOUT_MS);

    afterEach(async () => {
        try {
            await deleteAllPluginRows();
        } finally {
            process.exitCode = ambientExitCode;
            resetConfig();
        }
    });

    afterAll(async () => {
        // Every step is attempted, rather than awaited in a chain. This teardown releases five independent
        // things — a data source, the generated migration's temporary directory, the snapshot copy's temporary
        // directory, two pieces of mutated process state and a listening server — and a chain of awaits would
        // let the least important of them decide whether the most important one is released. The server is LAST
        // and is still reached however the four before it end, which is the property that keeps a leaked port
        // out of the next file.
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

            expect(entries, `${MIGRATIONS_DIR} must hold exactly one migration`).toEqual([
                MIGRATION_FILENAME,
            ]);
        });

        it('is emitted into the published package, at the path a consumer registers', async () => {
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

            expect(SHIPPED_MIGRATION_CLASS_NAME).toMatch(/\d+$/);
            expect(MIGRATION_FILENAME.startsWith(SHIPPED_MIGRATION_CLASS_NAME.replace(/^\D+/, ''))).toBe(
                true,
            );
        });

        it('is the generator emitted form, every statement issued through queryRunner.query', () => {
            // The form is what identifies the artefact as generated rather than transcribed.
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
            // The property a historical migration lives or dies by. A migration that builds its tables from
            // `getMetadata(ReorderList)` describes whatever that class says at REPLAY time, not what this
            // timestamp created — so the moment a later feature adds a column to the entity, this older
            // migration starts creating it on a fresh database and that feature's own `ADD COLUMN` collides
            // with a column its migration never created. EPIC-001 §7.8 L603 assigns exactly such a column to
            // FEATURE-001-06's later migration, so the hazard is scheduled rather than theoretical.
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
            expect(ALL_NAMED_OBJECTS.map(namedObject => namedObject.name).sort()).toEqual(
                [...authorizedNamedObjectsOn(LIST_TABLE), ...authorizedNamedObjectsOn(LINE_TABLE)].sort(),
            );
            expect(ALL_NAMED_OBJECTS).toHaveLength(AUTHORIZED_NAMED_OBJECT_COUNT);
            expect(new Set(ALL_NAMED_OBJECTS.map(namedObject => namedObject.name)).size).toBe(
                AUTHORIZED_NAMED_OBJECT_COUNT,
            );

            // BOTH DIRECTIONS OF THE EMITTED TEXT, which is what this artefact hands the engine. `up()` must
            // spell every authorised name and no other, and `down()` must spell no name the contract does not
            // authorise — a name in one direction alone would be a divergence between what a deployment creates
            // and what it drops.
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
            // another schema regenerates the file against its own connection.
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
            // deployment and every e2e suite here gets its schema.
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
            // because a parent still referenced cannot be dropped. Read off the emitted statements in the order
            // the generator serialised them.
            expect(tablesInOrder(emittedStatements(migrationSource, 'up'), 'CREATE TABLE')).toEqual([
                ...PLUGIN_TABLES_PARENT_FIRST,
            ]);
            expect(tablesInOrder(emittedStatements(migrationSource, 'down'), 'DROP TABLE')).toEqual([
                ...PLUGIN_TABLES_CHILD_FIRST,
            ]);

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

                expect(columnsSpannedBy(statement, namedObject.name).slice().sort()).toEqual(
                    namedObject.columns.slice().sort(),
                );
            }
        });

        it('carries both named check constraints, which generating against PostgreSQL is what buys', () => {
            // Conflict C-E, located rather than assumed. Both checks are here, inline in the `CREATE TABLE`
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

            expect(up).toContain(`CONSTRAINT "${CHK_LINE_QUANTITY_POSITIVE}" CHECK ("quantity" > 0)`);
            expect(up).toContain(`CONSTRAINT "${CHK_LIST_LINE_COUNT_NON_NEGATIVE}" CHECK ("lineCount" >= 0)`);
        });

        it('carries the denormalised line counter and both bounded name columns at their declared width', () => {
            const listTable = String(statementCreating(migrationSource, LIST_TABLE));
            for (const column of ['lineCount', 'name', 'nameKey']) {
                expect(listTable).toContain(`"${column}"`);
            }

            // 191 on both name columns. A key-size ceiling on the MySQL family rather than a product choice,
            // which is why the same number is the plugin's fixed name-length bound.
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
            // contract withdraws all three objects and the story's own migration sub-task and
            // Definition-of-Done item make their ABSENCE the assertion. The seats counter belongs to
            // FEATURE-001-06's own later migration, so this file must never be edited to add it either.
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
    // By a glob at the plugin's own migrations directory, which is what AAP section 0.8.3.5 conflict C-D option
    // A specifies: "append the plugin's migration glob to the existing `dbConnectionOptions.migrations` array".
    // EXACTLY ONE pattern, and that is the load-bearing part. The package carries its migration in two layouts
    // — `src/migrations/*.ts` in a checkout and `lib/src/migrations/*.js` in the published artefact — and a
    // built checkout carries both, so a configuration naming a pattern for each would hand TypeORM two
    // migrations of one name and be refused in full (`MigrationExecutor.checkForDuplicateMigrations`).

    describe('the registration the dev server carries', () => {
        it("appends exactly one glob at the plugin's own migrations directory", async () => {
            const devConfigSource = await fs.readFile(DEV_CONFIG_FILE_PATH, 'utf-8');
            const options = dbConnectionOptionsBlockOf(devConfigSource);

            // ONE APPENDED CLAUSE, and the pattern that was already there is still first.
            const migrationsArray = /migrations: \[([\s\S]*?)\n {8}\],/.exec(options);
            expect(migrationsArray, 'dev-config must declare a migrations array').not.toBeNull();
            const entries = [...(migrationsArray as RegExpExecArray)[1].matchAll(/path\.join\([^)]*\)/g)].map(
                match => match[0],
            );
            expect(entries).toEqual([
                "path.join(__dirname, 'migrations/*.ts')",
                "path.join(__dirname, '../reorder-plugin/src/migrations/*.ts')",
            ]);
            expect(
                (migrationsArray as RegExpExecArray)[1].replace(/path\.join\([^)]*\),?/g, '').trim(),
                'the migrations array must carry exactly the two path.join entries and nothing else',
            ).toBe('');

            // And it names ONE layout. Both layouts declare `AddReorderLists1786838400000`, so a pattern for
            // each would hand TypeORM two migrations of one name and be refused in full — which is why the
            // built layout must NOT also be named. Asserted over the array's own text rather than over the
            // whole options block, because the comment above the array names the compiled layout in prose to
            // tell a reader what an installed package registers instead.
            expect(
                (migrationsArray as RegExpExecArray)[1],
                'naming the compiled layout as well would register the same migration twice',
            ).not.toContain('lib/src/migrations');

            expect(devConfigSource).toContain("import { ReorderPlugin } from '@vendure/reorder-plugin';");
            expect(
                devConfigSource,
                'the root barrel does not publish the migration constant, so nothing may import it here',
            ).not.toContain('reorderPluginMigrations');
            expect(
                devConfigSource,
                'a glob registration needs no filesystem probe, so no such probe may appear',
            ).not.toContain("import fs from 'fs'");
            expect(
                devConfigSource,
                'the registration must not vary by which script Node was handed',
            ).not.toContain('process.argv');
        });

        it('resolves that glob to exactly one migration file, in each layout', async () => {
            const registeredDir = path.resolve(
                path.dirname(DEV_CONFIG_FILE_PATH),
                '../reorder-plugin/src/migrations',
            );
            const sourceEntries = (await fs.readdir(registeredDir))
                .filter(entry => entry.endsWith('.ts'))
                .sort();
            expect(sourceEntries).toEqual([MIGRATION_FILENAME]);
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

            expect(reorderPluginMigrations).toEqual([AddReorderLists1786838400000]);
            expect(reorderPluginMigrations.map(migration => migration.name)).toEqual([
                SHIPPED_MIGRATION_CLASS_NAME,
            ]);
            expect(Object.isFrozen(reorderPluginMigrations)).toBe(true);
        });
    });

    describe('the configuration that drives the migration', () => {
        it('is synchronization-free because the platform forces it, on every entry point', async () => {
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

            // THE DECLARATION IS THE HARNESS'S, NOT THIS FEATURE'S, AND THAT IS THE ASSERTION. AAP section
            // 0.4.1.1 permits three changes to this file and a `synchronize` of its own is not one of them, so
            // the key stays where the harness put it — first in the object, ABOVE the engine spread — and this
            // feature adds none of its own.
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

            // The registration itself, with the five declared option values: the second of the three changes
            // AAP §0.4.1.1 sanctions, and the values the plan supplies.
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

            expect(devConfigSource, 'no custom field may be registered').toContain('customFields: {},');
            expect(devConfigSource, 'no custom permission may be registered').toContain(
                'customPermissions: [],',
            );
        });
    });

    // Which artefact this run executed, and why. Everything below this point reads a schema a migration built,
    // and which migration that was differs by engine — see {@link MIGRATION_UNDER_TEST_CITATION} — so a reader
    // of a failure two hundred lines further down cannot tell which without being told. The choice is therefore
    // asserted rather than left implicit in a helper, against the same predicate five sibling suites read the
    // dialect question through, and the generated artefact is checked to be a lifecycle emission rather than
    // anything else.

    describe('the migration this engine applies', () => {
        it("applied the checked-in artefact where its dialect matches, and this engine's own emission otherwise", () => {
            expect(
                migrationProvenance,
                `${activeEngine} must apply ${
                    appliesShippedMigration ? 'the checked-in artefact' : 'its own lifecycle emission'
                }. ${MIGRATION_UNDER_TEST_CITATION}`,
            ).toBe(appliesShippedMigration ? 'committed-migration' : 'lifecycle-generated');
            expect(appliesShippedMigration).toBe(committedMigrationApplies(activeEngine));

            if (migrationProvenance === 'committed-migration') {
                expect(migrationUnderTest).toBe(AddReorderLists1786838400000);
                expect(migrationUnderTestName).toBe(SHIPPED_MIGRATION_CLASS_NAME);
                expect(generatedMigration, 'nothing was generated on this engine').toBeUndefined();
            } else {
                expect(generatedMigration, 'this engine needed an emission of its own').toBeDefined();
                expect(migrationUnderTest).toBe(generatedMigration?.migrationClass);
                expect(migrationUnderTestName).toBe(generatedMigration?.className);
                expect(migrationUnderTestName).toMatch(/^AddReorderLists\d+$/);
            }

            expect(
                firstApply.migrationsRan,
                `runMigrations recorded a different migration than the one this file registered. ${MIGRATION_UNDER_TEST_CITATION}`,
            ).toEqual([migrationUnderTestName]);
        });

        it('generated that emission through the platform lifecycle, outside this repository', async () => {
            if (generatedMigration === undefined) {
                // STATED RATHER THAN SKIPPED. On the engine the checked-in artefact was generated for there is
                // nothing to generate, and the assertion that nothing was is the evidence — a run that quietly
                // generated a second migration here would be measuring an artefact nobody reviewed.
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
            // `queryRunner.query(<SQL>)` calls (`packages/core/src/migrate.ts:L127-L179`).
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
                // configuration's own `process.env.DB || 'sqljs'`).
                expect(
                    activeEngine,
                    'the running data source is not the engine this e2e run was configured for',
                ).toBe(resolveConfiguredEngine());
                expect(assertionDataSource.options.type).toBe(activeEngine);

                expect(
                    pluginTablesBeforeAnyApply,
                    'the harness registers no plugin, so the initializer must have synchronised the core schema alone',
                ).toEqual([]);

                // AND THE MIGRATION IS WHAT CREATED THEM, on whichever engine this run configured.
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
                // compared digit for digit rather than string for string, because one engine writes `0`,
                // another `'0'` and a third `(0)` for the same value.
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
                // text. The name is what a revert addresses, so a constraint that enforces the right rule under
                // a name nothing will look for again is a defect the shape assertions above cannot see.
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

                // And nowhere in the engine's whole catalogue either, so a stray object on a table this suite
                // does not inspect is still a finding.
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
                        // The gap, stated positively. Not skipped, and not tolerated silently: the constraint
                        // is asserted ABSENT here, because on this engine family TypeORM 0.3.28 cannot create
                        // it and an assertion that it existed would be asserting a falsehood.
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

    // HALF TWO, PART TWO — the engine's own enforcement of each named object The four constraints are evidenced
    // by the writes they forbid; `IDX_reorder_list_customer_channel` is evidenced by an engine-catalogue read,
    // because a non-unique index constrains no value and forbids no write. Each case in its own `it`, each
    // building its own precondition, each issued straight through the repository. They are sequential single
    // writes rather than interleavings, so there is no barrier anywhere in this file.

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
                    // The gap, observed rather than assumed. Both writes land, because the constraint does not
                    // exist on this engine family. The invariant is not therefore unguarded: the service
                    // refuses a non-positive quantity with a top-level `UserInputError` before any statement is
                    // issued, on every engine, and the create, add-item and mutate suites assert that.
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
            // migration that had failed outright, so the exit code the platform left behind is read.
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
                    // down-path fails and the one a schema-only cycle cannot make. The plugin rows are expected
                    // to be gone with their tables — a down-path that preserved them would be keeping rows
                    // whose table it dropped. THE COMPARISON IS OVER FULL VALUES; THE ASSERTION IS OVER A
                    // REDACTED DESCRIPTION OF THE RESULT.
                    for (const coreTable of REFERENCED_CORE_TABLES) {
                        const survivors = await selectAllRows(coreTable);
                        expect(
                            describeRowDifferences(baselineCoreRows[coreTable], survivors),
                            `the down-path took or changed a row in "${coreTable}"; the difference is reported ` +
                                'by row id, column name and value SHAPE only, deliberately — see ' +
                                'describeCellForDiagnostic in e2e/fixtures/concurrency-barrier.ts',
                        ).toBe(NO_ROW_DIFFERENCE);
                        expect(
                            survivors.length,
                            `the down-path changed how many rows "${coreTable}" holds`,
                        ).toBe(baselineCoreRows[coreTable].length);
                    }

                    for (const coreTable of REFERENCED_CORE_TABLES) {
                        expect(await readTableSnapshot(coreTable)).toEqual(
                            baselineCoreTableShapes[coreTable],
                        );
                    }
                } finally {
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

describe('attemptEveryCleanup', () => {
    /**
     * A step that records the order it ran in, and optionally fails.
     *
     * The recorder is shared rather than per-step so the assertions can read the ACTUAL order of execution,
     * which is the property under test — that every step ran, and in the order it was given.
     */
    function recordingStep(
        ran: string[],
        what: string,
        failure?: { message: string; asynchronous: boolean },
    ): CleanupStep {
        return {
            what,
            run: () => {
                ran.push(what);
                if (failure === undefined) {
                    return undefined;
                }
                if (failure.asynchronous) {
                    return Promise.reject(new Error(failure.message));
                }
                throw new Error(failure.message);
            },
        };
    }

    describe('attempts every step, whatever an earlier one does', () => {
        it('runs the steps behind a failure, in order', async () => {
            const ran: string[] = [];
            await expect(
                attemptEveryCleanup([
                    recordingStep(ran, 'first', { message: 'first failed', asynchronous: true }),
                    recordingStep(ran, 'second'),
                    recordingStep(ran, 'third'),
                ]),
                // Keyed on the STEP LABEL, not on the failure message: the message is measured rather
                // than reproduced, and the label is what identifies the step that broke anyway.
            ).rejects.toThrow(/1 of 3 failed: first —/);

            expect(ran, 'a step behind the failure did not run').toEqual(['first', 'second', 'third']);
        });

        it('runs the steps behind a SYNCHRONOUS throw as well as behind a rejected promise', async () => {
            const ran: string[] = [];
            await expect(
                attemptEveryCleanup([
                    recordingStep(ran, 'sync-thrower', { message: 'thrown outright', asynchronous: false }),
                    recordingStep(ran, 'after-sync'),
                ]),
            ).rejects.toThrow(/1 of 2 failed: sync-thrower —/);

            expect(ran).toEqual(['sync-thrower', 'after-sync']);
        });

        it('attempts the last step even when every earlier step fails', async () => {
            // The shape the migration suite's teardown actually has: `server.destroy()` is last, and a leaked
            // listening port breaks the NEXT file rather than this one.
            const ran: string[] = [];
            await expect(
                attemptEveryCleanup([
                    recordingStep(ran, 'a', { message: 'a failed', asynchronous: true }),
                    recordingStep(ran, 'b', { message: 'b failed', asynchronous: false }),
                    recordingStep(ran, 'destroy-the-server'),
                ]),
            ).rejects.toThrow(/2 of 3 failed: a —/);

            expect(ran).toContain('destroy-the-server');
        });
    });

    describe('reports what failed rather than swallowing it', () => {
        it('names every failure and how many of how many there were', async () => {
            await expect(
                attemptEveryCleanup([
                    {
                        what: 'dropping the isolated database',
                        run: () => Promise.reject(new Error('no such database')),
                    },
                    { what: 'removing the temporary directory', run: () => undefined },
                    {
                        what: 'restoring the platform configuration',
                        run: () => {
                            throw new Error('config already reset');
                        },
                    },
                ]),
                // The step labels, the fraction, and each failure MEASURED — its class, its
                // classification and its length — rather than either message reproduced.
            ).rejects.toThrow(
                new RegExp(
                    'teardown attempted every step and 2 of 3 failed: ' +
                        'dropping the isolated database — Error \\[unclassified\\] ' +
                        'mentioning nothing recognised \\(message withheld, 16 chars\\); ' +
                        'restoring the platform configuration — Error \\[unclassified\\] ' +
                        'mentioning nothing recognised \\(message withheld, 20 chars\\)',
                ),
            );
        });

        it('reports a non-Error rejection without losing that there was one', async () => {
            await expect(
                attemptEveryCleanup([
                    { what: 'releasing a query runner', run: () => Promise.reject('a bare string') },
                ]),
            ).rejects.toThrow(/releasing a query runner — string \[unclassified\]/);
        });

        it('reproduces nothing from a driver failure, and still says what a reader needs', async () => {
            // The case this aggregator exists to get right. The steps it releases are a query runner, a data
            // source, a generated directory, an isolated database, mutated process state and a running server —
            // so a failure arriving here is a TypeORM `QueryFailedError`, which has copied the driver's own
            // error onto itself and therefore carries the statement and its bound parameters as ENUMERABLE
            // properties. This aggregate is thrown, printed by the runner and read in a build log.
            const email = 'someone.real@example.invalid';
            const driverFailure = Object.assign(
                new Error(`Duplicate entry '${email}' for key 'UQ_reorder_list_line_list_variant'`),
                {
                    name: 'QueryFailedError',
                    code: 'ER_DUP_ENTRY',
                    errno: 1062,
                    query: 'INSERT INTO `customer` (`emailAddress`) VALUES (?)',
                    parameters: [email],
                    driverError: { sqlMessage: `Duplicate entry '${email}'`, sqlState: '23000' },
                },
            );

            let aggregated = '';
            try {
                await attemptEveryCleanup([
                    { what: 'dropping the isolated database', run: () => Promise.reject(driverFailure) },
                ]);
            } catch (err: unknown) {
                aggregated = err instanceof Error ? err.message : String(err);
            }

            // What a reader NEEDS: the step, the error class, the enumerated driver code and errno, how the
            // failure classifies, and the schema object the driver named.
            expect(aggregated).toContain('dropping the isolated database');
            expect(aggregated).toContain('QueryFailedError/ER_DUP_ENTRY#1062');
            expect(aggregated).toContain('[unique-violation]');
            for (const secret of [email, 'INSERT', 'VALUES', '23000', 'Duplicate']) {
                expect(
                    aggregated.includes(secret),
                    `the teardown aggregate disclosed "${secret.slice(0, 3)}"`,
                ).toBe(false);
            }
        });

        it('refuses a step label that carries a value, because a per-resource label invites one', async () => {
            let aggregated = '';
            try {
                await attemptEveryCleanup([
                    {
                        what: '/var/folders/T/reorder-plugin-a1b2c3/migrations',
                        run: () => Promise.reject(new Error('busy')),
                    },
                ]);
            } catch (err: unknown) {
                aggregated = err instanceof Error ? err.message : String(err);
            }

            expect(aggregated).toContain('<unrenderable-stage-label>');
            expect(aggregated.includes('/var/folders')).toBe(false);
            expect(aggregated.includes('reorder-plugin-a1b2c3')).toBe(false);
        });

        it('resolves silently when every step succeeds', async () => {
            const ran: string[] = [];
            await expect(
                attemptEveryCleanup([recordingStep(ran, 'one'), recordingStep(ran, 'two')]),
            ).resolves.toBeUndefined();
            expect(ran).toEqual(['one', 'two']);
        });

        it('resolves silently for no steps at all', async () => {
            await expect(attemptEveryCleanup([])).resolves.toBeUndefined();
        });
    });

    describe('composes with itself, which is how per-resource granularity is expressed', () => {
        it('surfaces a nested aggregate inside the outer one', async () => {
            const ran: string[] = [];
            await expect(
                attemptEveryCleanup([
                    {
                        what: 'removing the temporary directories',
                        run: () =>
                            attemptEveryCleanup([
                                recordingStep(ran, 'dir-1', { message: 'busy', asynchronous: true }),
                                recordingStep(ran, 'dir-2'),
                            ]),
                    },
                    recordingStep(ran, 'destroy-the-server'),
                ]),
            ).rejects.toThrow(
                /removing the temporary directories — Error \[unclassified\] mentioning nothing recognised/,
            );

            expect(ran, 'a nested step or the outer step behind it did not run').toEqual([
                'dir-1',
                'dir-2',
                'destroy-the-server',
            ]);
        });
    });
});

// Schema-qualified rendering, on the one engine whose harness honours DB_SCHEMA.
//
// Every statement the service writes names its tables through TypeORM metadata rather than a bare literal, so
// a deployment that puts the plugin tables in a non-default schema still reaches its own rows. A decoy row of
// the same identifier in the search-path schema is what makes that measurable: if a statement resolved
// through the search path instead, it would reach the decoy.

/** The non-public schema the real rows live in — the one a `DB_SCHEMA` deployment would configure. */
const CONFIGURED_SCHEMA = 'reorder_alt';

/** The schema a bare, unqualified reference resolves to through PostgreSQL's default search path. */
const SEARCH_PATH_SCHEMA = 'public';

/**
 * How far the decoy owner's identifiers are moved away from the real owner's.
 *
 * Each schema has its own sequences, so rows seeded independently into the two are allocated the SAME
 * identifiers — which would make the decoy answer the ownership question correctly by coincidence and this suite
 * unable to fail. The offset is what makes the decoy's answer demonstrably the wrong one.
 */
const DECOY_OWNER_OFFSET = 1000;

/** Schema-qualified rendering is measurable only on the harness branch that honours `DB_SCHEMA`. */
const rendersQualifiedIdentifiers = activeConfiguredEngine === 'postgres';

describe.skipIf(!rendersQualifiedIdentifiers)(
    'the ownership predicate on a connection that qualifies its identifiers (PostgreSQL)',
    () => {
        let isolation: IsolatedDatabase;
        let configuredDataSource: DataSource;
        let decoyDataSource: DataSource;
        let service: ReorderListService;
        let ctx: RequestContext;
        let seeded: SeededRows;

        beforeAll(async () => {
            isolation = await createIsolatedDatabase(
                testConfig(),
                activeConfiguredEngine,
                'schema_qualified',
            );
            await createSchema(isolation, CONFIGURED_SCHEMA);

            configuredDataSource = await synchronisedDataSource(isolation, CONFIGURED_SCHEMA);
            decoyDataSource = await synchronisedDataSource(isolation, SEARCH_PATH_SCHEMA);

            seeded = await seedConfiguredSchema(configuredDataSource);
            await seedDecoySchema(decoyDataSource, seeded);

            service = buildService(configuredDataSource);
            ctx = buildContext(seeded);
        }, 240_000);

        afterAll(async () => {
            await attemptEveryCleanup([
                {
                    what: 'closing the configured-schema data source',
                    run: () => configuredDataSource?.destroy(),
                },
                { what: 'closing the decoy-schema data source', run: () => decoyDataSource?.destroy() },
                { what: 'dropping the isolated database', run: () => isolation?.dispose() },
                {
                    what: 'restoring the platform configuration this suite resolved',
                    run: () => restorePlatformConfig(testConfig()),
                },
            ]);
        }, 120_000);

        it('resolves the plugin tables to the configured schema, not to the search path', () => {
            expect(configuredDataSource.getMetadata(ReorderList).tablePath).toBe(
                `${CONFIGURED_SCHEMA}.reorder_list`,
            );
            expect(configuredDataSource.getMetadata(ReorderListLine).tablePath).toBe(
                `${CONFIGURED_SCHEMA}.reorder_list_line`,
            );
            expect(decoyDataSource.getMetadata(ReorderList).tablePath).toBe(
                `${SEARCH_PATH_SCHEMA}.reorder_list`,
            );
        });

        it('carries a decoy list of the same id in the search-path schema, owned by somebody else', async () => {
            // The adversarial fixture itself, asserted rather than trusted. The decoy shares the real list's
            // identifier — sequential ids make that ordinary — and names a different customer, so a sub-query
            // that reads it cannot answer the ownership question correctly for this caller.
            const decoy = await decoyDataSource
                .createQueryBuilder()
                .select(['list.id AS id', 'list.customerId AS "customerId"'])
                .from(ReorderList, 'list')
                .where('list.id = :id', { id: seeded.listId })
                .getRawOne<{ id: number; customerId: number }>();
            expect(decoy, 'the decoy list row was not created').toBeDefined();
            expect(Number(decoy?.customerId)).not.toBe(seeded.customerId);
        });

        it('sets an absolute quantity on the configured schema, leaving the decoy untouched', async () => {
            const result = await service.adjustReorderListLine(ctx, {
                reorderListId: seeded.listId,
                lineId: seeded.lineId,
                quantity: 7,
            });

            expect(result).toBeInstanceOf(ReorderList);
            expect(await quantityIn(configuredDataSource, seeded.lineId)).toBe(7);
            expect(await quantityIn(decoyDataSource, seeded.lineId)).toBe(1);
        });

        it('accumulates onto an existing line of the configured schema', async () => {
            const before = await quantityIn(configuredDataSource, seeded.lineId);

            const result = await service.addItemToReorderList(ctx, {
                reorderListId: seeded.listId,
                productVariantId: seeded.variantId,
                quantity: 2,
            });

            expect(result).toBeInstanceOf(ReorderList);
            expect(before, 'the line this test accumulates onto is missing').toBeDefined();
            expect(await quantityIn(configuredDataSource, seeded.lineId)).toBe((before ?? 0) + 2);
            expect(await quantityIn(decoyDataSource, seeded.lineId)).toBe(1);
        });

        it('inserts a new line and claims capacity on the configured schema', async () => {
            const result = await service.addItemToReorderList(ctx, {
                reorderListId: seeded.listId,
                productVariantId: seeded.secondVariantId,
                quantity: 3,
            });

            expect(result).toBeInstanceOf(ReorderList);
            expect(await lineCountIn(configuredDataSource, seeded.listId)).toBe(2);
            // The parent counter of the decoy list is untouched, which is the same claim for the statement that
            // writes `lineCount` as the line assertions are for the statements that write a line.
            expect(await lineCountIn(decoyDataSource, seeded.listId)).toBe(1);
        });

        it('removes a line from the configured schema and decrements only its own counter', async () => {
            const result = await service.removeReorderListLine(ctx, {
                reorderListId: seeded.listId,
                lineId: seeded.lineId,
            });

            expect(result).toBeInstanceOf(ReorderList);
            expect(await quantityIn(configuredDataSource, seeded.lineId)).toBeUndefined();
            expect(await lineCountIn(configuredDataSource, seeded.listId)).toBe(1);
            expect(await quantityIn(decoyDataSource, seeded.lineId)).toBe(1);
            expect(await lineCountIn(decoyDataSource, seeded.listId)).toBe(1);
        });
    },
);

/** What the configured schema was seeded with, carried to the decoy seeder and to the service builder. */
interface SeededRows {
    channelId: number;
    userId: number;
    customerId: number;
    listId: number;
    lineId: number;
    variantId: number;
    secondVariantId: number;
}

/**
 * Creates a schema in the isolated database.
 */
async function createSchema(isolation: IsolatedDatabase, schema: string): Promise<void> {
    const dataSource = new DataSource({
        ...(isolation.dbConnectionOptions as object),
        entities: [],
        subscribers: [],
        migrations: [],
        synchronize: false,
        migrationsRun: false,
        dropSchema: false,
        logging: false,
    } as unknown as DataSourceOptions);
    await dataSource.initialize();
    try {
        await dataSource.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    } finally {
        await dataSource.destroy();
    }
}

/**
 * Opens a data source addressing one schema of the isolated database, with the platform's whole entity set
 * synchronised into it.
 */
async function synchronisedDataSource(isolation: IsolatedDatabase, schema: string): Promise<DataSource> {
    const resolved = await preBootstrapConfig(
        mergeConfig(testConfig(), {
            plugins: [ReorderPlugin.init(DECLARED_OPTIONS)],
            dbConnectionOptions: {
                ...(isolation.dbConnectionOptions as object),
                schema,
                synchronize: false,
                migrationsRun: false,
                dropSchema: false,
                migrations: [],
            },
        } as never),
    );
    return openDataSource({
        ...(resolved.dbConnectionOptions as object),
        schema,
        synchronize: true,
    } as unknown as DataSourceOptions);
}

/**
 * Seeds the configured schema with the smallest set of rows the three line-writing paths need: a channel, a
 * user, the customer bound to it, a product, two variants, one list and one line.
 *
 * Rows are saved through the platform's own entities rather than by raw insert, so every not-null column and
 * every foreign key is satisfied the way production satisfies it.
 */
async function seedConfiguredSchema(dataSource: DataSource): Promise<SeededRows> {
    const channel = await dataSource.getRepository(Channel).save(
        new Channel({
            code: 'schema-qualified-channel',
            token: 'schema-qualified-token',
            defaultLanguageCode: LanguageCode.en,
            availableLanguageCodes: [LanguageCode.en],
            defaultCurrencyCode: CurrencyCode.USD,
            availableCurrencyCodes: [CurrencyCode.USD],
            pricesIncludeTax: true,
        }),
    );
    const user = await dataSource.getRepository(User).save(
        new User({
            identifier: 'schema-qualified@example.test',
            verified: true,
            authenticationMethods: [],
            roles: [],
        }),
    );
    const customer = await dataSource.getRepository(Customer).save(
        new Customer({
            firstName: 'Schema',
            lastName: 'Qualified',
            emailAddress: 'schema-qualified@example.test',
            user,
        }),
    );
    const product = await dataSource.getRepository(Product).save(new Product({ enabled: true }));
    const variants = await dataSource.getRepository(ProductVariant).save([
        new ProductVariant({
            enabled: true,
            sku: 'SCHEMA-QUALIFIED-1',
            productId: product.id as never,
            outOfStockThreshold: 0,
            useGlobalOutOfStockThreshold: true,
        }),
        new ProductVariant({
            enabled: true,
            sku: 'SCHEMA-QUALIFIED-2',
            productId: product.id as never,
            outOfStockThreshold: 0,
            useGlobalOutOfStockThreshold: true,
        }),
    ]);
    const list = await dataSource.getRepository(ReorderList).save(
        new ReorderList({
            customerId: customer.id,
            channelId: channel.id,
            name: 'Schema qualified list',
            nameKey: 'schema qualified list',
            lineCount: 1,
        }),
    );
    const line = await dataSource.getRepository(ReorderListLine).save(
        new ReorderListLine({
            reorderListId: list.id,
            productVariantId: variants[0].id,
            quantity: 1,
        }),
    );
    return {
        channelId: Number(channel.id),
        userId: Number(user.id),
        customerId: Number(customer.id),
        listId: Number(list.id),
        lineId: Number(line.id),
        variantId: Number(variants[0].id),
        secondVariantId: Number(variants[1].id),
    };
}

/**
 * Seeds the search-path schema with the decoy: a list carrying the SAME identifier as the real one but a different
 * customer, and a line carrying the same identifier as the real line.
 */
async function seedDecoySchema(dataSource: DataSource, real: SeededRows): Promise<void> {
    const channel = await dataSource.getRepository(Channel).save(
        new Channel({
            code: 'decoy-channel',
            token: 'decoy-token',
            defaultLanguageCode: LanguageCode.en,
            availableLanguageCodes: [LanguageCode.en],
            defaultCurrencyCode: CurrencyCode.USD,
            availableCurrencyCodes: [CurrencyCode.USD],
            pricesIncludeTax: true,
        }),
    );
    // The owner is saved the ordinary way and its key is then MOVED, which is the only form that works here. A
    // supplied primary key does not survive either route into the table: the column is generated, so TypeORM
    // leaves the allocation to the engine and both schemas' sequences hand out 1 — the very collision this
    // suite must not have, because a decoy owned by the same customer id answers the ownership question
    // correctly by accident and the suite could then not fail. Nothing references the row yet, so moving its
    // key is safe, and it is read back rather than assumed.
    const decoyCustomerId = real.customerId + DECOY_OWNER_OFFSET;
    const savedCustomer = await dataSource.getRepository(Customer).save(
        new Customer({
            firstName: 'Decoy',
            lastName: 'Owner',
            emailAddress: 'decoy@example.test',
        }),
    );
    const customerTable = dataSource.getMetadata(Customer).tablePath;
    await dataSource.query(
        `UPDATE "${SEARCH_PATH_SCHEMA}"."${customerTable.split('.').pop() ?? ''}" SET id = $1 WHERE id = $2`,
        [decoyCustomerId, savedCustomer.id],
    );
    const moved: { id: number } | undefined = (
        await dataSource.query(
            `SELECT id FROM "${SEARCH_PATH_SCHEMA}"."${customerTable.split('.').pop() ?? ''}" WHERE id = $1`,
            [decoyCustomerId],
        )
    )[0];
    if (moved === undefined) {
        throw new Error('the decoy owner could not be given an identifier distinct from the real owner');
    }
    const product = await dataSource.getRepository(Product).save(new Product({ enabled: true }));
    const variant = await dataSource.getRepository(ProductVariant).save(
        new ProductVariant({
            enabled: true,
            sku: 'DECOY-1',
            productId: product.id as never,
            outOfStockThreshold: 0,
            useGlobalOutOfStockThreshold: true,
        }),
    );
    await dataSource
        .createQueryBuilder()
        .insert()
        .into(ReorderList)
        .values({
            id: real.listId as never,
            customerId: decoyCustomerId,
            channelId: channel.id,
            name: 'Decoy list',
            nameKey: 'decoy list',
            lineCount: 1,
        })
        .execute();
    await dataSource
        .createQueryBuilder()
        .insert()
        .into(ReorderListLine)
        .values({
            id: real.lineId as never,
            reorderListId: real.listId as never,
            productVariantId: variant.id,
            quantity: 1,
        })
        .execute();
}

/**
 * Constructs the service against one data source, with the two collaborators these paths reach stubbed to the
 * narrowest behaviour they need.
 */
function buildService(dataSource: DataSource): ReorderListService {
    const configuration = {
        authOptions: { entityAccessControlStrategy: new DefaultEntityAccessControlStrategy() },
    };
    const connection = new TransactionalConnection(
        dataSource,
        new TransactionWrapper(),
        configuration as never,
    );
    const productVariantService = {
        findOne: async (_ctx: RequestContext, id: unknown) => {
            const found = await dataSource
                .getRepository(ProductVariant)
                .findOne({ where: { id: Number(id) as never } });
            return found ?? undefined;
        },
    };
    return new ReorderListService(
        connection,
        productVariantService as never,
        {} as never,
        new RequestContextCacheService(),
        DECLARED_OPTIONS,
    );
}

/** A shop context for the seeded customer's session, in the seeded channel. */
function buildContext(seeded: SeededRows): RequestContext {
    return new RequestContext({
        apiType: 'shop',
        channel: new Channel({ id: seeded.channelId, code: 'schema-qualified-channel' }),
        session: { user: { id: seeded.userId } } as never,
        isAuthorized: true,
        authorizedAsOwnerOnly: true,
    });
}

/** One line's stored quantity in one schema, or `undefined` where no such row exists there. */
async function quantityIn(dataSource: DataSource, id: number): Promise<number | undefined> {
    const row = await dataSource
        .createQueryBuilder()
        .select('line.quantity', 'quantity')
        .from(ReorderListLine, 'line')
        .where('line.id = :id', { id })
        .getRawOne<{ quantity: number }>();
    return row === undefined ? undefined : Number(row.quantity);
}

/** One list's stored counter in one schema. */
async function lineCountIn(dataSource: DataSource, id: number): Promise<number | undefined> {
    const row = await dataSource
        .createQueryBuilder()
        .select('list.lineCount', 'lineCount')
        .from(ReorderList, 'list')
        .where('list.id = :id', { id })
        .getRawOne<{ lineCount: number }>();
    return row === undefined ? undefined : Number(row.lineCount);
}
