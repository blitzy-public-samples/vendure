import path from 'path';
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/**
 * Package-level Vitest configuration for the Seller Scoring plugin.
 *
 * This config is used by the `test` npm script
 * (`vitest --config vitest.config.mts --run`) and is responsible for two things:
 *
 *  1. Running the plugin's unit and component specs across two isolated projects:
 *       - `unit`      — the co-located backend specs (`src/**\/*.spec.ts`), transformed
 *                       with SWC so the TypeScript decorators used throughout `src/`
 *                       (`@VendurePlugin`, `@Entity`, `@Column`, `@Resolver`, `@Query`,
 *                       `@Mutation`, `@Injectable`, …) are supported. Mirrors
 *                       `packages/email-plugin/vitest.config.mts`.
 *       - `dashboard` — the co-located React dashboard component specs
 *                       (`dashboard/**\/*.spec.tsx`), transformed with esbuild's
 *                       automatic JSX runtime and rendered with `renderToStaticMarkup`
 *                       (the same lightweight, `@testing-library`-free convention used by
 *                       the in-repo `packages/dashboard/**\/page-layout.spec.tsx`).
 *
 *  2. Enforcing the mandatory >= 80% line-coverage floor over ALL of the plugin's
 *     executable code — the scoring service, entities, constants, the plugin bootstrap,
 *     the EventBus subscriber, the Admin resolvers and schema, AND the dashboard UI —
 *     not merely a hand-picked subset (a hard requirement of this feature). Coverage is
 *     declared once at the root and aggregated across both projects by Vitest.
 *
 * The e2e specs (`e2e/**\/*.e2e-spec.ts`) and the performance benchmark
 * (`e2e/**\/*.bench.ts`) are intentionally NOT run by this config; they are run
 * separately by the `e2e` and `bench` npm scripts, which point at the shared
 * `../../e2e-common/vitest.config.mts` and `../../e2e-common/vitest.config.bench.ts`
 * configs respectively. Each project below scopes its `include` to unit/component specs
 * only, so `vitest --run` never attempts to boot the full e2e Vendure test server.
 */
export default defineConfig({
    test: {
        coverage: {
            // Enabled in-config (rather than requiring a `--coverage` CLI flag) so
            // the coverage floor is always enforced by the plain `test` script.
            enabled: true,
            // Use the v8 coverage provider (@vitest/coverage-v8), which is declared
            // as a devDependency of this package and resolved via the root lockfile.
            provider: 'v8',
            reporter: ['text', 'text-summary', 'html', 'json-summary'],
            // Measure coverage over EVERY executable module the plugin ships — both the
            // backend (`src/**`) and the dashboard UI (`dashboard/**`). Broadening the
            // gate to the whole plugin (rather than a subset of `src/`) is what makes the
            // >= 80% floor a meaningful guarantee for all new code.
            include: ['src/**', 'dashboard/**'],
            // `all: true` instruments every included file even if a spec never imports it,
            // so an accidentally-untested module surfaces as 0% and drags the aggregate
            // down (it can never silently vanish from the denominator).
            all: true,
            exclude: [
                // Spec files themselves are never part of the measured surface.
                'src/**/*.spec.ts',
                'dashboard/**/*.spec.tsx',
                // Type-only module: `SellerScoringPluginOptions` is an interface that is
                // fully erased at compile time, leaving no executable lines to cover.
                'src/types.ts',
                // Generated TypeORM migration (produced by `packages/dev-server/migration.ts`).
                // It is exercised by the migration runner / e2e schema sync, not by unit
                // specs, and is machine-generated rather than hand-authored logic.
                'src/migrations/**',
                // Typed `gql.tada` Admin API operation documents. These are declarative
                // document/fragment declarations (no branching logic) that are authored
                // against, and type-checked by, the `@vendure/dashboard` build-time schema
                // introspection pipeline (`graphql.ts` re-exports the `@/vdb` `graphql()`
                // tag). They carry no runtime branches to cover and are mocked in the
                // component specs, so counting them would only add a phantom 0% penalty.
                'dashboard/graphql/**',
            ],
            // HARD REQUIREMENT (see the feature's coverage constraint): fail the run
            // if aggregate line coverage of the plugin's code drops below 80%. This
            // threshold must not be lowered — raise coverage instead.
            thresholds: {
                lines: 80,
            },
        },
        projects: [
            {
                // ---- Backend unit specs (decorators → SWC) --------------------------
                plugins: [
                    // SWC is required so Vitest can transform the TypeScript decorators
                    // used throughout `src/`. This mirrors
                    // `packages/email-plugin/vitest.config.mts`.
                    // See https://github.com/vitest-dev/vitest/issues/708#issuecomment-1118628479
                    swc.vite({
                        jsc: {
                            transform: {
                                // Vendure entities (extending VendureEntity) populate their columns
                                // from the constructor's `DeepPartial` input via base-class assignment.
                                // That pattern only survives transpilation when class fields use
                                // assignment — not "define" — semantics, matching the project's tsconfig
                                // (target es2017, useDefineForClassFields defaults to false). SWC
                                // otherwise defaults to define semantics, which re-initialises the
                                // declared columns to `undefined` after the base constructor sets them
                                // (e.g. `new SellerScore({ score })` would yield `score === undefined`).
                                // Every other entity-transpiling Vitest config in the repo sets this.
                                // See https://github.com/vendurehq/vendure/issues/2099
                                useDefineForClassFields: false,
                            },
                        },
                    }),
                ],
                test: {
                    name: 'unit',
                    environment: 'node',
                    include: ['src/**/*.spec.ts'],
                },
            },
            {
                // ---- Dashboard component specs (JSX → esbuild) ----------------------
                // The dashboard specs render the real components with `renderToStaticMarkup`
                // and mock their dependencies with `vi.mock`, so a DOM is not required and a
                // plain `node` environment is used (no `@testing-library/react` dependency).
                esbuild: {
                    // Transform TSX with the automatic JSX runtime (no `import React`
                    // needed and no SWC decorator transform — the dashboard layer has no
                    // decorators).
                    jsx: 'automatic',
                },
                resolve: {
                    alias: {
                        // Mirror the dashboard `tsconfig.json` path mapping
                        // (`"@/graphql/*": ["./graphql/*"]`) so the components' typed-operation
                        // imports resolve during tests. The operation documents themselves are
                        // replaced per-spec with `vi.mock('@/graphql/operations', …)`.
                        '@/graphql': path.resolve(__dirname, 'dashboard/graphql'),
                    },
                },
                test: {
                    name: 'dashboard',
                    environment: 'node',
                    include: ['dashboard/**/*.spec.tsx'],
                    server: {
                        deps: {
                            // Route `lucide-react` through Vite's transform pipeline instead of
                            // the default externalised node resolver. Its ESM entry re-exports
                            // ~1600 icon modules; the externalised resolver walks that barrel on
                            // every import and stalls under the `node` test environment. Inlining
                            // it lets esbuild pre-bundle the barrel once (a few seconds) — the same
                            // spirit as the dashboard package's own `optimizeDeps` barrel workaround.
                            inline: [/lucide-react/],
                        },
                    },
                },
            },
        ],
    },
});
