/**
 * The **package contract** of `@vendure/reorder-plugin`, proved end to end.
 *
 * This suite discharges exactly three obligations and deliberately nothing else. Everything about the
 * feature's own behaviour — the eight Shop operations, the four error results, the two entities, the
 * migration, the published schema widths — belongs to the five sibling suites in this directory and is
 * asserted there rather than duplicated here.
 *
 * 1. **A server bootstrapped with the plugin's declared compatibility range starts.**
 * 2. **A server bootstrapped with a deliberately unsatisfiable range fails with the platform's own
 *    message rather than starting anyway.**
 * 3. **The export proof:** every symbol a deployment configures this plugin through is reachable by a
 *    *static import from the package root*, `@vendure/reorder-plugin`, rather than only from a deep path
 *    into the package's own tree.
 *
 * ## Attribution — where these obligations come from
 *
 * **No user-specified rules were provided for this project.** The rules document was read in full and
 * returned exactly that, and EPIC-001 reaches the same finding independently in its own section 11.9. No
 * user-specified rule governs this file and no rule forced it into scope. Nothing below may be presented
 * as a rule: every obligation here is either prompt-derived (the plan's section 0.7.1 row "Package
 * contract") or ticket-derived (EPIC-001 sections 7.9.2 and 11.6.1, and rulings R15, R17 and R22), and
 * each is cited inline as such. The absence of a rules document has not been treated as licence to lower
 * the bar — the standard applied instead is the epic's own testing contract, which is stricter than a
 * general convention would have been.
 *
 * ## Why BOTH halves of the compatibility contract are required
 *
 * `VendurePluginMetadata.compatibility` is optional, and the platform's reaction to its **absence** is a
 * single informational log line saying the plugin is not guaranteed to be compatible
 * [packages/core/src/bootstrap.ts:L335-L338] — which nothing fails on and nobody reads. **Declared**, it
 * is enforced: a range the running version does not satisfy throws and the server does not start
 * [packages/core/src/bootstrap.ts:L340-L349]. EPIC-001 section 7.9.2 therefore requires two tests rather
 * than one, on the grounds that "a declaration nobody exercises is a declaration that regresses". A suite
 * asserting only the happy half would keep passing if the range were deleted outright.
 *
 * ## The decisive platform fact — why `server.init()` cannot carry either half
 *
 * `checkPluginCompatibility()` is called **inside `bootstrap()`** [packages/core/src/bootstrap.ts:L197]
 * and inside `bootstrapWorker()` [packages/core/src/bootstrap.ts:L265]. It is **not** called inside
 * `preBootstrapConfig()` [packages/core/src/bootstrap.ts:L287]. The harness's own server takes the second
 * route — `TestServer.bootstrapForTesting()` calls `preBootstrapConfig` and then `NestFactory.create`
 * directly [packages/testing/src/test-server.ts:L106-L138] — so **`server.init()` never runs the
 * compatibility check at all**. A suite that only called `server.init()` and passed would prove nothing
 * about compatibility, which is precisely the silent-success failure mode section 7.9.2 exists to
 * prevent. Both halves below therefore call the real exported `bootstrap()`.
 *
 * ## The one thing this file must never do
 *
 * `bootstrap()` takes an optional second argument, and one of its members is a plugin allow-list that
 * downgrades a compatibility failure from a thrown error to a `Logger.warn` and then loads the offending
 * plugin anyway [packages/core/src/bootstrap.ts:L51-L74, L344-L350]. Supplying it here would make both
 * negative tests below pass while the behaviour they exist to assert was absent — the worst kind of test,
 * because it reports success rather than absence. **No `bootstrap()` call in this file passes a second
 * argument at all**, and that option's identifier is deliberately not written anywhere in this file
 * either, so a search of this file for it returns nothing and the absence is checkable rather than
 * merely claimed.
 *
 * ## Assertion discipline
 *
 * Ruling R17 requires a negative assertion to name the exact error and its observable text. "It threw"
 * and "the server did not start" are not assertions, so each negative test below asserts the thrown
 * class, the exact message string, the error code carried in the error's GraphQL extensions, that no
 * application object was returned, and that nothing is left listening on the port it was told to use.
 *
 * Ruling R15 governs published-surface widths. This file asserts **none** of them: the schema-delta
 * assertions belong to `reorder-list-read.e2e-spec.ts`, and duplicating them here would create a second
 * authority for numbers that must have exactly one. Nothing here asserts a latency, throughput,
 * service-level, conversion or revenue figure either — the epic forbids all five, and the single
 * millisecond value in this file is an abort guard on a probe rather than a measurement of anything.
 *
 * Rulings R2 and R3 forbid asserting that a session "holds" `Permission.Owner`; it is declared
 * `assignable: false, internal: true` [packages/core/src/common/constants.ts:L27-L32]. No test here makes
 * any claim about a session's permissions.
 *
 * ## Lifecycle
 *
 * EPIC-001 section 11.6.1's canonical lifecycle applies unchanged: exactly one `TestServer`, created at
 * describe scope and initialised in `beforeAll` under the long setup timeout, with `afterAll` calling
 * `await server.destroy()` **unconditionally** so a leaked listening port cannot break the next file.
 * Every application this suite bootstraps *itself* is closed in a `finally`, and the global singleton
 * configuration is reset alongside it. The harness's wholesale `clearAllTables` is never called between
 * tests: it runs `connection.synchronize(true)`
 * [packages/testing/src/data-population/clear-all-tables.ts:L18] and would drop and recreate every table,
 * destroying the fixture the remaining tests depend on.
 */
