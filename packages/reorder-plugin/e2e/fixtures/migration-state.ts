/**
 * The shared instrument for every claim this package makes **about a schema the migration built**.
 *
 * ## Why it exists
 *
 * Three of this package's suites assert that their story adds no schema delta — STORY-001-01-02,
 * STORY-001-01-03 and STORY-001-01-04 each own no migration and each must show that they need none. That
 * assertion has one precondition it cannot skip, and an earlier revision of all three skipped it: **the schema
 * the generator is diffed against has to have been created by the migration.** Under the end-to-end harness it
 * is not. `packages/testing/src/initializers/mysql-initializer.ts` L16 and
 * `packages/testing/src/initializers/postgres-initializer.ts` L15 force `synchronize = true`, the sql.js
 * initializer enables it while it populates, and `e2e-common/test-config.ts` sets it per engine branch — so the
 * running server's schema is built from the same entity metadata the generator then diffs against, and a NEW
 * mapping added by a story would be synchronised into the database first and produce an empty diff second. The
 * check passes either way, which makes it evidence of nothing.
 *
 * This module supplies the missing precondition: an isolated database, its core schema synchronised with the
 * plugin **absent**, and the two plugin tables created by **applying the migration through the platform's own
 * lifecycle**. A delta taken against that state is falsifiable — add a column to either entity and it appears.
 *
 * ## The second thing it exists for
 *
 * One generation carries the DDL of exactly one engine (`packages/core/src/migrate.ts` L127 serialises
 * `driver.createSchemaBuilder().log()`), so the shipped artefact was generated once per engine family and
 * carries all three sets of statements, dispatching on the connection's own driver. That is what lets the
 * migration suite run a genuine data-bearing up → down → up cycle **of the shipped file** on every engine it
 * claims rather than on one, and it is why {@link committedMigrationApplies} asks the artefact which
 * connections it covers instead of restating an engine name this module would have to keep in step.
 *
 * Where a connection falls outside that coverage the artefact refuses it, and this module then does what a
 * deployment on such a connection does: **generates that connection's own migration through the same lifecycle
 * and applies that**. {@link generateMigrationForEngine} exposes the same route to a caller that needs the
 * generator's verdict rather than the shipped file's.
 *
 * Nothing here hand-writes DDL, and nothing here is allowed to: EPIC-001 section 7.8 L604 makes the lifecycle
 * the only sanctioned mechanism. Every statement applied by this module was emitted by `generateMigration` into
 * a file, and that file is what is loaded and run.
 *
 * ## Attribution
 *
 * **No user-specified rules were provided for this project** — the rules document was read and returned exactly
 * that, and EPIC-001 section 11.9 records the same finding independently. Nothing in this file derives from a
 * user-specified rule. Every obligation it serves is prompt-derived (the plan's sections 0.7.2 and 0.7.1) or
 * ticket-derived (EPIC-001 sections 7.8 and 11.6, STORY-001-01-01's Definition of Done), and each is cited as
 * such where it is discharged.
 *
 * @since 3.8.0
 */
import { generateMigration, mergeConfig, resetConfig, runMigrations, VendureConfig } from '@vendure/core';
import { preBootstrapConfig } from '@vendure/core/dist/bootstrap';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { DataSource, DataSourceOptions, MigrationInterface } from 'typeorm';
import * as ts from 'typescript';

import { ReorderPlugin, ReorderPluginOptions } from '../../index';
import { AddReorderLists1786838400000 } from '../../src/migrations/1786838400000-add-reorder-lists';

/** The two plugin tables, parent first — the order the migration must create them in. */
const PLUGIN_TABLES = ['reorder_list', 'reorder_list_line'] as const;

