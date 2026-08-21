/**
 * The shared instruments this package's suites reach for when a claim is **about a schema a migration built**,
 * or about releasing what such a claim had to create.
 *
 * ## Why it exists
 *
 * Under the end-to-end harness the schema is **never** the migration's. The MySQL initializer forces
 * `synchronize = true` (`packages/testing/src/initializers/mysql-initializer.ts` L16), the PostgreSQL one does
 * too (`:L15`), the sql.js one enables it while it populates, and `e2e-common/test-config.ts` sets it per
 * engine branch — so a running server's schema is built from the same entity metadata the migration generator
 * would then be diffed against. Any suite wanting to say something about a migration-created schema therefore
 * has to construct that state itself, and every suite that does needs the same four things: a database of its
 * own, a data source opened the way the platform's own migration entry points open one, a way to obtain the
 * migration THIS engine's lifecycle emits, and a teardown that releases all of it even when part of it fails.
 * Those four are what this module is.
 *
 * ## The engine question, answered once
 *
 * One generation carries the DDL of exactly one engine (`packages/core/src/migrate.ts` L127 serialises
 * `driver.createSchemaBuilder().log()`), and the checked-in artefact is one generation: PostgreSQL's. So the
 * artefact itself applies on PostgreSQL and nowhere else, which is what {@link committedMigrationApplies}
 * answers — and it is deliberately the ONE authority in the package for that question, read by the create,
 * add-item, mutate, read, compatibility and migration suites alike rather than re-spelled in each.
 *
 * Elsewhere the answer is not to skip the claim but to do what a deployment on that connection does:
 * **generate that connection's own migration through the same lifecycle and apply that**.
 * {@link generateLifecycleMigration} is that route, and `e2e/reorder-list-migration.e2e-spec.ts` drives its
 * whole data-bearing cycle through it, so the cycle is genuine on all four engines while the artefact under it
 * differs. Nothing here hand-writes DDL, and nothing here is allowed to: EPIC-001 section 7.8 L604 makes the
 * lifecycle the only sanctioned mechanism. Every statement any caller of this module applies was emitted by
 * `generateMigration` into a file, and that file is what is loaded and run.
 *
 * ## An addition to the planned file set, declared here
 *
 * AAP section 0.5.1.8 enumerates two fixture modules — `e2e/fixtures/query-capture.ts` and
 * `e2e/fixtures/concurrency-barrier.ts` — and this is a third, so it is an addition rather than a planned
 * artefact. It is admitted by the in-scope pattern `packages/reorder-plugin/e2e/fixtures/*.ts` (AAP section
 * 0.6.1.2) and declared here under section 0.8.2's no-silent-deviation obligation. It is kept because the
 * four-engine migration cycle AAP section 0.7.5 requires cannot be written without these instruments, and
 * more than one suite needs them: `committedMigrationApplies` in particular has to be the ONE authority for
 * which engine the checked-in artefact applies on, or the suites that gate on it can disagree with each other.
 *
 * @since 3.8.0
 */
import { generateMigration, resetConfig, VendureConfig } from '@vendure/core';
import { preBootstrapConfig } from '@vendure/core/dist/bootstrap';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { DataSource, DataSourceOptions, MigrationInterface } from 'typeorm';
import * as ts from 'typescript';

import { describeTeardownStage, redactTeardownDiagnostic } from './diagnostic-redaction';

/**
 * @description
 * A migration produced by the platform's lifecycle, loaded and ready to hand to `runMigrations`.
 *
 * @since 3.8.0
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
 * Whether the checked-in migration can be applied on the given connection.
 *
 * **Only where the dialect matches, and the list is short for a structural reason.** The shipped migration is
 * the platform migration generator's own output, and `generateMigration` serialises the statements one
 * configured engine's schema builder logged into `queryRunner.query(<SQL>)` calls
 * (`packages/core/src/migrate.ts:L127-L179`). An emitted migration is therefore bound to the engine it was
 * generated against — plan section 0.2.3.1 records that as a known limitation of the form section 0.5.2.2
 * prescribes — and the shipped file was generated against PostgreSQL, which of the four targets is the only
 * server engine on which TypeORM 0.3.28 emits both named check constraints (conflict C-E).
 *
 * **A `false` answer is not a reason to skip a claim**, and no caller treats it as one. It selects the other
 * route: {@link generateLifecycleMigration} against the same connection, which is what a deployment on that
 * engine does with its own first migration.
 *
 * @param engine - The TypeORM driver type, as read off the connection rather than off an environment variable.
 * @since 3.8.0
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
 * @since 3.8.0
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
                'generateMigration wrote no file, so the schema it was diffed against already carries ' +
                    'every mapping the registered entities declare. A caller expecting the two plugin ' +
                    'tables has to diff against the core schema alone.',
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
