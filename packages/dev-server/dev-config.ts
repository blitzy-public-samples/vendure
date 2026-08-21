/* eslint-disable no-console */
import { OnApplicationBootstrap } from '@nestjs/common';
import { AdminUiPlugin } from '@vendure/admin-ui-plugin';
import { AssetServerPlugin } from '@vendure/asset-server-plugin';
import { ADMIN_API_PATH, API_PORT, SHOP_API_PATH } from '@vendure/common/lib/shared-constants';
import {
    DefaultJobQueuePlugin,
    DefaultLogger,
    DefaultSchedulerPlugin,
    DefaultSearchPlugin,
    dummyPaymentHandler,
    LogLevel,
    PluginCommonModule,
    RequestContextService,
    SettingsStoreScopes,
    SettingsStoreService,
    VendureConfig,
    VendurePlugin,
} from '@vendure/core';
import { DashboardPlugin } from '@vendure/dashboard/plugin';
import { defaultEmailHandlers, EmailPlugin, FileBasedTemplateLoader } from '@vendure/email-plugin';
import { GraphiqlPlugin } from '@vendure/graphiql-plugin';
import { ReorderPlugin } from '@vendure/reorder-plugin';
import { TelemetryPlugin } from '@vendure/telemetry-plugin';
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { DataSourceOptions } from 'typeorm';

import { NavModifierPlugin } from './test-plugins/nav-modifier-plugin/nav-modifier-plugin';
// import { FieldTestPlugin } from './test-plugins/field-test/field-test-plugin';
import { ReviewsPlugin } from './test-plugins/reviews/reviews-plugin';

const IS_INSTRUMENTED = process.env.IS_INSTRUMENTED === 'true';

/**
 * FEATURE-001-01: whether this process is driving the migration lifecycle rather than booting or populating a
 * server.
 *
 * `packages/dev-server/migration.ts` is the only entry point in this package that calls
 * `generateMigration`, `runMigrations` or `revertLastMigration`, so the script Node was handed is the signal.
 * Reading `process.argv[1]` keeps this free of a new environment variable — there is nothing for an operator
 * to remember to set, and nothing to forget. It is also fail-safe in the direction that matters: the platform
 * force-assigns `synchronize: false` on every migration connection regardless
 * (`packages/core/src/migrate.ts:L197-L204`), so a miss here costs nothing, while a false positive could only
 * arise from a server booted out of a file named `migration.ts`, which this package does not contain.
 */
const IS_MIGRATION_ENTRY_POINT = /(?:^|[\\/])migration\.(?:ts|js)$/.test(process.argv[1] ?? '');
const dashboardAppDir =
    path.basename(__dirname) === 'dist'
        ? path.join(__dirname, './dashboard')
        : path.join(__dirname, './dist/dashboard');

@VendurePlugin({
    imports: [PluginCommonModule],
    configuration: config => {
        config.settingsStoreFields = {
            ...config.settingsStoreFields,
            ReadonlyTest: [
                { name: 'buildVersion', readonly: true },
                { name: 'buildMeta', readonly: true },
            ],
        };
        return config;
    },
})
class ReadonlySettingsTestPlugin implements OnApplicationBootstrap {
    constructor(
        private settingsStoreService: SettingsStoreService,
        private requestContextService: RequestContextService,
    ) {}
    async onApplicationBootstrap() {
        const ctx = await this.requestContextService.create({ apiType: 'admin' });
        await this.settingsStoreService.set(ctx, 'ReadonlyTest.buildVersion', 'v3.5.2' as any);
        await this.settingsStoreService.set(ctx, 'ReadonlyTest.buildMeta', {
            buildDate: '2026-03-06',
            commit: 'd0384f3ed',
            features: ['settings-store-ui', 'option-groups'],
        });
    }
}

/**
 * Config settings used during development
 */
