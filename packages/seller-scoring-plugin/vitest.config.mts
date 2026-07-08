import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/**
 * Package-level Vitest configuration for the Seller Scoring plugin.
 *
 * This config is used by the `test` npm script
 * (`vitest --config vitest.config.mts --run`) and is responsible for two things:
 *
 *  1. Running the co-located unit specs (`src/**\/*.spec.ts`) with SWC-based
 *     decorator support, mirroring `packages/email-plugin/vitest.config.mts`.
 *  2. Enforcing the mandatory >= 80% line-coverage floor for the plugin's
 *     business logic (a hard requirement of this feature).
 *
 * The e2e specs (`e2e/**\/*.e2e-spec.ts`) and the performance benchmark
 * (`e2e/**\/*.bench.ts`) are intentionally NOT run by this config; they are run
 * separately by the `e2e` and `bench` npm scripts, which point at the shared
 * `../../e2e-common/vitest.config.mts` and `../../e2e-common/vitest.config.bench.ts`
 * configs respectively.
 */
export default defineConfig({
    test: {
        // Run ONLY the co-located unit specs here. Scoping the include to unit
        // specs keeps `vitest --run` from attempting to boot the full e2e Vendure
        // test server (which the e2e/bench configs own instead).
        include: ['src/**/*.spec.ts'],
        coverage: {
            // Enabled in-config (rather than requiring a `--coverage` CLI flag) so
            // the coverage floor is always enforced by the plain `test` script.
            enabled: true,
            // Use the v8 coverage provider (@vitest/coverage-v8), which is declared
            // as a devDependency of this package and resolved via the root lockfile.
            provider: 'v8',
            reporter: ['text', 'text-summary', 'html', 'json-summary'],
            // Measure coverage over the plugin's unit-tested business logic: the
            // scoring service (the bulk of the logic), the persisted entities, and
            // the runtime constants they consume.
            //
            // The thin delegation layers — the plugin bootstrap
            // (`src/seller-scoring.plugin.ts`), the EventBus subscriber
            // (`src/event-subscribers/**`), the GraphQL resolvers (`src/api/*.resolver.ts`)
            // and the `gql` schema string (`src/api/api-extensions.ts`) — are
            // exercised by the e2e suite, which runs under a separate config and is
            // therefore not counted here. Including them in this UNIT coverage gate
            // would dilute it with code it does not exercise and produce a false
            // failure, so they are deliberately left out of `include`.
            //
            // Type-only modules (`src/types.ts`, the generated `src/generated-admin-types.ts`)
            // and the generated migration (`src/migrations/**`) are also omitted: their
            // type declarations are erased at compile time, leaving no executable lines
            // to cover, so counting them would only add a phantom 0% penalty to a
            // line-coverage gate. This does NOT relax the 80% bar for real logic.
            include: ['src/services/**', 'src/entities/**', 'src/constants.ts'],
            // Never count the spec files themselves — `src/services/**` would
            // otherwise match `src/services/*.spec.ts`.
            exclude: ['src/**/*.spec.ts'],
            // HARD REQUIREMENT (see the feature's coverage constraint): fail the run
            // if aggregate line coverage of the plugin's business logic drops below
            // 80%. This threshold must not be lowered — raise coverage instead.
            thresholds: {
                lines: 80,
            },
        },
    },
    plugins: [
        // SWC is required so Vitest can transform the TypeScript decorators
        // (`@VendurePlugin`, `@Entity`, `@Column`, `@Index`, `@Resolver`, `@Query`,
        // `@Mutation`, `@Injectable`, etc.) used throughout `src/`. This mirrors
        // `packages/email-plugin/vitest.config.mts`.
        // See https://github.com/vitest-dev/vitest/issues/708#issuecomment-1118628479
        swc.vite({
            jsc: {
                transform: {
                    // Vendure entities (extending VendureEntity) populate their columns from
                    // the constructor's `DeepPartial` input via base-class assignment. That
                    // pattern only survives transpilation when class fields use assignment —
                    // not "define" — semantics, matching the project's tsconfig (target es2017,
                    // useDefineForClassFields defaults to false). SWC otherwise defaults to
                    // define semantics, which re-initialises the declared columns to `undefined`
                    // after the base constructor sets them (e.g. `new SellerScore({ score })`
                    // would yield `score === undefined`). Every other entity-transpiling Vitest
                    // config in the repo sets this for the same reason.
                    // See https://github.com/vendurehq/vendure/issues/2099
                    useDefineForClassFields: false,
                },
            },
        }),
    ],
});
