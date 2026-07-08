/**
 * @file Performance benchmark for the {@link SellerScoringPlugin} — the mandated
 * performance deliverable for the Seller Performance Scoring feature (AAP §0.2.6,
 * §0.9.3).
 *
 * It boots a real Vendure server via `@vendure/testing` against an in-memory
 * `sqljs` database and, using the repo-standard `tinybench` harness, reports and
 * asserts three things:
 *
 *  1. Absolute p50/p95 resolver latency for the NEW Admin API `sellerScore` query.
 *  2. Absolute p50/p95 resolver latency for the NEW Admin API `flaggedSellers` query.
 *  3. Before/after p95 latency for the EXISTING core `sellers` admin query, proving
 *     the plugin introduces no regression greater than 5% (the behaviour-preservation
 *     guarantee of AAP §0.2.4 / §0.9.2).
 *
 * ## Architecture: one in-process server + one child process
 *
 * The before/after comparison needs a "before" (no plugin) and an "after" (with
 * plugin) measurement of the `sellers` query, on the SAME machine in the SAME run, so
 * the ratio `after.p95 / before.p95` is machine-independent even though absolute
 * latency is not.
 *
 * A subtle framework constraint dictates the design: `@nestjs/graphql` maintains a
 * PROCESS-LIFETIME global resolver-metadata registry. Once the plugin's Admin
 * resolvers (`sellerScore` / `flaggedSellers`) are registered by booting a with-plugin
 * server, that registration persists for the life of the Node process and is not
 * cleared by `server.destroy()`. Consequently two Vendure servers with different
 * plugin sets cannot coexist — nor even boot sequentially — in one process/worker:
 * a no-plugin server booted after a with-plugin one fails at bootstrap with
 * `"Query.sellerScore defined in resolvers, but not in schema"`, and a with-plugin
 * server booted after a no-plugin one boots but leaves its plugin resolvers unbound
 * (they return `null`). The only isolation boundary that yields a fresh registry is a
 * separate OS process.
 *
 * Therefore this suite's own process boots ONLY the with-plugin server (first, and
 * cleanly) so the new `sellerScore` / `flaggedSellers` resolvers work, and measures
 * the "after" `sellers` latency there. The plugin-free "before" `sellers` measurement
 * is delegated to a child process — {@link ./fixtures/baseline-sellers-runner} — which
 * is spawned via `node -r ts-node/register`, boots a no-plugin server in its own
 * fresh registry, measures the `sellers` query, and prints a single machine-readable
 * JSON line that this suite parses. See that file's header for the full rationale.
 *
 * ## Seeding
 *
 * Per the AAP the with-plugin server is seeded with 500 sellers and 50,000 orders
 * (plus directly-inserted `SellerScore` rows so the read resolvers return realistic
 * data). All heavy seeding happens once in `beforeAll` (budget = `TEST_SETUP_TIMEOUT_MS`,
 * 120s) via batched bulk inserts in the fixtures — the measured `it`s only run fast
 * query loops. The child baseline seeds the same 500 sellers (orders do not affect the
 * `sellers` query, so it seeds none) for a fair A/B comparison.
 *
 * The suite is gated with `describe.skipIf(NODE_ENV === 'development')` to mirror the
 * reference benchmark (`packages/core/e2e/default-search-plugin.bench.ts`); it runs
 * deliberately via `bun run bench` (which does not set `NODE_ENV=development`).
 *
 * It only ever READS through the public Admin API and seeds through the fixtures
 * (direct DB inserts of new rows) — no existing core behaviour, GraphQL operation,
 * or table is modified.
 *
 * @since 3.8.0
 * @docsCategory core plugins/SellerScoringPlugin
 */
import { ID, mergeConfig, Order, TransactionalConnection } from '@vendure/core';
import { createTestEnvironment, registerInitializer, SqljsInitializer } from '@vendure/testing';
import { execFileSync } from 'child_process';
import fs from 'fs';
import gql from 'graphql-tag';
import path from 'path';
import { Bench } from 'tinybench';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { initialData } from '../../../e2e-common/e2e-initial-data';
import { TEST_SETUP_TIMEOUT_MS, testConfig } from '../../../e2e-common/test-config';
import { SellerScoringPlugin } from '../src/seller-scoring.plugin';

import { seedPerformanceData } from './fixtures/seed-test-data';

