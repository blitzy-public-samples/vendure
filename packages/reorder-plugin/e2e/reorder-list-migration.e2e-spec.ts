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
 * 2. **Every one of the five named database objects asserted twice** — once as declared by the migration
 *    itself, and once by **attempting the write it forbids**, issued directly through the repository and
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
 * ## THE SCHEMA UNDER TEST IS ALWAYS THE MIGRATION'S OWN — read this before changing anything below
 *
 * **There is no schema-builder fallback in this file, on any engine.** The migration under test carries no
 * SQL: it describes the plugin's two tables as literals of its own and hands that description to the same
 * query-runner API `RdbmsSchemaBuilder.createNewTables()` uses
 * (`node_modules/typeorm/schema-builder/RdbmsSchemaBuilder.js:L409-L420`) and therefore the same API whose
 * log `generateMigration` serialises (`packages/core/src/migrate.ts:L127`). So one file emits each engine's
 * own correct DDL, honours a configured non-default database schema, and applies on all four target
 * engines. Every assertion below reads a schema that `runMigrations` created, and the suite fails rather
 * than substituting anything if it did not.
 *
 * **How that is made observable on sql.js, where it otherwise would not be.** `runMigrations` builds its
 * own data source (`packages/core/src/migrate.ts:L42`), and on sql.js each connection holds a private
 * in-memory copy of its database; the harness leaves `autoSave` false after populating
 * (`packages/testing/src/initializers/sqljs-initializer.ts:L41-L42`), so DDL applied through a second
 * connection would evaporate when that connection closed and this suite would be reading a database the
 * migration never touched. So the suite takes the populated database off the running server
 * (`sqljsManager.exportDatabase()`), writes it to a file it owns outside the repository, and points **both**
 * the migration lifecycle and its own assertion data source at that file with `autoSave` enabled — reloading
 * its in-memory copy after each lifecycle call. On a server engine `location` and `autoSave` mean nothing
 * and both connections already address the same physical database, so the same configuration serves all
 * four engines unchanged. The harness's own cached snapshot under `e2e/__data__` is never written to.
 *
 * **Half one of each named-object claim reads the migration's own behaviour, not its text.** A text grep
 * could only ever match one engine's dialect. Instead `up()` and `down()` are driven once against a
 * recording proxy over a real query runner — real driver, real metadata, `createTable`/`dropTable`
 * intercepted and nothing executed — so the assertions read the exact `Table` descriptions the migration
 * hands this engine: the order, the columns and their widths, the named uniques, index and checks, and the
 * four cascading foreign keys. What is still asserted against the file's text is what text is the right
 * medium for: that it contains no DDL literal, no hard-coded schema qualifier, and neither withdrawn
 * identifier.
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
 * MySQL family, and never skips the assertion. It also localises the gap precisely: the migration
 * **declares both named checks on every engine** — each is a literal of the migration's own, and the
 * recording proxy below reads them off the `Table` on all four — and it is the MySQL-family driver that discards them
 * between that declaration and the catalogue. Where the invariant is upheld instead: the quantity bound by
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
import os from 'os';
import path from 'path';
import {
    DataSource,
    DataSourceOptions,
    QueryRunner,
    Table,
    TableColumn,
    TableForeignKey,
    TableIndex,
    TableUnique,
} from 'typeorm';
import ts from 'typescript';
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
 * The compiled counterpart of {@link MIGRATION_FILE_PATH}, which is what an installed package offers.
 *
 * The migration is named as a build root in `tsconfig.build.json`, so `bun run build` emits it here, inside
 * the one path the manifest's `files` entry publishes. A consumer registers it by this path — it is
 * deliberately absent from the package's root barrel, a migration not being public API — so the suite
 * asserts the path exists once the package has been built, and states plainly when it has not.
 */
const BUILT_MIGRATION_GLOB_DIR = path.join(__dirname, '../lib/src/migrations');

/**
 * The dev-server configuration that registers this plugin and its migration.
 *
 * It is the one file outside this package the feature edits, and the only place the migration's registration
 * decision lives, so the decision is read out of it rather than restated here.
 */
const DEV_CONFIG_FILE_PATH = path.join(__dirname, '../../dev-server/dev-config.ts');

/** The name of the pure selector in {@link DEV_CONFIG_FILE_PATH} that chooses which layout to register. */
const LAYOUT_SELECTOR_NAME = 'selectReorderPluginMigrationGlob';

/**
 * A package root that exists nowhere, used to ask the selector about layouts this machine is not in.
 *
 * The selector takes its existence test as an argument precisely so that an installed package and an unbuilt
 * checkout can both be exercised from a built checkout, and a path that cannot accidentally exist keeps the
 * injected answer the only thing the selector can be responding to.
 */
const SELECTOR_PROBE_ROOT = path.join(path.sep, 'nonexistent-probe-root', 'reorder-plugin');

/** The signature of the layout selector, so the extracted function is called through a checked type. */
type LayoutSelector = (packageRoot: string, directoryExists: (candidate: string) => boolean) => string[];

/** Memoised so repeated cases neither re-read the file nor leave a second temporary module behind. */
let extractedLayoutSelector: LayoutSelector | undefined;

/**
 * Reads the layout selector out of `packages/dev-server/dev-config.ts` and returns it as a callable function.
 *
 * **Why extraction rather than an import.** The decision under test lives in the dev-server package, which
 * cannot be imported from here: it pulls in `@vendure/dashboard/plugin` and two other packages that are not
 * built in this environment, so importing it fails at module load for reasons that have nothing to do with
 * migrations. Restating the selector in this file instead would assert only that the copy agrees with itself.
 * Extracting the declaration and executing it tests the shipped decision, and a rename or a rewrite of it
 * surfaces here as a failure rather than as a silently weakened assertion.
 *
 * The declaration is located by name, brace-matched to its end, transpiled with the workspace's own TypeScript
 * and written to a temporary module outside the repository, which is then required. Brace matching is safe
 * because the selector's body contains no brace inside a string or a comment; the extraction fails loudly
 * rather than quietly if that ever stops being true, because the transpile or the require would throw.
 *
 * @returns The selector, taking a package root and a directory-existence predicate.
 */
async function devConfigLayoutSelector(): Promise<LayoutSelector> {
    if (extractedLayoutSelector) {
        return extractedLayoutSelector;
    }
    const source = await fs.readFile(DEV_CONFIG_FILE_PATH, 'utf-8');
    const start = source.indexOf(`function ${LAYOUT_SELECTOR_NAME}(`);
    expect(
        start,
        `${DEV_CONFIG_FILE_PATH} must declare ${LAYOUT_SELECTOR_NAME}, which is where the choice of ` +
            'migration layout is made',
    ).toBeGreaterThan(-1);
    const bodyStart = source.indexOf('{', start);
    let depth = 0;
    let end = -1;
    for (let index = bodyStart; index < source.length; index++) {
        if (source[index] === '{') {
            depth++;
        } else if (source[index] === '}') {
            depth--;
            if (depth === 0) {
                end = index + 1;
                break;
            }
        }
    }
    expect(end, `${LAYOUT_SELECTOR_NAME} is not brace-balanced`).toBeGreaterThan(bodyStart);

    const transpiled = ts.transpileModule(
        `const path = require('path');\n${source.slice(start, end)}\n` +
            `module.exports = ${LAYOUT_SELECTOR_NAME};\n`,
        { compilerOptions: { target: ts.ScriptTarget.ES2019, module: ts.ModuleKind.CommonJS } },
    ).outputText;
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'reorder-plugin-layout-'));
    const modulePath = path.join(directory, 'layout-selector.js');
    await fs.writeFile(modulePath, transpiled);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    extractedLayoutSelector = require(modulePath) as LayoutSelector;
    return extractedLayoutSelector;
}

/**
 * The migration's class name, **derived from the imported class rather than restated as a string**.
 *
 * A rename therefore breaks this file at compile time instead of silently weakening an assertion, and the
 * name TypeORM records in its own bookkeeping table is by construction the name asserted here.
 */
const MIGRATION_CLASS_NAME = AddReorderLists1786838400000.name;

/**
 * DDL keywords that must appear **nowhere** in the migration's text.
 *
 * Every one of them is dialect-bound, and a migration containing any of them is a migration that carries one
 * engine's DDL and therefore cannot apply on the other three. Their absence is what makes the file portable,
 * so it is asserted as a property of the artefact rather than left implied by the fact that it happens to
 * apply on the engine the run was configured for.
 */
const FORBIDDEN_DDL_KEYWORDS = [
    'CREATE TABLE',
    'ALTER TABLE',
    'DROP TABLE',
    'CREATE INDEX',
    'DROP INDEX',
    'FOREIGN KEY',
    'PRIMARY KEY',
    'SERIAL',
    'character varying',
    'ENGINE=InnoDB',
] as const;

/**
 * Schema qualifiers a migration must never spell as a literal.
 *
 * `DataSourceOptions.schema` is configurable — the dev-server exposes it as `DB_SCHEMA` — and TypeORM
 * neither rewrites raw migration SQL nor sets a `search_path` from it. A statement naming `public`
 * explicitly therefore targets the wrong schema on any deployment that configured another one, which is
 * precisely the defect that made the previous revision of this migration unusable outside the default
 * schema. The qualified name must therefore be built at run time through
 * `driver.buildTableName(tableName, schema, database)`, from the schema and database a platform entity
 * resolves to, rather than spelled in the file alongside the rest of the frozen shape.
 */
const FORBIDDEN_SCHEMA_LITERALS = ['"public"', '`public`', "'public'"] as const;

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

/**
 * The frozen name of the cascading reference from `reorder_list.customerId` to `customer.id`.
 *
 * The default naming strategy derives a reference's name by hashing the UNQUALIFIED table name together with
 * the referencing columns, ignoring the referenced side entirely, so this value is identical on all four
 * engines and under any configured schema. That invariance is what lets the frozen description name it, and
 * what lets the comparison find a reference by name rather than by the columns it happens to span.
 */
const FK_LIST_CUSTOMER = 'FK_0c7c5c80bfaa5a02595fd089bb8';

/** The frozen name of the cascading reference from `reorder_list_line.reorderListId` to `reorder_list.id`. */
const FK_LINE_LIST = 'FK_19a7479a99a7bd9f3e3b6ecd97c';

/**
 * One way an existing table can differ from the frozen description, and what the refusal must name.
 *
 * `drift` mutates a CLONE of the real catalogue reading and returns `false` when the attribute it targets is
 * not present on this engine — a collation is declared only where the engine needs one, and the MySQL family
 * carries no check constraints at all. Returning `false` skips the case rather than passing it vacuously,
 * which is the same engine-conditional discipline every other conditional claim in this file follows.
 */
interface FrozenShapeDrift {
    /** Completes the sentence "refuses a table whose …". */
    readonly description: string;
    /** The plugin table whose reading is drifted. */
    readonly table: string;
    /** Applies the drift; `false` means the attribute is not reported on this engine. */
    readonly drift: (table: Table) => boolean | void;
    /** Every string the refusal must contain, so a refusal for another reason cannot stand in. */
    readonly names: readonly string[];
}