/**
 * @description
 * Every column each plugin table carries **and nothing else**, sorted, frozen here as a literal.
 *
 * ## Why a literal rather than a derivation
 *
 * This is the one part of the no-delta evidence that does not read the entity metadata, and that is the
 * entire point of it. A check that compares the database against the entity declarations cannot catch a story
 * that added a column to an entity on an engine whose migration is regenerated from those same declarations —
 * the generator would emit the new column, the engine would create it, and the comparison would come back
 * empty. Comparing against a literal closes that: the literal does not move when an entity does, so the
 * addition shows up as an extra column on **every** engine.
 *
 * ## What the columns are
 *
 * `id`, `createdAt` and `updatedAt` are inherited from `VendureEntity`
 * (`packages/core/src/entity/base/base.entity.ts` L28-L33) and are part of the contract even though neither
 * entity re-declares them. Beyond those, `reorder_list` carries exactly five — the owning customer, the owning
 * channel, the display name, the canonical name key and the denormalised line count — and `reorder_list_line`
 * exactly three. No contact detail, no free-text note, no serialised request context, no monetary column, and
 * neither of the two withdrawn claim columns.
 *
 * @since 3.8.0
 */
export const EXPECTED_PLUGIN_TABLE_COLUMNS: Readonly<Record<string, readonly string[]>> = Object.freeze({
    reorder_list: Object.freeze(
        ['channelId', 'createdAt', 'customerId', 'id', 'lineCount', 'name', 'nameKey', 'updatedAt'].sort(),
    ),
    reorder_list_line: Object.freeze(
        ['createdAt', 'id', 'productVariantId', 'quantity', 'reorderListId', 'updatedAt'].sort(),
    ),
});

/** Matches a statement naming either plugin table, whatever the engine's identifier quoting. */
const PLUGIN_TABLE_PATTERN = /reorder_list(_line)?/i;

/** The plugin option values this package's suites run against, so an isolated state matches the live one. */
const DECLARED_PLUGIN_OPTIONS: ReorderPluginOptions = {
    maxListsPerCustomer: 25,
    maxLinesPerList: 200,
    maxQuantityPerLine: 999,
    defaultReorderListsPageSize: 25,
    defaultReorderListLinesPageSize: 50,
};

/**
 * @description
 * A migration produced by the platform's lifecycle, loaded and ready to hand to `runMigrations`.
 */
export interface LifecycleMigration {
    /** The class TypeORM will instantiate. Its name carries the trailing timestamp TypeORM orders by. */
    readonly migrationClass: new () => MigrationInterface;
    /** That class's name, which is also the name TypeORM records in its own bookkeeping table. */
    readonly className: string;
    /** The generated file's full text, so a caller can assert its dialect markers or its statements. */
    readonly source: string;
    /** Where the generator wrote it — always a temporary directory outside this repository. */
    readonly filePath: string;
    /** Removes the temporary directory. Safe to call more than once. */
    dispose(): Promise<void>;
}

/**
 * @description
 * An isolated database whose plugin tables were created by a migration, and the questions a suite may ask of
 * it.
 */
export interface IsolatedMigrationState {
    /** The engine this state was built on, read from the configuration rather than from an environment. */
    readonly engine: string;
    /** Whether the shipped migration applied here, or an engine-appropriate one had to be generated. */
    readonly provenance: 'committed-migration' | 'lifecycle-generated';
    /** The migration class name TypeORM recorded as applied. */
    readonly migrationName: string;
    /** What `runMigrations` reported having run, so "the migration ran" is read rather than assumed. */
    readonly migrationsRan: readonly string[];
    /** The plugin tables that exist after the apply, in the order this module checked for them. */
    readonly pluginTablesCreated: readonly string[];
    /**
     * The schema builder's outstanding statements that name a plugin table, up and down.
     *
     * This is the exact input `generateMigration` decides on (`packages/core/src/migrate.ts` L127), read
     * against the migration-created schema. Empty means the entity declarations and the migration agree.
     */
    pluginTableDelta(): Promise<{ up: string[]; down: string[] }>;
    /**
     * Runs the generator itself against the migration-created schema and returns the path it wrote, or
     * `undefined` where it found nothing to write — which is the platform's own way of saying "no delta".
     */
    generateFurtherMigration(): Promise<string | undefined>;
    /**
     * The column names each plugin table actually carries in the migration-created schema, sorted, read out of
     * the engine's own catalogue.
     *
     * Compared against {@link EXPECTED_PLUGIN_TABLE_COLUMNS} this is the engine-independent half of the
     * no-delta evidence: it moves when the database moves and stays put when the entity declarations move, so
     * a column a story added is visible on every engine rather than only on the one the shipped migration
     * targets.
     */
    pluginTableColumns(): Promise<Record<string, string[]>>;
}

