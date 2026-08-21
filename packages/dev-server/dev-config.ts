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
import path from 'path';
import { DataSourceOptions } from 'typeorm';

import { NavModifierPlugin } from './test-plugins/nav-modifier-plugin/nav-modifier-plugin';
// import { FieldTestPlugin } from './test-plugins/field-test/field-test-plugin';
import { ReviewsPlugin } from './test-plugins/reviews/reviews-plugin';

const IS_INSTRUMENTED = process.env.IS_INSTRUMENTED === 'true';
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
        synchronize: false,
        logging: false,
        // FEATURE-001-01: the ONE clause this feature appends here. `ReorderPlugin` owns its migration inside
        // its own package, so it is registered from there rather than copied into this directory — a glob at
        // the plugin's own `src/migrations/`, in the same form as the pattern beside it. This repository is a
        // source checkout, which is why the pattern names `src/migrations/*.ts`; an installed package carries
        // only the compiled layout and names `lib/src/migrations/*.js` instead, as the plugin's README
        // records. Exactly one pattern is named, because two patterns matching the same migration under two
        // layouts would hand TypeORM two migrations of one name, which
        // `MigrationExecutor.checkForDuplicateMigrations` rejects outright rather than degrading.
        //
        // `packages/dev-server/migration.ts`'s `run` and `revert` subcommands are what apply and reverse it,
        // and every migration connection is forced to `synchronize: false` by the platform itself
        // (`packages/core/src/migrate.ts:L197-L204`) whatever this object declares. This harness ships no core
        // migrations of its own — the pattern above names a directory that does not exist — so its schema
        // comes from the schema builder, and `packages/dev-server/index.ts` runs `runMigrations` before
        // `bootstrap`: on an engine other than the one the plugin's migration was generated against, that call
        // reports its failure through `process.exitCode` rather than by throwing (`migrate.ts:L52-L59`).
        //
        // What the boot then does depends on the engine, and the two cases are NOT the same. `getDbConfig()`
        // is spread over this object, and its `postgres`, `sqlite` and `mysql`/`mariadb`/default branches each
        // set `synchronize: true` — so on those four the schema builder still provisions the schema and the
        // failed migration costs nothing but a non-zero exit code. Its `sqljs` branch sets no `synchronize` at
        // all, so the `false` declared above stays effective there: a failed migration on sql.js leaves the
        // schema EMPTY and the boot proceeds against it, which surfaces as a missing-table error on first use
        // rather than as a migration failure. The migration-owned flow is exercised by the plugin's own e2e
        // suites instead, against a schema the migration itself created.
        migrations: [
            path.join(__dirname, 'migrations/*.ts'),
            path.join(__dirname, '../reorder-plugin/src/migrations/*.ts'),
        ],
        ...getDbConfig(),
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
            // The one branch that supplies no `synchronize`, so the `false` declared on
            // `dbConnectionOptions` above is what takes effect here. See the note beside `migrations`:
            // it is why a failed migration leaves this engine with an empty schema rather than one the
            // schema builder provisioned.
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
