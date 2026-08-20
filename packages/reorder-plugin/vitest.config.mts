import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';
import type { Reporter } from 'vitest/reporters';

/*
 * SWC required to support decorators used in test plugins.
 * See https://github.com/vitest-dev/vitest/issues/708#issuecomment-1118628479
 *
 * Declared once and shared by the project below, because every class it imports is
 * decorator-based: without `useDefineForClassFields: false`, ES2022 class-field semantics overwrite an
 * entity's fields with `undefined` after its constructor has run.
 * See https://github.com/vendurehq/vendure/issues/2099
 */
const decoratorTransform = swc.vite({
    jsc: {
        transform: {
            useDefineForClassFields: false,
        },
    },
});

/**
 * Fails a run that executed no test at all.
 *
 * Vitest exits 0 when every collected test is filtered out — `passWithNoTests` does not cover it,
 * because the flag is consulted only when NO test file was collected: with files collected and all of
 * their tests skipped, each module reports `ok()` and the run is graded "passed". A `-t` filter that
 * matches nothing therefore succeeds having run nothing, which is the one result a test command must
 * never give: it says the code is fine while never having looked at it.
 *
 * The counting is deliberately over the executed states only (`passed` and `failed`), so a run that is
 * entirely skipped is caught while a run that executed something and skipped the rest is not. A real
 * failure is left alone — `reason` is already "failed" and Vitest has already set the exit code, so
 * saying so twice would only obscure the actual output.
 *
 * The one way past the guard is an invocation that replaces the reporter list wholesale (`--reporter=…`),
 * which is a deliberate act by whoever types it; the declared `test` script passes no such flag.
 */
const failRunThatExecutedNoTest: Reporter = {
    onTestRunEnd(testModules, _unhandledErrors, reason) {
        if (reason !== 'passed') {
            return;
        }
        let executed = 0;
        for (const testModule of testModules) {
            for (const _passed of testModule.children.allTests('passed')) {
                executed++;
            }
            for (const _failed of testModule.children.allTests('failed')) {
                executed++;
            }
        }
        if (executed > 0) {
            return;
        }
        process.stderr.write(
            '\nThis run executed no test at all, so it is reported as a failure: a green result would ' +
                'say nothing\nabout the code. Check the file filter or the -t name filter that was ' +
                'passed to Vitest.\n\n',
        );
        process.exitCode = 1;
    },
};

/*
 * ---------------------------------------------------------------------------------------------------------
 * WHY THE INVENTORY IS ENUMERATED RATHER THAN MATCHED BY A PATTERN.
 * ---------------------------------------------------------------------------------------------------------
 * Section 0.5.1.7 fixes this feature's unit inventory at exactly three co-located specifications —
 * `src/service/reorder-list-name.spec.ts`, `src/service/reorder-list.service.spec.ts` and
 * `src/reorder.plugin.spec.ts`. They are ENUMERATED here rather than matched by a glob, so the inventory is
 * stated in the configuration instead of being an accident of what happens to be on disk: a fourth
 * specification added to this feature does not silently join the run, and `reorder.plugin.spec.ts` asserts
 * that this list is exactly those three and that no `*.spec.ts` file in the package sits outside it.
 *
 * The two specifications that once sat beside them — an api-layer counter-repair spec under `src/api/` and a
 * fixture spec under `e2e/fixtures/` — widened the discovered inventory to four unit specs and seven e2e
 * suites, which is the one thing this configuration exists to prevent. Their assertions were not dropped:
 * the counter-repair cases are now a section of `src/service/reorder-list.service.spec.ts`, and the
 * statement-parser cases are a section of `e2e/reorder-list-mutate.e2e-spec.ts`, so every claim they made is
 * still made — from a file the manifest names.
 *
 * WHAT STAYS OUT, AND WHY IT IS STATED STRUCTURALLY. The end-to-end SUITES belong only to
 * `e2e-common/vitest.config.mts`, which supplies the long setup timeout and the database initializers a
 * server needs; `bun run test` starts no database. Vitest's `*.spec.ts` pattern happens to miss the
 * `*.e2e-spec.ts` suffix already, because it requires a literal `.spec.`, and enumerating the three files
 * outright makes that boundary a statement rather than a consequence of one character.
 * ---------------------------------------------------------------------------------------------------------
 */
export default defineConfig({
    test: {
        // The reporter and the flag guard the two halves of one hazard: a run whose tests were all filtered
        // out is graded "passed" by Vitest, and a run that collected no file at all is covered only by the
        // flag. Both are declared at the root so they hold for the project below whatever it collects.
        passWithNoTests: false,
        reporters: ['default', failRunThatExecutedNoTest],
        projects: [
            {
                plugins: [decoratorTransform],
                test: {
                    name: 'unit',
                    include: [
                        'src/reorder.plugin.spec.ts',
                        'src/service/reorder-list-name.spec.ts',
                        'src/service/reorder-list.service.spec.ts',
                    ],
                    exclude: ['e2e/**/*.e2e-spec.ts', 'e2e/__data__/**', 'lib/**', 'node_modules/**'],
                },
            },
        ],
    },
});