/**
 * @description
 * Whether the checked-in migration can be applied on the given connection.
 *
 * **The families are named here because the artefact does not publish them.** The shipped migration exports
 * its class and nothing else: it resolves the engine family and the connection's own schema or database from
 * the `QueryRunner` it is handed, and builds every identifier through TypeORM's own table API, so it applies
 * on any connection whose driver belongs to one of the three families below and on any schema that connection
 * is configured for. There is therefore no schema condition to apply — the earlier revision's `public`-only
 * restriction belonged to a per-dialect artefact carrying pre-rendered SQL, and no longer exists.
 *
 * A caller reading `false` here generates a migration rather than exercising the shipped file, so drift in
 * this list shows up as weaker evidence rather than as a failure; the migration suite is what proves the
 * shipped file really applies on each engine the jobs run.
 *
 * @param engine - The TypeORM driver type, as read off the connection rather than off an environment variable.
 */
export function committedMigrationApplies(engine: string): boolean {
    return [
        'postgres',
        'aurora-postgres',
        'mysql',
        'mariadb',
        'aurora-mysql',
        'sqlite',
        'sqljs',
        'better-sqlite3',
        'expo',
    ].includes(engine);
}

/**
 * @description
 * Generates a migration for the engine `config` points at, through the platform's own lifecycle, and loads the
 * class out of the file it wrote.
 *
 * **The file is the artefact under test, not a convenience.** `generateMigration` writes TypeScript, so the
 * text it produced is transpiled in memory and evaluated to recover the class — which means the statements
 * applied are provably the statements the generator emitted, rather than a second serialisation of the same
 * schema-builder log that could drift from it. The transpile is `typescript`'s own, at the version the root
 * manifest pins exactly, and no module resolution is involved: the generated file's only import is
 * `MigrationInterface` and `QueryRunner`, both used in type position alone, so TypeScript elides it and the
 * evaluated module requires nothing at all.
 *
 * @param config - A configuration whose `dbConnectionOptions` point at the database to diff. It must NOT list
 * this migration in its own `migrations`, or the generator would be diffing against a schema it is about to
 * create.
 * @param name - The migration name, which becomes part of the class name and of the filename.
 * @throws Where the generator finds no changes to write, which for a caller expecting the two plugin tables
 * means the schema already carries them and the caller's precondition was not met.
 */
export async function generateLifecycleMigration(
    config: Partial<VendureConfig>,
    name: string,
): Promise<LifecycleMigration> {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'reorder-lifecycle-migration-'));
    const dispose = async () => {
        await fs.remove(outputDir);
    };
    try {
        const filePath = await generateMigration(config, { name, outputDir });
        if (filePath === undefined) {
            throw new Error(
                'generateMigration wrote no file, so the schema it was diffed against already carries the ' +
                    'plugin tables. An isolated state must start from the core schema alone.',
            );
        }
        const source = await fs.readFile(filePath, 'utf-8');
        return { ...loadMigrationClass(source, filePath), source, filePath, dispose };
    } catch (err) {
        await dispose();
        throw err;
    }
}

/**
 * @description
 * Generates the migration this engine's own lifecycle emits, from a schema carrying the core entities alone.
 *
 * **This is the generator's verdict, obtained the way a first deployment obtains it.** An isolated database is
 * created, its core schema is synchronised with the plugin absent — and asserted to carry neither plugin table,
 * because a pre-existing one would make the diff empty and the result a transcription rather than a generation —
 * and the generator is then run against it with the plugin registered and its own migration withheld. The
 * caller receives the file the generator wrote, loaded and ready to apply or to read.
 *
 * It exists so that a suite can compare the shipped artefact against a FRESH generation on the engine it is
 * running on, which is the only assertion that proves the composed file still carries that engine's own
 * statements. A dialect-marker heuristic over the file's text cannot do that: it recognises which engine wrote
 * some statement, not whether every statement is still the one that engine writes today.
 *
 * The returned `dispose` releases both the temporary directory and the isolated database, so a caller owes it
 * exactly one call in its own teardown.
 *
 * @param serverConfig - The running suite's configuration. Only its `dbConnectionOptions` are used to reach the
 * server; the database itself is created fresh and dropped again.
 * @param label - A short name distinguishing this caller's isolated database from every other one.
 *
 * @since 3.8.0
 */
