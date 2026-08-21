/**
 * The shared instrument for every claim this package makes **about a schema the migration built**.
 *
 * ## Why it exists
 *
 * Three of this package's suites assert that their story adds no schema delta — STORY-001-01-02,
 * STORY-001-01-03 and STORY-001-01-04 each own no migration and each must show that they need none. That
 * assertion has one precondition it cannot skip: **the schema the generator is diffed against has to have
 * been created by the migration.** Under the end-to-end harness it
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
 * `driver.createSchemaBuilder().log()`), and the shipped artefact is one generation: PostgreSQL's. So a
 * data-bearing up → down → up cycle **of the shipped file** is available on PostgreSQL and nowhere else,
 * which is what {@link committedMigrationApplies} answers.
 *
 * On every other connection this module does what a deployment on that connection does: **generates that
 * connection's own migration through the same lifecycle and applies that**. The cycle is therefore genuine on
 * all four engines while the artefact under it differs, which is the honest shape of the obligation rather
 * than a weakening of it. {@link generateMigrationForEngine} exposes the same route to a caller that needs the
 * generator's verdict rather than the shipped file's.
 *
 * Nothing here hand-writes DDL, and nothing here is allowed to: EPIC-001 section 7.8 L604 makes the lifecycle
 * the only sanctioned mechanism. Every statement applied by this module was emitted by `generateMigration` into
 * a file, and that file is what is loaded and run.
 *
 * ## Attribution
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

import { describeTeardownStage, redactTeardownDiagnostic } from './diagnostic-redaction';

/** The two plugin tables, parent first — the order the migration must create them in. */
const PLUGIN_TABLES = ['reorder_list', 'reorder_list_line'] as const;

/**
 * @description
 * Every column each plugin table carries **and nothing else**, sorted, frozen here as a literal.
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
     */
    pluginTableColumns(): Promise<Record<string, string[]>>;
}

/**
 * @description
 * Whether the checked-in migration can be applied on the given connection.
 *
 * **Only where the dialect matches, and the list is short for a structural reason.** The shipped migration is
 * the platform migration generator's own output, and `generateMigration` serialises the statements one
 * configured engine's schema builder logged into `queryRunner.query(<SQL>)` calls
 * (`packages/core/src/migrate.ts:L127-L179`). An emitted migration is therefore bound to the engine it was
 * generated against — plan section 0.2.3.1 records that as a known limitation of the form section 0.5.2.2
 * prescribes — and the shipped file was generated against PostgreSQL, because of the four targets that is the
 *
 * @param engine - The TypeORM driver type, as read off the connection rather than off an environment variable.
 */
export function committedMigrationApplies(engine: string): boolean {
    return ['postgres', 'aurora-postgres'].includes(engine);
}

/**
 * @description
 * Generates a migration for the engine `config` points at, through the platform's own lifecycle, and loads the
 * class out of the file it wrote.
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
        // EVERY STEP IS ATTEMPTED, rather than awaited in sequence. Awaiting in sequence would let a rejection
        // while removing the first temporary directory skip the generated migration's disposal, skip dropping
        // the isolated DATABASE — a leak that outlives the process — and skip restoring the platform
        // configuration, leaving every later case in the file running against the platform's defaults instead
        // of the server it started with. The first failure is the least important thing here; the steps after
        // it are the ones that matter.
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
            // ★ NOTHING FROM THE CAUGHT FAILURE IS CARRIED HERE, ONLY A DESCRIPTION OF IT — and the step
            // label is guarded on the same footing as the reason.
            //
            // The steps this releases are a query runner, a data source, a GENERATED DIRECTORY, an isolated
            // database, mutated process state and a running server. So a failure arriving here is either a
            // driver error — a TypeORM `QueryFailedError`, which has copied the driver's own error onto
            // itself and therefore carries the statement and its bound parameters as enumerable properties —
            // or a filesystem error, whose message is an absolute path describing the machine that ran the
            // suite. This aggregate is thrown, printed by the runner and read in a build log.
            //
            // The label is guarded too, and that is not belt-and-braces: the natural way to make a per-item
            // cleanup step readable is to interpolate the item, and here the items ARE temporary directories
            // and database names. `describeTeardownStage` refuses a label carrying a path separator, an `@`
            // or an over-budget length rather than trusting every future step declaration to be reviewed.
            failures.push(`${describeTeardownStage(step.what)} — ${redactTeardownDiagnostic(error)}`);
        }
    }
    if (failures.length > 0) {
        throw new Error(
            `teardown attempted every step and ${failures.length} of ${steps.length} failed: ` +
                failures.join('; '),
        );
    }
}

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
