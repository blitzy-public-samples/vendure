import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
    plugins: [
        // SWC required to support decorators used in test plugins
        // See https://github.com/vitest-dev/vitest/issues/708#issuecomment-1118628479
        // Vite plugin
        swc.vite({
            jsc: {
                transform: {
                    // See https://github.com/vendurehq/vendure/issues/2099
                    useDefineForClassFields: false,
                },
            },
        }),
    ],
    test: {
        // The unit run collects the co-located specs under `src/` and, deliberately, the specs of the
        // e2e FIXTURES — and nothing else under `e2e/`.
        //
        // The end-to-end SUITES stay out, and the exclusion below states that structurally rather than
        // leaving it to punctuation. Vitest's pattern happens to miss the `*.e2e-spec.ts` suffix already,
        // because `*.spec.ts` requires a literal `.spec.` and this repository's e2e files spell it
        // `-spec.`; but resting the boundary on one character would be fragile, and those suites must
        // only ever run under `e2e-common/vitest.config.mts`, which supplies the long setup timeout and
        // the database initializers a server needs. `bun run test` starts no database.
        //
        // The fixtures' own specs are a different case, and admitting them is what makes them exist at
        // all. `e2e/fixtures/query-capture.ts` is a pure module — it imports `typeorm` types only, reaches
        // no database, starts no server and holds the statement parsers a suite's ownership and
        // statement-count claims are decided by. Left out of both runners it would have tests that no
        // command executes, which protects nothing against regression; the e2e runner cannot collect them
        // because it matches `*.e2e-spec.ts` only, so this is the one run they can belong to. A fixture
        // spec that ever needed a database would belong in a suite instead, and its absence from here is
        // therefore also a statement about what a fixture may be.
        include: ['src/**/*.spec.ts', 'e2e/fixtures/**/*.spec.ts'],
        exclude: ['e2e/**/*.e2e-spec.ts', 'e2e/__data__/**', 'lib/**', 'node_modules/**'],
    },
});
