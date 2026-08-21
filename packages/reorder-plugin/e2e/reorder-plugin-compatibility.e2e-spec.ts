/**
 * The **package contract** of `@vendure/reorder-plugin`, proved end to end.
 */
import {
    bootstrap,
    ConfigService,
    getCompatibility,
    HEALTH_CHECK_ROUTE,
    I18nService,
    InternalServerError,
    mergeConfig,
    PLUGIN_METADATA,
    PluginCommonModule,
    resetConfig,
    runMigrations,
    TransactionalConnection,
    VENDURE_VERSION,
    VendureConfig,
    VendurePlugin,
} from '@vendure/core';
/**
 * **THE EXPORT PROOF, and it is this import statement rather than any assertion below.**
 */
import { preBootstrapConfig } from '@vendure/core/dist/bootstrap';
import {
    ReorderList,
    ReorderListLine,
    ReorderPlugin,
    type ReorderPluginOptions,
} from '@vendure/reorder-plugin';
import { createTestEnvironment } from '@vendure/testing';
import { execFileSync } from 'child_process';
import fs from 'fs-extra';
import path from 'path';
import { DataSource, DataSourceOptions, QueryRunner } from 'typeorm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { initialData } from '../../../e2e-common/e2e-initial-data';
import { TEST_SETUP_TIMEOUT_MS, testConfig } from '../../../e2e-common/test-config';
import { AddReorderLists1786838400000 } from '../src/migrations/1786838400000-add-reorder-lists';
/**
 * **Deliberately NOT from the package root, and the specifier is the assertion.**
 */
import { ReorderPluginConfigurationError, reorderPluginMigrations } from '../src/reorder.plugin';

import { resolveConfiguredEngine } from './fixtures/concurrency-barrier';
import { committedMigrationApplies } from './fixtures/query-capture';
import {
    ADD_ITEM_TO_REORDER_LIST,
    AddItemToReorderListMutation,
    AddItemToReorderListMutationVariables,
    CREATE_REORDER_LIST,
    CreateReorderListMutation,
    CreateReorderListMutationVariables,
    GET_ACTIVE_CUSTOMER_REORDER_LIST,
    GetActiveCustomerReorderListQuery,
    GetActiveCustomerReorderListQueryVariables,
    ReorderListSuccessShape,
} from './graphql/reorder-definitions';

/**
 * The compatibility range `ReorderPlugin` declares, transcribed from the declaration itself — the
 * `compatibility` property of the `@VendurePlugin` metadata in
 * [packages/reorder-plugin/src/reorder.plugin.ts] — rather than guessed at. Cited by property name and not
 * by line, because a line number is invalidated by any edit above it.
 */
const DECLARED_COMPATIBILITY_RANGE = '>=3.3.0';

/**
 * A range no released Vendure version can satisfy, used only to drive the negative half.
 */
const UNSATISFIABLE_COMPATIBILITY_RANGE = '^0.0.1';

/**
 * The platform's own incompatibility message, reproduced exactly as [packages/core/src/bootstrap.ts:L353-L355]
 * composes it.
 */
const incompatibilityMessageFor = (pluginName: string) =>
    `Plugin "${pluginName}" is not compatible with this version of Vendure.`;

/** The error code `InternalServerError` carries in its GraphQL extensions [packages/core/src/common/error/errors.ts]. */
const INTERNAL_SERVER_ERROR_CODE = 'INTERNAL_SERVER_ERROR';

const DECLARED_OPTIONS: Required<ReorderPluginOptions> = {
    maxListsPerCustomer: 25,
    maxLinesPerList: 200,
    maxQuantityPerLine: 999,
    defaultReorderListsPageSize: 25,
    defaultReorderListLinesPageSize: 50,
};

const DECLARED_OPTION_KEYS_SORTED = [
    'defaultReorderListLinesPageSize',
    'defaultReorderListsPageSize',
    'maxLinesPerList',
    'maxListsPerCustomer',
    'maxQuantityPerLine',
];

// The first is a race. The platform's own initializer creates it with a bare, non-recursive `mkdirSync`
// guarded by a preceding `existsSync` (`packages/testing/src/initializers/sqljs-initializer.ts` L31-L35),
// which is a check-then-act race: this package's e2e suites start together, so when the directory is absent —
// both observe it missing and the loser fails its `beforeAll` with `EEXIST`. The three server engines use no
fs.mkdirSync(path.join(__dirname, '__data__'), { recursive: true });