/**
 * One drift per object class, and per compared attribute that any frozen object actually declares.
 *
 * **Columns**: absence, physical type, declared width, precision, nullability, default, character collation,
 * membership of the row identifier, generation disabled, generation by a DIFFERENT strategy, scalar versus
 * array, signedness and zero fill. **Uniques**: absence, subject and deferred enforcement. **Indices**:
 * absence, subject ORDER, uniqueness, a partial-index predicate, the spatial, full-text and null-filtered
 * kinds, and a full-text parser. **Checks**: absence and condition.
 * **References**: absence, name, leaving columns, target table, target column, both referential actions, a
 * non-cascading delete under the other name for it, deferred enforcement, and a same-named target in another
 * schema.
 *
 * The two deferred-enforcement entries in that inventory exercise the comparator against a reading handed to
 * it. What a LIVE deferred constraint does is measured separately, by the three cases above this list, because
 * TypeORM's generic view is blind to it on two engine-and-class combinations and a doctored reading could not
 * have shown that.
 *
 * Some attributes the comparison reads have **no case here, and cannot have one**, because no frozen column
 * declares them and there is therefore nothing to drift: declared scale, display width, character set,
 * identity generation, generated expression and storage, enumerated members and type name, spatial feature
 * type, spatial reference identifier and the row identifier's constraint name. The comparison still reads each
 * of them, so a future frozen column that DOES declare one is covered the moment it appears — but a case here
 * would drift a value the frozen side leaves unset, which the comparison deliberately does not read, and would
 * therefore pass without measuring anything. Naming them is the honest alternative to a vacuous case.
 *
 * Several cases are engine-conditional by construction rather than by engine name: a precision drift needs an
 * engine that reports one (the MySQL family), a collation drift needs a column that declares one (the MySQL
 * family), a check drift needs checks to exist (not the MySQL family), a unique-deferrability drift needs the
 * unique to be filed as a CONSTRAINT rather than as an index (not the MySQL family), and a schema-impostor
 * drift needs a qualifier to exist (not the SQLite family). Each decides from the real reading and skips rather
 * than passing vacuously.
 *
 * **Every case in THIS list drifts the READING, never the database.** The doctored value is exactly what the
 * comparison would see if a deployment carried it, so a case remains a real test of the comparison even for an
 * attribute no engine reports — but it is evidence about the COMPARATOR, not about a live schema, and it is
 * described that way rather than as proof that a real deployment would be caught.
 *
 * Where the difference matters, live cases carry it instead. Enforcement timing is the one property TypeORM's
 * generic view is not authoritative on, so it has three cases of its own above this list — two that genuinely
 * defer a live constraint and read the engine's own catalogue back, and one that removes the catalogue reading
 * to prove an unanswerable question is refused rather than defaulted. The doctored deferrability cases below
 * remain, because they exercise the same comparator branch on every engine including the two whose grammar
 * cannot hold a deferred constraint at all.
 */
const FROZEN_SHAPE_DRIFTS: readonly FrozenShapeDrift[] = [
    {
        description: 'frozen column is missing',
        table: LIST_TABLE,
        drift: table => {
            table.columns = table.columns.filter(column => column.name !== 'lineCount');
        },
        names: ['lineCount'],
    },
    {
        description: 'column carries a different physical type',
        table: LIST_TABLE,
        drift: table => {
            columnOf(table, 'name').type = 'text';
        },
        names: ['name', 'physical type', 'text'],
    },
    {
        description: 'indexed string column is narrower than the frozen width',
        table: LIST_TABLE,
        drift: table => {
            columnOf(table, 'nameKey').length = '64';
        },
        names: ['nameKey', 'declared width', '64'],
    },
    {
        description: 'timestamp column carries a different precision',
        table: LIST_TABLE,
        drift: table => {
            const column = columnOf(table, 'createdAt');
            if (column.precision === undefined || column.precision === null) {
                return false;
            }
            column.precision = column.precision === 3 ? 4 : 3;
        },
        names: ['createdAt', 'declared precision'],
    },
    {
        description: 'integer column has become zero-filled',
        table: LIST_TABLE,
        drift: table => {
            columnOf(table, 'lineCount').zerofill = true;
        },
        names: ['lineCount', 'zero fill', 'zero-filled'],
    },
    {
        description: 'column has left the row identifier',
        table: LINE_TABLE,
        drift: table => {
            columnOf(table, 'id').isPrimary = false;
        },
        names: ['id', 'membership of the row identifier'],
    },
    {
        description: 'integer column has become unsigned',
        table: LINE_TABLE,
        drift: table => {
            columnOf(table, 'quantity').unsigned = true;
        },
        names: ['quantity', 'signedness', 'unsigned'],
    },
    {
        description: 'row identifier is generated by a different strategy',
        table: LIST_TABLE,
        drift: table => {
            const column = columnOf(table, 'id');
            if (column.isGenerated !== true) {
                return false;
            }
            // NOT merely disabled — a DIFFERENT strategy. A column generated as a uuid rather than by
            // increment satisfies "is generated" while storing something else entirely.
            column.generationStrategy = column.generationStrategy === 'uuid' ? 'rowid' : 'uuid';
        },
        names: ['id', 'generation', 'uuid'],
    },
    {
        description: 'string column has become array-valued',
        table: LIST_TABLE,
        drift: table => {
            // PostgreSQL reports `varchar` and `varchar[]` under the same physical type name and separates
            // them through this flag alone, so a column that had become array-valued would satisfy every
            // other comparison while storing something the service can neither read nor write.
            columnOf(table, 'name').isArray = true;
        },
        names: ['name', 'value shape', 'an array'],
    },
    {
        description: 'reference arrives at a same-named table in another schema',
        table: LIST_TABLE,
        drift: table => {
            // The bare table name is unchanged; only the qualifier moves. Under a multi-schema deployment
            // that is a different `customer` table holding different people's rows, so comparing only the
            // bare name would accept it.
            const reference = referenceOf(table, FK_LIST_CUSTOMER);
            const scope = table.schema ?? bareSchemaOf(table.name);
            if (scope === undefined) {
                // The SQLite family qualifies nothing, so there is no other schema to arrive in.
                return false;
            }
            reference.referencedSchema = `${scope}_impostor`;
            reference.referencedTableName = `${scope}_impostor.customer`;
        },
        names: [FK_LIST_CUSTOMER, '_impostor'],
    },
    {
        description: 'not-null column has become nullable',
        table: LINE_TABLE,
        drift: table => {
            columnOf(table, 'quantity').isNullable = true;
        },
        names: ['quantity', 'nullability'],
    },
    {
        description: 'counter carries a different default',
        table: LIST_TABLE,
        drift: table => {
            columnOf(table, 'lineCount').default = 7;
        },
        names: ['lineCount', 'default value', '7'],
    },
    {
        description: 'row identifier is no longer generated',
        table: LINE_TABLE,
        drift: table => {
            const column = columnOf(table, 'id');
            column.isGenerated = false;
            column.generationStrategy = undefined;
        },
        names: ['id', 'generation'],
    },
    {
        description: 'canonical key column carries a different collation',
        table: LIST_TABLE,
        drift: table => {
            const column = columnOf(table, 'nameKey');
            if (!column.collation) {
                return false;
            }
            column.collation = 'utf8mb4_general_ci';
        },
        names: ['nameKey', 'collation', 'utf8mb4_general_ci'],
    },
    {
        description: 'frozen unique is missing',
        table: LIST_TABLE,
        drift: table => {
            table.uniques = table.uniques.filter(unique => unique.name !== UQ_LIST_OWNER_NAME_KEY);
            table.indices = table.indices.filter(index => index.name !== UQ_LIST_OWNER_NAME_KEY);
        },
        names: [UQ_LIST_OWNER_NAME_KEY],
    },
    {
        description: 'unique spans a different set of columns',
        table: LINE_TABLE,
        drift: table => {
            const subject =
                table.uniques.find(unique => unique.name === UQ_LINE_LIST_VARIANT) ??
                table.indices.find(index => index.name === UQ_LINE_LIST_VARIANT);
            expect(subject, `${UQ_LINE_LIST_VARIANT} must be reported in one catalogue view`).toBeDefined();
            (subject as { columnNames: string[] }).columnNames = ['reorderListId'];
        },
        names: [UQ_LINE_LIST_VARIANT, 'reorderListId, productVariantId'],
    },
    {
        description: 'frozen index is missing',
        table: LIST_TABLE,
        drift: table => {
            table.indices = table.indices.filter(index => index.name !== IDX_LIST_OWNER);
        },
        names: [IDX_LIST_OWNER],
    },
    {
        description: 'index spans its columns in a different order',
        table: LIST_TABLE,
        drift: table => {
            const index = table.indices.find(candidate => candidate.name === IDX_LIST_OWNER);
            expect(index, `${IDX_LIST_OWNER} must be reported`).toBeDefined();
            (index as TableIndex).columnNames = (index as TableIndex).columnNames.slice().reverse();
        },
        names: [IDX_LIST_OWNER, 'in that order'],
    },
    {
        // A partial index covers only the rows satisfying its predicate, so a same-named partial index leaves
        // the ownership lookup unindexed for every row the predicate excludes — here, every list that has no
        // lines yet, which is every list at the moment it is created. PostgreSQL and the SQLite family both
        // support partial indices and both report the predicate; the MySQL family has neither, which is why
        // the comparison reads an absent predicate as "every row" rather than as "unknown".
        description: 'ownership index covers only some rows',
        table: LIST_TABLE,
        drift: table => {
            const index = table.indices.find(candidate => candidate.name === IDX_LIST_OWNER);
            expect(index, `${IDX_LIST_OWNER} must be reported`).toBeDefined();
            (index as TableIndex).where = '"lineCount" > 0';
        },
        names: [IDX_LIST_OWNER, 'covers only rows satisfying', '<every row>'],
    },
    // The remaining kinds an index can be. Each answers a different class of predicate than the B-tree the
    // ownership lookup needs, so a same-named index of the wrong kind leaves that lookup unserved. Unlike a
    // column attribute the frozen side leaves unset — which the comparison deliberately does not read, and
    // which therefore cannot have a case — these are read as booleans on both sides and so are reachable:
    // "not spatial" is a state the frozen description asserts rather than declines to state.
    ...(
        [
            { described: 'spatial', flag: 'isSpatial' },
            { described: 'full-text', flag: 'isFulltext' },
            { described: 'null-filtered', flag: 'isNullFiltered' },
        ] as ReadonlyArray<{ described: string; flag: 'isSpatial' | 'isFulltext' | 'isNullFiltered' }>
    ).map(kind => ({
        description: `ownership index is ${kind.described} rather than an ordinary index`,
        table: LIST_TABLE,
        drift: (table: Table) => {
            const index = table.indices.find(candidate => candidate.name === IDX_LIST_OWNER);
            expect(index, `${IDX_LIST_OWNER} must be reported`).toBeDefined();
            (index as TableIndex)[kind.flag] = true;
        },
        names: [IDX_LIST_OWNER, `is ${kind.described}`, `not ${kind.described}`],
    })),
    {
        // The full-text parser selects how indexed text is tokenised, and so which queries the index can
        // answer at all. No frozen index sets one, and the comparison reads an unset parser as the empty
        // string on both sides rather than as "unknown", which is what makes this case reachable.
        description: 'ownership index tokenises its subject through a parser',
        table: LIST_TABLE,
        drift: table => {
            const index = table.indices.find(candidate => candidate.name === IDX_LIST_OWNER);
            expect(index, `${IDX_LIST_OWNER} must be reported`).toBeDefined();
            (index as TableIndex).parser = 'ngram';
        },
        names: [IDX_LIST_OWNER, 'tokenises with "ngram"'],
    },
    {
        // A deferred unique is enforced at COMMIT rather than at the statement, which would move the
        // violation of UQ_reorder_list_customer_channel_name_key past every `catch` the service has and turn
        // `ReorderListNameConflictError` into an unclassified transaction failure.
        //
        // This case exercises the COMPARATOR against a reading handed to it, and that is all it claims. It
        // exists alongside the live cases rather than instead of them, and for a reason the live ones cannot
        // cover: TypeORM's generic view never reports a unique's deferrability on PostgreSQL (its unique
        // loader reads fields its own constraints query does not select) and no engine here reports one at
        // all, so without this case the comparator branch would run on no engine. The live case above proves
        // a real deferred unique is caught, by reading `pg_constraint`. It skips where the engine files the
        // unique as an index, which carries no deferrability clause to drift.
        description: 'unique is enforced at commit rather than at the statement',
        table: LIST_TABLE,
        drift: table => {
            const unique = table.uniques.find(candidate => candidate.name === UQ_LIST_OWNER_NAME_KEY);
            if (!unique) {
                return false;
            }
            unique.deferrable = 'INITIALLY DEFERRED';
        },
        names: [UQ_LIST_OWNER_NAME_KEY, 'INITIALLY DEFERRED', 'NOT DEFERRABLE'],
    },
    {
        // The same hazard on a reference: a deferred cascade lets a parent delete and its child cascade sit
        // apart until commit, so a statement between them reads a child whose parent is gone. Reachable on
        // every engine here because the comparison resolves an unstated clause to the SQL default on both
        // sides instead of skipping when either is unset.
        //
        // `INITIALLY DEFERRED` is not an invented spelling: PostgreSQL's own foreign-key loader renders
        // `condeferred` as exactly that string, and a probe read it back off `getTable` for a reference
        // genuinely created `DEFERRABLE INITIALLY DEFERRED`. So the doctored reading here is byte-for-byte
        // what a PostgreSQL deployment carrying one presents to this comparison — which is also why this is
        // the one class-and-engine pairing where the generic view alone would have sufficed. It does not
        // suffice on the SQLite family, which writes the clause and never reads it back, and the live case
        // above is what covers that.
        description: 'reference is enforced at commit rather than at the statement',
        table: LINE_TABLE,
        drift: table => {
            referenceOf(table, FK_LINE_LIST).deferrable = 'INITIALLY DEFERRED';
        },
        names: [FK_LINE_LIST, 'INITIALLY DEFERRED', 'NOT DEFERRABLE'],
    },
    {
        description: 'ownership index has become unique',
        table: LIST_TABLE,
        drift: table => {
            const index = table.indices.find(candidate => candidate.name === IDX_LIST_OWNER);
            expect(index, `${IDX_LIST_OWNER} must be reported`).toBeDefined();
            (index as TableIndex).isUnique = true;
        },
        names: [IDX_LIST_OWNER, 'unique'],
    },
    {
        description: 'frozen check constraint is missing',
        table: LINE_TABLE,
        drift: table => {
            if (!table.checks.some(check => check.name === CHK_LINE_QUANTITY_POSITIVE)) {
                return false;
            }
            table.checks = table.checks.filter(check => check.name !== CHK_LINE_QUANTITY_POSITIVE);
        },
        names: [CHK_LINE_QUANTITY_POSITIVE],
    },
    {
        description: 'check constraint guards a different condition',
        table: LIST_TABLE,
        drift: table => {
            const check = table.checks.find(candidate => candidate.name === CHK_LIST_LINE_COUNT_NON_NEGATIVE);
            if (!check) {
                return false;
            }
            check.expression = '"lineCount" >= 5000';
        },
        names: [CHK_LIST_LINE_COUNT_NON_NEGATIVE, '5000'],
    },
    {
        description: 'cascading reference is missing',
        table: LIST_TABLE,
        drift: table => {
            table.foreignKeys = table.foreignKeys.filter(key => key.name !== FK_LIST_CUSTOMER);
        },
        names: [FK_LIST_CUSTOMER, 'customerId', 'customer'],
    },
    {
        description: 'cascading reference carries a different name',
        table: LINE_TABLE,
        drift: table => {
            referenceOf(table, FK_LINE_LIST).name = 'FK_renamed_by_something_else';
        },
        names: [FK_LINE_LIST],
    },
    {
        description: 'reference leaves from a different column',
        table: LINE_TABLE,
        drift: table => {
            referenceOf(table, FK_LINE_LIST).columnNames = ['id'];
        },
        names: [FK_LINE_LIST, 'leaves from id'],
    },
    {
        description: 'reference arrives at a different table',
        table: LIST_TABLE,
        drift: table => {
            referenceOf(table, FK_LIST_CUSTOMER).referencedTableName = 'administrator';
        },
        names: [FK_LIST_CUSTOMER, 'administrator'],
    },
    {
        description: 'reference arrives at a different column',
        table: LIST_TABLE,
        drift: table => {
            referenceOf(table, FK_LIST_CUSTOMER).referencedColumnNames = ['createdAt'];
        },
        names: [FK_LIST_CUSTOMER, 'createdAt'],
    },
    {
        description: 'reference no longer cascades on delete',
        table: LINE_TABLE,
        drift: table => {
            referenceOf(table, FK_LINE_LIST).onDelete = 'SET NULL';
        },
        names: [FK_LINE_LIST, 'SET NULL on delete'],
    },
    {
        description: 'reference has acquired an action on update',
        table: LIST_TABLE,
        drift: table => {
            referenceOf(table, FK_LIST_CUSTOMER).onUpdate = 'CASCADE';
        },
        names: [FK_LIST_CUSTOMER, 'on update'],
    },
    {
        // THE FOLD IS NARROW, and this case is what says so. The comparison treats `RESTRICT` and
        // `NO ACTION` as one action, because they are one action on the MySQL family and MariaDB reports
        // whichever of the two names matches how the constraint was created. That fold must not become a
        // blanket acceptance of any action at all: a reference that rejects a parent delete instead of
        // cascading it leaves orphan rows behind on every list deletion, and is still refused.
        description: 'reference rejects a parent delete instead of cascading it',
        table: LINE_TABLE,
        drift: table => {
            referenceOf(table, FK_LINE_LIST).onDelete = 'RESTRICT';
        },
        names: [FK_LINE_LIST, 'on delete rather than CASCADE'],
    },
];