/** AAP-mandated seed volume: number of sellers to create on each server. */
const SELLER_COUNT = 500;
/** AAP-mandated seed volume: number of orders to bulk-insert on the with-plugin server. */
const ORDER_COUNT = 50_000;
/** Flagging threshold the plugin is configured with (scores below this are flagged). */
const FLAGGING_THRESHOLD = 70;
/** Fulfillment SLA (hours) the plugin is configured with. */
const SLA_HOURS = 48;
/** Maximum allowed p95 regression ratio for the existing `sellers` query (5%). */
const MAX_REGRESSION = 1.05;
/**
 * Explicit, pinned API ports. `WITH_PLUGIN_PORT` is used by the in-process "after"
 * server; `BASELINE_PORT` is handed to the child-process "before" server (which runs
 * in its own OS process — see the file header). Pinning both (rather than relying on
 * `testConfig()`'s computed `basePort + fileIndex`) guarantees the two servers can
 * never collide on a port, regardless of directory-listing order.
 */
const WITH_PLUGIN_PORT = 3250;
const BASELINE_PORT = 3252;
/**
 * Number of measured iterations per resolver benchmark. A generous count (with
 * warmup) keeps the p95 meaningful; raise it if CI proves noisy — never relax the
 * 5% regression bound instead.
 */
const MEASURE_ITERATIONS = 200;

/**
 * Distinct on-disk `sqljs` cache directories. `WITH_PLUGIN_DATA_DIR` backs the
 * in-process with-plugin server (populated with the plugin's additive `seller_score`
 * / `seller_score_snapshot` tables); `BASELINE_DATA_DIR` is passed to the child
 * baseline process (booted without the plugin, so it deliberately has neither table).
 * Both live under this suite's own `e2e/__data__` (runtime-generated, not committed).
 */
const WITH_PLUGIN_DATA_DIR = path.join(__dirname, '__data__', 'with-plugin');
const BASELINE_DATA_DIR = path.join(__dirname, '__data__', 'baseline');

/**
 * Absolute path to the child-process "before" baseline runner. It is executed as a
 * separate OS process (never imported — importing it would trigger its top-level
 * `main()`), so the no-plugin server boots in a fresh `@nestjs/graphql` registry.
 */
const BASELINE_RUNNER_PATH = path.join(__dirname, 'fixtures', 'baseline-sellers-runner.ts');

/**
 * Sentinel that prefixes the single JSON result line the child runner prints on
 * success. Kept in sync with `RESULT_PREFIX` in `baseline-sellers-runner.ts` (it is
 * duplicated rather than imported to avoid executing the runner in this process).
 */
const BASELINE_RESULT_PREFIX = '__BASELINE_RESULT__';

/**
 * The "after" environment — WITH the {@link SellerScoringPlugin} installed. It is the
 * ONLY Vendure server booted in this process; its `sqljs` cache (assigned in
 * `beforeAll`) receives the plugin's additive tables.
 */
const withPluginEnv = createTestEnvironment(
    mergeConfig(testConfig(), {
        apiOptions: { port: WITH_PLUGIN_PORT },
        plugins: [SellerScoringPlugin.init({ slaHours: SLA_HOURS, flaggingThreshold: FLAGGING_THRESHOLD })],
    }),
);

/**
 * The seller ids seeded on the with-plugin server, stashed in `beforeAll` from
 * {@link seedPerformanceData}'s return value so the `sellerScore` benchmark can
 * target a seller that is known to have a persisted `SellerScore` row.
 */
let withPluginSellerIds: ID[] = [];

/**
 * The total number of `Order` rows seeded on the with-plugin server, captured in
 * `beforeAll` via a direct repository count so the AAP-mandated 50,000-order volume
 * can be asserted exactly (a direct count avoids the channel/state filtering a
 * GraphQL `orders` query would apply).
 */
let withPluginOrderCount = 0;

/**
 * CPU / margin normalization factors, computed once by the fibonacci calibration
 * test (see below) and reported for parity with the reference benchmark. The
 * regression assertion itself uses the machine-independent before/after ratio, so
 * these factors are informational only.
 */
let marginFactor = 1;
let cpuFactor = 1;

/**
 * Naive recursive fibonacci used purely as a fixed-cost CPU probe to calibrate
 * `cpuFactor` / `marginFactor` (identical to the reference benchmark).
 */
const fibonacci = (i: number): number => (i <= 1 ? i : fibonacci(i - 1) + fibonacci(i - 2));