export const devConfig: VendureConfig = {
    apiOptions: {
        port: Number(process.env.API_PORT) || API_PORT,
        adminApiPath: ADMIN_API_PATH,
        adminApiPlayground: {
            settings: {
                'request.credentials': 'include',
            },
        },
        adminApiDebug: true,
        shopApiPath: SHOP_API_PATH,
        shopApiPlayground: {
            settings: {
                'request.credentials': 'include',
            },
        },
        shopApiDebug: true,
    },
    authOptions: {
        disableAuth: false,
        tokenMethod: ['bearer', 'cookie', 'api-key'] as const,
        requireVerification: true,
        customPermissions: [],
        cookieOptions: {
            secret: 'abc',
        },
    },
    dbConnectionOptions: {
        logging: false,
        // FEATURE-001-01: ReorderPlugin owns its migration in its own package, so it is globbed from there
        // rather than copied into this directory — and it is registered ONLY on a migration-driven
        // connection, which is the same condition that turns synchronization off below. The two are one rule
        // and are deliberately not separable; see `reorderPluginMigrationGlobs` for why a server connection
        // must not carry it.
        migrations: [
            path.join(__dirname, 'migrations/*.ts'),
            ...(IS_MIGRATION_ENTRY_POINT ? reorderPluginMigrationGlobs() : []),
        ],
        ...getDbConfig(),
        // FEATURE-001-01: `synchronize` is declared HERE, after every spread, and that position is the point
        // of it. A later key wins, and every branch of `getDbConfig()` returns `synchronize: true`, so the
        // same key declared ABOVE the spread would be silently overwritten and the file would read as though
        // it made a guarantee it did not deliver.
        //
        // The value is derived, because the two things this configuration is used for want opposite answers
        // and the entry point is what distinguishes them:
        //
        //   * Driving the migration lifecycle. `packages/dev-server/migration.ts` is the only entry point
        //     that calls `generateMigration`, `runMigrations` or `revertLastMigration`, and a migration-driven
        //     connection must not synchronise — otherwise the schema builder creates this plugin's two tables
        //     before the migration runs, and the migration validates a schema it did not author instead of
        //     owning it. `false` here says so explicitly. The platform enforces the same thing independently:
        //     all three entry points build their own DataSource through `createConnectionOptions`, which
        //     force-assigns `synchronize: false` over whatever this object declares
        //     (`packages/core/src/migrate.ts:L197-L204`). So this line agrees with the platform rather than
        //     substituting for it, and a misread of the entry point cannot make a migration run synchronise.
        //
        //   * Booting or populating a dev server, where it stays `true`. `packages/dev-server` ships NO core
        //     migrations — the `migrations/*.ts` pattern above names a directory that does not exist — so a
        //     blanket `false` leaves `bun run populate` and `bun run dev` facing a database with no tables at
        //     all.
        //
        // Neither of the two ways of making a BOOT migration-owned works, and both fail on that same missing
        // piece. `migrationsRun: true` runs migrations BEFORE synchronizing (`DataSource.initialize`,
        // node_modules/typeorm/data-source/DataSource.js:L151-L157), so on a fresh database this plugin's
        // migration meets one with no `customer`, `channel` or `product_variant` for its foreign keys to
        // reference. Declaring `synchronize: false` on the plugin's own entities keeps the schema builder off
        // those two tables everywhere, but TypeORM's contract for that option is that "schema sync will and
        // migrations ignore this entity"
        // (node_modules/typeorm/decorator/options/EntityOptions.d.ts:L31-L35), which leaves every e2e suite —
        // all of them synchronization-driven by their initializers — with no tables at all. The
        // migration-owned flow is exercised by the plugin's own e2e suites instead, against a schema the
        // migration created with synchronization off.
        synchronize: !IS_MIGRATION_ENTRY_POINT,
    },
    paymentOptions: {
        paymentMethodHandlers: [dummyPaymentHandler],
    },
    settingsStoreFields: {
        MyPlugin: [
            {
                name: 'globalVal',
            },
            {
                name: 'userVal',
                scope: SettingsStoreScopes.user,
            },
        ],
    },
    customFields: {},
    logger: new DefaultLogger({ level: LogLevel.Verbose }),
    importExportOptions: {
        importAssetsDir: path.join(__dirname, 'import-assets'),
    },
    plugins: [
        // MultivendorPlugin.init({
        //     platformFeePercent: 10,
        //     platformFeeSKU: 'FEE',
        // }),
        ReadonlySettingsTestPlugin,
        ReviewsPlugin,
        // FieldTestPlugin,
        NavModifierPlugin,
        GraphiqlPlugin.init(),
        AssetServerPlugin.init({
            route: 'assets',
            assetUploadDir: path.join(__dirname, 'assets'),
        }),
        DefaultSearchPlugin.init({ bufferUpdates: false, indexStockStatus: false }),
        // Enable if you need to debug the job queue
        // BullMQJobQueuePlugin.init({}),
        DefaultJobQueuePlugin.init({}),
        // JobQueueTestPlugin.init({ queueCount: 10 }),
        DefaultSchedulerPlugin.init({}),
        EmailPlugin.init({
            devMode: true,
            route: 'mailbox',
            handlers: defaultEmailHandlers,
            templateLoader: new FileBasedTemplateLoader(path.join(__dirname, '../email-plugin/templates')),
            outputPath: path.join(__dirname, 'test-emails'),
            globalTemplateVars: {
                verifyEmailAddressUrl: 'http://localhost:4201/verify',
                passwordResetUrl: 'http://localhost:4201/reset-password',
                changeEmailAddressUrl: 'http://localhost:4201/change-email-address',
            },
        }),
        ...(IS_INSTRUMENTED ? [TelemetryPlugin.init({})] : []),
        // AdminUiPlugin.init({
        //     route: 'admin',
        //     port: 5001,
        //     adminUiConfig: {},
        //     // Un-comment to compile a custom admin ui
        //     // app: compileUiExtensions({
        //     //     outputPath: path.join(__dirname, './custom-admin-ui'),
        //     //     extensions: [
        //     //         {
        //     //             id: 'ui-extensions-library',
        //     //             extensionPath: path.join(__dirname, 'example-plugins/ui-extensions-library/ui'),
        //     //             routes: [{ route: 'ui-library', filePath: 'routes.ts' }],
        //     //             providers: ['providers.ts'],
        //     //         },
        //     //         {
        //     //             globalStyles: path.join(
        //     //                 __dirname,
        //     //                 'test-plugins/with-ui-extension/ui/custom-theme.scss',
        //     //             ),
        //     //         },
        //     //     ],
        //     //     devMode: true,
        //     // }),
        // }),
        AdminUiPlugin.init({
            route: 'admin',
            port: 5001,
            adminUiConfig: {},
            // Un-comment to compile a custom admin ui
            // app: compileUiExtensions({
            //     outputPath: path.join(__dirname, './custom-admin-ui'),
            //     extensions: [
            //         {
            //             id: 'ui-extensions-library',
            //             extensionPath: path.join(__dirname, 'example-plugins/ui-extensions-library/ui'),
            //             routes: [{ route: 'ui-library', filePath: 'routes.ts' }],
            //             providers: ['providers.ts'],
            //         },
            //         {
            //             globalStyles: path.join(
            //                 __dirname,
            //                 'test-plugins/with-ui-extension/ui/custom-theme.scss',
            //             ),
            //         },
            //     ],
            //     devMode: true,
            // }),
        }),
        DashboardPlugin.init({
            route: 'dashboard',
            appDir: dashboardAppDir,
        }),
        // FEATURE-001-01: Named Reorder Lists with Line Quantities
        ReorderPlugin.init({
            maxListsPerCustomer: 25,
            maxLinesPerList: 200,
            maxQuantityPerLine: 999,
            defaultReorderListsPageSize: 25,
            defaultReorderListLinesPageSize: 50,
        }),
    ],
};