const harnessConfig = mergeConfig(testConfig(), {
    plugins: [ReorderPlugin.init(DECLARED_OPTIONS)],
    importExportOptions: {
        importAssetsDir: path.join(__dirname, '../../core/e2e/fixtures/assets'),
    },
});

const LIST_TABLE = 'reorder_list';
const LINE_TABLE = 'reorder_list_line';

const SEEDED_CUSTOMER_PASSWORD = 'test';

/**
 * Runs work with a query runner and releases it in a `finally`, however the work ends.
 *
 * A leaked runner holds a pooled connection open, which on PostgreSQL is enough to make a later `DROP` in
 * the same file wait on a lock it can never get.
 */
async function withRunner<T>(
    connection: { createQueryRunner: () => QueryRunner },
    work: (runner: QueryRunner) => Promise<T>,
): Promise<T> {
    const runner = connection.createQueryRunner();
    try {
        return await work(runner);
    } finally {
        if (!runner.isReleased) {
            await runner.release();
        }
    }
}

/**
 * The e-mail address of a seeded buyer, read from the database rather than transcribed.
 *
 * Which addresses `@vendure/testing`'s populator generates is its business and not this suite's, so the
 * lowest-identifier customer is taken and the login below is driven with whatever it is.
 */
async function firstCustomerEmail(connection: DataSource): Promise<string> {
    const rows: Array<{ emailAddress: string }> = await connection.query(
        `SELECT ${connection.driver.escape('emailAddress')} FROM ` +
            `${connection.driver.escape('customer')} ORDER BY ${connection.driver.escape('id')} ASC`,
    );
    expect(rows.length, 'the seeded data must carry at least one customer').toBeGreaterThan(0);
    return String(rows[0].emailAddress);
}

/**
 * The API identifier of a seeded product variant, read from the database rather than assumed.
 *
 * This suite populates no catalogue CSV, so the variants present are whatever `initialData` creates; taking
 * the lowest identifier makes the case independent of how many there are.
 */
async function firstProductVariantId(connection: DataSource): Promise<string> {
    const rows: Array<{ id: number | string }> = await connection.query(
        `SELECT ${connection.driver.escape('id')} FROM ${connection.driver.escape('product_variant')} ` +
            `ORDER BY ${connection.driver.escape('id')} ASC`,
    );
    expect(rows.length, 'the seeded data must carry at least one product variant').toBeGreaterThan(0);
    return `T_${rows[0].id}`;
}

/**
 * Ports for the two applications this suite bootstraps itself, derived from the harness's own port and never written
 * as absolute numbers.
 */
const HARNESS_PORT = harnessConfig.apiOptions.port;
const SATISFIED_RANGE_BOOTSTRAP_PORT = HARNESS_PORT + 100;
const UNSATISFIABLE_RANGE_BOOTSTRAP_PORT = HARNESS_PORT + 200;

/**
 * The port the Shop-limit refusal names. Distinct from the two above only so that a failure to refuse cannot
 * be masked by another test's listener; the path under test never reaches `app.listen()`.
 */
const SHOP_LIMIT_REFUSAL_BOOTSTRAP_PORT = HARNESS_PORT + 300;

/**
 * How long a health probe waits before it gives up.
 *
 * This is an abort guard and **not** an assertion about how fast anything is: no test compares an elapsed
 * time against it, and the epic forbids asserting a latency figure anywhere. Without it, a probe that hung
 * would exhaust the runner's own timeout instead of failing with the assertion that explains why.
 */
const HEALTH_PROBE_ABORT_AFTER_MS = 30000;

/** The distinguished result of a health probe that could not reach a server at all. */
const UNREACHABLE = 'unreachable';

/**
 * The type of the object `bootstrap()` resolves to, taken from the platform's own signature.
 *
 * Deriving it rather than importing `INestApplication` keeps this file's dependencies to the four modules
 * it genuinely needs, and makes a change to the platform's return type a compile error here rather than a
 * silently widened annotation.
 */
type BootstrappedApp = Awaited<ReturnType<typeof bootstrap>>;

/**
 * A throwaway plugin declaring a range nothing can satisfy, used by the second negative test.
 */