import {
    bootstrap,
    getCompatibility,
    HEALTH_CHECK_ROUTE,
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
 *
 * The specifier is the **package root**. EPIC-001 ruling R22 requires every symbol a deployment
 * configures this plugin through to be reachable from the root, and requires that reachability be proved
 * by a static import from the root rather than from a deep path into the package's own source tree. A
 * test that reached past `package.json` — for a module beneath the package's `src` directory, say — would
 * exercise a route that is *unsupported* rather than impossible: the manifest publishes the whole compiled
 * tree and declares no `exports` map, so such a specifier does resolve for an installed consumer, but it
 * names an internal module carrying no compatibility guarantee. The root is the surface the package
 * documents and keeps. So this line is load-bearing twice over: it fails at resolution time if the root
 * barrel stops publishing one of the six symbols it names, and it fails at build time if
 * `tsconfig.build.json` stops emitting the module a symbol lives in. That file names TWO build roots, and
 * the distinction matters to this proof: the barrel is the public one, from which every symbol here is
 * reachable, and the plugin's single migration is the second. The migration is a root of its own so that its
 * compiled class is emitted into the published tree whatever the barrel happens to import — a module no root
 * reaches is not compiled, and a migration absent from `lib` cannot be registered by a consumer.
 *
 * `ReorderPluginOptions` carries the `type` modifier because the root barrel publishes it with
 * `export type`, so it has no runtime binding to import. The modifier is what keeps the statement honest:
 * it declares that this symbol is a compile-time contract and nothing else.
 *
 * There is a second, independent guard on the same rule. The repository-wide import check at
 * `scripts/check-imports.ts` fails any file under `packages/` (bar the dev-server) that reaches into the
 * internal source tree of `@vendure/core`, `@vendure/common` or `@vendure/admin-ui` — the three
 * `<package>` plus `/src` specifiers it lists as illegal patterns. That guard tests the **whole file
 * content** against those patterns rather than only its import statements, which is why this comment
 * describes the three banned specifiers instead of spelling them out: writing one out would trip the
 * guard on the comment itself and so fail the very check the comment exists to explain.
 */
import { preBootstrapConfig } from '@vendure/core/dist/bootstrap';
import {
    ReorderList,
    ReorderListLine,
    ReorderPlugin,
    ReorderPluginConfigurationError,
    reorderPluginMigrations,
    type ReorderPluginOptions,
} from '@vendure/reorder-plugin';
import { createTestEnvironment } from '@vendure/testing';
import { execFileSync } from 'child_process';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { DataSource, DataSourceOptions, QueryRunner } from 'typeorm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { initialData } from '../../../e2e-common/e2e-initial-data';
import { TEST_SETUP_TIMEOUT_MS, testConfig } from '../../../e2e-common/test-config';
import { AddReorderLists1786838400000 } from '../src/migrations/1786838400000-add-reorder-lists';

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
 *
 * It is a **floor** (`>=`) and not the `^3.0.0` caret form that five shipped first-party plugins declare,
 * because EPIC-001 section 7.9.2 rules that a plugin depending on a mechanism introduced later states the
 * floor instead, as `packages/telemetry-plugin/src/telemetry.plugin.ts:L121` does. Pinning the literal
 * here is the whole point of the assertion that reads it back: a change to the declared range then has to
 * be a deliberate edit to this constant rather than an unnoticed edit to the plugin.
 */
const DECLARED_COMPATIBILITY_RANGE = '>=3.3.0';

/**
 * A range no released Vendure version can satisfy, used only to drive the negative half.
 *
 * `^0.0.1` admits `0.0.1` alone — the caret's special case for a zero major *and* a zero minor — so it
 * cannot be satisfied by any 3.x version and cannot begin silently passing as the platform's version
 * advances. A range derived from the running version instead (`>` it, say) would eventually collide with
 * a real release; this one never can.
 */
const UNSATISFIABLE_COMPATIBILITY_RANGE = '^0.0.1';

/**
 * The platform's own incompatibility message, reproduced exactly as
 * [packages/core/src/bootstrap.ts:L353-L355] composes it.
 *
 * Only this short form is thrown. The longer text that also names the offending semver range and the
 * running version goes to `Logger.error` one line earlier and never reaches the caller
 * [packages/core/src/bootstrap.ts:L341-L352], so asserting the longer form would fail against a correct
 * platform.
 */
const incompatibilityMessageFor = (pluginName: string) =>
    `Plugin "${pluginName}" is not compatible with this version of Vendure.`;

/** The error code `InternalServerError` carries in its GraphQL extensions [packages/core/src/common/error/errors.ts]. */
const INTERNAL_SERVER_ERROR_CODE = 'INTERNAL_SERVER_ERROR';

/**
 * The five options this suite registers the plugin with, annotated with the imported options type.
 *
 * The annotation is half of the export proof and is not decoration. If the root barrel stopped publishing
 * `ReorderPluginOptions` as a type, this line would stop compiling; if it stopped publishing
 * `ReorderPlugin` as a value, the assertions below would stop passing. The two failure modes are
 * different, and the suite is arranged so that each is caught by the mechanism able to see it.
 *
 * The values are the declared defaults from `packages/reorder-plugin/src/types.ts`. Every key is optional
 * there, so naming all five is a deliberate completeness statement rather than a requirement of the type.
 */
const DECLARED_OPTIONS: ReorderPluginOptions = {
    maxListsPerCustomer: 25,
    maxLinesPerList: 200,
    maxQuantityPerLine: 999,
    defaultReorderListsPageSize: 25,
    defaultReorderListLinesPageSize: 50,
};

/** The five option keys, in the order `Array.prototype.sort` puts them, so the assertion is order-free. */
const DECLARED_OPTION_KEYS_SORTED = [
    'defaultReorderListLinesPageSize',
    'defaultReorderListsPageSize',
    'maxLinesPerList',
    'maxListsPerCustomer',
    'maxQuantityPerLine',
];

/**
 * The harness configuration, built at the **top level of this spec file**.
 *
 * `testConfig()` is a function, and it must be called from here rather than from a helper module: it
 * derives this file's port as `getBasePort() + <index of the calling file in its own directory listing>`,
 * reading the caller off the stack [e2e-common/test-config.ts:L37-L48, L71-L77]. Called from `fixtures/`
 * it would compute the index against the wrong directory and hand two suites the same port.
 *
 * `reorder-plugin` has no entry in that file's package-offset table, so it falls to the shared default
 * base of 3250 [e2e-common/test-config.ts:L55-L64]. That gap is **reported and not fixed**: `e2e-common`
 * lies outside this feature's boundary and may not be edited.
 */
// THE SQL.JS SNAPSHOT DIRECTORY, CREATED IDEMPOTENTLY AND AT MODULE SCOPE, FOR TWO SEPARATE REASONS.
//
// The first is a race. The platform's own initializer creates it with a bare, non-recursive `mkdirSync`
// guarded by a preceding `existsSync` (`packages/testing/src/initializers/sqljs-initializer.ts` L31-L35),
// which is a check-then-act race: this package's six suites start together, so when the directory is absent —
// as it is on a fresh checkout, and after the operational reset a schema change requires — two of them can
// both observe it missing and the loser fails its `beforeAll` with `EEXIST`. Measured, not hypothesised: that
// is exactly how one four-engine sweep of this package failed on sql.js while the three server engines, which
// use no snapshot directory, all passed.
//
// The second is why it happens HERE, before `testConfig()` below, rather than inside `beforeAll`.
// `e2e-common/test-config.ts` derives this suite's server port from the INDEX of this file within `e2e/` —
// `getIndexOfTestFileInParentDir` reads the listing with `readdirSync` and takes `indexOf` — so a directory
// that appears inside `e2e/` between one suite's index computation and another's shifts the second suite's
// port onto a neighbour's and one of them dies of `EADDRINUSE`. Creating it before this file computes its own
// index means every suite computes with it present, whichever arrives first.
//
// `recursive` makes the call idempotent, so whichever suite arrives second simply proceeds. An EMPTY
// directory is not a cached snapshot — the initializer keys synchronisation on the snapshot FILE — so this
// does not weaken the stale-cache reset it exists alongside.
fs.mkdirSync(path.join(__dirname, '__data__'), { recursive: true });

const harnessConfig = mergeConfig(testConfig(), {
    plugins: [ReorderPlugin.init(DECLARED_OPTIONS)],
    // The seeded catalogue's assets live in core's fixtures, and the shipped cross-package route to them is
    // `packages/dashboard/e2e/global-setup.ts:L105,L122`. It is pointed at here because the shared
    // configuration aims this at THIS package's own `e2e/fixtures/assets`, which this package does not ship
    // and may not add — its directory file set is closed.
    importExportOptions: {
        importAssetsDir: path.join(__dirname, '../../core/e2e/fixtures/assets'),
    },
});

/** The two plugin-owned table names, as TypeORM's snake-casing of the entity class names produces them. */
const LIST_TABLE = 'reorder_list';
const LINE_TABLE = 'reorder_list_line';

/**
 * The engines whose database lives inside whichever connection holds it, so two connections cannot see one
 * another's writes without an explicit export and load.
 */
const CONNECTION_LOCAL_ENGINES: readonly string[] = ['sqljs', 'sqlite', 'better-sqlite3'];

/** The password `@vendure/testing` gives every seeded customer, as the sibling suites also declare it. */
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
 * Ports for the two applications this suite bootstraps itself, derived from the harness's own port and
 * never written as absolute numbers.
 *
 * The offsets are whole hundreds for a specific reason. Sibling suites in this directory each receive
 * `<base> + <their own index>`, so an offset of `+1` would give this file's positive-case port the same
 * number as the next suite's harness port, and the two would collide the moment the runner executed them
 * in parallel. Whole-hundred offsets keep all three families — harness, satisfied-range bootstrap,
 * unsatisfiable-range bootstrap — disjoint however many suites this directory grows.
 *
 * What the scheme cannot separate, and does not claim to, is two simultaneous *checkouts*: the base is
 * chosen per package rather than per working tree [e2e-common/test-config.ts:L55-L64], so a second clone
 * running this same suite competes for these same numbers and one of the two fails to bind. That is the
 * shared configuration's behaviour for every suite in the repository, not something this file introduces,
 * and it is recorded here only so the resulting `EADDRINUSE` is recognised for what it is rather than
 * investigated as a defect in this suite.
 */
const HARNESS_PORT = harnessConfig.apiOptions.port;
const SATISFIED_RANGE_BOOTSTRAP_PORT = HARNESS_PORT + 100;
const UNSATISFIABLE_RANGE_BOOTSTRAP_PORT = HARNESS_PORT + 200;

/**
 * How long a health probe waits before it gives up.
 *
 * This is an abort guard and **not** an assertion about how fast anything is: no test compares an elapsed
 * time against it, and the epic forbids asserting a latency figure anywhere. Without it, a probe that hung
 * would exhaust the runner's own timeout instead of failing with the assertion that explains why.
 *
 * It is set generously rather than tightly, because being tight buys nothing here and could cost a false
 * failure. A refused connection returns immediately and never reaches this bound, so the value only ever
 * governs a probe that hangs; making it small would instead risk aborting a slow-but-correct answer on a
 * loaded machine and reporting a healthy server as unreachable.
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
 *
 * It exists so that the platform mechanism is proved **independently of the metadata override** the first
 * negative test uses. That test rewrites `ReorderPlugin`'s own compatibility metadata, which is the
 * faithful reading of EPIC-001 section 7.9.2 because it exercises the class the epic is about; but a
 * defect in `Reflect.defineMetadata` or in the plugin decorator could in principle make that test pass
 * for the wrong reason. This class declares its unsatisfiable range the ordinary way — through the
 * decorator, at module-evaluation time, exactly as a real third-party plugin would — so the two tests
 * fail for different reasons and cannot both be satisfied by one mistake.
 *
 * Declaring a plugin class inside a specification file is the shipped convention rather than an
 * invention; see `packages/core/e2e/error-handler-strategy.e2e-spec.ts`. It registers no entity, no
 * provider and no API extension, and `bootstrap()` refuses the configuration before any module is
 * instantiated, so `PluginCommonModule` is never actually resolved.
 */
@VendurePlugin({
    imports: [PluginCommonModule],
    compatibility: UNSATISFIABLE_COMPATIBILITY_RANGE,
})
class UnsatisfiableCompatibilityTestPlugin {}

/**
 * Builds the configuration for an application this suite bootstraps itself.
 *
 * **It is built from the harness's own configuration object, and that is what makes it work.** The
 * database initializers mutate `dbConnectionOptions` **in place** during `server.init()` — the sql.js
 * initializer writes the snapshot `location` [packages/testing/src/initializers/sqljs-initializer.ts],
 * and the MySQL and PostgreSQL initializers write the per-specification `database` name
 * [packages/testing/src/initializers/mysql-initializer.ts:L16],
 * [packages/testing/src/initializers/postgres-initializer.ts:L15] — so a configuration derived *after*
 * `beforeAll` points at the database the harness actually prepared. `mergeConfig` deep-clones its target
 * at call time [packages/core/src/config/merge-config.ts], which is precisely why this is a function
 * called from inside a test rather than a constant evaluated at module load.
 *
 * Two deliberate departures from a plain copy, each stated rather than left to be discovered:
 *
 * - **`synchronize` is forced off.** The harness has already built the schema; the MySQL and PostgreSQL
 *   initializers leave the flag on, and a second connection running schema synchronisation against a
 *   schema a live connection just created is a data-definition race that has nothing whatever to do with
 *   compatibility. Turning it off keeps the test measuring the one thing it claims to measure.
 * - **`plugins` is replaced, not extended.** `mergeConfig` treats an array as a single value and
 *   substitutes it wholesale [packages/core/src/config/merge-config.ts], so passing a plugin list here
 *   yields exactly that list. The default is `[ReorderPlugin]`, which is what the harness itself
 *   registers, because `ReorderPlugin.init()` returns the plugin class.
 *
 * **One shared-instance consequence, bounded and recorded.** Every configuration derived from the
 * platform's `defaultConfig` shares its strategy *instances*: `simpleDeepClone` returns a class instance
 * by reference rather than copying it, so the application bootstrapped here adopts the same job-queue
 * strategy object the harness holds, and closing it flips that object's `hasInitialized` flag back to
 * false [packages/core/src/job-queue/injectable-job-queue-strategy.ts]. The effect is bounded because
 * `bootstrap()` never starts the job queue — only the harness's own path does
 * [packages/testing/src/test-server.ts:L131] — so no queue is created, processed or torn down by these
 * tests, and no assertion in this file touches a job. It is recorded here because a future test in this
 * file that *did* depend on the harness's job queue after a direct bootstrap would need its own instance,
 * and the platform's default implementation is not exported for one to be constructed.
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

/** The timestamp the one additive migration carries, which is also its class-name suffix. */
const MIGRATION_TIMESTAMP = '1786838400000';

/** The class the emitted migration must export, since the glob registers whatever the module exports. */
const MIGRATION_CLASS_NAME = `AddReorderLists${MIGRATION_TIMESTAMP}`;

/** How long the packer is given. It reads the manifest and walks the package; a second is typical. */
const PACK_INVOCATION_TIMEOUT_MS = 120_000;

/**
 * The exact file list a consumer installing this package would receive, as the packer itself reports it.
 *
 * ★ WHY THE PACKER RATHER THAN THE MANIFEST. `files` is a pattern list, and the question this answers is
 * whether those patterns cover a particular emitted path — which is npm's own matching semantics, including
 * its always-included and never-included sets. Re-implementing that here would mean asserting this file's
 * reading of the rules rather than the rules, and the failure it exists to catch (an emission that lands
 * outside every pattern and is therefore never published) is exactly the case a hand-rolled matcher gets
 * wrong. `--dry-run` writes no tarball, so nothing is left behind to clean up.
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
 * Asks the platform's own health endpoint whether a server is listening on `port`, and reports either the
 * HTTP status it answered with or {@link UNREACHABLE}.
 *
 * The route is the platform's constant rather than a literal, so a rename of the endpoint is a compile
 * error here [packages/core/src/health-check/constants.ts:L1]. Returning a distinguished value instead of
 * throwing is what lets both the positive and the negative test assert an exact result — `200` and
 * `'unreachable'` — rather than one asserting a value and the other asserting that something threw, which
 * ruling R17 would not accept.
 */
async function probeHealthEndpoint(port: number): Promise<number | typeof UNREACHABLE> {
    try {
        const response = await fetch(`http://localhost:${port}/${HEALTH_CHECK_ROUTE}`, {
            signal: AbortSignal.timeout(HEALTH_PROBE_ABORT_AFTER_MS),
        });
        return response.status;
    } catch {
        // A refused connection, a DNS failure or the abort guard above all mean the same thing for the
        // purposes of these tests: no server answered on that port.
        return UNREACHABLE;
    }
}

/**
 * The suite-level timeout is declared once here rather than three times below.
 *
 * Three of the tests in this file bootstrap a real Vendure application, which the runner's per-test
 * default of fifteen seconds locally and thirty in continuous integration
 * [e2e-common/vitest.config.mts:L12] does not reliably accommodate. Vitest applies a suite's `timeout`
 * to every test it contains, so one declaration covers all five; the two that assert no application at
 * all take milliseconds and are unaffected by the ceiling. `beforeAll` keeps its own explicit value
 * because a hook is governed by the separate hook timeout rather than by this one.
 */
describe('ReorderPlugin package contract', { timeout: TEST_SETUP_TIMEOUT_MS }, () => {
    const { server, shopClient } = createTestEnvironment(harnessConfig);

    beforeAll(async () => {
        // The MINIMAL catalogue, and one variant is the whole reason for it: the migration-owned deployment
        // case below adds a line to a list, which is what exercises the child table, its foreign key to
        // `product_variant` and the stored counter's increment — none of which a parent-only case can reach.
        // The compatibility obligations themselves need no catalogue at all, so the smallest shipped CSV is
        // used rather than a fuller one, and it is reached in core's fixtures because this package ships no
        // fixture of its own and its directory file set is closed; the cross-package route is the one
        // `packages/dashboard/e2e/global-setup.ts:L105,L122` takes.
        await server.init({
            initialData,
            customerCount: 1,
            productsCsvPath: path.join(__dirname, '../../core/e2e/fixtures/e2e-products-minimal.csv'),
        });
    }, TEST_SETUP_TIMEOUT_MS);

    afterEach(async () => {
        // EPIC-001 section 11.6.1: anything a test mutated that it did not create is restored here, in
        // the same hook, rather than only in the test's own `finally`. The negative test rewrites this
        // plugin's compatibility metadata, and a failure between the rewrite and its restore would
        // otherwise leak an unsatisfiable range into every later test in this file.
        Reflect.defineMetadata(PLUGIN_METADATA.COMPATIBILITY, DECLARED_COMPATIBILITY_RANGE, ReorderPlugin);

        // Section 11.6.1 again: every plugin-owned row a test created is deleted here, child table
        // (`reorder_list_line`) before parent (`reorder_list`), so a foreign key can never be the thing
        // that fails the cleanup. No test in this file writes either table, which makes this a guard
        // rather than a necessity — and a guard worth keeping, because the cost of it being absent when
        // somebody adds a writing test is a suite that passes or fails on the order the runner chose.
        // The delete goes through the query builder so that each identifier is quoted the way the engine
        // under test expects; the harness's wholesale `clearAllTables` is deliberately not used.
        const { rawConnection } = server.app.get(TransactionalConnection);
        await rawConnection.createQueryBuilder().delete().from(ReorderListLine).execute();
        await rawConnection.createQueryBuilder().delete().from(ReorderList).execute();
    });

    afterAll(async () => {
        // Unconditional, and not only on the success path: a leaked listening port breaks the next file.
        await server.destroy();
    });

    it('publishes ReorderPlugin, ReorderPluginOptions and both entities from the package root', () => {
        // The static import at the top of this file is the proof of ruling R22; what follows reads back
        // what that import resolved to, so that a symbol which resolves but is the wrong thing is caught
        // as well as one that fails to resolve at all.
        expect(ReorderPlugin).toBeDefined();
        expect(ReorderPlugin.name).toBe('ReorderPlugin');
        expect(typeof ReorderPlugin.init).toBe('function');

        // `init()` returns a `ReorderPlugin` REGISTRATION, which is what makes `plugins: [ReorderPlugin.init()]`
        // a valid entry. It is a distinct subclass rather than the class itself, so that each configuration
        // in a process carries its own resolved options instead of sharing one module-level slot — see
        // `createScopedRegistration` in `src/reorder.plugin.ts`. What a consumer needs is asserted here: it is
        // a constructor function, it is a `ReorderPlugin`, and it presents under that name so every platform
        // log line reads the same as before.
        const registration = ReorderPlugin.init(DECLARED_OPTIONS);

        expect(typeof registration).toBe('function');
        expect(registration.prototype instanceof ReorderPlugin).toBe(true);
        expect(registration.name).toBe('ReorderPlugin');
        // And calling it again is safe: each call yields its own registration, so re-initialising cannot
        // reach the options of a registration that already exists — which is the whole point of the change.
        expect(ReorderPlugin.init(DECLARED_OPTIONS)).not.toBe(registration);

        expect(ReorderList).toBeDefined();
        expect(ReorderListLine).toBeDefined();

        // Stronger than "is defined": the two classes reached through the package root are the very
        // classes the running server registered as entities. A barrel that re-exported a look-alike, or a
        // build that emitted a second copy of the module, would satisfy `toBeDefined()` and fail this.
        const { rawConnection } = server.app.get(TransactionalConnection);
        expect(rawConnection.hasMetadata(ReorderList)).toBe(true);
        expect(rawConnection.hasMetadata(ReorderListLine)).toBe(true);

        // The type half of the proof. This annotation is what fails to compile if the root barrel stops
        // publishing `ReorderPluginOptions`; asserting the keys is what fails at run time if the shape
        // the plugin is actually configured with drifts from the shape published as its contract.
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

    it('publishes the configuration error class and the migration classes from the package root', () => {
        // The error class is documented with an `instanceof` consumer path, so the root export is what
        // makes that documentation true. Read back as a class rather than merely as defined: a plain
        // `Error` re-exported under the name would satisfy `toBeDefined()` and fail the subclass check.
        expect(typeof ReorderPluginConfigurationError).toBe('function');
        expect(ReorderPluginConfigurationError.prototype instanceof Error).toBe(true);

        // The documented `instanceof` path itself, driven through the root-imported `init()`. `0` is
        // below the minimum of every bound, so it is refused whichever key carries it, and a refused
        // call leaves the previously resolved options in force — which is why the harness's own
        // registration is unaffected by running this.
        let caught: unknown;
        try {
            ReorderPlugin.init({ maxLinesPerList: 0 });
        } catch (e) {
            caught = e;
        }
        expect(caught).toBeInstanceOf(ReorderPluginConfigurationError);
        expect((caught as ReorderPluginConfigurationError).optionKey).toBe('maxLinesPerList');
        // Restores the declared set, so the assertion above cannot leave a rejected value — or an
        // unrelated one — in force for any test that follows: `init()` assigns the module-level slot
        // `ReorderPlugin.options` reports, and only an accepted call reaches that assignment.
        //
        // What the accepted call RETURNS is a `ReorderPlugin` REGISTRATION, which is what makes
        // `plugins: [ReorderPlugin.init()]` a valid entry. It is a distinct subclass rather than the class
        // itself, so that each configuration in a process carries its own resolved options instead of
        // sharing one module-level slot — see `createScopedRegistration` in `src/reorder.plugin.ts`. What a
        // consumer needs is asserted here: it is a constructor function, it is a `ReorderPlugin`, and it
        // presents under that name so every platform log line reads the same as before.
        const registration = ReorderPlugin.init(DECLARED_OPTIONS);
        expect(typeof registration).toBe('function');
        expect(registration.prototype instanceof ReorderPlugin).toBe(true);
        expect(registration.name).toBe('ReorderPlugin');
        // And calling it again is safe: each call yields its own registration, so re-initialising cannot
        // reach the options of a registration that already exists — which is the whole point of the design.
        expect(ReorderPlugin.init(DECLARED_OPTIONS)).not.toBe(registration);

        // The migration classes are what a deployment registers in `dbConnectionOptions.migrations`, so
        // the export is the registration contract and is read back as such: a non-empty array whose
        // every member is a constructor carrying the timestamped name TypeORM orders migrations by.
        expect(Array.isArray(reorderPluginMigrations)).toBe(true);
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
        // ★ WHY THIS IS ASSERTED AGAINST THE INSTALLED ARTEFACT RATHER THAN THE SOURCE TREE. A consumer
        // installs `@vendure/reorder-plugin` from the registry, and what arrives is whatever `files` ships:
        // `lib/**/*` and `i18n/**/*`, and no `src/` at all. The plugin's two tables are created by exactly
        // one migration, so a migration that is emitted nowhere and shipped in nothing cannot be applied by
        // the deployment that needs it — the tables never exist, and every published operation fails on a
        // missing relation. Asserting the file under `src/` would prove nothing about that, because `src/`
        // is precisely the directory a consumer does not receive.
        //
        // The path is resolved the way `packages/dev-server/dev-config.ts` resolves it — through the
        // package's own `main` — so this test and the registration cannot drift apart: if the emission moves,
        // both follow it, and if the emission disappears, both fail.
        const installedEntry = require.resolve('@vendure/reorder-plugin');
        const installedLib = path.dirname(installedEntry);
        const packageRoot = path.dirname(installedLib);
        expect(
            path.relative(packageRoot, installedEntry),
            'the package must be entered through its built barrel, which is what makes `lib/` the layout a ' +
                'deployment has',
        ).toBe(path.join('lib', 'index.js'));

        // ONE EMITTED MIGRATION, at the registered glob's own directory. Exactly one, because the feature
        // owns exactly one additive migration and a second emitted file would be applied as a second
        // migration by every deployment that globs this directory.
        const installedMigrationDir = path.join(installedLib, 'src', 'migrations');
        expect(
            fs.existsSync(installedMigrationDir),
            `${installedMigrationDir} does not exist, so the migration is emitted nowhere a deployment can ` +
                'register it: the build graph must reach it, which `tsconfig.build.json` does by naming it ' +
                'as a second root rather than by publishing it from the barrel',
        ).toBe(true);
        const emitted = fs
            .readdirSync(installedMigrationDir)
            .filter(name => name.endsWith('.js'))
            .sort();
        expect(emitted).toEqual([`${MIGRATION_TIMESTAMP}-add-reorder-lists.js`]);

        // LOADABLE FROM THERE, which is the difference between a file that exists and a class TypeORM can
        // register: the glob is resolved with Node's own `require`, so an emission that throws on load, or
        // that exports the class under another name, is registered as nothing at all.
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

        // AND PUBLISHED, read out of the packer rather than inferred from `files`. `npm pack --dry-run`
        // reports exactly the file list a consumer would receive, so this is the only assertion that can
        // fail when a manifest pattern stops covering the emission.
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

        // Asserted separately from the value below, because absence is its own failure mode: an omitted
        // range is not a neutral choice but a silent degradation to one informational log line that
        // nothing fails on [packages/core/src/bootstrap.ts:L335-L338]. A suite that only compared the
        // string would report `undefined !== '>=3.3.0'` without saying why that matters.
        expect(declared).toBeDefined();
        expect(declared).toBe(DECLARED_COMPATIBILITY_RANGE);

        // EPIC-001 section 7.9.2: this plugin states a floor rather than copying the caret form five
        // shipped first-party plugins declare, so both halves of that ruling are asserted.
        expect(declared?.startsWith('>=')).toBe(true);
        expect(declared).not.toBe('^3.0.0');

        // The version the platform will test that range against is readable, which is the precondition
        // for the check being meaningful at all. Whether the range is *satisfied* by it is asserted
        // behaviourally by the next test — `bootstrap()` returns an application only when the platform's
        // own `satisfies()` call passed — and its negation by the two tests after that. That is stronger
        // evidence than re-implementing a semver comparison here would be, and it avoids importing a
        // package this one does not declare as a dependency.
        expect(typeof VENDURE_VERSION).toBe('string');
        expect(VENDURE_VERSION.length).toBeGreaterThan(0);
    });

    it('starts a server bootstrapped with the declared compatibility range', async () => {
        // Stated as a precondition of the test rather than assumed: the range in force is the declared
        // one, so a leaked override from an earlier run of the negative test cannot make this pass.
        expect(getCompatibility(ReorderPlugin)).toBe(DECLARED_COMPATIBILITY_RANGE);

        let app: BootstrappedApp | undefined;
        try {
            // The real exported `bootstrap()`, and no second argument — so the compatibility check runs
            // and runs undiluted.
            app = await bootstrap(directBootstrapConfigFor(SATISFIED_RANGE_BOOTSTRAP_PORT));

            expect(app).toBeDefined();

            // "Starts" is asserted as an observation and not as the existence of an object: the
            // underlying HTTP server reports itself listening, and the platform's own health endpoint
            // answers 200 over a real request on the port this test chose.
            expect(app.getHttpServer().listening).toBe(true);
            expect(await probeHealthEndpoint(SATISFIED_RANGE_BOOTSTRAP_PORT)).toBe(200);
        } finally {
            // Closed whether or not the assertions held, so a failure here cannot leave a second server
            // listening and break the rest of this file. Closing also resets the global configuration by
            // itself [packages/core/src/config/config.module.ts]; the explicit reset below is kept
            // because the negative tests never create an application and so never reach that hook. Nested,
            // so the reset is not conditional on the close succeeding: a close that throws is the case where
            // a stale global configuration would otherwise survive into every later test in this file.
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
            // The override is written with the platform's own metadata key, which is the same key the
            // plugin decorator writes [packages/core/src/plugin/vendure-plugin.ts:L170] and the same one
            // `getCompatibility` reads [packages/core/src/plugin/plugin-metadata.ts:L56-L58]. Asserting
            // that the override took effect before bootstrapping is what stops a silently ineffective
            // rewrite from being reported as a passing negative test.
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
            // Restored here as well as in `afterEach`, so the window in which an unsatisfiable range is
            // in force is this test and not the remainder of the file.
            Reflect.defineMetadata(PLUGIN_METADATA.COMPATIBILITY, declared, ReorderPlugin);
            // `app` stays undefined on the path under test; the close is the guard for the failure mode
            // where the platform wrongly returned an application, so that even a failing run leaves no
            // listener behind. `resetConfig()` is required rather than defensive here: `bootstrap()`
            // reaches `preBootstrapConfig` and mutates the global singleton before the check throws
            // [packages/core/src/bootstrap.ts:L194-L197], and no application shutdown hook runs to undo
            // it because no application was created. Nested, so neither the metadata restore above nor a
            // failing close can prevent the reset: leaving the singleton mutated would carry an
            // unsatisfiable range, or a half-built configuration, into the rest of the file.
            try {
                await app?.close();
            } finally {
                resetConfig();
            }
        }

        // Ruling R17, discharged item by item: no application, the exact platform error class, its exact
        // message naming this plugin, the code it carries, and nothing left listening on the port.
        expect(app).toBeUndefined();
        expect(caught).toBeInstanceOf(InternalServerError);
        expect((caught as Error).message).toBe(incompatibilityMessageFor('ReorderPlugin'));
        expect((caught as InternalServerError).extensions.code).toBe(INTERNAL_SERVER_ERROR_CODE);
        expect(await probeHealthEndpoint(UNSATISFIABLE_RANGE_BOOTSTRAP_PORT)).toBe(UNREACHABLE);

        // The override is gone by the end of the test, so the suite is order-independent.
        expect(getCompatibility(ReorderPlugin)).toBe(DECLARED_COMPATIBILITY_RANGE);
    });

    it('refuses to start a server when any plugin declares an unsatisfiable range, naming it', async () => {
        // The same refusal, reached without touching `ReorderPlugin`'s metadata at all: this plugin
        // declared its unsatisfiable range through the decorator when this module was evaluated. It also
        // pins the other half of the platform's message — that the plugin named is the offending one and
        // not merely the first in the array.
        expect(UnsatisfiableCompatibilityTestPlugin.name).toBe('UnsatisfiableCompatibilityTestPlugin');
        expect(getCompatibility(UnsatisfiableCompatibilityTestPlugin)).toBe(
            UNSATISFIABLE_COMPATIBILITY_RANGE,
        );

        let app: BootstrappedApp | undefined;
        let caught: unknown;
        try {
            // `mergeConfig` substitutes an array wholesale, so this configuration registers the throwaway
            // plugin *instead of* `ReorderPlugin` — which is what makes the assertion below evidence
            // about the platform's mechanism rather than about this feature's plugin. The port is shared
            // with the test above because neither path ever reaches `app.listen()`.
            app = await bootstrap(
                directBootstrapConfigFor(UNSATISFIABLE_RANGE_BOOTSTRAP_PORT, [
                    UnsatisfiableCompatibilityTestPlugin,
                ]),
            );
        } catch (e) {
            caught = e;
        } finally {
            // Nested for the same reason as the cases above: the reset must run even when the close throws,
            // because the global configuration was already mutated before the compatibility check refused.
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

        // This plugin's own declaration was never in play and is unchanged.
        expect(getCompatibility(ReorderPlugin)).toBe(DECLARED_COMPATIBILITY_RANGE);
    });

    // ═══════════════════════════════════════════════════════════════════════════════════════════════
    // THE MIGRATION-OWNED DEPLOYMENT, EXECUTED
    //
    // A deployment that provisions this plugin the way a real one does — the consumer's own migrations
    // create the core schema, then this plugin's migration creates its two tables, and the server that
    // serves them creates nothing — has to be shown working rather than described. This is where it can
    // be shown, and the reason it is HERE rather than in the migration suite is a platform fact:
    // `AppModule` imports `PluginModule.forRoot()`, which reads `getConfig().plugins` inside the
    // `@Module({...})` decorator argument, and Node evaluates that once, when
    // `@vendure/core/dist/app.module.js` is first loaded [packages/core/src/app.module.ts:L18-L30,
    // packages/core/src/plugin/plugin.module.ts:L14-L19]. Every test server loads it through the same
    // `await import(...)` [packages/testing/src/test-server.ts:L108-L112], so the plugin module set of a
    // worker is frozen by its first bootstrap. The migration suite's first bootstrap is deliberately
    // plugin-less — that is what leaves the two tables for the migration to create — so a plugin-enabled
    // server booted there merges the SDL and registers neither providers nor resolvers, which was measured:
    // it answers `Cannot return null for non-nullable field Mutation.createReorderList` while
    // `activeCustomer` still resolves. THIS file's first bootstrap registers the plugin, so its resolvers
    // are live, and the schema underneath them can be replaced with the migration's own output.
    //
    // The sequence below is therefore: drop what synchronisation created, apply the migration with
    // synchronization off, and issue the published operations against what the migration built.
    // ═══════════════════════════════════════════════════════════════════════════════════════════════

    describe('a deployment provisioned by the migration alone', () => {
        it(
            'serves the published operations against a schema this migration created',
            async () => {
                const { rawConnection } = server.app.get(TransactionalConnection);
                const engine = rawConnection.options.type;
                const connectionLocal = CONNECTION_LOCAL_ENGINES.indexOf(engine) !== -1;

                // ONE. Remove the tables the harness's own synchronisation created at bootstrap, child before
                // parent so a foreign key cannot be what fails the drop. From here the running server has the
                // core schema and nothing of this plugin's — the state a real deployment is in before this
                // plugin's migration has ever run.
                await withRunner(rawConnection, async runner => {
                    await runner.dropTable(LINE_TABLE, true);
                    await runner.dropTable(LIST_TABLE, true);
                    expect(await runner.hasTable(LINE_TABLE)).toBe(false);
                    expect(await runner.hasTable(LIST_TABLE)).toBe(false);
                });

                // TWO. Apply the migration. On a server engine the lifecycle's own connection addresses the
                // same physical database; on the connection-local engine it cannot — the database is a buffer
                // inside whichever connection holds it — so the running server's database is exported to a file
                // this test owns, the lifecycle is pointed at it with `autoSave`, and the result is loaded back
                // into the running connection afterwards. Both are the same claim, arranged for each engine.
                let sharedDatabase: string | undefined;
                if (connectionLocal) {
                    sharedDatabase = path.join(
                        await fs.mkdtemp(path.join(os.tmpdir(), 'reorder-plugin-provisioned-')),
                        'provisioned.sqlite',
                    );
                    await fs.writeFile(
                        sharedDatabase,
                        Buffer.from(rawConnection.sqljsManager.exportDatabase()),
                    );
                }
                try {
                    const migrationDrivenConfig = {
                        ...harnessConfig,
                        dbConnectionOptions: {
                            ...harnessConfig.dbConnectionOptions,
                            ...(sharedDatabase === undefined
                                ? {}
                                : { location: sharedDatabase, autoSave: true }),
                            // Declared, and the platform force-assigns the same value over it for every
                            // migration entry point [packages/core/src/migrate.ts:L197-L204]. So the schema
                            // builder cannot be what creates these tables, here or anywhere.
                            synchronize: false,
                            // The class rather than a `*.ts` glob, for the reason the migration suite records:
                            // TypeORM resolves a glob with Node's own `require`, which has no TypeScript loader
                            // registered under this runner.
                            migrations: [AddReorderLists1786838400000],
                        } as DataSourceOptions,
                    };

                    await runMigrations(migrationDrivenConfig);
                    // `runMigrations` resets the platform's module-level configuration in its own `finally`
                    // [packages/core/src/migrate.ts:L63], and the server this test goes on to use is still
                    // running against it. Re-establishing it is what keeps that server's request handling
                    // reading this suite's configuration rather than the platform default.
                    await preBootstrapConfig(harnessConfig);

                    if (sharedDatabase !== undefined) {
                        await rawConnection.sqljsManager.loadDatabase(sharedDatabase);
                    }

                    // The migration, and only the migration, put them back.
                    await withRunner(rawConnection, async runner => {
                        expect(await runner.hasTable(LIST_TABLE)).toBe(true);
                        expect(await runner.hasTable(LINE_TABLE)).toBe(true);
                    });

                    // THREE. The published contract, over the running server's own Shop API, against that
                    // schema. Nothing here can create or alter a table: the server synchronised once at
                    // bootstrap, before the drop, and never again.
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

                    // The child table, its cascading foreign keys and the stored counter.
                    const variantId = await firstProductVariantId(rawConnection);
                    const { addItemToReorderList } = await shopClient.query<
                        AddItemToReorderListMutation,
                        AddItemToReorderListMutationVariables
                    >(ADD_ITEM_TO_REORDER_LIST, {
                        input: { reorderListId: list.id, productVariantId: variantId, quantity: 3 },
                    });
                    expect(addItemToReorderList.__typename).toBe('ReorderList');
                    expect((addItemToReorderList as ReorderListSuccessShape).lineCount).toBe(1);

                    // And the read path, which exercises the named ownership index, the nested page and the
                    // variant relation.
                    const { activeCustomerReorderList } = await shopClient.query<
                        GetActiveCustomerReorderListQuery,
                        GetActiveCustomerReorderListQueryVariables
                    >(GET_ACTIVE_CUSTOMER_REORDER_LIST, { id: list.id });
                    expect(activeCustomerReorderList).not.toBeNull();
                    const read = activeCustomerReorderList as NonNullable<typeof activeCustomerReorderList>;
                    expect(read.lineCount).toBe(1);
                    expect(read.lines.totalItems).toBe(1);
                    expect(read.lines.items[0].quantity).toBe(3);
                    expect(read.lines.items[0].productVariantId).toBe(variantId);
                } finally {
                    if (sharedDatabase !== undefined) {
                        // The test's own file, outside the repository, removed however the case ends.
                        await fs.remove(path.dirname(sharedDatabase));
                    }
                }
            },
            TEST_SETUP_TIMEOUT_MS,
        );
    });
});
