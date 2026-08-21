/**
 * @file Specification for {@link attemptEveryCleanup}, the teardown primitive every suite in this package
 * releases its resources through.
 *
 * WHY THIS FILE EXISTS. The helper's whole value is a property no suite can demonstrate on its own: that a
 * teardown step which fails does not prevent the steps behind it from being attempted. A suite can only show it
 * by failing a step deliberately, which is not something a suite may do — and the resources at stake are the
 * ones whose loss is invisible until a LATER file breaks: a listening port that was never closed, an isolated
 * database that was never dropped, a spy left on a singleton. So the property is asserted here, directly, where
 * a failing step is the fixture rather than a fault.
 *
 * It carries the `.e2e-spec.ts` suffix because `e2e-common/vitest.config.mts` collects exactly that pattern, and
 * it boots NO server: every case is a pure exercise of the helper, in the same style as this directory's
 * `concurrency-barrier.e2e-spec.ts`. It is therefore free of the port and database contention the
 * server-bearing suites carry.
 *
 * @since 3.8.0
 */
import { describe, expect, it } from 'vitest';

import { attemptEveryCleanup, CleanupStep } from './migration-state';

describe('attemptEveryCleanup', () => {
    /**
     * A step that records the order it ran in, and optionally fails.
     *
     * The recorder is shared rather than per-step so the assertions can read the ACTUAL order of execution,
     * which is the property under test — that every step ran, and in the order it was given.
     */
    function recordingStep(
        ran: string[],
        what: string,
        failure?: { message: string; asynchronous: boolean },
    ): CleanupStep {
        return {
            what,
            run: () => {
                ran.push(what);
                if (failure === undefined) {
                    return undefined;
                }
                if (failure.asynchronous) {
                    return Promise.reject(new Error(failure.message));
                }
                throw new Error(failure.message);
            },
        };
    }

    describe('attempts every step, whatever an earlier one does', () => {
        it('runs the steps behind a failure, in order', async () => {
            // THE PROPERTY THE HELPER EXISTS FOR. A chain of awaits stops at its first rejection, so the least
            // important resource decides whether the most important one is released; here the first step fails
            // and the two behind it still run.
            const ran: string[] = [];
            await expect(
                attemptEveryCleanup([
                    recordingStep(ran, 'first', { message: 'first failed', asynchronous: true }),
                    recordingStep(ran, 'second'),
                    recordingStep(ran, 'third'),
                ]),
                // Keyed on the STEP LABEL, not on the failure message: the message is measured rather
                // than reproduced, and the label is what identifies the step that broke anyway.
            ).rejects.toThrow(/1 of 3 failed: first —/);

            expect(ran, 'a step behind the failure did not run').toEqual(['first', 'second', 'third']);
        });

        it('runs the steps behind a SYNCHRONOUS throw as well as behind a rejected promise', async () => {
            // A step may be written either way — `resetConfig()` is synchronous, `server.destroy()` is not —
            // and a helper that only guarded the asynchronous form would let a synchronous throw escape and
            // strand everything behind it, which is exactly the failure mode being removed.
            const ran: string[] = [];
            await expect(
                attemptEveryCleanup([
                    recordingStep(ran, 'sync-thrower', { message: 'thrown outright', asynchronous: false }),
                    recordingStep(ran, 'after-sync'),
                ]),
            ).rejects.toThrow(/1 of 2 failed: sync-thrower —/);

            expect(ran).toEqual(['sync-thrower', 'after-sync']);
        });

        it('attempts the last step even when every earlier step fails', async () => {
            // The shape the migration suite's teardown actually has: `server.destroy()` is last, and a leaked
            // listening port breaks the NEXT file rather than this one.
            const ran: string[] = [];
            await expect(
                attemptEveryCleanup([
                    recordingStep(ran, 'a', { message: 'a failed', asynchronous: true }),
                    recordingStep(ran, 'b', { message: 'b failed', asynchronous: false }),
                    recordingStep(ran, 'destroy-the-server'),
                ]),
            ).rejects.toThrow(/2 of 3 failed: a —/);

            expect(ran).toContain('destroy-the-server');
        });
    });

    describe('reports what failed rather than swallowing it', () => {
        it('names every failure and how many of how many there were', async () => {
            // Collected rather than swallowed: a teardown fault stays loud, it simply no longer costs the steps
            // behind it. The count is stated as a fraction so a reader can see at a glance whether the teardown
            // mostly worked or mostly did not.
            await expect(
                attemptEveryCleanup([
                    {
                        what: 'dropping the isolated database',
                        run: () => Promise.reject(new Error('no such database')),
                    },
                    { what: 'removing the temporary directory', run: () => undefined },
                    {
                        what: 'restoring the platform configuration',
                        run: () => {
                            throw new Error('config already reset');
                        },
                    },
                ]),
                // The step labels, the fraction, and each failure MEASURED — its class, its
                // classification and its length — rather than either message reproduced.
            ).rejects.toThrow(
                new RegExp(
                    'teardown attempted every step and 2 of 3 failed: ' +
                        'dropping the isolated database — Error \\[unclassified\\] ' +
                        'mentioning nothing recognised \\(message withheld, 16 chars\\); ' +
                        'restoring the platform configuration — Error \\[unclassified\\] ' +
                        'mentioning nothing recognised \\(message withheld, 20 chars\\)',
                ),
            );
        });

        it('reports a non-Error rejection without losing that there was one', async () => {
            // A driver or a mock can reject with something that is not an `Error`. It is still MEASURED —
            // its type and its length — rather than printed, because the thing most likely to arrive here
            // as a bare non-Error is a bound parameter that was thrown.
            await expect(
                attemptEveryCleanup([
                    { what: 'releasing a query runner', run: () => Promise.reject('a bare string') },
                ]),
            ).rejects.toThrow(/releasing a query runner — string \[unclassified\]/);
        });

        it('reproduces nothing from a driver failure, and still says what a reader needs', async () => {
            // ★ THE CASE THIS AGGREGATOR EXISTS TO GET RIGHT. The steps it releases are a query runner, a
            // data source, a generated directory, an isolated database, mutated process state and a running
            // server — so a failure arriving here is a TypeORM `QueryFailedError`, which has copied the
            // driver's own error onto itself and therefore carries the statement and its bound parameters as
            // ENUMERABLE properties. This aggregate is thrown, printed by the runner and read in a build log.
            const email = 'someone.real@example.invalid';
            const driverFailure = Object.assign(
                new Error(`Duplicate entry '${email}' for key 'UQ_reorder_list_line_list_variant'`),
                {
                    name: 'QueryFailedError',
                    code: 'ER_DUP_ENTRY',
                    errno: 1062,
                    query: 'INSERT INTO `customer` (`emailAddress`) VALUES (?)',
                    parameters: [email],
                    driverError: { sqlMessage: `Duplicate entry '${email}'`, sqlState: '23000' },
                },
            );

            let aggregated = '';
            try {
                await attemptEveryCleanup([
                    { what: 'dropping the isolated database', run: () => Promise.reject(driverFailure) },
                ]);
            } catch (err: unknown) {
                aggregated = err instanceof Error ? err.message : String(err);
            }

            // What a reader NEEDS: the step, the error class, the enumerated driver code and errno, how the
            // failure classifies, and the schema object the driver named.
            expect(aggregated).toContain('dropping the isolated database');
            expect(aggregated).toContain('QueryFailedError/ER_DUP_ENTRY#1062');
            expect(aggregated).toContain('[unique-violation]');
            // What it must NOT carry.
            for (const secret of [email, 'INSERT', 'VALUES', '23000', 'Duplicate']) {
                expect(
                    aggregated.includes(secret),
                    `the teardown aggregate disclosed "${secret.slice(0, 3)}"`,
                ).toBe(false);
            }
        });

        it('refuses a step label that carries a value, because a per-resource label invites one', async () => {
            // The natural way to make a per-item cleanup step readable is to interpolate the item — and the
            // items here ARE temporary directories and database names, so the label is a path.
            let aggregated = '';
            try {
                await attemptEveryCleanup([
                    {
                        what: '/var/folders/T/reorder-plugin-a1b2c3/migrations',
                        run: () => Promise.reject(new Error('busy')),
                    },
                ]);
            } catch (err: unknown) {
                aggregated = err instanceof Error ? err.message : String(err);
            }

            expect(aggregated).toContain('<unrenderable-stage-label>');
            expect(aggregated.includes('/var/folders')).toBe(false);
            expect(aggregated.includes('reorder-plugin-a1b2c3')).toBe(false);
        });

        it('resolves silently when every step succeeds', async () => {
            const ran: string[] = [];
            await expect(
                attemptEveryCleanup([recordingStep(ran, 'one'), recordingStep(ran, 'two')]),
            ).resolves.toBeUndefined();
            expect(ran).toEqual(['one', 'two']);
        });

        it('resolves silently for no steps at all', async () => {
            // A suite may compose its steps from a list that happens to be empty — no directories created, no
            // rows to delete — and that is a teardown with nothing to do rather than a failure.
            await expect(attemptEveryCleanup([])).resolves.toBeUndefined();
        });
    });

    describe('composes with itself, which is how per-resource granularity is expressed', () => {
        it('surfaces a nested aggregate inside the outer one', async () => {
            // The suites nest it deliberately: a list of directories or restorers becomes one outer step whose
            // own steps are the individual resources, so one bad directory strands neither its siblings nor the
            // outer steps behind it. Both levels report, so the diagnosis names the resource and not just the
            // group.
            const ran: string[] = [];
            await expect(
                attemptEveryCleanup([
                    {
                        what: 'removing the temporary directories',
                        run: () =>
                            attemptEveryCleanup([
                                recordingStep(ran, 'dir-1', { message: 'busy', asynchronous: true }),
                                recordingStep(ran, 'dir-2'),
                            ]),
                    },
                    recordingStep(ran, 'destroy-the-server'),
                ]),
            ).rejects.toThrow(
                /removing the temporary directories — Error \[unclassified\] mentioning nothing recognised/,
            );

            expect(ran, 'a nested step or the outer step behind it did not run').toEqual([
                'dir-1',
                'dir-2',
                'destroy-the-server',
            ]);
        });
    });
});