beforeAll(async () => {
    // Pre-create the with-plugin cache directory (idempotent, recursive). The bundled
    // SqljsInitializer creates its leaf cache dir with a NON-recursive `mkdir`, so the
    // parent `__data__` directory must already exist for the nested
    // `__data__/with-plugin` layout; creating it up-front here makes the suite work
    // from a clean checkout with no committed `__data__`. (The child baseline process
    // creates its own `BASELINE_DATA_DIR` recursively.)
    fs.mkdirSync(WITH_PLUGIN_DATA_DIR, { recursive: true });

    // Bootstrap the WITH-plugin server — the ONLY server booted in this process, and
    // booted cleanly (no prior no-plugin bootstrap to pollute the global
    // @nestjs/graphql resolver registry), so its `sellerScore` / `flaggedSellers`
    // resolvers bind correctly. Because the plugin is loaded, the first populate()
    // creates the additive `seller_score` / `seller_score_snapshot` tables in the
    // cache.
    registerInitializer('sqljs', new SqljsInitializer(WITH_PLUGIN_DATA_DIR));
    await withPluginEnv.server.init({
        initialData,
        productsCsvPath: path.join(__dirname, 'fixtures/e2e-products-empty.csv'),
        customerCount: 1,
    });
    await withPluginEnv.adminClient.asSuperAdmin();
    // Seed 500 sellers + 50,000 orders + one directly-inserted SellerScore (plus
    // history snapshots) per seller, so the read resolvers return realistic data
    // without running hundreds of full recalculations in the setup budget.
    const seeded = await seedPerformanceData(withPluginEnv.server, {
        sellerCount: SELLER_COUNT,
        orderCount: ORDER_COUNT,
        flaggedFraction: 0.2,
        seedScores: true,
        flaggingThreshold: FLAGGING_THRESHOLD,
    });
    withPluginSellerIds = seeded.sellerIds;

    // Capture the exact seeded order volume directly from the DB so the AAP-mandated
    // 50,000-order requirement can be asserted (see the seed-volume `it`). A raw
    // repository count is exact and cheap, and avoids the channel/state filtering that
    // a GraphQL `orders` query would impose.
    withPluginOrderCount = await withPluginEnv.server.app
        .get(TransactionalConnection)
        .rawConnection.getRepository(Order)
        .count();
}, TEST_SETUP_TIMEOUT_MS);

afterAll(async () => {
    // Destroy the with-plugin server so its port does not leak after the run. The
    // child baseline process tears itself down (and exits) before this point.
    await withPluginEnv.server.destroy();
});

/**
 * Computes the nearest-rank percentile `p` (0–100) of `samples`. tinybench exposes
 * raw per-iteration `samples` but no p50/p95, so we derive them here. Returns `NaN`
 * for an empty/undefined sample set.
 */
