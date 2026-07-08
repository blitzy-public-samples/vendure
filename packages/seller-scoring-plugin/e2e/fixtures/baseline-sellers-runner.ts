/**
 * @file Standalone "before" (no-plugin) baseline runner for the Seller Scoring
 * performance benchmark.
 *
 * ## Why this exists (a hard framework constraint)
 *
 * The benchmark (`../seller-scoring.bench.ts`) must report **before/after** p95
 * latency for the existing core `sellers` admin query to prove the
 * {@link SellerScoringPlugin} introduces no regression greater than 5% (AAP §0.2.4 /
 * §0.9.2). "Before" means a Vendure server WITHOUT the plugin; "after" means one WITH
 * it.
 *
 * `@nestjs/graphql` maintains a **process-lifetime global resolver-metadata registry**.
 * Once the plugin's Admin resolvers (`sellerScore` / `flaggedSellers`) are registered
 * by booting a with-plugin server, that registration persists for the life of the
 * Node process and is NOT cleared by `server.destroy()`. As a result, two Vendure
 * servers with different plugin sets cannot coexist — nor even boot sequentially — in
 * the same process/vitest worker:
 *
 *  - no-plugin server booted after a with-plugin one fails at bootstrap with
 *    `"Query.sellerScore defined in resolvers, but not in schema"`;
 *  - with-plugin server booted after a no-plugin one boots, but its plugin resolvers
 *    are left unbound and return `null`.
 *
 * The only isolation boundary that yields a fresh registry is a **separate OS
 * process**. This runner therefore boots the plugin-free "before" server in its own
 * process (spawned via `bun` by the benchmark), measures the `sellers` query, prints a
 * single machine-readable JSON line, and exits. The benchmark's own process keeps the
 * with-plugin server (booted first and cleanly) so the new `sellerScore` /
 * `flaggedSellers` resolvers work there. Both processes run in the same wall-clock run
 * on the same machine, so the `after.p95 / before.p95` ratio remains machine-
 * independent and the ≤5% assertion is valid.
 *
 * ## Contract
 *
 * Configured entirely through environment variables (all optional, with defaults):
 *
 *  - `BASELINE_PORT`         — API port for the no-plugin server (default `3252`).
 *  - `BASELINE_DATA_DIR`     — sqljs cache directory (default `<e2e>/__data__/baseline`).
 *  - `BASELINE_SELLER_COUNT` — sellers to seed (default `500`).
 *  - `BASELINE_ITERATIONS`   — measured `sellers` iterations (default `200`).
 *  - `BASELINE_TAKE`         — `SellerListOptions.take` used per query (default `50`).
 *
 * On success it prints exactly one line beginning with the {@link RESULT_PREFIX}
 * sentinel followed by JSON `{ p50, p95, mean, iterations }` (latencies in ms). On
 * failure it prints a line beginning with {@link ERROR_PREFIX} and exits non-zero.
 *
 * It is NEVER imported by the benchmark; it is only ever executed as a child process,
 * so it invokes {@link main} unconditionally at module load.
 *
 * @since 3.8.0
 * @docsCategory core plugins/SellerScoringPlugin
 */
import { mergeConfig } from '@vendure/core';
import { createTestEnvironment, registerInitializer, SqljsInitializer } from '@vendure/testing';
import fs from 'fs';
import gql from 'graphql-tag';
import path from 'path';
import { Bench } from 'tinybench';

import { initialData } from '../../../../e2e-common/e2e-initial-data';
import { testConfig } from '../../../../e2e-common/test-config';

import { seedPerformanceData } from './seed-test-data';

/** Sentinel prefix for the single JSON result line printed on success. */
export const RESULT_PREFIX = '__BASELINE_RESULT__';
/** Sentinel prefix for the single error line printed on failure. */
export const ERROR_PREFIX = '__BASELINE_ERROR__';

/** The `sellers` admin query, kept field-identical to the benchmark's `GET_SELLERS`. */
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

/**
 * Nearest-rank percentile over an array of per-iteration latency samples.
 * Duplicated (rather than imported) so this runner stays fully self-contained for
 * execution as a standalone child process.
 */
function percentile(samples: number[] | undefined, p: number): number {
    if (!samples || samples.length === 0) {
        return NaN;
    }
    const sorted = [...samples].sort((a, b) => a - b);
    const rank = Math.ceil((p / 100) * sorted.length);
    return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

/**
 * Boots a no-plugin Vendure test server, seeds sellers, measures the `sellers` query
 * latency, prints the JSON result line, and exits.
 */
async function main(): Promise<void> {
    const port = Number(process.env.BASELINE_PORT ?? 3252);
    const dataDir = process.env.BASELINE_DATA_DIR ?? path.join(__dirname, '..', '__data__', 'baseline');
    const sellerCount = Number(process.env.BASELINE_SELLER_COUNT ?? 500);
    const iterations = Number(process.env.BASELINE_ITERATIONS ?? 200);
    const take = Number(process.env.BASELINE_TAKE ?? 50);

    fs.mkdirSync(dataDir, { recursive: true });
    registerInitializer('sqljs', new SqljsInitializer(dataDir));

    // NO plugins — this is the plugin-free "before" server.
    const env = createTestEnvironment(mergeConfig(testConfig(), { apiOptions: { port } }));

    await env.server.init({
        initialData,
        productsCsvPath: path.join(__dirname, 'e2e-products-empty.csv'),
        customerCount: 1,
    });
    await env.adminClient.asSuperAdmin();
    await seedPerformanceData(env.server, { sellerCount, orderCount: 0, seedScores: false });

    const bench = new Bench({ warmupTime: 0, warmupIterations: 5, time: 0, iterations });
    bench.add('sellers(before/no-plugin)', async () => {
        await env.adminClient.query(GET_SELLERS, { options: { take } });
    });
    const [task] = await bench.run();
    const samples = task.result?.samples;

    const result = {
        p50: percentile(samples, 50),
        p95: percentile(samples, 95),
        mean: task.result?.mean ?? NaN,
        iterations: samples?.length ?? 0,
    };

    await env.server.destroy();

    // Single machine-readable line the benchmark parses out of stdout.
    // eslint-disable-next-line no-console
    console.log(`${RESULT_PREFIX} ${JSON.stringify(result)}`);
}

main().then(
    () => {
        process.exit(0);
    },
    (err: unknown) => {
        // eslint-disable-next-line no-console
        console.error(`${ERROR_PREFIX} ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
        process.exit(1);
    },
);