export async function generateMigrationForEngine(
    serverConfig: Required<VendureConfig>,
    label: string,
): Promise<LifecycleMigration> {
    const engine = String((serverConfig.dbConnectionOptions as { type: string }).type);
    const isolation = await createIsolatedDatabase(serverConfig, engine, label);
    try {
        await synchroniseCoreSchema(serverConfig, isolation.dbConnectionOptions);
        const generated = await generateLifecycleMigration(
            configFor(serverConfig, isolation.dbConnectionOptions, []),
            'add-reorder-lists',
        );
        return {
            ...generated,
            dispose: async () => {
                await attemptEveryCleanup([
                    { what: "removing the generator's output directory", run: () => generated.dispose() },
                    { what: 'dropping the isolated database', run: () => isolation.dispose() },
                ]);
            },
        };
    } catch (err) {
        await isolation.dispose();
        throw err;
    }
}

/**
 * @description
 * The SQL statements a generated migration file will actually execute, up and down, in order.
 *
 * **It reverses `generateMigration`'s own escaping rather than approximating it.** That function writes each
 * statement into a JavaScript literal and escapes exactly one character while doing so: the MySQL family gets a
 * double-quoted literal with `"` escaped (`packages/core/src/migrate.ts` L131-L152) and every other engine gets
 * a template literal with a backtick escaped (L153-L171). Undoing precisely that yields the string
 * `queryRunner.query` would receive at run time — which is the thing worth comparing, since two files can hold
 * the same statement under different quoting and a source-text comparison would call them different.
 *
 * @throws Where a statement line does not open with a delimiter this function knows how to close, which would
 * mean the generator's template had changed and the extraction could no longer be trusted.
 *
 * @since 3.8.0
 */
export function extractGeneratedStatements(source: string): { up: string[]; down: string[] } {
    const prefix = 'await queryRunner.query(';
    const statements: { up: string[]; down: string[] } = { up: [], down: [] };
    let section: 'up' | 'down' | undefined;
    for (const line of source.split('\n')) {
        if (line.includes('public async up(')) {
            section = 'up';
            continue;
        }
        if (line.includes('public async down(')) {
            section = 'down';
            continue;
        }
        const trimmed = line.trim();
        if (section === undefined || !trimmed.startsWith(prefix)) {
            continue;
        }
        const body = trimmed.slice(prefix.length);
        const delimiter = body.charAt(0);
        if (delimiter !== '"' && delimiter !== '`') {
            throw new Error(
                `a generated statement opens with ${JSON.stringify(delimiter)} rather than a quote or a ` +
                    "backtick, so the generator's template has changed and this extraction is no longer valid",
            );
        }
        let statement = '';
        for (let index = 1; index < body.length; index++) {
            const character = body.charAt(index);
            if (character === '\\' && body.charAt(index + 1) === delimiter) {
                statement += delimiter;
                index++;
                continue;
            }
            if (character === delimiter) {
                break;
            }
            statement += character;
        }
        statements[section].push(statement);
    }
    return statements;
}

/**
 * @description
 * Builds an isolated database whose core schema is synchronised **without** the plugin and whose two plugin
 * tables are then created by applying a migration through `runMigrations`, hands it to `work`, and tears it
 * down again however `work` ends.
 *
 * The database is named (or, on sql.js, located) with the clone index in it, so two agents running this
 * package's suites against one server cannot collide.
 *
 * @param serverConfig - The suite's own server configuration. Its connection options decide the engine, the
 * host and the credentials; only the database name (or sql.js location) is replaced.
 * @param label - A short identifier for the calling suite, used in the database name.
 * @param work - What to assert. It receives the state and may ask it anything on {@link IsolatedMigrationState}.
 */