/**
 * FEATURE-001-01: the ONE glob pattern that resolves `@vendure/reorder-plugin`'s own migration, in whichever
 * layout the package happens to be installed in.
 *
 * **Registered only on a migration-driven connection, and that restriction is the point of it.** The caller
 * gates this on {@link IS_MIGRATION_ENTRY_POINT}, so the plugin's migration is visible to the `generate`,
 * `run` and `revert` subcommands of `packages/dev-server/migration.ts` and invisible to a server boot or a
 * population run. Without that gate the shipped boot path is incoherent, and provably so rather than
 * arguably:
 *
 *   1. `packages/dev-server/index.ts:L8-L9` runs `runMigrations(devConfig)` and then `bootstrap(devConfig)`.
 *      Both that ordering and the `migrations` pattern naming a directory which does not exist are this
 *      package's own, so on a boot `runMigrations` has nothing to apply.
 *   2. A migration connection is forced to `synchronize: false` (`packages/core/src/migrate.ts:L197-L204`),
 *      so on a FRESH database the plugin's migration would run before `customer`, `channel` and
 *      `product_variant` exist — the three tables its references point at — and could not succeed.
 *   3. `runMigrations` does not rethrow outside the Vendure CLI: it logs, sets `process.exitCode = 1` and
 *      resolves (`packages/core/src/migrate.ts:L52-L59`), so `.then(() => bootstrap(devConfig))` continues.
 *   4. Bootstrap then synchronizes, the schema builder creates the plugin's two tables, and a later boot's
 *      migration finds them already standing. The migration would be recorded as applied against a schema it
 *      did not author, after having failed once without stopping anything.
 *
 * Gating removes that whole chain: a boot runs no plugin migration at all, and the schema builder owns the
 * dev schema openly rather than behind a migration's name. This package ships
 * **no core migrations**, so a migration-owned dev schema is not available to any plugin here — the AAP
 * records that at section 0.4.3 as a discovered property of this harness rather than something a plugin
 * changes. The ordered flow that IS migration-owned belongs to a real deployment and is written out in the
 * plugin's own README.
 *
 * The pattern is anchored on the package's INSTALLED ROOT rather than on this file's `__dirname`, and both
 * halves of that matter. `__dirname` is `packages/dev-server` when the config is run from source through
 * `ts-node` and `packages/dev-server/dist` once it has been built, so a relative `../reorder-plugin/...`
 * pattern silently resolves to `packages/dev-server/reorder-plugin/...` — a directory that does not exist —
 * in the built layout. Resolving the package's own `package.json` gives the right root in both, and in a
 * real consumer's `node_modules` too.
 *
 * **Exactly one layout is registered, and choosing between them is a correctness requirement rather than a
 * tidiness.** The package has two: `src/migrations/*.ts` is the source tree of a monorepo checkout, and
 * `lib/src/migrations/*.js` is the compiled output the published artefact carries (the migration is a named
 * build root, so `bun run build` emits it there). In a built source checkout — the normal state of this
 * repository, since `AGENTS.md` prescribes change, build, restart — BOTH exist and both define
 * `AddReorderLists1786838400000`. TypeORM loads every pattern it is given and then rejects the whole
 * configuration: `MigrationExecutor.checkForDuplicateMigrations` throws
 * `Duplicate migrations: AddReorderLists1786838400000`
 * (`node_modules/typeorm/migration/MigrationExecutor.js:L423-L433`), so registering both patterns does not
 * degrade gracefully — it stops the server and every migration command outright.
 *
 * The built layout wins where both are present, for two reasons beyond determinism. A compiled `.js`
 * migration is loadable by every host, whereas a `.ts` one is loadable only by a host that has registered a
 * TypeScript loader — and TypeORM resolves these patterns through `PlatformTools.load`, which is Node's own
 * `require`. And it is the layout this file already consumes for the plugin itself: `ReorderPlugin` is
 * imported by package name, so it comes from `lib/index.js` by way of the manifest's `main`. Taking the
 * plugin from `lib` while taking its migration from `src` is the combination that could actually disagree.
 *
 * @returns A single-element array naming the layout that exists, or an empty array when the package carries
 * neither — an unbuilt checkout registers nothing rather than a pattern that cannot match.
 */
