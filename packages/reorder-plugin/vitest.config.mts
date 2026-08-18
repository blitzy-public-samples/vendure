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
        // The unit run is confined to the co-located specs under `src/`, and the e2e tree is excluded
        // outright. Vitest's default pattern happens to miss the `*.e2e-spec.ts` suffix already,
        // because it requires a literal `.spec.` and this repository's e2e files spell it `-spec.`
        // (`e2e-common/vitest.config.mts` is what collects those, under its own timeouts and database
        // initializers). Relying on that would leave the separation resting on a punctuation detail:
        // any `*.spec.ts` placed anywhere under `e2e/` — a fixture's own spec, for instance — would
        // join the unit run and try to reach a database that `bun run test` never starts. Naming the
        // boundary here makes it structural instead of incidental.
        include: ['src/**/*.spec.ts'],
        exclude: ['e2e/**', 'lib/**', 'node_modules/**'],
    },
});