@VendurePlugin({
    imports: [PluginCommonModule],
    compatibility: UNSATISFIABLE_COMPATIBILITY_RANGE,
})
class UnsatisfiableCompatibilityTestPlugin {}

/**
 * Builds the configuration for an application this suite bootstraps itself.
 */
function directBootstrapConfigFor(
    port: number,
    plugins: NonNullable<VendureConfig['plugins']> = [ReorderPlugin],
): Required<VendureConfig> {
    return mergeConfig(harnessConfig, {
        apiOptions: { port },
        plugins,
        dbConnectionOptions: { synchronize: false },
    });
}

const MIGRATION_TIMESTAMP = '1786838400000';

const MIGRATION_CLASS_NAME = `AddReorderLists${MIGRATION_TIMESTAMP}`;

/** How long the packer is given. It reads the manifest and walks the package; a second is typical. */
const PACK_INVOCATION_TIMEOUT_MS = 120_000;

/**
 * The exact file list a consumer installing this package would receive, as the packer itself reports it.
 */
function publishedFileList(): string[] {
    const packageDir = path.join(__dirname, '..');
    const output = execFileSync('npm', ['pack', '--dry-run', '--json'], {
        cwd: packageDir,
        encoding: 'utf-8',
        timeout: PACK_INVOCATION_TIMEOUT_MS,
    });
    const reported = JSON.parse(output) as Array<{ files?: Array<{ path?: string }> }>;
    expect(reported.length, 'the packer must report exactly one package').toBe(1);
    return (reported[0].files ?? []).map(entry => String(entry.path));
}

/**
 * Asks the platform's own health endpoint whether a server is listening on `port`, and reports either the HTTP
 * status it answered with or {@link UNREACHABLE}.
 */
async function probeHealthEndpoint(port: number): Promise<number | typeof UNREACHABLE> {
    try {
        const response = await fetch(`http://localhost:${port}/${HEALTH_CHECK_ROUTE}`, {
            signal: AbortSignal.timeout(HEALTH_PROBE_ABORT_AFTER_MS),
        });
        return response.status;
    } catch {
        return UNREACHABLE;
    }
}