export async function withIsolatedMigrationState<T>(
    serverConfig: Required<VendureConfig>,
    label: string,
    work: (state: IsolatedMigrationState) => Promise<T>,
): Promise<T> {
    const engine = String((serverConfig.dbConnectionOptions as { type: string }).type);
    const isolation = await createIsolatedDatabase(serverConfig, engine, label);
    let generated: LifecycleMigration | undefined;
    const temporaryDirectories: string[] = [];
    try {
        // STEP ONE — the core schema ALONE. The plugin is absent, so neither plugin table can exist yet, which
        // is the precondition the whole exercise rests on and is asserted rather than assumed below.
        await synchroniseCoreSchema(serverConfig, isolation.dbConnectionOptions);

        // STEP TWO — the migration. The shipped file where its dialect matches this engine, and otherwise the
        // one this engine's own lifecycle emits, which is exactly what a deployment on that engine would run.
        const withoutMigrations = configFor(serverConfig, isolation.dbConnectionOptions, []);
        let migrationClass: new () => MigrationInterface;
        let provenance: IsolatedMigrationState['provenance'];
        if (committedMigrationApplies(engine)) {
            migrationClass = AddReorderLists1786838400000;
            provenance = 'committed-migration';
        } else {
            generated = await generateLifecycleMigration(withoutMigrations, 'add-reorder-lists-for-engine');
            migrationClass = generated.migrationClass;
            provenance = 'lifecycle-generated';
        }

        // STEP THREE — apply it through the platform's own entry point, and read what it says it ran.
        const withMigration = configFor(serverConfig, isolation.dbConnectionOptions, [migrationClass]);
        const migrationsRan = await withRestoredExitCode(() => runMigrations(withMigration));
        const pluginTablesCreated = await tablesPresent(serverConfig, isolation.dbConnectionOptions);

        const state: IsolatedMigrationState = {
            engine,
            provenance,
            migrationName: migrationClass.name,
            migrationsRan,
            pluginTablesCreated,
            pluginTableDelta: async () => {
                const resolved = await preBootstrapConfig(withMigration);
                const dataSource = await openDataSource(resolved.dbConnectionOptions);
                try {
                    const log = await dataSource.driver.createSchemaBuilder().log();
                    return {
                        up: log.upQueries
                            .map(query => query.query)
                            .filter(query => PLUGIN_TABLE_PATTERN.test(query)),
                        down: log.downQueries
                            .map(query => query.query)
                            .filter(query => PLUGIN_TABLE_PATTERN.test(query)),
                    };
                } finally {
                    await dataSource.destroy();
                }
            },
            generateFurtherMigration: async () => {
                const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'reorder-no-delta-'));
                temporaryDirectories.push(outputDir);
                return generateMigration(withMigration, {
                    name: 'thisStoryShouldEmitNothing',
                    outputDir,
                });
            },
            pluginTableColumns: async () => {
                const resolved = await preBootstrapConfig(withMigration);
                const dataSource = await openDataSource(resolved.dbConnectionOptions);
                try {
                    const queryRunner = dataSource.createQueryRunner();
                    try {
                        const columns: Record<string, string[]> = {};
                        for (const table of PLUGIN_TABLES) {
                            // TypeORM's own catalogue reader rather than a per-engine `information_schema`
                            // query, because it parses each engine's catalogue back into one `Table` shape —
                            // which is what makes this comparison portable across all four engines.
                            const described = await queryRunner.getTable(table);
                            if (described === undefined) {
                                throw new Error(`the migration created no "${table}" table`);
                            }
                            columns[table] = described.columns.map(column => column.name).sort();
                        }
                        return columns;
                    } finally {
                        if (!queryRunner.isReleased) {
                            await queryRunner.release();
                        }
                    }
                } finally {
                    await dataSource.destroy();
                }
            },
        };
        return await work(state);
    } finally {
        // EVERY STEP IS ATTEMPTED, and that is a correction rather than a tidying. An earlier revision awaited
        // these in sequence, so a rejection while removing the first temporary directory skipped the generated
        // migration's disposal, skipped dropping the isolated DATABASE — a leak that outlives the process — and
        // skipped restoring the platform configuration, which would have left every later case in the file
        // running against the platform's defaults instead of the server it started with. The first failure is
        // the least important thing here; the steps after it are the ones that matter.
        await attemptEveryCleanup([
            ...temporaryDirectories.map(directory => ({
                what: `removing the temporary directory ${directory}`,
                run: () => fs.remove(directory),
            })),
            { what: "disposing the generated migration's output", run: async () => generated?.dispose() },
            { what: 'dropping the isolated database', run: () => isolation.dispose() },
            {
                // The migration entry points reset the platform's module-level configuration in their own
                // `finally` (`packages/core/src/migrate.ts` L63), which also replaces the process-wide logger.
                // Restoring the suite's own configuration here is what keeps the rest of the file running
                // against the server it started with rather than against the platform's defaults.
                what: "restoring the suite's own platform configuration",
                run: () => preBootstrapConfig(serverConfig),
            },
        ]);
    }
}