function reorderPluginMigrationGlobs(): string[] {
    const packageRoot = path.dirname(require.resolve('@vendure/reorder-plugin/package.json'));
    return selectReorderPluginMigrationGlob(packageRoot, candidate => fs.existsSync(candidate));
}

/**
 * FEATURE-001-01: picks the migration layout to register, given a package root and a way to test for a
 * directory.
 *
 * Split out from {@link reorderPluginMigrationGlobs} as a pure function of its two arguments so that the
 * choice can be exercised for a layout the machine running the test does not happen to be in — an installed
 * package carries `lib` only, an unbuilt checkout carries `src` only, and a built checkout carries both.
 *
 * @param packageRoot - The directory holding the plugin's `package.json`.
 * @param directoryExists - Whether a directory is present; injected so all three layouts are reachable.
 * @returns Zero or one glob pattern — never two.
 */
function selectReorderPluginMigrationGlob(
    packageRoot: string,
    directoryExists: (candidate: string) => boolean,
): string[] {
    const layouts: ReadonlyArray<{ readonly directory: string; readonly pattern: string }> = [
        { directory: path.join(packageRoot, 'lib/src/migrations'), pattern: '*.js' },
        { directory: path.join(packageRoot, 'src/migrations'), pattern: '*.ts' },
    ];
    for (const layout of layouts) {
        if (directoryExists(layout.directory)) {
            return [path.join(layout.directory, layout.pattern)];
        }
    }
    return [];
}

function getDbConfig(): DataSourceOptions {
    const dbType = process.env.DB || 'mysql';
    switch (dbType) {
        case 'postgres':
            console.log('Using postgres connection');
            return {
                synchronize: true,
                type: 'postgres',
                host: process.env.DB_HOST || 'localhost',
                port: Number(process.env.DB_PORT) || 5432,
                username: process.env.DB_USERNAME || 'vendure',
                password: process.env.DB_PASSWORD || 'password',
                database: process.env.DB_NAME || 'vendure-dev',
                schema: process.env.DB_SCHEMA || 'public',
            };
        case 'sqlite':
            console.log('Using sqlite connection');
            return {
                synchronize: true,
                type: 'better-sqlite3',
                database: path.join(__dirname, 'vendure.sqlite'),
            };
        case 'sqljs':
            console.log('Using sql.js connection');
            return {
                type: 'sqljs',
                autoSave: true,
                database: new Uint8Array([]),
                location: path.join(__dirname, 'vendure.sqlite'),
            };
        case 'mysql':
        case 'mariadb':
        default:
            console.log('Using mysql connection');
            return {
                synchronize: true,
                type: 'mariadb',
                host: '127.0.0.1',
                port: 3306,
                username: 'vendure',
                password: 'password',
                database: 'vendure-dev',
            };
    }
}