function percentile(samples: number[] | undefined, p: number): number {
    if (!samples || samples.length === 0) {
        return NaN;
    }
    const sorted = [...samples].sort((a, b) => a - b);
    const rank = Math.ceil((p / 100) * sorted.length);
    return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

/** Summary latency statistics derived from a single benchmarked task. */
interface LatencyStats {
    /** Median (50th percentile) per-iteration latency, in milliseconds. */
    p50: number;
    /** 95th percentile per-iteration latency, in milliseconds. */
    p95: number;
    /** Mean per-iteration latency, in milliseconds. */
    mean: number;
    /** Number of measured iterations (samples) collected. */
    iterations: number;
}

/**
 * Runs `fn` under a dedicated tinybench `Bench` for a fixed number of iterations
 * (no time bound, small warmup) and returns the derived {@link LatencyStats}. The
 * per-iteration `samples` reported by tinybench are in milliseconds (v2.x).
 */
async function measure(
    name: string,
    fn: () => Promise<unknown>,
    iterations: number = MEASURE_ITERATIONS,
): Promise<LatencyStats> {
    const bench = new Bench({ warmupTime: 0, warmupIterations: 5, time: 0, iterations });
    bench.add(name, fn);
    const [task] = await bench.run();
    const samples = task.result?.samples;
    return {
        p50: percentile(samples, 50),
        p95: percentile(samples, 95),
        mean: task.result?.mean ?? NaN,
        iterations: samples?.length ?? 0,
    };
}

/**
 * Measures the "before" (no-plugin) `sellers` query latency in a CHILD PROCESS and
 * returns its {@link LatencyStats}.
 *
 * A no-plugin Vendure server cannot be booted in this process once the with-plugin
 * server has registered its resolvers into `@nestjs/graphql`'s process-lifetime global
 * registry (see the file header), so the baseline is delegated to
 * {@link ./fixtures/baseline-sellers-runner}. It is executed via `node -r
 * ts-node/register` in transpile-only CommonJS mode — which elides the type-only
 * imports its dependencies use (`ID`, etc.), exactly as this suite's own SWC transform
 * does; running it under `bun` fails because bun's ESM loader rejects those type-only
 * re-exports from `@vendure/core`'s CommonJS bundle. `PACKAGE` is forwarded because
 * `testConfig()` requires it. The runner boots a plugin-free server (fresh registry),
 * seeds the same seller count, measures the `sellers` query, and prints a single
 * `__BASELINE_RESULT__ { ... }` line which we parse here. Both processes run in the
 * same wall-clock run on the same machine, so the `after/before` ratio stays valid.
 */
function measureBaselineSellers(): LatencyStats {
    let stdout: string;
    try {
        stdout = execFileSync('node', ['-r', 'ts-node/register', BASELINE_RUNNER_PATH], {
            cwd: path.join(__dirname, '..'),
            encoding: 'utf-8',
            timeout: 150_000,
            maxBuffer: 64 * 1024 * 1024,
            env: {
                ...process.env,
                PACKAGE: 'seller-scoring-plugin',
                TS_NODE_TRANSPILE_ONLY: '1',
                TS_NODE_COMPILER_OPTIONS: '{"module":"commonjs","moduleResolution":"node"}',
                BASELINE_PORT: String(BASELINE_PORT),
                BASELINE_DATA_DIR,
                BASELINE_SELLER_COUNT: String(SELLER_COUNT),
                BASELINE_ITERATIONS: String(MEASURE_ITERATIONS),
                BASELINE_TAKE: '50',
            },
        });
    } catch (e) {
        const err = e as { stdout?: string; stderr?: string; message?: string };
        throw new Error(
            `Baseline runner child process failed: ${err.message ?? 'unknown error'}\n` +
                `stdout:\n${err.stdout ?? ''}\nstderr:\n${err.stderr ?? ''}`,
        );
    }
    const line = stdout.split('\n').find(l => l.startsWith(BASELINE_RESULT_PREFIX));
    if (!line) {
        throw new Error(`Baseline runner produced no '${BASELINE_RESULT_PREFIX}' line. stdout:\n${stdout}`);
    }
    return JSON.parse(line.slice(BASELINE_RESULT_PREFIX.length).trim()) as LatencyStats;
}

/**
 * Returns the first seeded seller id from the with-plugin server (stashed in
 * `beforeAll`). That seller is guaranteed to have a persisted `SellerScore` row
 * (`seedScores: true` inserts one per seeded seller), so it exercises the fully
 * populated `sellerScore` read path.
 */
function firstSellerId(): ID {
    const sellerId = withPluginSellerIds[0];
    if (sellerId === undefined) {
        throw new Error(
            'No seeded seller ids are available; seedPerformanceData did not populate withPluginSellerIds',
        );
    }
    return sellerId;
}

// --- Inline GraphQL documents (no codegen for this self-contained benchmark) ---

/** NEW Admin API query: the current score for a single seller. */
const GET_SELLER_SCORE = gql`
    query GetSellerScore($sellerId: ID!) {
        sellerScore(sellerId: $sellerId) {
            id
            sellerId
            score
            flagged
        }
    }
`;

/** NEW Admin API query: only sellers whose current score is flagged. */
const GET_FLAGGED_SELLERS = gql`
    query GetFlaggedSellers {
        flaggedSellers {
            id
            sellerId
            score
            flagged
        }
    }
`;

/**
 * EXISTING core Admin API query — exercised UNCHANGED to prove the plugin does not
 * regress it. The selection is kept minimal to focus the measurement on the
 * resolver rather than serialization.
 */
const GET_SELLERS = gql`
    query GetSellers($options: SellerListOptions) {
        sellers(options: $options) {
            items {
                id
                name
            }
            totalItems
        }
    }
`;

// The suite is skipped during local `development` runs and executed deliberately
// via `bun run bench` (which does not set NODE_ENV=development), mirroring the
// reference benchmark. Each measured `it` gets a generous per-test timeout because
// the bench loops (and the fibonacci calibration) exceed the default 15s bench
// testTimeout.
const isDevelopment = process.env.NODE_ENV === 'development';

describe.skipIf(isDevelopment)('SellerScoringPlugin - benchmark', () => {
    it('defines benchmark cpu and margin factor', async () => {
        const bench = new Bench({ warmupTime: 0, warmupIterations: 1, time: 0, iterations: 10 });

        bench.add('measure time to calculate fibonacci', () => {
            fibonacci(41); // If this task took 1000 ms the cpuFactor would be 1.
        });

        const tasks = await bench.run();

        tasks.forEach(task => {
            expect(task.result?.rme).toBeDefined();
            expect(task.result?.mean).toBeDefined();
            if (task.result?.rme && task.result?.mean) {
                marginFactor = 1 + task.result.rme / 100;
                cpuFactor = 1000 / task.result.mean;
            }
        });
        // eslint-disable-next-line no-console
        console.log(
            `[bench] calibration  cpuFactor=${cpuFactor.toFixed(3)}  marginFactor=${marginFactor.toFixed(3)}`,
        );
    }, 120_000);

    it('seeded the AAP-mandated 500 sellers and 50,000 orders', async () => {
        // Seller volume via the public `sellers` query (take: 0 → totalItems only).
        const { sellers } = await withPluginEnv.adminClient.query<{
            sellers: { items: Array<{ id: string; name: string }>; totalItems: number };
        }>(GET_SELLERS, { options: { take: 0 } });
        expect(sellers.totalItems).toBeGreaterThanOrEqual(SELLER_COUNT);
        // Order volume via the exact repository count captured in `beforeAll`.
        expect(withPluginOrderCount).toBeGreaterThanOrEqual(ORDER_COUNT);
        // eslint-disable-next-line no-console
        console.log(`[bench] seeded volume  sellers=${sellers.totalItems}  orders=${withPluginOrderCount}`);
    }, 120_000);

    it('reports p50/p95 latency for sellerScore', async () => {
        const sellerId = firstSellerId();

        // Correctness probe: fail the bench (rather than silently benchmark an
        // error path) if the resolver does not return the seeded score.
        const probe = await withPluginEnv.adminClient.query<{
            sellerScore: { id: string; sellerId: string; score: number | null; flagged: boolean } | null;
        }>(GET_SELLER_SCORE, { sellerId });
        expect(probe.sellerScore).not.toBeNull();

        const stats = await measure('sellerScore', async () => {
            await withPluginEnv.adminClient.query(GET_SELLER_SCORE, { sellerId });
        });

        // eslint-disable-next-line no-console
        console.log(
            `[bench] sellerScore     p50=${stats.p50.toFixed(3)}ms  p95=${stats.p95.toFixed(
                3,
            )}ms  mean=${stats.mean.toFixed(3)}ms  (n=${stats.iterations})`,
        );
        expect(stats.p50).toBeGreaterThan(0);
        expect(Number.isFinite(stats.p95)).toBe(true);
    }, 120_000);

    it('reports p50/p95 latency for flaggedSellers', async () => {
        // Correctness probe: with ~20% of 500 sellers flagged, the query must
        // return a populated list.
        const probe = await withPluginEnv.adminClient.query<{
            flaggedSellers: Array<{ id: string; sellerId: string; score: number | null; flagged: boolean }>;
        }>(GET_FLAGGED_SELLERS);
        expect(probe.flaggedSellers.length).toBeGreaterThan(0);

        const stats = await measure('flaggedSellers', async () => {
            await withPluginEnv.adminClient.query(GET_FLAGGED_SELLERS);
        });

        // eslint-disable-next-line no-console
        console.log(
            `[bench] flaggedSellers  p50=${stats.p50.toFixed(3)}ms  p95=${stats.p95.toFixed(
                3,
            )}ms  mean=${stats.mean.toFixed(3)}ms  (n=${stats.iterations})`,
        );
        expect(Number.isFinite(stats.p50)).toBe(true);
        expect(Number.isFinite(stats.p95)).toBe(true);
    }, 120_000);

    it('does not regress the existing sellers query p95 by more than 5%', async () => {
        const options = { options: { take: 50 } };

        // "after" — measured in this process against the with-plugin server.
        const after = await measure('sellers(after/with-plugin)', async () => {
            await withPluginEnv.adminClient.query(GET_SELLERS, options);
        });
        // "before" — measured by a plugin-free server in a dedicated child process
        // (see measureBaselineSellers / the file header for why this cannot run
        // in-process alongside the with-plugin server).
        const before = measureBaselineSellers();

        // The child seeds the same seller count, so the comparison is apples-to-apples.
        expect(before.iterations).toBeGreaterThan(0);

        const ratio = after.p95 / before.p95;
        // eslint-disable-next-line no-console
        console.log(
            `[bench] sellers p95  before=${before.p95.toFixed(3)}ms  after=${after.p95.toFixed(
                3,
            )}ms  ratio=${ratio.toFixed(3)}  (max=${MAX_REGRESSION})`,
        );
        expect(after.p95).toBeLessThanOrEqual(before.p95 * MAX_REGRESSION);
    }, 180_000);
});
