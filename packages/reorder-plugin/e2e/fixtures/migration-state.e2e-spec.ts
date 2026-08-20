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
            ).rejects.toThrow(/first failed/);

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
            ).rejects.toThrow(/thrown outright/);

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
            ).rejects.toThrow(/a failed/);

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
            ).rejects.toThrow(
                new RegExp(
                    'teardown attempted every step and 2 of 3 failed: ' +
                        'dropping the isolated database — no such database; ' +
                        'restoring the platform configuration — config already reset',
                ),
            );
        });

        it('reports a non-Error rejection without losing it', async () => {
            // A driver or a mock can reject with something that is not an `Error`; the diagnosis must still
            // carry it rather than printing an empty message.
            await expect(
                attemptEveryCleanup([
                    { what: 'releasing a query runner', run: () => Promise.reject('a bare string') },
                ]),
            ).rejects.toThrow(/releasing a query runner — a bare string/);
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
                /removing the temporary directories — teardown attempted every step and 1 of 2 failed: dir-1 — busy/,
            );

            expect(ran, 'a nested step or the outer step behind it did not run').toEqual([
                'dir-1',
                'dir-2',
                'destroy-the-server',
            ]);
        });
    });
});
