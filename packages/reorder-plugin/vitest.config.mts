import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';
import type { Reporter } from 'vitest/reporters';

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
        // The unit run reaches into `src` and nowhere else, matching the sibling that states the same
        // boundary explicitly [packages/create/vitest.config.mts:L8]. Everything under `e2e/` — the
        // suites, the fixtures and the fixtures' own specs — belongs to the end-to-end runner
        // [e2e-common/vitest.config.mts:L7], which supplies the long setup timeout and the database
        // initializers a server needs. `bun run test` starts no database and must not discover a file
        // that expects one, so the exclusion below states the boundary structurally rather than
        // resting it on which suffix happens not to match a glob.
        include: ['src/**/*.spec.ts'],
        exclude: ['e2e/**', 'lib/**', 'node_modules/**'],
        // Guards the other half of the same hazard: a run that collected no file at all fails rather
        // than reporting success. The reporter above guards the case this flag does not reach.
        passWithNoTests: false,
        reporters: ['default', failRunThatExecutedNoTest],
    },
});