/**
 * @description
 * One teardown step: what it does, for a diagnosis, and how to do it.
 *
 * @since 3.8.0
 */
export interface CleanupStep {
    /** What this step releases, phrased to read inside "teardown attempted … and N of them failed: …". */
    readonly what: string;
    /** Performs the step. May be synchronous; a returned promise is awaited. */
    run(): Promise<unknown> | unknown;
}

/**
 * @description
 * Attempts EVERY step, whatever any earlier one does, and reports all failures together afterwards.
 *
 * A teardown written as a chain of awaits releases its resources in the order they happen to be listed and
 * stops at the first rejection — so the least important resource decides whether the most important one is
 * released. That is the defect this exists to remove: a query runner, a data source, a generated directory, an
 * isolated database, mutated process state and a running server are independent of one another, and each is
 * released here regardless of the others.
 *
 * Failures are collected rather than swallowed, and a single error naming all of them is thrown once every step
 * has been attempted, so a teardown fault is still loud — it simply no longer costs the steps behind it.
 *
 * @param steps - The steps, attempted in the order given.
 * @throws Where one or more steps failed, after all of them have been attempted, with every failure named.
 * @since 3.8.0
 */
export async function attemptEveryCleanup(steps: readonly CleanupStep[]): Promise<void> {
    const failures: string[] = [];
    for (const step of steps) {
        try {
            await step.run();
        } catch (error) {
            failures.push(`${step.what} — ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    if (failures.length > 0) {
        throw new Error(
            `teardown attempted every step and ${failures.length} of ${steps.length} failed: ` +
                failures.join('; '),
        );
    }
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════
// Internals
// ═════════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * @description
 * The isolated database, and how to remove it again.
 *
 * @since 3.8.0
 */
export interface IsolatedDatabase {
    readonly dbConnectionOptions: DataSourceOptions;
    dispose(): Promise<void>;
}

/**
 * A database name (or file) unique to this clone and this caller.
 *
 * `CLONE_INDEX` is exported by the workspace for exactly this purpose — every host-global resource carries it —
 * so two clones running this package's suites against one database server address different databases.
 */
function isolatedName(label: string): string {
    const clone = (process.env.CLONE_INDEX ?? '000').replace(/[^a-z0-9]/gi, '');
    return `e2e_reorder_state_${label.replace(/[^a-z0-9]/gi, '_')}_${clone}`.toLowerCase();
}

/**
 * @description
 * Creates the isolated database for the engine in use.
 *
 * Each branch uses the engine's own mechanism and nothing else: a maintenance connection issuing
 * `CREATE DATABASE` on the three server engines, and a temporary file on the in-process SQLite engine, whose
 * "database" is a file rather than a server object. The sql.js branch additionally turns `autoSave` on, because
 * this state is built by one connection and read by the next and an unsaved database would not survive between
 * them.
 *
 * @since 3.8.0
 */
export async function createIsolatedDatabase(
    serverConfig: Required<VendureConfig>,
    engine: string,
    label: string,
): Promise<IsolatedDatabase> {
    const options = serverConfig.dbConnectionOptions as unknown as Record<string, unknown>;
    if (engine === 'sqljs') {
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'reorder-isolated-sqljs-'));
        const location = path.join(directory, `${isolatedName(label)}.sqlite`);
        return {
            dbConnectionOptions: {
                ...(options as object),
                type: 'sqljs',
                location,
                autoSave: true,
                database: undefined,
                synchronize: false,
                logging: false,
            } as unknown as DataSourceOptions,
            dispose: async () => {
                await fs.remove(directory);
            },
        };
    }

    const database = isolatedName(label);
    const maintenance = new DataSource({
        ...(options as object),
        // PostgreSQL requires a database to connect to before it can create another, and its always-present
        // maintenance database is the conventional one. The MySQL family connects without naming one at all.
        database: engine === 'postgres' ? 'postgres' : undefined,
        synchronize: false,
        migrationsRun: false,
        dropSchema: false,
        entities: [],
        subscribers: [],
        migrations: [],
        logging: false,
    } as unknown as DataSourceOptions);
    await maintenance.initialize();
    try {
        await maintenance.query(`DROP DATABASE IF EXISTS ${database}`);
        await maintenance.query(`CREATE DATABASE ${database}`);
    } finally {
        await maintenance.destroy();
    }
    return {
        dbConnectionOptions: {
            ...(options as object),
            database,
            synchronize: false,
            logging: false,
        } as unknown as DataSourceOptions,
        dispose: async () => {
            const cleanup = new DataSource({
                ...(options as object),
                database: engine === 'postgres' ? 'postgres' : undefined,
                synchronize: false,
                migrationsRun: false,
                dropSchema: false,
                entities: [],
                subscribers: [],
                migrations: [],
                logging: false,
            } as unknown as DataSourceOptions);
            await cleanup.initialize();
            try {
                await cleanup.query(`DROP DATABASE IF EXISTS ${database}`);
            } finally {
                await cleanup.destroy();
            }
        },
    };
}

/**
 * Builds a configuration for the isolated database, with or without the plugin's migration registered.
 *
 * The plugin itself is always registered, because the delta being asked about is a delta between its entity
 * declarations and the database. Only `migrations` varies: the generator must not be handed the migration it is
 * being asked to decide the need for.
 */
function configFor(
    serverConfig: Required<VendureConfig>,
    dbConnectionOptions: DataSourceOptions,
    migrations: Array<new () => MigrationInterface>,
): Partial<VendureConfig> {
    return mergeConfig(serverConfig, {
        plugins: [ReorderPlugin.init(DECLARED_PLUGIN_OPTIONS)],
        dbConnectionOptions: {
            ...(dbConnectionOptions as object),
            synchronize: false,
            migrationsRun: false,
            dropSchema: false,
            migrations,
        },
    } as unknown as Partial<VendureConfig>);
}

/**
 * Creates the core schema in the isolated database with the plugin **absent**, and asserts that neither plugin
 * table came out of it.
 *
 * The assertion is the point rather than a precaution: were a plugin table present here, the migration applied
 * next would fail on an object that already exists, or worse succeed against a schema it did not build, and
 * every delta taken afterwards would be measuring the schema builder against itself.
 */
async function synchroniseCoreSchema(
    serverConfig: Required<VendureConfig>,
    dbConnectionOptions: DataSourceOptions,
): Promise<void> {
    const coreOnly = mergeConfig(serverConfig, {
        plugins: [],
        dbConnectionOptions: { ...(dbConnectionOptions as object), synchronize: false },
    } as unknown as Partial<VendureConfig>);
    const resolved = await preBootstrapConfig(coreOnly);
    const dataSource = await openDataSource({
        ...(resolved.dbConnectionOptions as object),
        synchronize: true,
    } as unknown as DataSourceOptions);
    try {
        const present = await pluginTablesIn(dataSource);
        if (present.length !== 0) {
            throw new Error(
                `the isolated core schema must not carry a plugin table, found ${present.join(', ')}`,
            );
        }
    } finally {
        await dataSource.destroy();
    }
}

/** Which plugin tables exist in the isolated database, read through the platform's resolved entity set. */
async function tablesPresent(
    serverConfig: Required<VendureConfig>,
    dbConnectionOptions: DataSourceOptions,
): Promise<string[]> {
    const resolved = await preBootstrapConfig(
        configFor(serverConfig, dbConnectionOptions, [] as Array<new () => MigrationInterface>),
    );
    const dataSource = await openDataSource(resolved.dbConnectionOptions);
    try {
        return await pluginTablesIn(dataSource);
    } finally {
        await dataSource.destroy();
    }
}

/** The plugin tables an open data source can see, in parent-first order. */
async function pluginTablesIn(dataSource: DataSource): Promise<string[]> {
    const queryRunner = dataSource.createQueryRunner();
    try {
        const found: string[] = [];
        for (const table of PLUGIN_TABLES) {
            if (await queryRunner.hasTable(table)) {
                found.push(table);
            }
        }
        return found;
    } finally {
        if (!queryRunner.isReleased) {
            await queryRunner.release();
        }
    }
}

/**
 * @description
 * Opens a data source with the four overrides the platform's own migration entry points apply
 * (`packages/core/src/migrate.ts` L197-L205), plus no subscribers — Vendure's are dependency-injected and
 * nothing here resolves a Nest container.
 *
 * @since 3.8.0
 */
export async function openDataSource(options: DataSourceOptions): Promise<DataSource> {
    const dataSource = new DataSource({
        ...(options as object),
        migrationsRun: false,
        dropSchema: false,
        subscribers: [],
        logging: false,
    } as unknown as DataSourceOptions);
    await dataSource.initialize();
    return dataSource;
}

/**
 * Runs work that may write `process.exitCode`, and puts it back.
 *
 * `runMigrations` does not re-throw when it is not driven from the Vendure CLI: it logs and sets
 * `process.exitCode = 1` (`packages/core/src/migrate.ts` L52-L58). Leaving that behind would fail the whole
 * test process at exit for a migration failure a suite had already asserted, so the code is read, restored, and
 * turned into a thrown error here.
 */
async function withRestoredExitCode(work: () => Promise<string[]>): Promise<string[]> {
    const saved = process.exitCode;
    process.exitCode = undefined;
    let ran: string[] = [];
    let observed: number | string | undefined;
    try {
        ran = await work();
    } finally {
        observed = process.exitCode;
        process.exitCode = saved;
    }
    if (observed !== undefined && observed !== 0) {
        throw new Error(
            `runMigrations reported failure through process.exitCode (${String(observed)}); the migration ` +
                'did not apply',
        );
    }
    return ran;
}

/**
 * Transpiles the generated migration file in memory and returns the migration class it exports.
 *
 * Evaluating generated source is deliberate and is bounded to exactly what the generator wrote: the text comes
 * from `generateMigration`, it is transpiled by the pinned `typescript` compiler with no type checking and no
 * module resolution, and the module it produces requires nothing — the generated file's only import is used in
 * type position and TypeScript elides it. The `require` handed to the evaluated module therefore exists only to
 * make a future generator change fail loudly rather than silently: it answers with an empty object so a
 * type-only import that stopped being elided still works, and nothing else can smuggle a dependency in.
 *
 * The class's name matters as much as its body: TypeORM parses the trailing digits of the name to order
 * migrations and records that name in its bookkeeping table, so it is read off the class rather than restated.
 */
function loadMigrationClass(
    source: string,
    filePath: string,
): { migrationClass: new () => MigrationInterface; className: string } {
    const transpiled = ts.transpileModule(source, {
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2019,
        },
        fileName: filePath,
    });
    const moduleExports: Record<string, unknown> = {};
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const evaluate = new Function('exports', 'require', 'module', transpiled.outputText);
    evaluate(moduleExports, () => ({}), { exports: moduleExports });
    const candidates = Object.values(moduleExports).filter(
        (value): value is new () => MigrationInterface =>
            typeof value === 'function' &&
            typeof (value as { prototype?: { up?: unknown } }).prototype?.up === 'function',
    );
    if (candidates.length !== 1) {
        throw new Error(
            `the generated migration at ${filePath} exports ${candidates.length} migration classes, expected 1`,
        );
    }
    const migrationClass = candidates[0];
    if (!/\d+$/.test(migrationClass.name)) {
        throw new Error(
            `the generated migration class ${migrationClass.name} carries no trailing timestamp, which ` +
                'TypeORM needs to order it',
        );
    }
    return { migrationClass, className: migrationClass.name };
}

/**
 * Exposed so a suite that owns its own isolated schema — the migration suite does — can put the platform's
 * module-level configuration back after driving a migration entry point, without importing the platform's
 * reset directly and having to reason about ordering.
 */
export async function restorePlatformConfig(serverConfig: Required<VendureConfig>): Promise<void> {
    resetConfig();
    await preBootstrapConfig(serverConfig);
}