/**
 * One table description reduced to the form in which two descriptions of the same table compare equal.
 *
 * Used to compare what the entity classes declare with what the migration froze, and the reduction exists
 * because TypeORM itself carries the same table in more than one shape:
 *
 *  * A qualified name may sit wholly in `name`, or be split across `name` and `schema` — `Driver.parseTableName`
 *    accepts either — so only the bare name is compared, and the schema-qualification claim is asserted
 *    separately against the entity metadata's own `tablePath`.
 *  * A unique may be filed under `uniques` or, on the MySQL family, as a named unique index under `indices`.
 *    Both views are merged into one set, which is the same fold the migration's own comparison performs.
 *  * Collections come back in arbitrary order from both sides, so every collection is sorted by name.
 *
 * **Everything else either side carries is compared, and the two exceptions are named rather than implied.**
 * Every property of `TableColumn`, `TableUnique`, `TableIndex`, `TableCheck` and `TableForeignKey` is projected
 * — including the properties a coarser comparison would drop and a drifting entity could then change unnoticed:
 * a column's declared and display widths, precision, scale, character set, collation, value shape, signedness,
 * zero fill, enumerated members, generated expression and storage, identity generation, row-identifier
 * membership and that membership's constraint name, and its `ON UPDATE` clause; an index's predicate and its
 * spatial, full-text and null-filtered kinds and parser; a unique's and a reference's deferrability; and a
 * reference's qualified target schema and database. The two exceptions:
 *
 *  * A column's `comment`, which changes neither the stored value nor any constraint on it, and which the
 *    SQLite family's parser reports as an empty string where the others report nothing.
 *  * An index's `isConcurrent`, which is a modifier on the statement that BUILDS an index rather than a
 *    property of the index that results; no engine stores it and none reports it.
 */
function comparableTableShape(table: Table): unknown {
    const uniqueLike = [
        ...table.uniques.map(unique => ({
            name: unique.name,
            columns: unique.columnNames,
            deferrable: unique.deferrable,
        })),
        ...table.indices
            .filter(index => index.isUnique)
            .map(index => ({
                name: index.name,
                columns: index.columnNames,
                deferrable: undefined as string | undefined,
            })),
    ];
    const byName = <T extends { name?: string }>(entries: T[]): T[] =>
        entries
            .slice()
            .sort((left, right) => String(left.name ?? '').localeCompare(String(right.name ?? '')));
    return {
        name: bareTableName(table.name),
        columns: byName(
            table.columns.map(column => ({
                name: column.name,
                type: column.type.toLowerCase(),
                length: column.length === '' ? undefined : column.length,
                precision: column.precision ?? undefined,
                scale: column.scale ?? undefined,
                width: column.width ?? undefined,
                default: column.default === undefined ? undefined : String(column.default),
                onUpdate: column.onUpdate === '' ? undefined : column.onUpdate,
                charset: column.charset === '' ? undefined : column.charset,
                collation: column.collation === '' ? undefined : column.collation,
                isNullable: column.isNullable,
                isPrimary: column.isPrimary,
                primaryKeyConstraintName: column.primaryKeyConstraintName ?? undefined,
                isUnique: column.isUnique === true,
                isArray: column.isArray === true,
                isGenerated: column.isGenerated,
                generationStrategy: column.generationStrategy,
                generatedIdentity: column.generatedIdentity ?? undefined,
                asExpression: column.asExpression === '' ? undefined : column.asExpression,
                generatedType: column.generatedType ?? undefined,
                unsigned: column.unsigned === true,
                zerofill: column.zerofill === true,
                enum: column.enum ?? undefined,
                enumName: column.enumName ?? undefined,
                spatialFeatureType: column.spatialFeatureType ?? undefined,
                srid: column.srid ?? undefined,
            })),
        ),
        uniques: byName(uniqueLike).map(unique => ({
            name: unique.name,
            columns: unique.columns.slice().sort(),
            deferrable: unique.deferrable ?? undefined,
        })),
        indices: byName(table.indices.filter(index => !index.isUnique)).map(index => ({
            name: index.name,
            columns: index.columnNames,
            where: index.where === '' ? undefined : index.where,
            isSpatial: index.isSpatial === true,
            isFulltext: index.isFulltext === true,
            isNullFiltered: index.isNullFiltered === true,
            parser: index.parser ?? undefined,
        })),
        checks: byName(table.checks).map(check => ({ name: check.name, expression: check.expression })),
        references: byName(table.foreignKeys).map(reference => ({
            name: reference.name,
            columns: reference.columnNames,
            target: bareTableName(reference.referencedTableName),
            targetColumns: reference.referencedColumnNames,
            targetSchema: reference.referencedSchema ?? undefined,
            targetDatabase: reference.referencedDatabase ?? undefined,
            onDelete: reference.onDelete,
            onUpdate: reference.onUpdate,
            deferrable: reference.deferrable ?? undefined,
        })),
    };
}

/** The schema segment of a possibly-qualified table name, or `undefined` when it carries none. */
function bareSchemaOf(name: string): string | undefined {
    const segments = name.split('.');
    return segments.length > 1 ? segments[segments.length - 2] : undefined;
}

/** One named column of a catalogue reading, failing the case rather than throwing when it is absent. */
function columnOf(table: Table, name: string): TableColumn {
    const column = table.columns.find(candidate => candidate.name === name);
    expect(column, `"${bareTableName(table.name)}" carries no "${name}" column`).toBeDefined();
    return column as TableColumn;
}

/** One named cascading reference of a catalogue reading, failing the case when it is absent. */
function referenceOf(table: Table, name: string): TableForeignKey {
    const reference = table.foreignKeys.find(candidate => candidate.name === name);
    expect(reference, `"${bareTableName(table.name)}" carries no reference named "${name}"`).toBeDefined();
    return reference as TableForeignKey;
}

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
 * Why the migration applies on every engine, carried into the messages that depend on it.
 *
 * The same reasoning as the header's schema-provenance section, in the form an assertion failure can print.
 */
const ENGINE_PORTABILITY_CITATION =
    'The migration carries no SQL: it hands its two tables to the same query-runner schema API the ' +
    'platform schema builder uses (node_modules/typeorm/schema-builder/RdbmsSchemaBuilder.js:L409-L420), ' +
    'which is the API whose log generateMigration serialises into a file ' +
    '(packages/core/src/migrate.ts:L127). Their shape is frozen in the migration itself — every column, ' +
    'width, named unique, index, check and cascading reference is a literal there, and neither plugin ' +
    'entity is consulted — while the three things a deployment decides are resolved at run time: the ' +
    'identifier type the configured EntityIdStrategy produces, the engine date type and default from ' +
    'driver.mappedDataTypes, and the qualified name from ' +
    'driver.buildTableName(tableName, schema, database). One file therefore emits each engine own correct ' +
    'DDL and honours a configured non-default schema. It must apply on every target engine, and a failure ' +
    'here is a defect rather than a documented engine scope.';

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

/** The TypeORM engine identifiers whose catalogue answers a deferrability question through `pg_catalog`. */
const POSTGRES_FAMILY_ENGINES: readonly string[] = ['postgres', 'aurora-postgres'];

/** Whether the given engine records constraint deferrability in `pg_constraint`. */
function isPostgresFamily(engine: string): boolean {
    return POSTGRES_FAMILY_ENGINES.indexOf(engine) !== -1;
}

/**
 * What enforcement timing the ENGINE ITSELF holds for one named constraint, read independently of both
 * TypeORM's generic table view and the migration under test.
 *
 * This is the oracle the two live-deferral cases below decide their own applicability from. It has to be an
 * independent reading rather than a call into the migration, because the question those cases ask is
 * precisely "does the engine hold a deferred constraint" — answering it with the code under test would make
 * the case agree with itself. And it cannot be `getTable()`, because being blind to exactly this is why the
 * migration reads a native catalogue at all.
 *
 * @param queryRunner - A runner on the assertion connection.
 * @param table - The bare table name the constraint belongs to.
 * @param name - The constraint's name.
 * @returns The deferrability clause the engine holds, `'NOT DEFERRABLE'` when it holds none, or `undefined`
 *   on an engine whose catalogue this oracle does not read — which is every engine whose grammar refuses the
 *   clause outright, so there is nothing there to read.
 */