describe('ReorderPlugin package contract', { timeout: TEST_SETUP_TIMEOUT_MS }, () => {
    const { server, shopClient } = createTestEnvironment(harnessConfig);

    beforeAll(async () => {
        await server.init({
            initialData,
            customerCount: 1,
            productsCsvPath: path.join(__dirname, '../../core/e2e/fixtures/e2e-products-minimal.csv'),
        });
    }, TEST_SETUP_TIMEOUT_MS);

    afterEach(async () => {
        // otherwise leak an unsatisfiable range into every later test in this file.
        Reflect.defineMetadata(PLUGIN_METADATA.COMPATIBILITY, DECLARED_COMPATIBILITY_RANGE, ReorderPlugin);

        const { rawConnection } = server.app.get(TransactionalConnection);
        await rawConnection.createQueryBuilder().delete().from(ReorderListLine).execute();
        await rawConnection.createQueryBuilder().delete().from(ReorderList).execute();
    });

    afterAll(async () => {
        await server.destroy();
    });

    it('publishes ReorderPlugin, ReorderPluginOptions and both entities from the package root', () => {
        expect(ReorderPlugin).toBeDefined();
        expect(ReorderPlugin.name).toBe('ReorderPlugin');
        expect(typeof ReorderPlugin.init).toBe('function');

        const registration = ReorderPlugin.init(DECLARED_OPTIONS);

        expect(typeof registration).toBe('function');
        expect(registration.prototype instanceof ReorderPlugin).toBe(true);
        expect(registration.name).toBe('ReorderPlugin');
        expect(ReorderPlugin.init(DECLARED_OPTIONS)).not.toBe(registration);

        expect(ReorderList).toBeDefined();
        expect(ReorderListLine).toBeDefined();

        const { rawConnection } = server.app.get(TransactionalConnection);
        expect(rawConnection.hasMetadata(ReorderList)).toBe(true);
        expect(rawConnection.hasMetadata(ReorderListLine)).toBe(true);

        const options: ReorderPluginOptions = {
            maxListsPerCustomer: 25,
            maxLinesPerList: 200,
            maxQuantityPerLine: 999,
            defaultReorderListsPageSize: 25,
            defaultReorderListLinesPageSize: 50,
        };
        expect(Object.keys(options).sort()).toEqual(DECLARED_OPTION_KEYS_SORTED);
        expect(options).toEqual(DECLARED_OPTIONS);
    });

    it('publishes exactly the documented surface from the package root, and nothing else', () => {
        // its options type (erased at run time) and both entity classes — the four symbols AAP section
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const rootModule = require('@vendure/reorder-plugin') as Record<string, unknown>;
        expect(Object.keys(rootModule).sort()).toEqual(
            ['ReorderList', 'ReorderListLine', 'ReorderPlugin'].sort(),
        );
        expect(rootModule.ReorderPlugin).toBe(ReorderPlugin);
        expect(rootModule.reorderPluginMigrations).toBeUndefined();
        expect(rootModule.ReorderPluginConfigurationError).toBeUndefined();

        expect(typeof ReorderPluginConfigurationError).toBe('function');
        expect(ReorderPluginConfigurationError.prototype instanceof Error).toBe(true);

        let caught: unknown;
        try {
            ReorderPlugin.init({ maxLinesPerList: 0 });
        } catch (e) {
            caught = e;
        }

        expect((caught as Error).name).toBe('ReorderPluginConfigurationError');
        expect(caught).toBeInstanceOf(Error);
        expect((caught as ReorderPluginConfigurationError).optionKey).toBe('maxLinesPerList');
        const registration = ReorderPlugin.init(DECLARED_OPTIONS);
        expect(typeof registration).toBe('function');
        expect(registration.prototype instanceof ReorderPlugin).toBe(true);
        expect(registration.name).toBe('ReorderPlugin');
        expect(ReorderPlugin.init(DECLARED_OPTIONS)).not.toBe(registration);

        expect(Array.isArray(reorderPluginMigrations)).toBe(true);
        expect(Object.isFrozen(reorderPluginMigrations)).toBe(true);
        expect(reorderPluginMigrations.length).toBeGreaterThan(0);
        for (const migration of reorderPluginMigrations) {
            expect(typeof migration).toBe('function');
            expect(migration.name).toMatch(/^[A-Za-z]+\d{13}$/);
            const instance = new migration();
            expect(typeof instance.up).toBe('function');
            expect(typeof instance.down).toBe('function');
        }
    });

    it('ships its migration in the built package, at the path a deployment registers', () => {
        const installedEntry = require.resolve('@vendure/reorder-plugin');
        const installedLib = path.dirname(installedEntry);
        const packageRoot = path.dirname(installedLib);
        expect(
            path.relative(packageRoot, installedEntry),
            'the package must be entered through its built barrel, which is what makes `lib/` the layout a ' +
                'deployment has',
        ).toBe(path.join('lib', 'index.js'));

        const installedMigrationDir = path.join(installedLib, 'src', 'migrations');
        expect(
            fs.existsSync(installedMigrationDir),
            `${installedMigrationDir} does not exist, so the migration is emitted nowhere a deployment can ` +
                'register it. `tsconfig.build.json` names ONE root, the barrel, so the migration is ' +
                'compiled because the import graph reaches it: the barrel exports `ReorderPlugin`, and the ' +
                'module that declares it imports the migration class for its own `reorderPluginMigrations`. ' +
                'Removing that import would silently stop publishing the migration.',
        ).toBe(true);
        const emitted = fs
            .readdirSync(installedMigrationDir)
            .filter(name => name.endsWith('.js'))
            .sort();
        expect(emitted).toEqual([`${MIGRATION_TIMESTAMP}-add-reorder-lists.js`]);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const loaded = require(path.join(installedMigrationDir, emitted[0])) as Record<string, unknown>;
        const migrationClass = loaded[MIGRATION_CLASS_NAME] as
            | { prototype: Record<string, unknown> }
            | undefined;
        expect(migrationClass, `the emitted migration must export ${MIGRATION_CLASS_NAME}`).toBeDefined();
        expect(typeof (migrationClass as { prototype: Record<string, unknown> }).prototype.up).toBe(
            'function',
        );
        expect(typeof (migrationClass as { prototype: Record<string, unknown> }).prototype.down).toBe(
            'function',
        );

        const packed = publishedFileList();
        expect(packed).toContain(
            ['lib', 'src', 'migrations', `${MIGRATION_TIMESTAMP}-add-reorder-lists.js`].join('/'),
        );
        expect(
            packed.filter(name => name.split('/')[0] === 'src'),
            'the published package ships no source tree, which is why the built path is the one a ' +
                'deployment can name',
        ).toEqual([]);
    });

    it('declares a compatibility range, and declares it as a floor rather than a caret', () => {
        const declared = getCompatibility(ReorderPlugin);

        // nothing fails on [packages/core/src/bootstrap.ts:L335-L338]. A suite that only compared the
        expect(declared).toBeDefined();
        expect(declared).toBe(DECLARED_COMPATIBILITY_RANGE);

        expect(declared?.startsWith('>=')).toBe(true);
        expect(declared).not.toBe('^3.0.0');

        expect(typeof VENDURE_VERSION).toBe('string');
        expect(VENDURE_VERSION.length).toBeGreaterThan(0);
    });

    it('starts a server bootstrapped with the declared compatibility range', async () => {
        expect(getCompatibility(ReorderPlugin)).toBe(DECLARED_COMPATIBILITY_RANGE);

        let app: BootstrappedApp | undefined;
        try {
            app = await bootstrap(directBootstrapConfigFor(SATISFIED_RANGE_BOOTSTRAP_PORT));

            expect(app).toBeDefined();

            expect(app.getHttpServer().listening).toBe(true);
            expect(await probeHealthEndpoint(SATISFIED_RANGE_BOOTSTRAP_PORT)).toBe(200);
        } finally {
            // itself [packages/core/src/config/config.module.ts]; the explicit reset below is kept
            try {
                await app?.close();
            } finally {
                resetConfig();
            }
        }
    });

    it('refuses to start a server when this plugin declares an unsatisfiable range', async () => {
        const declared = getCompatibility(ReorderPlugin);
        expect(declared).toBe(DECLARED_COMPATIBILITY_RANGE);

        let app: BootstrappedApp | undefined;
        let caught: unknown;
        try {
            // plugin decorator writes [packages/core/src/plugin/vendure-plugin.ts:L170] and the same one
            // `getCompatibility` reads [packages/core/src/plugin/plugin-metadata.ts:L56-L58]. Asserting
            Reflect.defineMetadata(
                PLUGIN_METADATA.COMPATIBILITY,
                UNSATISFIABLE_COMPATIBILITY_RANGE,
                ReorderPlugin,
            );
            expect(getCompatibility(ReorderPlugin)).toBe(UNSATISFIABLE_COMPATIBILITY_RANGE);

            try {
                app = await bootstrap(directBootstrapConfigFor(UNSATISFIABLE_RANGE_BOOTSTRAP_PORT));
            } catch (e) {
                caught = e;
            }
        } finally {
            Reflect.defineMetadata(PLUGIN_METADATA.COMPATIBILITY, declared, ReorderPlugin);
            // [packages/core/src/bootstrap.ts:L194-L197], and no application shutdown hook runs to undo
            try {
                await app?.close();
            } finally {
                resetConfig();
            }
        }

        expect(app).toBeUndefined();
        expect(caught).toBeInstanceOf(InternalServerError);
        expect((caught as Error).message).toBe(incompatibilityMessageFor('ReorderPlugin'));
        expect((caught as InternalServerError).extensions.code).toBe(INTERNAL_SERVER_ERROR_CODE);
        expect(await probeHealthEndpoint(UNSATISFIABLE_RANGE_BOOTSTRAP_PORT)).toBe(UNREACHABLE);

        expect(getCompatibility(ReorderPlugin)).toBe(DECLARED_COMPATIBILITY_RANGE);
    });

    it('refuses to start a server when any plugin declares an unsatisfiable range, naming it', async () => {
        expect(UnsatisfiableCompatibilityTestPlugin.name).toBe('UnsatisfiableCompatibilityTestPlugin');
        expect(getCompatibility(UnsatisfiableCompatibilityTestPlugin)).toBe(
            UNSATISFIABLE_COMPATIBILITY_RANGE,
        );

        let app: BootstrappedApp | undefined;
        let caught: unknown;
        try {
            app = await bootstrap(
                directBootstrapConfigFor(UNSATISFIABLE_RANGE_BOOTSTRAP_PORT, [
                    UnsatisfiableCompatibilityTestPlugin,
                ]),
            );
        } catch (e) {
            caught = e;
        } finally {
            try {
                await app?.close();
            } finally {
                resetConfig();
            }
        }

        expect(app).toBeUndefined();
        expect(caught).toBeInstanceOf(InternalServerError);
        expect((caught as Error).message).toBe(
            incompatibilityMessageFor('UnsatisfiableCompatibilityTestPlugin'),
        );
        expect((caught as InternalServerError).extensions.code).toBe(INTERNAL_SERVER_ERROR_CODE);
        expect(await probeHealthEndpoint(UNSATISFIABLE_RANGE_BOOTSTRAP_PORT)).toBe(UNREACHABLE);

        expect(getCompatibility(ReorderPlugin)).toBe(DECLARED_COMPATIBILITY_RANGE);
    });

    /**
     * The Shop list-query-limit refusal, in the two forms that together settle it.
     */
    describe('the Shop list-query limit a page size is checked against', () => {
        it('refuses to start a server whose limit is below a declared page size', async () => {
            const limit = 10;
            expect(
                limit,
                'the limit must be below both declared page sizes for this case to mean anything',
            ).toBeLessThan(
                Math.min(
                    DECLARED_OPTIONS.defaultReorderListsPageSize,
                    DECLARED_OPTIONS.defaultReorderListLinesPageSize,
                ),
            );

            let app: BootstrappedApp | undefined;
            let caught: unknown;
            try {
                const config = mergeConfig(directBootstrapConfigFor(SHOP_LIMIT_REFUSAL_BOOTSTRAP_PORT), {
                    apiOptions: { shopListQueryLimit: limit },
                    plugins: [ReorderPlugin.init(DECLARED_OPTIONS)],
                });
                expect(config.apiOptions.shopListQueryLimit).toBe(limit);
                try {
                    app = await bootstrap(config);
                } catch (e) {
                    caught = e;
                }
            } finally {
                try {
                    await app?.close();
                } finally {
                    resetConfig();
                }
            }

            expect(app, 'the server must not have been created').toBeUndefined();
            expect((caught as Error | undefined)?.name).toBe('ReorderPluginConfigurationError');
            expect((caught as { optionKey?: string } | undefined)?.optionKey).toBe(
                'defaultReorderListsPageSize',
            );
            expect((caught as Error).message).toContain('defaultReorderListsPageSize');
            expect((caught as Error).message).toContain(String(limit));
            expect(await probeHealthEndpoint(SHOP_LIMIT_REFUSAL_BOOTSTRAP_PORT)).toBe(UNREACHABLE);
        });

        /** Builds a plugin instance over the configuration the platform resolves for `limit`. */
        async function pluginOver(limit: number | undefined): Promise<{
            plugin: ReorderPlugin;
            resolvedLimit: number;
            addTranslationFile: ReturnType<typeof vi.fn>;
        }> {
            resetConfig();
            const config = mergeConfig(harnessConfig, {
                apiOptions: limit === undefined ? {} : { shopListQueryLimit: limit },
                plugins: [ReorderPlugin.init(DECLARED_OPTIONS)],
            });
            await preBootstrapConfig(config);
            const configService = new ConfigService();
            const addTranslationFile = vi.fn();
            const plugin = new ReorderPlugin({ addTranslationFile } as unknown as I18nService, configService);
            return { plugin, resolvedLimit: configService.apiOptions.shopListQueryLimit, addTranslationFile };
        }

        afterEach(() => {
            vi.restoreAllMocks();
            resetConfig();
        });

        it('refuses a page size above the resolved limit, naming the key and the limit', async () => {
            const limit = 10;
            const { plugin, resolvedLimit, addTranslationFile } = await pluginOver(limit);
            expect(resolvedLimit).toBe(limit);
            expect(resolvedLimit).toBeLessThan(DECLARED_OPTIONS.defaultReorderListsPageSize);

            let caught: unknown;
            try {
                plugin.onApplicationBootstrap();
            } catch (e) {
                caught = e;
            }

            expect((caught as Error | undefined)?.name).toBe('ReorderPluginConfigurationError');
            expect((caught as { optionKey?: string }).optionKey).toBe('defaultReorderListsPageSize');
            expect((caught as Error).message).toContain('defaultReorderListsPageSize');
            expect((caught as Error).message).toContain(String(limit));
            expect(addTranslationFile).not.toHaveBeenCalled();
        });

        it('accepts both page sizes under the platform default limit, which the platform supplies', async () => {
            const { plugin, resolvedLimit, addTranslationFile } = await pluginOver(undefined);
            expect(resolvedLimit).toBeGreaterThanOrEqual(DECLARED_OPTIONS.defaultReorderListsPageSize);
            expect(resolvedLimit).toBeGreaterThanOrEqual(DECLARED_OPTIONS.defaultReorderListLinesPageSize);

            expect(() => plugin.onApplicationBootstrap()).not.toThrow();
            expect(addTranslationFile).toHaveBeenCalledTimes(1);
        });
    });

    /**
     * A deployment provisioned the way a real one is: the consumer's own migrations create the core schema, this
     * plugin's migration creates its two tables, and the server that serves them creates nothing.
     */
    describe.skipIf(!committedMigrationApplies(resolveConfiguredEngine()))(
        'a deployment provisioned by the migration alone',
        () => {
            it(
                'serves the published operations against a schema this migration created',
                async () => {
                    const { rawConnection } = server.app.get(TransactionalConnection);

                    await withRunner(rawConnection, async runner => {
                        await runner.dropTable(LINE_TABLE, true);
                        await runner.dropTable(LIST_TABLE, true);
                        expect(await runner.hasTable(LINE_TABLE)).toBe(false);
                        expect(await runner.hasTable(LIST_TABLE)).toBe(false);
                    });

                    // (`packages/core/src/migrate.ts:L42`) and on this engine that connection addresses the same
                    {
                        const migrationDrivenConfig = {
                            ...harnessConfig,
                            dbConnectionOptions: {
                                ...harnessConfig.dbConnectionOptions,
                                // migration entry point [packages/core/src/migrate.ts:L197-L204]. So the schema
                                synchronize: false,
                                migrations: [AddReorderLists1786838400000],
                            } as DataSourceOptions,
                        };

                        await runMigrations(migrationDrivenConfig);
                        // [packages/core/src/migrate.ts:L63], and the server this test goes on to use is still
                        await preBootstrapConfig(harnessConfig);

                        await withRunner(rawConnection, async runner => {
                            expect(await runner.hasTable(LIST_TABLE)).toBe(true);
                            expect(await runner.hasTable(LINE_TABLE)).toBe(true);
                        });

                        await shopClient.asUserWithCredentials(
                            await firstCustomerEmail(rawConnection),
                            SEEDED_CUSTOMER_PASSWORD,
                        );

                        const { createReorderList } = await shopClient.query<
                            CreateReorderListMutation,
                            CreateReorderListMutationVariables
                        >(CREATE_REORDER_LIST, { input: { name: 'Provisioned by the migration' } });
                        expect(createReorderList.__typename).toBe('ReorderList');
                        const list = createReorderList as ReorderListSuccessShape;
                        expect(list.name).toBe('Provisioned by the migration');
                        expect(list.lineCount).toBe(0);

                        const variantId = await firstProductVariantId(rawConnection);
                        const { addItemToReorderList } = await shopClient.query<
                            AddItemToReorderListMutation,
                            AddItemToReorderListMutationVariables
                        >(ADD_ITEM_TO_REORDER_LIST, {
                            input: { reorderListId: list.id, productVariantId: variantId, quantity: 3 },
                        });
                        expect(addItemToReorderList.__typename).toBe('ReorderList');
                        expect((addItemToReorderList as ReorderListSuccessShape).lineCount).toBe(1);

                        const { activeCustomerReorderList } = await shopClient.query<
                            GetActiveCustomerReorderListQuery,
                            GetActiveCustomerReorderListQueryVariables
                        >(GET_ACTIVE_CUSTOMER_REORDER_LIST, { id: list.id });
                        expect(activeCustomerReorderList).not.toBeNull();
                        const read = activeCustomerReorderList as NonNullable<
                            typeof activeCustomerReorderList
                        >;
                        expect(read.lineCount).toBe(1);
                        expect(read.lines.totalItems).toBe(1);
                        expect(read.lines.items[0].quantity).toBe(3);
                        expect(read.lines.items[0].productVariantId).toBe(variantId);
                    }
                },
                TEST_SETUP_TIMEOUT_MS,
            );
        },
    );
});