async function liveEnforcementTiming(
    queryRunner: QueryRunner,
    table: string,
    name: string,
): Promise<string | undefined> {
    const engine = resolveConfiguredEngine();
    if (isPostgresFamily(engine)) {
        const rows: Array<{ deferrable: unknown; deferred: unknown }> = await queryRunner.query(
            'SELECT "con"."condeferrable" AS "deferrable", "con"."condeferred" AS "deferred" ' +
                'FROM "pg_catalog"."pg_constraint" "con" ' +
                'INNER JOIN "pg_catalog"."pg_class" "cls" ON "cls"."oid" = "con"."conrelid" ' +
                'WHERE "cls"."relname" = $1 AND "con"."conname" = $2',
            [table, name],
        );
        if (!rows.length) {
            return undefined;
        }
        return rows[0].deferrable === true
            ? rows[0].deferred === true
                ? 'INITIALLY DEFERRED'
                : 'INITIALLY IMMEDIATE'
            : 'NOT DEFERRABLE';
    }
    if (isSqliteFamily(engine)) {
        const rows: Array<{ ddl: string | null }> = await queryRunner.query(
            'SELECT "sql" AS "ddl" FROM "sqlite_master" WHERE "name" = ?',
            [table],
        );
        const ddl = rows[0]?.ddl;
        if (!ddl) {
            return undefined;
        }
        const marker = `CONSTRAINT "${name}"`;
        const at = ddl.indexOf(marker);
        if (at < 0) {
            return undefined;
        }
        const rest = ddl.slice(at + marker.length);
        const next = rest.indexOf('CONSTRAINT "');
        const segment = next < 0 ? rest : rest.slice(0, next);
        const deferred = /\bDEFERRABLE\s+INITIALLY\s+(DEFERRED|IMMEDIATE)\b/i.exec(segment);
        return deferred ? `INITIALLY ${deferred[1].toUpperCase()}` : 'NOT DEFERRABLE';
    }
    return undefined;
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
 *
 * The two text assertions below are about what the migration *does*, and a comment does nothing. The
 * migration's header necessarily names some of the very tokens those assertions forbid — it explains why
 * engine-specific DDL and a hard-coded schema qualifier are wrong, and cannot do that without quoting them —
 * so matching against the raw file would fail on its own documentation. Stripping comments first is what
 * makes the assertion say what it means.
 *
 * A regular expression is sufficient here rather than approximate: the file under test contains no string or
 * template literal carrying a comment opener, so there is no case for the naive strip to get wrong. It is
 * applied only to this one known file.
 */
function executableTextOf(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

/**
 * Whether the engine keeps its whole database in one connection-local buffer rather than on a server.
 *
 * The distinction decides one thing only: whether the migration lifecycle's own connection and this file's
 * assertion data source address the same bytes automatically (a server engine) or have to be pointed at a
 * shared file this suite owns (sql.js and the native SQLite driver).
 */
function isConnectionLocalEngine(engine: string): boolean {
    return isSqliteFamily(engine);
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

/**
 * What one direction of the migration asked the engine to do, recorded without anything being executed.
 *
 * This is half one of every named-object claim. The migration builds its `Table` descriptions from frozen
 * literals of its own and hands them to `queryRunner.createTable` / `dropTable`; a proxy standing in front of
 * a **real** query runner — real driver, so the deployment-specific primitives and the rendered DDL are the
 * ones this engine would actually receive — records those calls and performs none of them. Reading the recording is therefore
 * reading what the migration does, on the engine the run was configured for, rather than grepping one
 * engine's dialect out of a text file.
 */
interface RecordedMigrationDirection {
    /** The tables named, in the order the migration named them. */
    tables: Table[];
    /** Which query-runner method each call was, so the up and down paths can be told apart in a diagnostic. */
    calls: string[];
}

/**
 * Runs one direction of `migration` against a recording proxy over `queryRunner` and returns what it asked
 * for.
 *
 * Every member other than the four below is delegated to the real runner, so `connection`,
 * `connection.getMetadata` and `connection.driver` are genuine and the recorded `Table` objects carry the
 * engine's own normalised column types and its own qualified table name. `createTable` and `dropTable`
 * return without issuing a statement, which is what makes this observation free of side effects — it can run
 * after the real migration has already been applied without disturbing it.
 *
 * `getTable` and `hasTable` are answered with ABSENCE, and that is not a shortcut. The migration's up path
 * asks whether each table is already there and, when it is, checks it against the frozen description instead
 * of creating it — so a recording taken after the apply would otherwise capture the CHECK path and record no
 * table at all. Reporting absence is what makes the recording show the shape this migration creates on a
 * fresh database, which is the shape every named-object claim below is about. The check path is asserted
 * separately, against a table that really is there.
 */
async function recordMigrationDirection(
    queryRunner: QueryRunner,
    run: (recording: QueryRunner) => Promise<void>,
): Promise<RecordedMigrationDirection> {
    const recorded: RecordedMigrationDirection = { tables: [], calls: [] };
    const recording = new Proxy(queryRunner, {
        get(target, property, receiver) {
            if (property === 'createTable' || property === 'dropTable') {
                return (table: Table): Promise<void> => {
                    recorded.calls.push(String(property));
                    recorded.tables.push(table);
                    return Promise.resolve();
                };
            }
            if (property === 'getTable') {
                return (): Promise<Table | undefined> => Promise.resolve(undefined);
            }
            if (property === 'hasTable') {
                return (): Promise<boolean> => Promise.resolve(false);
            }
            const value = Reflect.get(target, property, receiver);
            return typeof value === 'function' ? value.bind(target) : value;
        },
    });
    await run(recording);
    return recorded;
}

/** The recorded table of a given (unqualified) name, failing with a diagnostic when the migration named none. */
function recordedTable(recording: RecordedMigrationDirection, name: string): Table {
    const table = recording.tables.find(candidate => bareTableName(candidate.name) === name);
    expect(
        table,
        `the migration named no table "${name}"; it named ${recording.tables
            .map(candidate => bareTableName(candidate.name))
            .join(', ')}`,
    ).toBeDefined();
    return table as Table;
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

    /** The migration file's text, read once. Every file-level assertion reads this and never the disk again. */
    let migrationSource: string;

    /** The plugin tables that existed before any apply. Expected empty — the precondition the up-path needs. */
    let pluginTablesBeforeAnyApply: string[];

    /** The plugin tables that existed immediately after the first apply attempt and before any fallback. */
    let pluginTablesAfterFirstAttempt: string[];

    /** The outcome of the first apply attempt, recorded in `beforeAll` and asserted by the cycle case. */
    let firstApply: GuardedMigrationOutcome;

    /** What `up()` asked this engine for, recorded once through the proxy and read by half one of each claim. */
    let recordedUp: RecordedMigrationDirection;

    /** What `down()` asked this engine for, recorded the same way. */
    let recordedDown: RecordedMigrationDirection;

    /**
     * The database file this suite owns on a connection-local engine, and `undefined` on a server engine.
     *
     * On sql.js the migration lifecycle's own connection and this file's assertion data source would
     * otherwise hold independent in-memory copies, and the migration's effect would be unobservable. Both are
     * pointed at this file instead, with `autoSave` enabled, so each sees what the other did. It is created
     * outside the repository and removed in `afterAll`; the harness's cached snapshot under `e2e/__data__` is
     * never written to.
     */
    let privateDatabasePath: string | undefined;

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

    /**
     * Re-reads the assertion data source's copy of the database on a connection-local engine.
     *
     * On sql.js the working database is a buffer inside the connection, so a lifecycle call made through the
     * migration connection is invisible to this file's data source until its copy is reloaded from the shared
     * file both of them address. On a server engine there is nothing to reload: both connections already speak
     * to the same physical database, so this is a no-op and is called unconditionally rather than guarded at
     * every call site.
     */
    async function resyncAssertionSource(): Promise<void> {
        if (privateDatabasePath === undefined || !isConnectionLocalEngine(activeEngine)) {
            return;
        }
        await assertionDataSource.sqljsManager.loadDatabase(privateDatabasePath);
    }

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
        if (assertionDataSource !== undefined && assertionDataSource.isInitialized) {
            await resyncAssertionSource();
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
        if (assertionDataSource !== undefined && assertionDataSource.isInitialized) {
            await resyncAssertionSource();
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

        await server.init({
            initialData,
            customerCount: SEEDED_CUSTOMER_COUNT,
            productsCsvPath: path.join(__dirname, '../../core/e2e/fixtures/e2e-products-minimal.csv'),
        });

        const rawConnection = server.app.get(TransactionalConnection).rawConnection;
        activeEngine = rawConnection.options.type;
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

        // THE SHARED DATABASE, on the one engine family where "shared" is not automatic. On sql.js the
        // database is a buffer inside whichever connection holds it, and the migration lifecycle builds its
        // own connection (`packages/core/src/migrate.ts:L42`); the harness also leaves `autoSave` false after
        // populating (`packages/testing/src/initializers/sqljs-initializer.ts:L41-L42`). Applied through that
        // second connection, the migration's DDL would therefore vanish when it closed and this suite would be
        // asserting against a database the migration never touched — which is exactly the hole that made a
        // schema-builder fallback look necessary. So the populated database is taken off the running server and
        // written to a file THIS SUITE OWNS, outside the repository, and both the lifecycle and the assertion
        // data source are pointed at it with `autoSave` enabled. The harness's own cached snapshot under
        // `e2e/__data__` is never written to, so a second run of this file starts from the same core-only
        // schema. On a server engine `location` and `autoSave` mean nothing and the two connections already
        // address the same physical database, so there is nothing to arrange.
        if (isConnectionLocalEngine(activeEngine)) {
            privateDatabasePath = path.join(
                await fs.mkdtemp(path.join(os.tmpdir(), 'reorder-plugin-migration-')),
                'migration-suite.sqlite',
            );
            await fs.writeFile(privateDatabasePath, Buffer.from(rawConnection.sqljsManager.exportDatabase()));
        }

        /** The overrides that make one physical database serve both connections, per engine family. */
        const sharedDatabaseOptions =
            privateDatabasePath === undefined ? {} : { location: privateDatabasePath, autoSave: true };

        // From this point the plugin-less server is NOT USED AGAIN — every statement below goes through the
        // data source this file owns. The plan permits "destroy or stop using", and stopping using it is the
        // choice taken deliberately: `afterAll` owes the contract exactly one unconditional
        // `await server.destroy()`, and destroying here as well would run every module's shutdown hook twice.
        migrationConfig = {
            ...serverConfig,
            plugins: [ReorderPlugin.init(DECLARED_OPTIONS)],
            dbConnectionOptions: {
                ...serverConfig.dbConnectionOptions,
                ...sharedDatabaseOptions,
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

        // WHAT THE MIGRATION ASKED FOR, recorded through a proxy that executes nothing. It is taken after the
        // apply deliberately: the recording issues no statement, so it can neither disturb the schema the rest
        // of the file reads nor depend on the order the cases run in. This is half one of every named-object
        // claim, and it reads the migration's own behaviour on THIS engine rather than one engine's dialect out
        // of a text file.
        await withQueryRunner(async recordingSubject => {
            const migration = new AddReorderLists1786838400000();
            recordedUp = await recordMigrationDirection(recordingSubject, recording =>
                migration.up(recording),
            );
            recordedDown = await recordMigrationDirection(recordingSubject, recording =>
                migration.down(recording),
            );
        });

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
        try {
            if (assertionDataSource !== undefined && assertionDataSource.isInitialized) {
                await assertionDataSource.destroy();
            }
            if (privateDatabasePath !== undefined) {
                // The suite's own file, created by the suite, outside the repository — so removing it is the
                // one deletion this file performs and it can only ever remove what `beforeAll` wrote.
                await fs.remove(path.dirname(privateDatabasePath));
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
    // HALF ONE OF EVERY NAMED-OBJECT CLAIM — what the migration itself asks this engine for
    //
    // Reading the migration proves only what it asked for. Issuing the write it forbids proves the database
    // enforces it. The two are different claims and STORY-001-01-01's Definition-of-Done item 7 requires both,
    // which is why every named object appears twice in this file: once here and once below.
    //
    // WHY THIS HALF READS BEHAVIOUR RATHER THAN TEXT. The migration carries no SQL — it builds its two
    // `Table` descriptions from frozen literals of its own and hands them to the query runner — so there is no
    // DDL string to grep, and a grep would in any case only ever have matched one engine's dialect. The
    // recording proxy in `beforeAll` drove `up()` and `down()` against a real query runner with
    // `createTable`/`dropTable` intercepted, so what these cases read is the exact description this engine
    // receives: the order, the columns and their widths, the named uniques, index and checks, and the four
    // cascading foreign keys. Nothing was executed to obtain it.
    //
    // What the file's TEXT is still asserted on is what text is the right medium for: that it contains no DDL
    // literal (which is what makes it portable), no hard-coded schema qualifier (which is what makes it
    // correct under a configured non-default schema), and neither withdrawn identifier.
    // ═══════════════════════════════════════════════════════════════════════════════════════════════

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
            // path the manifest's `files` entry publishes — and it is still absent from the package's root
            // barrel, because a migration is not public API.
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
                `export class ${MIGRATION_CLASS_NAME} implements MigrationInterface`,
            );

            // TypeORM orders migrations by the digits trailing the class name and records that name in its own
            // bookkeeping table, so the filename digits and the class-name digits must agree. A mismatch
            // silently reorders migrations rather than failing.
            expect(MIGRATION_CLASS_NAME).toMatch(/\d+$/);
            expect(MIGRATION_FILENAME.startsWith(MIGRATION_CLASS_NAME.replace(/^\D+/, ''))).toBe(true);
        });

        it('contains no DDL of any engine, which is what makes one file serve all four', () => {
            // Every keyword below is dialect-bound, so any one of them appearing would pin this file to a
            // single engine — which is the defect this migration exists without. The absence is asserted
            // positively rather than left implied by the file happening to apply on the configured engine.
            //
            // The keywords are matched against the executable text only. The header explains the mechanism and
            // necessarily names some of these words while doing so; a prose sentence is not a statement.
            const body = executableTextOf(migrationSource);
            for (const keyword of FORBIDDEN_DDL_KEYWORDS) {
                expect(
                    body.toUpperCase(),
                    `"${keyword}" is engine-specific DDL and must not appear. ${ENGINE_PORTABILITY_CITATION}`,
                ).not.toContain(keyword.toUpperCase());
            }

            // And the positive form of the same claim: the two directions are expressed through the query
            // runner's own schema API, which is the API the platform's schema builder uses, over table
            // descriptions the file constructs itself.
            expect(body).toContain('createTable(');
            expect(body).toContain('dropTable(');
            expect(body).toContain('new Table(');
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
            for (const column of [...EXPECTED_LIST_COLUMNS, ...EXPECTED_LINE_COLUMNS]) {
                expect(
                    body,
                    `the migration must spell the "${column}" column it created, so that a reader can see ` +
                        'the frozen shape without resolving entity metadata',
                ).toContain(`'${column}'`);
            }
            for (const namedObject of ALL_NAMED_OBJECTS) {
                expect(body, `the migration must spell ${namedObject.name}`).toContain(namedObject.name);
            }
        });

        it('froze the shape these entities still declare, so changing one needs a new migration', () => {
            // THE OTHER DIRECTION OF THE SAME PROPERTY, and the reason the frozen shape is auditable rather
            // than merely fixed. Freezing stops a later entity edit from changing what THIS timestamp
            // creates; it does not stop the two from drifting apart, and a drift would mean a deployment
            // built by migration carries a different schema from one built by the schema builder.
            //
            // So the entity declarations are turned into the same kind of description the migration froze —
            // `Table.create(metadata, driver)`, the schema builder's own translation, plus the foreign keys it
            // omits — and compared with what the migration actually handed this engine. Whoever adds a column
            // to `ReorderList` fails here, which is the moment to be told that the column belongs to a new
            // migration of its own rather than to this one.
            for (const [table, entityClass] of [
                [LIST_TABLE, ReorderList],
                [LINE_TABLE, ReorderListLine],
            ] as const) {
                const metadata = assertionDataSource.getMetadata(entityClass);
                const declared = Table.create(metadata, assertionDataSource.driver);
                // `Table.create` omits foreign keys, exactly as `RdbmsSchemaBuilder` does before adding them
                // separately, so they are supplied through the same translation it uses.
                declared.foreignKeys = metadata.foreignKeys.map(foreignKey =>
                    TableForeignKey.create(foreignKey, assertionDataSource.driver),
                );
                const frozen = recordedUp.tables.find(candidate => bareTableName(candidate.name) === table);
                expect(frozen, `the migration must create "${table}"`).toBeDefined();

                expect(
                    comparableTableShape(declared),
                    `"${table}" as ${entityClass.name} declares it differs from what this migration froze; ` +
                        'a change to the entity belongs in a new migration rather than in this one',
                ).toEqual(comparableTableShape(frozen as Table));
            }
        });

        it('hard-codes no schema qualifier, so a configured non-default schema is honoured', () => {
            // `DataSourceOptions.schema` is configurable and the dev-server exposes it as `DB_SCHEMA`. TypeORM
            // neither rewrites raw migration SQL nor sets a `search_path` from it, so a literal `public` would
            // target the wrong schema on any deployment that configured another one — in `down()` most
            // damagingly of all, where it would fail to drop what `up()` created.
            // The executable text again, and for the same reason: the header quotes the qualifier while
            // explaining why spelling it would be wrong.
            const body = executableTextOf(migrationSource);
            for (const literal of FORBIDDEN_SCHEMA_LITERALS) {
                expect(
                    body,
                    `${literal} is a hard-coded schema qualifier; the qualified name must be built at run ` +
                        'time through driver.buildTableName(tableName, schema, database)',
                ).not.toContain(literal);
            }

            // The positive half, read off the recording: the table names the migration actually handed this
            // engine are the ones the configured schema resolves to, which is what a name built through the
            // driver produces. The entity metadata is the ORACLE for that expectation here — it is what a
            // correctly-qualified name must agree with — not the source the migration read it from.
            for (const table of PLUGIN_TABLES_PARENT_FIRST) {
                const expectedName = assertionDataSource.getMetadata(
                    table === LIST_TABLE ? ReorderList : ReorderListLine,
                ).tablePath;
                expect(recordedTable(recordedUp, table).name).toBe(expectedName);
                expect(recordedTable(recordedDown, table).name).toBe(expectedName);
            }
        });

        it('creates the parent table first and drops the child table first', () => {
            // The parent first, because the child's foreign key references it; the child first on the way down,
            // because a parent still referenced cannot be dropped. Read off the recording in the order the
            // migration made the calls.
            expect(recordedUp.calls).toEqual(['createTable', 'createTable']);
            expect(recordedUp.tables.map(table => bareTableName(table.name))).toEqual([
                ...PLUGIN_TABLES_PARENT_FIRST,
            ]);

            expect(recordedDown.calls).toEqual(['dropTable', 'dropTable']);
            expect(recordedDown.tables.map(table => bareTableName(table.name))).toEqual([
                ...PLUGIN_TABLES_CHILD_FIRST,
            ]);
        });

        it('carries the three engine-portable named objects under their exact names', () => {
            for (const namedObject of PORTABLE_NAMED_OBJECTS) {
                const table = recordedTable(recordedUp, namedObject.table);
                expect(
                    namedObjectsOf(table),
                    `the migration must name ${namedObject.name} on ${namedObject.table}`,
                ).toContain(namedObject.name);

                // And spanning exactly the declared columns, so a name cannot be right while its subject is
                // wrong. The name is load-bearing — the service translates a violation of
                // `UQ_reorder_list_customer_channel_name_key` into `ReorderListNameConflictError` by matching
                // it — and so is what it covers.
                const spans = [...table.uniques, ...table.indices].find(
                    candidate => candidate.name === namedObject.name,
                );
                expect(spans, `${namedObject.name} is not declared on ${namedObject.table}`).toBeDefined();
                expect(spans?.columnNames.slice().sort()).toEqual(namedObject.columns.slice().sort());
            }
        });

        it('declares both named check constraints on every engine, which localises conflict C-E', () => {
            // THE GAP IS LOCATED HERE RATHER THAN ASSUMED. The migration declares both checks on all four
            // engines — each is one of its own frozen literals, and this recording is taken before any driver
            // has had a chance to discard them. So what conflict C-E describes is not a missing declaration but a
            // MySQL-family driver that drops the declaration silently between here and the catalogue, and the
            // catalogue half below is where that shows up. Asserting the declaration on every engine is what
            // makes the two halves distinguishable.
            for (const namedObject of CHECK_NAMED_OBJECTS) {
                const table = recordedTable(recordedUp, namedObject.table);
                expect(
                    table.checks.map(check => String(check.name ?? '')),
                    `the migration must declare ${namedObject.name} on ${namedObject.table}. ${C_E_CITATION}`,
                ).toContain(namedObject.name);
            }

            // The expressions themselves, so a check cannot be present under the right name while guarding
            // nothing. Both are read off the entity declarations rather than restated, which is the whole
            // reason the migration cannot drift from them.
            const lineChecks = recordedTable(recordedUp, LINE_TABLE).checks.map(check =>
                String(check.expression ?? ''),
            );
            expect(lineChecks.join(' ')).toContain('quantity');
            const listChecks = recordedTable(recordedUp, LIST_TABLE).checks.map(check =>
                String(check.expression ?? ''),
            );
            expect(listChecks.join(' ')).toContain('lineCount');
        });

        it('carries the denormalised line counter and both indexed string columns at their declared width', () => {
            const list = describeTable(recordedTable(recordedUp, LIST_TABLE));
            const columnNames = list.columns.map(column => column.name);
            expect(columnNames).toContain('lineCount');
            expect(columnNames).toContain('name');
            expect(columnNames).toContain('nameKey');

            // 191 on both string columns. A key-size ceiling on the MySQL family rather than a product choice,
            // which is why the same number is the plugin's fixed name-length bound.
            for (const stringColumn of ['name', 'nameKey']) {
                const column = list.columns.find(candidate => candidate.name === stringColumn);
                expect(column?.length, `"${stringColumn}" must be declared at 191`).toBe(
                    INDEXED_STRING_COLUMN_LENGTH,
                );
                expect(column?.isNullable).toBe(false);
            }

            // The counter starts at zero, which is what makes a freshly created list report `lineCount: 0`
            // without the service writing anything.
            const lineCount = list.columns.find(candidate => candidate.name === 'lineCount');
            expect(lineCount?.isNullable).toBe(false);
            expect(String(lineCount?.default ?? '').replace(/[()']/g, '')).toBe('0');
        });

        it('carries four ON DELETE CASCADE foreign keys, every one declared on a plugin table', () => {
            const declared: string[] = [];
            for (const table of recordedUp.tables) {
                for (const foreignKey of table.foreignKeys) {
                    expect(
                        foreignKey.columnNames.length,
                        `${String(foreignKey.name)} must be a single-column key`,
                    ).toBe(1);
                    expect(
                        String(foreignKey.onDelete ?? '').toUpperCase(),
                        `${bareTableName(table.name)}.${foreignKey.columnNames[0]} must cascade`,
                    ).toBe('CASCADE');
                    declared.push(
                        `${bareTableName(table.name)}.${foreignKey.columnNames[0]}->${bareTableName(
                            foreignKey.referencedTableName,
                        )}`,
                    );
                }
            }

            // Exactly the four the entity declarations carry, each FROM a plugin table TO a core table or to
            // the plugin's own parent. The direction is the whole point of the additive-boundary claim: nothing
            // here adds a column to a core table or makes a core table depend on a plugin table.
            expect(declared.slice().sort()).toEqual(
                EXPECTED_FOREIGN_KEYS.map(key => `${key.table}.${key.column}->${key.references}`)
                    .slice()
                    .sort(),
            );
        });

        it('alters no core table and drops no core object', () => {
            // Every table the migration names is a PLUGIN table, on both directions. The core tables appear
            // only as the target of a foreign-key reference, which adds nothing to them.
            for (const recording of [recordedUp, recordedDown]) {
                for (const table of recording.tables) {
                    expect(
                        PLUGIN_TABLES_PARENT_FIRST.indexOf(
                            bareTableName(table.name) as (typeof PLUGIN_TABLES_PARENT_FIRST)[number],
                        ),
                        `"${table.name}" is not a plugin table, so this migration is not additive`,
                    ).toBeGreaterThan(-1);
                }
            }

            // Each core table IS named in the migration's text — that is what freezing a foreign key means —
            // and the assertion is therefore about HOW. It appears only as a reference target: the file
            // contains no DDL of any kind (asserted above), and the only tables it hands the engine are the
            // two plugin tables (asserted just now), so naming `customer` can create nothing and alter
            // nothing. A core table absent from the text would mean the reference had been derived from live
            // metadata, which is the very thing that made this migration's shape mutable.
            const body = executableTextOf(migrationSource);
            for (const coreTable of REFERENCED_CORE_TABLES) {
                expect(
                    body,
                    `"${coreTable}" must be named as a frozen foreign-key target rather than resolved from ` +
                        'entity metadata at replay time',
                ).toContain(`'${coreTable}'`);
            }
        });

        it('carries neither withdrawn claim column, nor the withdrawn claim constraint, nor a seats counter', () => {
            // CONFLICT C-A. One stale sub-task of STORY-001-01-01 still asks for the claim pair; the feature
            // contract withdraws all three objects and the story's own migration sub-task and Definition-of-Done
            // item make their ABSENCE the assertion. The seats counter belongs to FEATURE-001-06's own later
            // migration, so this file must never be edited to add it either.
            //
            // Asserted twice over, and the two reads answer different questions now that the migration spells
            // its own frozen inventory: absent from the file's TEXT, so no future editor can add one here
            // without the assertion catching it, AND absent from the tables it actually asks this engine to
            // create, so a shape that acquired one by some other route is caught too.
            for (const column of WITHDRAWN_COLUMNS) {
                expect(migrationSource, `${column} is withdrawn and must not appear`).not.toContain(column);
                for (const table of recordedUp.tables) {
                    expect(
                        table.columns.map(candidate => candidate.name),
                        `${column} is withdrawn and must not be created on ${bareTableName(table.name)}`,
                    ).not.toContain(column);
                }
            }
            expect(
                migrationSource,
                `${WITHDRAWN_CHECK_CONSTRAINT} is withdrawn and must not appear`,
            ).not.toContain(WITHDRAWN_CHECK_CONSTRAINT);
            for (const table of recordedUp.tables) {
                expect(namedObjectsOf(table)).not.toContain(WITHDRAWN_CHECK_CONSTRAINT);
            }
        });
    });

    // ═══════════════════════════════════════════════════════════════════════════════════════════════
    // The layout the dev server registers
    //
    // The package ships its migration in two layouts — `src/migrations/*.ts` in a checkout and
    // `lib/src/migrations/*.js` in the published artefact — and a built checkout carries BOTH. Registering
    // both patterns is not a harmless superset: TypeORM loads every pattern and then refuses the whole
    // configuration, because both files declare the same class.
    // `MigrationExecutor.checkForDuplicateMigrations` throws `Duplicate migrations: <name>`
    // (`node_modules/typeorm/migration/MigrationExecutor.js:L423-L433`), which stops the server and every
    // migration command outright.
    //
    // So the registration must pick exactly one, and the choice is asserted for all three layouts a machine
    // can be in rather than only for the one this machine happens to be in. The selection function is read out
    // of `packages/dev-server/dev-config.ts` and executed, so what is exercised is the shipped decision rather
    // than a restatement of it here.
    // ═══════════════════════════════════════════════════════════════════════════════════════════════

    describe('the layout the dev server registers', () => {
        /** Directories the selector is asked about, keyed by the layout each represents. */
        const BUILT_LAYOUT_DIR = path.join(SELECTOR_PROBE_ROOT, 'lib/src/migrations');
        const SOURCE_LAYOUT_DIR = path.join(SELECTOR_PROBE_ROOT, 'src/migrations');

        it('registers exactly one layout, in every layout the package can be installed in', async () => {
            const select = await devConfigLayoutSelector();

            const present =
                (...directories: string[]) =>
                (candidate: string) =>
                    directories.includes(candidate);

            // An installed package: no `src` tree at all, so the compiled layout is the only one there is.
            expect(
                select(SELECTOR_PROBE_ROOT, present(BUILT_LAYOUT_DIR)),
                'an installed package must register its compiled migration',
            ).toEqual([path.join(BUILT_LAYOUT_DIR, '*.js')]);

            // A source checkout that has been built — the normal state of this repository, because `AGENTS.md`
            // prescribes change, build, restart. Both layouts are present and exactly one must be chosen.
            expect(
                select(SELECTOR_PROBE_ROOT, present(BUILT_LAYOUT_DIR, SOURCE_LAYOUT_DIR)),
                'a built checkout must register one layout, not both',
            ).toEqual([path.join(BUILT_LAYOUT_DIR, '*.js')]);

            // A source checkout that has not been built yet: the source layout, which a TypeScript-aware host
            // can load and which is the only thing there.
            expect(
                select(SELECTOR_PROBE_ROOT, present(SOURCE_LAYOUT_DIR)),
                'an unbuilt checkout must register its source migration',
            ).toEqual([path.join(SOURCE_LAYOUT_DIR, '*.ts')]);

            // Neither: nothing is registered, rather than a pattern that cannot match.
            expect(select(SELECTOR_PROBE_ROOT, () => false)).toEqual([]);
        });

        it('never registers both layouts, because each declares the same migration class', async () => {
            // WHY one had to be chosen, stated as evidence rather than as a comment. Both artefacts declare
            // `AddReorderLists1786838400000`, so a configuration naming both hands TypeORM two migrations of
            // one name and is rejected in full.
            expect(migrationSource, 'the source layout must declare the migration class').toContain(
                `export class ${MIGRATION_CLASS_NAME}`,
            );
            const builtFile = path.join(BUILT_MIGRATION_GLOB_DIR, MIGRATION_FILENAME.replace(/\.ts$/, '.js'));
            expect(
                await fs.pathExists(builtFile),
                `${builtFile} must exist; run the package build first`,
            ).toBe(true);
            expect(
                await fs.readFile(builtFile, 'utf-8'),
                'the compiled layout must declare the same migration class, which is why both cannot be ' +
                    'registered together',
            ).toContain(MIGRATION_CLASS_NAME);

            // And the shipped selection, run against THIS machine's real filesystem, yields one pattern whose
            // directory holds exactly one migration file — so the duplicate-name rejection is unreachable.
            const select = await devConfigLayoutSelector();
            const selected = select(path.join(__dirname, '..'), candidate => fs.existsSync(candidate));
            expect(selected, 'exactly one pattern must be registered on this machine').toHaveLength(1);
            const selectedDir = path.dirname(selected[0]);
            const selectedExtension = path.extname(selected[0]);
            const matches = (await fs.readdir(selectedDir)).filter(entry =>
                entry.endsWith(selectedExtension),
            );
            expect(matches, `${selected[0]} must resolve to exactly one migration file`).toHaveLength(1);
        });

        it('anchors the pattern on the installed package root rather than on a relative path', async () => {
            const devConfigSource = await fs.readFile(DEV_CONFIG_FILE_PATH, 'utf-8');

            // `__dirname` is `packages/dev-server` from source and `packages/dev-server/dist` once built, so a
            // relative `../reorder-plugin/...` pattern resolves to a directory that does not exist in the
            // built layout. Resolving the package's own manifest is right in both, and in a consumer's
            // `node_modules` too.
            expect(devConfigSource).toContain("require.resolve('@vendure/reorder-plugin/package.json')");
            expect(
                devConfigSource,
                'the migration pattern must not be built from a path relative to the dev server',
            ).not.toContain("'../reorder-plugin");
        });
    });

    // ═══════════════════════════════════════════════════════════════════════════════════════════════
    // The configuration that drives the migration
    //
    // A migration-driven connection must not synchronise. If it does, the schema builder creates this
    // plugin's two tables from entity metadata before the migration runs, and the migration then validates a
    // schema it did not author instead of owning it — which is the difference between a schema history that
    // records what happened and one that merely records that something did.
    //
    // Two independent guarantees are asserted, because either alone is thinner than it looks. The platform
    // forces `synchronize: false` onto every migration connection, which is the guarantee that actually holds
    // in production; and the dev-server configuration says so itself, at a position where saying it has an
    // effect. The second exists because it used to be declared BEFORE `...getDbConfig()`, which returns
    // `synchronize: true` on every branch, so the file read as though it made a promise it did not keep.
    // ═══════════════════════════════════════════════════════════════════════════════════════════════

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
            // The forced object comes AFTER the caller's, which is what makes it win.
            expect(body.indexOf('synchronize: false')).toBeGreaterThan(
                body.indexOf('userConfig.dbConnectionOptions'),
            );
            for (const entryPoint of ['generateMigration', 'runMigrations', 'revertLastMigration']) {
                expect(migrateSource, `${entryPoint} must route through createConnectionOptions`).toMatch(
                    new RegExp(`${entryPoint}[\\s\\S]{0,4000}createConnectionOptions`),
                );
            }

            // And this suite's own lifecycle configuration says the same thing explicitly, so the apply the
            // rest of the file measures cannot have been a synchronization pass wearing a migration's name.
            expect(migrationConfig.dbConnectionOptions.synchronize).toBe(false);
        });

        it('declares synchronization after every spread, and disables it for the migration entry point', async () => {
            const devConfigSource = await fs.readFile(DEV_CONFIG_FILE_PATH, 'utf-8');
            const optionsStart = devConfigSource.indexOf('dbConnectionOptions: {');
            expect(optionsStart, 'dev-config must declare dbConnectionOptions').toBeGreaterThan(-1);
            const options = devConfigSource.slice(
                optionsStart,
                devConfigSource.indexOf('\n    },', optionsStart),
            );

            // POSITION IS THE POINT. A later key wins, so a `synchronize` declared before the spread is dead.
            expect(options, 'dbConnectionOptions must spread the engine configuration').toContain(
                '...getDbConfig()',
            );
            expect(options.indexOf('synchronize:')).toBeGreaterThan(options.indexOf('...getDbConfig()'));
            expect(
                options.slice(0, options.indexOf('...getDbConfig()')),
                'no synchronize declaration may sit before the spread, where it would be overwritten',
            ).not.toContain('synchronize');

            // And the value is disabled for the migration entry point. The discriminator is lifted out of the
            // shipped file and run, so this asserts the behaviour rather than the spelling.
            expect(options).toContain('synchronize: !IS_MIGRATION_ENTRY_POINT');
            const declaration = /const IS_MIGRATION_ENTRY_POINT = (\/.+\/)\.test\(process\.argv\[1\]/.exec(
                devConfigSource,
            );
            expect(
                declaration,
                'IS_MIGRATION_ENTRY_POINT must be derived from the script Node was handed',
            ).not.toBeNull();
            const literal = (declaration as RegExpExecArray)[1];
            const lastSlash = literal.lastIndexOf('/');
            const isMigrationEntryPoint = new RegExp(
                literal.slice(1, lastSlash),
                literal.slice(lastSlash + 1),
            );

            for (const migrationEntryPoint of [
                path.join('packages', 'dev-server', 'migration.ts'),
                path.join('packages', 'dev-server', 'dist', 'migration.js'),
            ]) {
                expect(
                    isMigrationEntryPoint.test(migrationEntryPoint),
                    `${migrationEntryPoint} drives migrations, so synchronization must be off`,
                ).toBe(true);
            }
            // Every server and population entry point keeps it on: this package ships no core migrations, so a
            // blanket disable would leave `populate` and `dev` facing a database with no tables at all.
            for (const serverEntryPoint of [
                path.join('packages', 'dev-server', 'populate-dev-server.ts'),
                path.join('packages', 'dev-server', 'index.ts'),
                path.join('packages', 'dev-server', 'index-worker.ts'),
                path.join('packages', 'cli', 'dist', 'cli.js'),
                '',
            ]) {
                expect(
                    isMigrationEntryPoint.test(serverEntryPoint),
                    `${serverEntryPoint || '<no argv[1]>'} boots or populates a server, so synchronization ` +
                        'must stay on',
                ).toBe(false);
            }
        });

        it('registers this plugin migration only where synchronization is off', async () => {
            // ONE RULE, NOT TWO. A connection is either migration-driven — synchronization off AND this
            // plugin's migration registered — or a server connection, with synchronization on and no plugin
            // migration registered at all. Half of that pairing is the incoherent state, and the shipped boot
            // path is what makes it concrete: `packages/dev-server/index.ts:L8-L9` runs
            // `runMigrations(devConfig)` before `bootstrap(devConfig)`, a migration connection is forced to
            // `synchronize: false`, and on a fresh database this migration would therefore run before the three
            // core tables its references point at exist. `runMigrations` does not rethrow outside the Vendure
            // CLI — it logs, sets `process.exitCode = 1` and resolves
            // (`packages/core/src/migrate.ts:L52-L59`) — so the chain continues, bootstrap synchronizes, the
            // schema builder creates the two tables, and a later boot records this migration as applied
            // against a schema it did not author, having already failed once without stopping anything.
            //
            // Gating the registration on the same discriminator that gates synchronization removes that whole
            // chain, and restores the boot path to what it was before this feature registered anything: a
            // pattern that matches nothing.
            const devConfigSource = await fs.readFile(DEV_CONFIG_FILE_PATH, 'utf-8');
            const optionsStart = devConfigSource.indexOf('dbConnectionOptions: {');
            const options = devConfigSource.slice(
                optionsStart,
                devConfigSource.indexOf('\n    },', optionsStart),
            );

            // The plugin's patterns appear exactly once, and behind the discriminator.
            const registration = /\.\.\.\((\w+) \? reorderPluginMigrationGlobs\(\) : \[\]\)/.exec(options);
            expect(
                registration,
                'the plugin migration must be registered only for a migration-driven connection, because a ' +
                    'server boot that carries it can half-apply it and then let the schema builder finish',
            ).not.toBeNull();

            // And it is the SAME discriminator that turns synchronization off, so the two cannot drift apart.
            const guard = (registration as RegExpExecArray)[1];
            expect(
                options,
                `the migration registration is gated on ${guard}, so synchronization must be gated on it too`,
            ).toContain(`synchronize: !${guard}`);

            // `runMigrations` really does swallow a failure outside the CLI, which is why a boot must not be
            // handed a migration it cannot apply. Read out of the platform rather than asserted from prose.
            const migrateSource = await fs.readFile(
                path.join(__dirname, '../../core/src/migrate.ts'),
                'utf-8',
            );
            expect(migrateSource).toContain('process.exitCode = 1');
            expect(
                migrateSource,
                'runMigrations rethrows only under the Vendure CLI; every other caller sees it resolve',
            ).toContain('isRunningFromVendureCli()');
        });
    });

    // ═══════════════════════════════════════════════════════════════════════════════════════════════
    // The up-path against a table that is already there
    //
    // `up()` passes no `ifNotExist`, because a migration that silently accepts whatever table it finds can be
    // recorded as applied against a shape it never created — and a schema history that says so is worse than
    // no history. Instead it asks for the table and, finding one, checks it against the FROZEN MINIMUM: every
    // frozen object and every attribute of it the catalogue reports, with a surplus tolerated and the
    // exclusions enumerated on the migration's own `frozenShapeShortfalls`. Both outcomes are asserted here,
    // on the live schema the apply in `beforeAll` produced: the matching table is accepted without a
    // statement, and a table falling short of the minimum is refused by name. The second case restores what it removed in a `finally`, so the schema every sibling
    // case reads is the one the migration built.
    // ═══════════════════════════════════════════════════════════════════════════════════════════════

    describe('the up-path against an existing table', () => {
        it(
            'accepts the schema it created, and issues no create for it',
            async () => {
                await withQueryRunner(async queryRunner => {
                    // A proxy that FAILS the case if a create is attempted, and delegates everything else —
                    // including `getTable` — to the real runner, so the decision is made against the live
                    // schema rather than against a stub. This is the counterpart of the recording proxy, which
                    // reports absence in order to observe the create path.
                    const created: string[] = [];
                    const observing = new Proxy(queryRunner, {
                        get(target, property, receiver) {
                            if (property === 'createTable') {
                                return (table: Table): Promise<void> => {
                                    created.push(bareTableName(table.name));
                                    return Promise.resolve();
                                };
                            }
                            const value = Reflect.get(target, property, receiver);
                            return typeof value === 'function' ? value.bind(target) : value;
                        },
                    });

                    await new AddReorderLists1786838400000().up(observing);

                    expect(
                        created,
                        'both tables are already standing in exactly the frozen shape, so the up-path must ' +
                            'verify them rather than attempt a create that the engine would refuse',
                    ).toEqual([]);
                });
            },
            CATALOGUE_READ_ABORT_AFTER_MS,
        );

        it(
            'refuses a table that is missing one of its frozen named objects',
            async () => {
                await withQueryRunner(async queryRunner => {
                    const before = await queryRunner.getTable(LIST_TABLE);
                    const removed = (before as Table).indices.find(index => index.name === IDX_LIST_OWNER);
                    expect(
                        removed,
                        `"${LIST_TABLE}" must carry ${IDX_LIST_OWNER} before this case removes it`,
                    ).toBeDefined();

                    // The drift is a DROPPED INDEX rather than a dropped column, and deliberately so: dropping
                    // and recreating an index is supported identically on all four engines, so this case makes
                    // the same measurement everywhere, and it restores exactly what it removed.
                    await queryRunner.dropIndex(LIST_TABLE, IDX_LIST_OWNER);
                    try {
                        await expect(new AddReorderLists1786838400000().up(queryRunner)).rejects.toThrowError(
                            new RegExp(IDX_LIST_OWNER),
                        );
                    } finally {
                        await queryRunner.createIndex(LIST_TABLE, removed as TableIndex);
                    }

                    const after = await queryRunner.getTable(LIST_TABLE);
                    expect(
                        (after as Table).indices.map(index => String(index.name ?? '')),
                        'this case must leave the schema exactly as it found it',
                    ).toContain(IDX_LIST_OWNER);
                });
            },
            CATALOGUE_READ_ABORT_AFTER_MS,
        );

        // ═══════════════════════════════════════════════════════════════════════════════════════════
        // LIVE deferred constraints — the drift TypeORM's generic table view cannot see
        // ═══════════════════════════════════════════════════════════════════════════════════════════
        //
        // A deferred constraint fires at COMMIT instead of at the statement, which breaks this plugin's
        // narrow constraint translation: `createReorderList` answers `ReorderListNameConflictError` by
        // catching the `INSERT` failing, and against a deferred unique the insert succeeds and the
        // transaction fails later, past every `catch` the service has.
        //
        // These two cases GENUINELY DEFER a live constraint rather than doctoring a catalogue reading, and
        // they exist because for two engine-and-class combinations the doctored form would prove nothing
        // about a real deployment. TypeORM's `getTable()` is not authoritative on enforcement timing:
        //
        //   - The SQLite family WRITES a reference's clause into the table text it stores
        //     (`AbstractSqliteQueryRunner.js:1204-1205`) and has no loader that reads it back, so a live
        //     deferred reference presents as `undefined` — indistinguishable, to the generic view, from an
        //     immediate one.
        //   - PostgreSQL's unique loader reads deferrability fields its own constraints query never selects
        //     (`PostgresQueryRunner.js:2125` against `:1801-1808`), so a live deferred UNIQUE presents as
        //     `undefined` there too.
        //
        // The migration answers both by reading the engine's own catalogue — `pg_constraint` on PostgreSQL,
        // the stored table text on the SQLite family. What these cases measure is exactly that: a constraint
        // the generic view calls immediate and the engine really defers. Each restores what it changed and
        // asserts the restoration, and each decides its own applicability from what the engine actually
        // stored rather than from an engine name.
        describe('a live constraint whose enforcement has been deferred', () => {
            it(
                'is refused for a unique, which the generic table view reports nothing about',
                async () => {
                    await withQueryRunner(async queryRunner => {
                        const before = await queryRunner.getTable(LIST_TABLE);
                        const original = (before as Table).uniques.find(
                            unique => unique.name === UQ_LIST_OWNER_NAME_KEY,
                        );
                        if (!original) {
                            // The MySQL family files a unique as a named unique index, which carries no
                            // deferrability clause in any grammar. There is no timing here to defer.
                            return;
                        }

                        await queryRunner.dropUniqueConstraint(LIST_TABLE, original);
                        try {
                            await queryRunner.createUniqueConstraint(
                                LIST_TABLE,
                                new TableUnique({
                                    name: original.name,
                                    columnNames: original.columnNames,
                                    deferrable: 'INITIALLY DEFERRED',
                                }),
                            );

                            // Applicability decided from what the ENGINE holds, read independently of both
                            // the generic view and the migration under test. SQLite's grammar admits no
                            // deferrability clause on a unique, so on that family the constraint comes back
                            // immediate and there is no deferral for anything to catch.
                            const held = await liveEnforcementTiming(
                                queryRunner,
                                LIST_TABLE,
                                UQ_LIST_OWNER_NAME_KEY,
                            );
                            if (held !== 'INITIALLY DEFERRED') {
                                expect(
                                    isPostgresFamily(resolveConfiguredEngine()),
                                    "PostgreSQL stores a unique's deferrability, so a request to defer one " +
                                        'that comes back immediate there is a defect in this case rather ' +
                                        'than an engine limitation',
                                ).toBe(false);
                                return;
                            }

                            // THE POINT OF THE CASE, asserted before the refusal is asked for: the generic
                            // view still reports nothing, so anything that refuses this must have read
                            // somewhere else.
                            const doctoredByTheEngine = await queryRunner.getTable(LIST_TABLE);
                            const asGenericViewSeesIt = (doctoredByTheEngine as Table).uniques.find(
                                unique => unique.name === UQ_LIST_OWNER_NAME_KEY,
                            );
                            expect(
                                asGenericViewSeesIt?.deferrable,
                                'this case rests on the generic view being blind to a live deferred unique; ' +
                                    'if TypeORM has started reporting it, the native reading is no longer ' +
                                    'the only source and this case must be rewritten rather than deleted',
                            ).toBeUndefined();

                            await expect(
                                new AddReorderLists1786838400000().up(queryRunner),
                                "a unique enforced at commit cannot be recorded as this migration's work, " +
                                    'because the service catches the statement failing and there would be ' +
                                    'no failing statement to catch',
                            ).rejects.toThrowError(new RegExp(UQ_LIST_OWNER_NAME_KEY));
                        } finally {
                            await queryRunner
                                .dropUniqueConstraint(LIST_TABLE, UQ_LIST_OWNER_NAME_KEY)
                                .catch(() => undefined);
                            await queryRunner.createUniqueConstraint(LIST_TABLE, original);
                        }

                        const after = await queryRunner.getTable(LIST_TABLE);
                        expect(
                            (after as Table).uniques.map(unique => String(unique.name ?? '')),
                            'this case must leave the schema exactly as it found it',
                        ).toContain(UQ_LIST_OWNER_NAME_KEY);
                        await expect(
                            new AddReorderLists1786838400000().up(queryRunner),
                            'and the restored schema must be accepted again, which is what proves the ' +
                                'refusal above was about the deferral rather than about the rebuild',
                        ).resolves.toBeUndefined();
                    });
                },
                CATALOGUE_READ_ABORT_AFTER_MS,
            );

            it(
                'is refused for a reference, on every engine that stores the clause',
                async () => {
                    await withQueryRunner(async queryRunner => {
                        const before = await queryRunner.getTable(LINE_TABLE);
                        const original = (before as Table).foreignKeys.find(
                            reference => reference.name === FK_LINE_LIST,
                        );
                        expect(
                            original,
                            `"${LINE_TABLE}" must carry ${FK_LINE_LIST} before this case defers it`,
                        ).toBeDefined();

                        const deferred = new TableForeignKey({
                            name: (original as TableForeignKey).name,
                            columnNames: (original as TableForeignKey).columnNames,
                            referencedTableName: (original as TableForeignKey).referencedTableName,
                            referencedColumnNames: (original as TableForeignKey).referencedColumnNames,
                            onDelete: (original as TableForeignKey).onDelete,
                            onUpdate: (original as TableForeignKey).onUpdate,
                            deferrable: 'INITIALLY DEFERRED',
                        });

                        await queryRunner.dropForeignKey(LINE_TABLE, original as TableForeignKey);
                        try {
                            await queryRunner.createForeignKey(LINE_TABLE, deferred);

                            // Applicability decided from what the ENGINE holds, read independently of both
                            // the generic view and the migration under test. The MySQL family's grammar
                            // refuses the clause outright — measured as `ER_PARSE_ERROR`, and its driver has
                            // no notion of deferrability in either direction — so it creates an immediate
                            // reference and there is nothing here to detect.
                            const held = await liveEnforcementTiming(queryRunner, LINE_TABLE, FK_LINE_LIST);
                            if (held !== 'INITIALLY DEFERRED') {
                                expect(
                                    isMysqlFamily(resolveConfiguredEngine()),
                                    'PostgreSQL and the SQLite family both store this clause, so a request ' +
                                        'to defer a reference that comes back immediate on either is a ' +
                                        'defect in this case rather than an engine limitation',
                                ).toBe(true);
                                return;
                            }

                            if (isSqliteFamily(resolveConfiguredEngine())) {
                                // THE POINT OF THE CASE on this family: the engine holds the deferral and
                                // the generic view reports nothing for it, so a refusal can only have come
                                // from the stored table text. Asserting the blindness here is what makes the
                                // native reading's necessity measured rather than argued.
                                const asGenericViewSeesIt = await queryRunner.getTable(LINE_TABLE);
                                expect(
                                    (asGenericViewSeesIt as Table).foreignKeys.find(
                                        reference => reference.name === FK_LINE_LIST,
                                    )?.deferrable,
                                    'the SQLite family writes this clause and never reads it back, so the ' +
                                        'generic view must still report nothing while the engine holds a ' +
                                        'deferred reference',
                                ).toBeUndefined();
                            }

                            await expect(
                                new AddReorderLists1786838400000().up(queryRunner),
                                'a cascade enforced at commit lets a parent delete and its child cascade ' +
                                    'sit apart, so a statement between them reads a child whose parent is ' +
                                    "gone; it cannot be recorded as this migration's work",
                            ).rejects.toThrowError(new RegExp(FK_LINE_LIST));
                        } finally {
                            await queryRunner.dropForeignKey(LINE_TABLE, FK_LINE_LIST).catch(() => undefined);
                            await queryRunner.createForeignKey(LINE_TABLE, original as TableForeignKey);
                        }

                        const after = await queryRunner.getTable(LINE_TABLE);
                        expect(
                            (after as Table).foreignKeys.map(reference => String(reference.name ?? '')),
                            'this case must leave the schema exactly as it found it',
                        ).toContain(FK_LINE_LIST);
                        await expect(
                            new AddReorderLists1786838400000().up(queryRunner),
                            'and the restored schema must be accepted again',
                        ).resolves.toBeUndefined();
                    });
                },
                CATALOGUE_READ_ABORT_AFTER_MS,
            );

            it(
                'is refused when the catalogue cannot be read at all, rather than assumed immediate',
                async () => {
                    // THE FAIL-CLOSED RULE, which is the other half of reading a native catalogue: a source
                    // that cannot answer must produce a refusal, not a default. Without it, the whole
                    // mechanism degrades silently the moment an engine, a driver version or a permission
                    // grant stops answering — which is precisely the failure mode that made the generic
                    // view's `undefined` unsafe in the first place.
                    //
                    // The reading is removed rather than the engine faked: every catalogue query the
                    // migration issues comes back empty, and nothing else about the connection changes. On
                    // the MySQL family the migration issues no such query — its grammar refuses a
                    // deferrability clause, measured as `ER_PARSE_ERROR` — so there is nothing to remove and
                    // the case records that instead.
                    await withQueryRunner(async queryRunner => {
                        let silenced = 0;
                        const mute = new Proxy(queryRunner, {
                            get(target, property, receiver) {
                                if (property === 'query') {
                                    return async (sql: string, parameters?: unknown[]): Promise<unknown> => {
                                        if (/pg_constraint|sqlite_master/i.test(sql)) {
                                            silenced += 1;
                                            return [];
                                        }
                                        return target.query(sql, parameters as undefined);
                                    };
                                }
                                const value = Reflect.get(target, property, receiver);
                                return typeof value === 'function' ? value.bind(target) : value;
                            },
                        });

                        let refusal: Error | undefined;
                        try {
                            await new AddReorderLists1786838400000().up(mute);
                        } catch (error) {
                            refusal = error as Error;
                        }

                        if (silenced === 0) {
                            expect(
                                isMysqlFamily(resolveConfiguredEngine()),
                                'every engine that can hold a deferred constraint must be asked about one, ' +
                                    'so a run that silenced no catalogue query on such an engine means the ' +
                                    'native reading was never issued',
                            ).toBe(true);
                            expect(
                                refusal,
                                'and the schema itself is unchanged, so it must be accepted',
                            ).toBe(undefined);
                            return;
                        }

                        expect(
                            refusal,
                            'a constraint whose enforcement timing cannot be established must be refused; ' +
                                'accepting it would record this migration as the author of a shape whose ' +
                                'error handling it cannot show works',
                        ).toBeDefined();
                        expect(
                            (refusal as Error).message,
                            'the refusal must say that the timing could not be shown, and name the engine ' +
                                'whose catalogue was asked, so an operator knows what to check',
                        ).toContain('cannot be shown to be NOT DEFERRABLE');
                        expect((refusal as Error).message).toContain(resolveConfiguredEngine());
                        expect(
                            (refusal as Error).message,
                            'and it must name the constraint, because a refusal that names nothing is not ' +
                                'actionable',
                        ).toContain(FK_LIST_CUSTOMER);

                        // The schema was never touched, so the real reading must still be accepted.
                        await expect(
                            new AddReorderLists1786838400000().up(queryRunner),
                            'nothing was written, so the unmuted run must accept the same schema',
                        ).resolves.toBeUndefined();
                    });
                },
                CATALOGUE_READ_ABORT_AFTER_MS,
            );
        });

        // ONE REFUSAL PER OBJECT CLASS, and per attribute within a class.
        //
        // The case above drifts the LIVE schema, which is the strongest evidence available but is only
        // practical for an object every engine can drop and recreate identically. A column's type, a check
        // constraint's expression and a reference's target are not in that set: altering them on the SQLite
        // family means rebuilding the table, and altering them on any engine risks leaving the schema every
        // sibling case reads in a state the migration did not build.
        //
        // So these cases drift the CATALOGUE READING instead. Each takes the real table the engine reports,
        // clones it, changes exactly one attribute, and hands that clone to `up()` — the comparison is the
        // shipped one, running against a real driver and real metadata, and the database is never written to.
        // Every case asserts the refusal names the object or attribute it broke, so a refusal for the wrong
        // reason cannot pass as the right one.
        describe.each(FROZEN_SHAPE_DRIFTS)(
            'refuses a table whose $description',
            ({ table, drift, names }) => {
                it(
                    'differs from the frozen description, naming what differs',
                    async () => {
                        await withQueryRunner(async queryRunner => {
                            const real = await queryRunner.getTable(table);
                            expect(real, `"${table}" must exist before this case reads it`).toBeDefined();

                            // Applicability is decided from the real reading rather than from the engine name: a
                            // collation is only declared where the engine needs one, and the MySQL family carries
                            // no check constraints at all (conflict C-E).
                            const rehearsal = (real as Table).clone();
                            if (drift(rehearsal) === false) {
                                return;
                            }

                            const created: string[] = [];
                            let doctored = false;
                            const drifting = new Proxy(queryRunner, {
                                get(target, property, receiver) {
                                    if (property === 'getTable') {
                                        return async (name: string): Promise<Table | undefined> => {
                                            const found = await target.getTable(name);
                                            if (!found) {
                                                return undefined;
                                            }
                                            const clone = found.clone();
                                            if (!doctored && bareTableName(clone.name) === table) {
                                                doctored = drift(clone) !== false;
                                            }
                                            return clone;
                                        };
                                    }
                                    if (property === 'createTable') {
                                        return (candidate: Table): Promise<void> => {
                                            created.push(bareTableName(candidate.name));
                                            return Promise.resolve();
                                        };
                                    }
                                    const value = Reflect.get(target, property, receiver);
                                    return typeof value === 'function' ? value.bind(target) : value;
                                },
                            });

                            let refusal: Error | undefined;
                            try {
                                await new AddReorderLists1786838400000().up(drifting);
                            } catch (error) {
                                refusal = error as Error;
                            }

                            expect(
                                doctored,
                                'the drift must have been applied to the catalogue reading',
                            ).toBe(true);
                            expect(
                                refusal,
                                'a table that differs from the frozen description must not be accepted, ' +
                                    'because accepting it records this migration as the author of a shape it ' +
                                    'never created',
                            ).toBeDefined();
                            expect(
                                (refusal as Error).message,
                                'the refusal must name the table it examined',
                            ).toContain(table);
                            for (const name of names) {
                                expect(
                                    (refusal as Error).message,
                                    `the refusal must name "${name}", so an operator is told what to fix`,
                                ).toContain(name);
                            }
                            // And it refuses rather than quietly creating a second table over the first.
                            expect(created, 'a refusal must not also attempt a create').toEqual([]);
                        });
                    },
                    CATALOGUE_READ_ABORT_AFTER_MS,
                );
            },
        );
    });

    // ═══════════════════════════════════════════════════════════════════════════════════════════════
    // The schema under test, which the migration and nothing else produced
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
            'was created by the migration itself, on whichever engine the run configured',
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

                // AND THE MIGRATION IS WHAT CREATED THEM, on this engine and on every other. There is no
                // schema-builder fallback anywhere in this file: the schema every shape, catalogue and
                // forbidden-write assertion below reads is the one `runMigrations` built, and if it did not
                // build it this case fails rather than substituting something that resembles it.
                expect(
                    pluginTablesAfterFirstAttempt.slice().sort(),
                    `the migration did not create both plugin tables on ${activeEngine}. ` +
                        ENGINE_PORTABILITY_CITATION,
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
                        `${namedObject.name} is missing from ${catalogue.source} on ${activeEngine}, where ` +
                            'the schema was created by the migration under test',
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

    // ═══════════════════════════════════════════════════════════════════════════════════════════════
    // THE MIGRATION-OWNED DEPLOYMENT, AND WHERE ITS EXECUTED PROOF LIVES
    //
    // Everything above establishes that the migration BUILT this schema, on whichever engine the run
    // configured. The other half of the claim — that a deployment provisioned that way SERVES the published
    // contract — is executed in `reorder-plugin-compatibility.e2e-spec.ts` ("a deployment provisioned by the
    // migration alone"), and it has to be there rather than here for a platform reason worth stating exactly,
    // because it looks at first like something this file could simply do.
    //
    // A second server booted in THIS worker cannot serve the plugin's operations. `AppModule` imports
    // `PluginModule.forRoot()`, which reads `getConfig().plugins` — and it does so inside the `@Module({...})`
    // decorator argument, which Node evaluates once, when `@vendure/core/dist/app.module.js` is first loaded
    // [packages/core/src/app.module.ts:L18-L30, packages/core/src/plugin/plugin.module.ts:L14-L19]. Every test
    // server loads that module through the same `await import(...)`
    // [packages/testing/src/test-server.ts:L108-L112], so the plugin module set of the whole worker is frozen
    // by the FIRST bootstrap in it. This file's first bootstrap is deliberately plugin-less — that is what
    // leaves the plugin tables for the migration to create — so a later plugin-enabled server here merges the
    // SDL (read per schema build from `getConfig()`) while registering neither the providers nor the
    // resolvers. Measured, not assumed: such a server answers `Cannot return null for non-nullable field
    // Mutation.createReorderList` while `activeCustomer` still resolves, and `app.get(ReorderListService)`
    // reports that the provider does not exist in the current context.
    //
    // WHY THE DEV-SERVER HARNESS ITSELF IS NOT MIGRATION-DRIVEN FOR BOOTING, which is the related question.
    // `packages/dev-server` ships no core migrations at all — `dev-config.ts`'s own `migrations/*.ts` pattern
    // names a directory that does not exist — so a migration-first boot there would face a database with no
    // core tables for this plugin's foreign keys to reference, and authoring core migrations would create
    // files outside `packages/reorder-plugin`, which the change boundary forbids [AAP §0.1.2.1]. The dev
    // harness therefore stays synchronization-driven for booting and populating, which is its own
    // long-standing design and predates this feature, while its migration-driven entry points run with
    // synchronization off and this plugin's migration registered. Both halves of that rule are asserted by
    // "the configuration that drives the migration" above.
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
        it('applied cleanly through the platform lifecycle, on the engine the run configured', () => {
            expect(
                firstApply.migrationsRan,
                `runMigrations must report ${MIGRATION_CLASS_NAME} as applied on ${activeEngine}. ` +
                    ENGINE_PORTABILITY_CITATION,
            ).toContain(MIGRATION_CLASS_NAME);

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
                // DATA-BEARING. One list row and two line rows on two distinct variants, alongside the seeded core
                // rows they reference. A schema-only cycle cannot detect collateral data loss, which is the whole
                // point of seeding before the revert rather than after it.
                const seeded = await seedPluginRows();
                expect(seeded.lineIds).toHaveLength(2);
                const afterFirstApply = await snapshotPluginSchema();

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
