import { DataSource, EntityManager, QueryRunner } from 'typeorm';
import { describe, expect, it } from 'vitest';

import { ConcurrencyBarrier, runSequentialPair } from './concurrency-barrier';

/**
 * The two-connection harness's TEARDOWN CONTRACT, tested where it is hardest to reach: on a query runner
 * whose own state accessors misbehave.
 *
 * ★ **WHY THIS SPEC EXISTS.** Every race claim in this package is produced by
 * `runSequentialPair`/`runBarrieredPair`, and each of them borrows real pool connections. The failure mode
 * that matters is not a wrong assertion — it is a connection that is never given back: the next test then
 * hangs, or worse inherits a stranger's open transaction, and neither symptom names this harness. The
 * module goes to considerable length to make that impossible (a single-owner cleanup claim, a bounded
 * budget on every teardown action, a baseline every close is measured against, and a rule that anything it
 * cannot certify is quarantined rather than released) — and all of it is decided from two runner
 * accessors, `isTransactionActive` and the driver-internal `transactionDepth`. An accessor that THROWS
 * therefore does not merely produce a wrong answer, it produces no answer at all, and every guarantee
 * above it is void. That is the case tested here, because it is the case no database-backed suite can
 * reach: a real driver does not throw from a getter on demand.
 *
 * ★ **WHY A FAKE RUNNER RATHER THAN A REAL ONE.** The subject is what the harness does when the runner
 * lies to it, so the runner has to be the instrument. Each fake below records every lifecycle call it
 * receives, which is what makes "the connection was never released" and "it was released exactly once"
 * observable facts rather than inferences. No database is opened, no server is started and nothing is
 * seeded — this file is as pure as the fixture it tests.
 *
 * ★ **WHICH RUNNER EXECUTES IT, AND WHY THAT ONE.** The `e2e-spec` suffix places it in the end-to-end run
 * [e2e-common/vitest.config.mts:L7], which owns everything under `e2e/`. The suffix is the whole of the
 * selection: the package's own configuration declares no `include` and no `exclude`, so its discovery is
 * Vitest's default pattern, which requires a literal `.spec.` and therefore collects an ordinary `.spec.ts`
 * wherever it sits — including here — while never collecting an `.e2e-spec.ts`. Its sibling
 * `migration-state.e2e-spec.ts` carries the suffix for exactly the same reason.
 *
 * ★ **AN ADDITION TO THE PLANNED FILE SET, DECLARED HERE.** AAP §0.5.1.8 enumerates
 * `e2e/fixtures/concurrency-barrier.ts` as a fixture module and enumerates no spec for it, so this file is
 * an addition rather than a planned artefact — admitted by the in-scope pattern
 * `packages/reorder-plugin/e2e/fixtures/*.ts` (AAP §0.6.1.2) and declared under §0.8.2's
 * no-silent-deviation obligation. It is kept because the guarantee it covers is invisible when it breaks:
 * a leaked connection surfaces as an unrelated suite hanging, and the fail-closed paths that prevent it
 * have no other test anywhere.
 */

/** Every lifecycle call a fake runner received, in order, so teardown is asserted rather than assumed. */
interface RunnerJournal {
    calls: string[];
}

/** How a fake runner should misbehave. Everything not selected here behaves like a healthy driver. */
interface FakeRunnerFaults {
    /** `isTransactionActive` throws on every read, as a driver double or a torn-down connection can. */
    throwOnTransactionFlag?: boolean;
    /** `transactionDepth` throws on every read, leaving the harness with no counter to compare. */
    throwOnTransactionDepth?: boolean;
    /**
     * The lifecycle call after which `isTransactionActive` STOPS reading — the transition case.
     *
     * ★ This is the fault a permanently-throwing getter cannot express, and it is the one that reaches the
     * dangerous path. A runner that was readable when its participant began carries a *certain* baseline,
     * so every guard keyed to the baseline is satisfied and only a later reading can notice anything is
     * wrong. It is not hypothetical either: a pool that hands back a connection whose socket has since
     * closed, or a driver whose connection object is torn out mid-chain, both read perfectly at the start
     * and throw afterwards.
     */
    flagFailsAfter?: 'connect' | 'startTransaction' | 'commitTransaction';
    /**
     * The runner arrives already inside a transaction at depth 1, as one drawn from a caller's outer
     * transaction does. This is a SUPPORTED situation for {@link runSequentialPair}, and it is what makes
     * the harness's `ownsRunner` false — so it is how the "genuinely foreign" branch is reached.
     */
    initiallyInTransaction?: boolean;
    /**
     * `release()` rejects with this exact value, so the harness's teardown-failure diagnostic can be
     * driven with a rejection of a chosen SHAPE — specifically a TypeORM-shaped one.
     */
    releaseFailsWith?: unknown;
}

/**
 * A query runner that records what was done to it, with the two state accessors optionally throwing.
 *
 * The healthy behaviour is the behaviour TypeORM's own runners have, in the order they have it:
 * `startTransaction` sets the flag and increments the depth, and both `commitTransaction` and
 * `rollbackTransaction` clear the flag and decrement it. That ordering is what the harness's baseline
 * arithmetic is written against, so a fake that got it wrong would test nothing.
 */
function createFakeRunner(
    journal: RunnerJournal,
    faults: FakeRunnerFaults = {},
): QueryRunner & { readonly journal: RunnerJournal } {
    let transactionActive = faults.initiallyInTransaction === true;
    let depth = faults.initiallyInTransaction === true ? 1 : 0;
    let released = false;
    // Flipped by whichever lifecycle call `flagFailsAfter` names, so the flag reads perfectly up to that
    // point and throws from then on.
    let flagBroken = false;
    const breakFlagAfter = (call: FakeRunnerFaults['flagFailsAfter']): void => {
        if (faults.flagFailsAfter === call) {
            flagBroken = true;
        }
    };
    const runner = {
        journal,
        get isReleased(): boolean {
            return released;
        },
        get isTransactionActive(): boolean {
            if (faults.throwOnTransactionFlag || flagBroken) {
                throw new Error('isTransactionActive is unreadable on this runner');
            }
            return transactionActive;
        },
        get transactionDepth(): number {
            if (faults.throwOnTransactionDepth) {
                throw new Error('transactionDepth is unreadable on this runner');
            }
            return depth;
        },
        set transactionDepth(value: number) {
            depth = value;
        },
        // The entity manager is handed to a participant phase and never used by the phases below, so it
        // is present for the type rather than exercised.
        manager: {} as EntityManager,
        // Each lifecycle method resolves immediately rather than being declared `async` with nothing to
        // await: the interface asks for a promise, and there is no asynchronous work in a fake.
        connect: () => {
            journal.calls.push('connect');
            breakFlagAfter('connect');
            return Promise.resolve();
        },
        startTransaction: () => {
            journal.calls.push('startTransaction');
            transactionActive = true;
            depth += 1;
            breakFlagAfter('startTransaction');
            return Promise.resolve();
        },
        commitTransaction: () => {
            journal.calls.push('commitTransaction');
            depth -= 1;
            // Closing a NESTED level leaves the outer transaction open, which is what TypeORM's own
            // runners do: they release a savepoint and decrement while the depth is still above zero, and
            // only the outermost close clears the flag. The fake has to agree, or a runner that arrived
            // inside somebody else's transaction would appear to lose it here.
            transactionActive = depth > 0;
            breakFlagAfter('commitTransaction');
            return Promise.resolve();
        },
        rollbackTransaction: () => {
            journal.calls.push('rollbackTransaction');
            depth -= 1;
            transactionActive = depth > 0;
            return Promise.resolve();
        },
        release: () => {
            journal.calls.push('release');
            if ('releaseFailsWith' in faults) {
                // NOT marked released: a release that rejected did not release, and the harness's own
                // diagnostic is what this fault exists to reach.
                return Promise.reject(faults.releaseFailsWith);
            }
            released = true;
            return Promise.resolve();
        },
        query: () => {
            journal.calls.push('query');
            return Promise.resolve([]);
        },
    };
    return runner as unknown as QueryRunner & { readonly journal: RunnerJournal };
}

/**
 * A data source that hands out the given runners in order and records a pool teardown if one happens.
 *
 * ★ `isInitialized` MUST BE TRUE, and it is not decoration. `quarantineRunner` destroys the pool only
 * `dataSource.isInitialized ? dataSource.destroy() : Promise.resolve()`, so a fake that omits the property
 * makes the guard falsy, skips the call, and turns every `not.toContain('dataSource.destroy')` in this file
 * into an assertion that cannot fail — and the one case that must OBSERVE a quarantine into one that
 * cannot see it. Setting it is what makes the destroy path real on both sides of every such assertion.
 */
function createFakeDataSource(runners: QueryRunner[], journal: RunnerJournal): DataSource {
    let handedOut = 0;
    return {
        options: { type: 'postgres' },
        isInitialized: true,
        createQueryRunner: () => {
            const runner = runners[handedOut];
            handedOut += 1;
            if (runner === undefined) {
                throw new Error('the fake data source was asked for more runners than it was given');
            }
            return runner;
        },
        destroy: () => {
            journal.calls.push('dataSource.destroy');
            return Promise.resolve();
        },
    } as unknown as DataSource;
}

/** A participant that writes nothing. The subject is the lifecycle around it, not the work inside it. */
const inertParticipant = (label: string) => ({
    label,
    write: () => Promise.resolve(`${label} wrote nothing`),
});

describe('the two-connection harness, when a runner cannot be read', () => {
    it('refuses before taking a pool connection, when neither accessor can be read', async () => {
        const journal: RunnerJournal = { calls: [] };
        const faults: FakeRunnerFaults = { throwOnTransactionFlag: true, throwOnTransactionDepth: true };
        const first = createFakeRunner(journal, faults);
        const second = createFakeRunner(journal, faults);
        const dataSource = createFakeDataSource([first, second], journal);

        const failure = await runSequentialPair(dataSource, {
            a: inertParticipant('reads-nothing-a'),
            b: inertParticipant('reads-nothing-b'),
        }).then(
            () => undefined,
            (reason: unknown) => reason,
        );

        // IT RAISES, and it raises as the HARNESS rather than as the accessor. Before this was guarded the
        // getter's own error escaped `runParticipantChain` before its `try` was entered, so no cleanup
        // ownership existed, no diagnostic was produced and the runner was simply dropped.
        expect(failure).toBeInstanceOf(Error);
        const message = (failure as Error).message;
        expect(message).toContain('The concurrency harness cannot certify this run');

        // IT REFUSES ON UNCERTAINTY, and says so in those terms. The fail-closed value reads as active, but
        // that is a substitution rather than an observation, so the chain does not go on to classify the
        // runner as somebody else's — it declines to begin at all.
        expect(message).toContain('transaction flag could not be read');
        expect(message).toContain('refused before it took a pool connection');

        // AND NOTHING WAS TAKEN OUT OF THE POOL. This is the property that closes the leak: `connect()` is
        // never reached, so there is no connection to release and none to quarantine, and the teardown says
        // exactly that rather than treating an unreadable runner as a foreign one to be left alone.
        expect(journal.calls).not.toContain('connect');
        expect(journal.calls).not.toContain('startTransaction');
        expect(journal.calls).not.toContain('rollbackTransaction');
        expect(journal.calls).not.toContain('release');
        expect(journal.calls).not.toContain('dataSource.destroy');
        expect(message).toContain('Nothing was acquired');
    });

    it('refuses on an unreadable flag even when the depth counter reads perfectly', async () => {
        const journal: RunnerJournal = { calls: [] };
        const first = createFakeRunner(journal, { throwOnTransactionFlag: true });
        const second = createFakeRunner(journal, { throwOnTransactionFlag: true });
        const dataSource = createFakeDataSource([first, second], journal);

        const failure = await runSequentialPair(dataSource, {
            a: inertParticipant('flagless-a'),
            b: inertParticipant('flagless-b'),
        }).then(
            () => undefined,
            (reason: unknown) => reason,
        );

        // A READABLE COUNTER IS NOT A SUBSTITUTE FOR A READABLE FLAG, and this is the case that says so.
        // With a depth to compare, the harness *could* tell its own nested level from an outer one and carry
        // on — treating the substituted `active: true` as proof of a foreign owner, opening and committing a
        // level inside it, and then, because a foreign connection is deliberately never released and never
        // quarantined, leaving the pool connection it had taken with nobody responsible for giving it back.
        // Certainty, not the counter, decides.
        expect(failure).toBeInstanceOf(Error);
        const message = (failure as Error).message;
        expect(message).toContain('transaction flag could not be read');

        // No connection, no transaction, no release, no quarantine, and both fakes still unreleased because
        // neither was ever connected.
        expect(journal.calls).not.toContain('connect');
        expect(journal.calls).not.toContain('startTransaction');
        expect(journal.calls).not.toContain('commitTransaction');
        expect(journal.calls).not.toContain('release');
        expect(journal.calls).not.toContain('dataSource.destroy');
        expect(first.isReleased).toBe(false);
        expect(second.isReleased).toBe(false);
    });

    it('completes the pair and releases both connections exactly once, when only the depth counter throws', async () => {
        const journal: RunnerJournal = { calls: [] };
        const first = createFakeRunner(journal, { throwOnTransactionDepth: true });
        const second = createFakeRunner(journal, { throwOnTransactionDepth: true });
        const dataSource = createFakeDataSource([first, second], journal);

        const result = await runSequentialPair(dataSource, {
            a: inertParticipant('depthless-a'),
            b: inertParticipant('depthless-b'),
        });

        // A DRIVER WITHOUT A READABLE COUNTER IS A SUPPORTED DRIVER, not a refused one: the public flag
        // alone is enough while nothing was open at the baseline, which is exactly the state a fresh runner
        // is in. Both participants therefore run and commit.
        expect(result.fulfilled).toHaveLength(2);
        expect(result.rejected).toHaveLength(0);

        // AND BOTH CONNECTIONS GO BACK — once each, after a commit, with no quarantine. This is the half of
        // the guarded read that a fail-closed answer must not break: reading "unknown" where a counter is
        // unreadable has to leave the ordinary path working, or every sequential pair on such a driver would
        // start destroying pools.
        expect(journal.calls.filter(call => call === 'commitTransaction')).toHaveLength(2);
        expect(journal.calls.filter(call => call === 'release')).toHaveLength(2);
        expect(journal.calls).not.toContain('rollbackTransaction');
        expect(journal.calls).not.toContain('dataSource.destroy');
        expect(first.isReleased).toBe(true);
        expect(second.isReleased).toBe(true);
    });
});

describe('the two-connection harness, when a runner STOPS being readable mid-chain', () => {
    /*
     * ★ WHY THIS GROUP IS SEPARATE FROM THE ONE ABOVE, AND WHY IT IS THE DANGEROUS HALF.
     *
     * The group above hands over a runner that was never readable, so `TransactionState.certain` is false
     * from the first reading and the chain refuses before it takes a pool connection. Nothing is at risk
     * because nothing is acquired.
     *
     * These cases are the opposite shape and the one that actually leaks: the flag reads perfectly when the
     * participant begins — so the baseline is a genuine observation, `certain` is true, and every guard
     * keyed to the baseline is satisfied — and only stops reading afterwards, by which time a connection is
     * out and a transaction level is open. The only thing that can notice is a LATER reading, which is why
     * certainty has to be consulted on every state read rather than on the baseline one alone.
     *
     * The consequence when it is not: a runner that arrived inside an outer transaction has a baseline of
     * "active, depth 1". A flag that has since stopped reading is substituted with "active" by the
     * fail-closed rule, so a comparison made on the VALUES ALONE finds active matching active and depth
     * matching depth, and the runner is positively certified as back at its baseline. Its teardown then
     * takes the foreign-owner path — deliberately neither releasing nor quarantining — and returns without
     * even a diagnostic. A connection is out, nobody has certified it, nobody will give it back, and
     * nothing was said. Both cases below assert the property that closes it, from both sides of ownership.
     */

    it('reports and holds a genuinely foreign connection whose flag dies after connect', async () => {
        const journal: RunnerJournal = { calls: [] };
        // Observed active at depth 1 when the participant begins — a real outer transaction, so ownership
        // is genuinely somebody else's — and then unreadable from `connect()` onwards.
        const first = createFakeRunner(journal, { initiallyInTransaction: true, flagFailsAfter: 'connect' });
        const second = createFakeRunner(journal, {
            initiallyInTransaction: true,
            flagFailsAfter: 'connect',
        });
        const dataSource = createFakeDataSource([first, second], journal);

        const failure = await runSequentialPair(dataSource, {
            a: inertParticipant('foreign-then-blind-a'),
            b: inertParticipant('foreign-then-blind-b'),
        }).then(
            () => undefined,
            (reason: unknown) => reason,
        );

        // IT IS NOT SILENT. This is the whole regression, and this case is the one that falsifies it: with
        // certainty ignored, a baseline of "active, depth 1" matched a substituted "active, depth 1" on the
        // values alone, the runner was positively certified, and the teardown returned WITHOUT a diagnostic
        // and without a quarantine. Now the run is failed and the runner is named.
        expect(failure).toBeInstanceOf(Error);
        const message = (failure as Error).message;
        expect(message).toContain('cannot certify this run');
        expect(message).toContain('foreign-then-blind-a');
        expect(message).toContain('arrived inside a transaction this harness did not open');
        expect(message).toContain('this harness only lost sight of it');

        // ★ AND THE PARTICIPANT IS REJECTED RATHER THAN REPORTED FULFILLED, which is the second half of the
        // same fix and the half only this assertion reaches. A fulfilled outcome asserts that the work
        // completed as asked, and the post-condition that keeps it honest is a positive certification that
        // the runner is back at its baseline. Certify from a substituted value and that certification
        // succeeds: the participant is reported as having committed while nobody can show the commit
        // happened. Requiring an OBSERVED flag is what turns that false fulfilment into a refusal.
        expect(message).toContain("'foreign-then-blind-a' rejected with");
        expect(message).toContain('could not complete its transaction');

        // AND THE FOREIGN WORK IS LEFT INTACT. Rule 6 still governs what is DONE about it: releasing would
        // publish a live foreign transaction and its locks to the next borrower, and destroying the pool
        // would end an outer run this harness never started. So it does neither — the diagnostic is the
        // action.
        expect(journal.calls).toContain('connect');
        expect(journal.calls).not.toContain('release');
        expect(journal.calls).not.toContain('dataSource.destroy');
        expect(first.isReleased).toBe(false);
        expect(second.isReleased).toBe(false);
    });

    it('quarantines a connection the harness borrowed itself whose flag dies after the commit', async () => {
        const journal: RunnerJournal = { calls: [] };
        // A fresh runner, so the baseline is observed INACTIVE and the connection is genuinely this
        // harness's. The flag survives the whole transaction and dies once the commit has returned, which
        // is the latest moment it can still matter: the certification that gates `release()` comes next.
        const first = createFakeRunner(journal, { flagFailsAfter: 'commitTransaction' });
        const second = createFakeRunner(journal, { flagFailsAfter: 'commitTransaction' });
        const dataSource = createFakeDataSource([first, second], journal);

        const failure = await runSequentialPair(dataSource, {
            a: inertParticipant('ours-then-blind-a'),
            b: inertParticipant('ours-then-blind-b'),
        }).then(
            () => undefined,
            (reason: unknown) => reason,
        );

        expect(failure).toBeInstanceOf(Error);
        const message = (failure as Error).message;
        expect(message).toContain('cannot certify this run');
        expect(message).toContain('ours-then-blind-a');
        expect(message).toContain('cannot be certified as clean');
        expect(message).toContain('quarantined rather than released');

        // THE OPPOSITE DISPOSAL, FROM THE SAME CAUSE, because what differs is what the harness holds. This
        // connection is ours and uncertifiable, so it is NOT handed back — `release()` cancels nothing, and
        // returning it would give the next test a runner nobody could vouch for — and the owning pool is
        // destroyed so that a later test fails loudly on a closed connection instead of inheriting this one.
        expect(journal.calls).toContain('commitTransaction');
        expect(journal.calls).toContain('dataSource.destroy');
        expect(journal.calls).not.toContain('release');
        expect(first.isReleased).toBe(false);

        // ★ AND THE FAIL-CLOSED UNWIND TERMINATES, which is the property that makes the substitution safe
        // to hold rather than merely correct in direction. Once the flag reads "active" and cannot be
        // corrected, a runner whose baseline was inactive looks to have something open on every pass, so
        // the close loop would run forever if it were not bounded. It is bounded by
        // MAX_TRANSACTION_UNWIND_STEPS, so the closes per participant stay within one commit plus that
        // budget, and the harness reports having given up rather than hanging the suite.
        expect(message).toContain('within 8 closes');
        expect(journal.calls.filter(call => call === 'commitTransaction').length).toBeLessThanOrEqual(18);

        // WHICH OF THESE TWO CASES FALSIFIES WHICH CHANGE.
        // The foreign case above is the one that fails without the certainty check, because
        // there a substituted value produced a positive certification. Here the baseline was inactive, so
        // the value comparison already disagreed and the runner was already quarantined; what this case
        // pins down is the OWNERSHIP SPLIT — that the same unreadable state disposes of a borrowed
        // connection by quarantine and a foreign one by report alone, and that the borrowed one is never
        // released on the way.
    });
});

describe('the two-connection harness, when a teardown failure has to be reported', () => {
    /**
     * A rejection shaped exactly as TypeORM raises one, driver fields and all.
     *
     * ★ THE SHAPE IS THE POINT. TypeORM copies the driver's error ONTO the `QueryFailedError` it raises, so
     * `query`, `parameters` and `driverError` become its own ENUMERABLE properties. That is why an ordinary
     * `Error` serialises to `{}` and this does not — and it is why a diagnostic built with `value.message`
     * or `JSON.stringify(value)` published the statement and every bound value into a build log.
     */
    function driverRejection(email: string): Error {
        return Object.assign(
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
    }

    it('measures the failure rather than reproducing it, and still names what a reader needs', async () => {
        // ★ WHY THIS CASE MATTERS HERE RATHER THAN ONLY IN THE REDACTION FIXTURE'S OWN SPEC. A participant of
        // this harness writes STRAIGHT THROUGH THE REPOSITORY, so a rejection it produces is the most
        // sensitive error object this package ever holds. The harness raises its teardown diagnostic as an
        // ordinary error, the runner prints it, and a build log is readable by everyone who can see the
        // build. This asserts the delegation to the shared redactor, not the redactor itself.
        const email = 'someone.real@example.invalid';
        const journal: RunnerJournal = { calls: [] };
        const faults: FakeRunnerFaults = { releaseFailsWith: driverRejection(email) };
        const dataSource = createFakeDataSource(
            [createFakeRunner(journal, faults), createFakeRunner(journal, faults)],
            journal,
        );

        const failure = await runSequentialPair(dataSource, {
            a: inertParticipant('writes-first'),
            b: inertParticipant('writes-second'),
        }).then(
            () => undefined,
            (reason: unknown) => reason,
        );

        expect(failure).toBeInstanceOf(Error);
        const message = (failure as Error).message;

        // WHAT A READER NEEDS: which participant's connection would not go back, the error class, the
        // enumerated driver code and errno, and how the failure classifies.
        expect(message).toContain('writes-first');
        expect(message).toContain('QueryFailedError/ER_DUP_ENTRY#1062');
        expect(message).toContain('[unique-violation]');

        // WHAT IT MUST NOT CARRY: the statement, its bound values, the driver's own sentence, the SQLSTATE.
        for (const secret of [email, 'INSERT', 'VALUES', '23000', 'Duplicate']) {
            expect(message.includes(secret), `the harness diagnostic disclosed "${secret.slice(0, 3)}"`).toBe(
                false,
            );
        }
    });

    it('refuses a participant label that carries a value', async () => {
        // A participant is named by whoever wrote the case, and the same pressure that interpolates a reason
        // into a diagnostic interpolates an identifier into a name. The label is guarded on the same footing.
        const email = 'someone.real@example.invalid';
        const journal: RunnerJournal = { calls: [] };
        const faults: FakeRunnerFaults = { releaseFailsWith: new Error('the pool refused it') };
        const dataSource = createFakeDataSource(
            [createFakeRunner(journal, faults), createFakeRunner(journal, faults)],
            journal,
        );

        const failure = await runSequentialPair(dataSource, {
            a: inertParticipant(`writes-for-${email}`),
            b: inertParticipant('writes-second'),
        }).then(
            () => undefined,
            (reason: unknown) => reason,
        );

        expect((failure as Error).message.includes(email)).toBe(false);
    });
});

describe('the exported barrier primitive, driven directly rather than through a pair driver', () => {
    // ★ WHY THE PRIMITIVE NEEDS ITS OWN CASES. `runBarrieredPair` and `runSequentialPair` resolve their
    // labels before they ever reach this class, so every guard exercised through them is the DRIVER's. A
    // suite may construct `ConcurrencyBarrier` itself — it is exported — and then this class's own
    // constructor, `arrive()` and `dispose()` are the only boundary a caller's label or failure crosses.
    // Everything below drives it directly, for that reason.

    const EMAIL = 'someone.real@example.invalid';
    const TOKEN = ['s3cr3t', 'session', 'token', '4f2c81b9'].join('-');
    const HOST_PATH = '/var/folders/T/reorder-plugin-a1b2c3/migrations';
    const CONTROL = 'writes\u0007\u200b\nfake-log-line: OK';

    /** A rejection shaped exactly as TypeORM raises one: driver fields as enumerable own properties. */
    function driverRejection(): Error {
        return Object.assign(
            new Error(`Duplicate entry '${EMAIL}' for key 'UQ_reorder_list_line_list_variant'`),
            {
                name: 'QueryFailedError',
                code: 'ER_DUP_ENTRY',
                errno: 1062,
                query: 'INSERT INTO `customer` (`emailAddress`) VALUES (?)',
                parameters: [EMAIL],
                driverError: { sqlMessage: `Duplicate entry '${EMAIL}'`, sqlState: '23000' },
            },
        );
    }

    /** Fails naming which value leaked, without putting the value itself in the message. */
    function expectNoValueIn(text: string, values: readonly string[]): void {
        for (const value of values) {
            expect(text.includes(value), `the diagnostic disclosed "${value.slice(0, 3)}"`).toBe(false);
        }
    }

    it('publishes no part of a value-bearing label through the timeout diagnostic', async () => {
        // The timeout message is the one a hung rendezvous produces and therefore the one most likely to be
        // read in a build log. It names who arrived and who did not, from BOTH the arrival list and
        // `expectedLabels` — so both are asserted here.
        const barrier = new ConcurrencyBarrier(2, {
            timeoutMs: 20,
            expectedLabels: [`expects-${EMAIL}`, `expects-${HOST_PATH}`],
        });

        const failure = await barrier.arrive(`writes-for-${EMAIL}`).then(
            () => undefined,
            (reason: unknown) => reason,
        );

        expect(failure).toBeInstanceOf(Error);
        const message = (failure as Error).message;
        expect(message).toContain('Concurrency barrier timed out');
        expectNoValueIn(message, [EMAIL, HOST_PATH]);
    });

    it('publishes no part of a control-character label, so a log line cannot be forged', async () => {
        // CWE-117: a newline in a label splits one log record into two, and the second can be spelled to
        // look like a passing step. The label guard's length and shape rules refuse it wholesale.
        const barrier = new ConcurrencyBarrier(2, { timeoutMs: 20, expectedLabels: [CONTROL] });

        const failure = await barrier.arrive(CONTROL).then(
            () => undefined,
            (reason: unknown) => reason,
        );

        const message = (failure as Error).message;
        expect(message.includes('fake-log-line')).toBe(false);
        expect(message.includes('\u0007')).toBe(false);
        expect(message.includes('\u200b')).toBe(false);
    });

    it('converts a foreign disposal reason before storing it or rejecting anyone with it', async () => {
        // ★ THE SINK WITH THREE OUTLETS. `dispose()` stored a caller's Error unchanged, handed it to every
        // waiting participant, and had its `.message` replayed by every later arrival. A driver error carries
        // the statement and its bound parameters as enumerable own properties, so all three published them.
        const barrier = new ConcurrencyBarrier(2, { timeoutMs: 5_000 });
        const waiting = barrier.arrive('writes-first').then(
            () => undefined,
            (reason: unknown) => reason,
        );

        barrier.dispose(driverRejection());

        // OUTLET ONE — the participant that was already waiting.
        const rejected = await waiting;
        expect(rejected).toBeInstanceOf(Error);
        const rejectedMessage = (rejected as Error).message;
        expect(rejectedMessage).toContain('QueryFailedError/ER_DUP_ENTRY#1062');
        expect(rejectedMessage).toContain('[unique-violation]');
        expectNoValueIn(rejectedMessage, [EMAIL, 'INSERT', 'VALUES', '23000', 'Duplicate']);
        // Nothing foreign was stored, so a serialising reporter finds no driver payload either.
        expect(JSON.stringify(rejected)).toBe('{}');
        expect((rejected as { cause?: unknown }).cause).toBeUndefined();

        // OUTLET TWO — a later arrival, which replayed the stored message verbatim.
        const late = await barrier.arrive('arrives-late').then(
            () => undefined,
            (reason: unknown) => reason,
        );
        const lateMessage = (late as Error).message;
        expect(lateMessage).toContain('no longer');
        expectNoValueIn(lateMessage, [EMAIL, 'INSERT', 'VALUES', '23000', 'Duplicate']);
    });

    it('refuses a token-bearing disposal reason that is not an Error at all', async () => {
        const barrier = new ConcurrencyBarrier(2, { timeoutMs: 5_000 });
        const waiting = barrier.arrive('writes-first').then(
            () => undefined,
            (reason: unknown) => reason,
        );

        barrier.dispose([TOKEN, EMAIL]);

        expectNoValueIn(((await waiting) as Error).message, [TOKEN, EMAIL]);
    });

    it('keeps two refused labels DISTINCT, so refusing one cannot turn a leak into a hang', async () => {
        // ★ THE HAZARD THE ORDINAL EXISTS FOR. A label is also the identity a repeat arrival is deduplicated
        // by, so replacing every refused label with one shared constant would merge two participants, hold
        // the distinct-arrival count below the release threshold and hang the rendezvous. Both labels here
        // are refused and the barrier must still release on the second arrival.
        const barrier = new ConcurrencyBarrier(2, { timeoutMs: 5_000 });
        const first = barrier.arrive(`writes-for-${EMAIL}`);
        const second = barrier.arrive(`writes-for-${HOST_PATH}`);

        await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
        expect(barrier.released, 'two refused labels were merged into one participant').toBe(true);
        // And they are reported as distinct ordinals rather than as one string.
        expect(new Set(barrier.arrivedLabels).size).toBe(2);
        expectNoValueIn(barrier.arrivedLabels.join(' '), [EMAIL, HOST_PATH]);
    });

    it('still counts a REPEAT arrival of the same refused label exactly once', async () => {
        // The other half of the same property: stable per raw label. Arriving twice with one refused label
        // must not satisfy a two-participant barrier, or a test would read a rendezvous that never happened
        // as evidence of an interleaving.
        const barrier = new ConcurrencyBarrier(2, { timeoutMs: 40 });
        // The first arrival's promise is settled by the same timeout as the second, so it MUST carry a
        // handler: left bare it becomes an unhandled rejection, which Vitest reports as a run-level error
        // and which fails the suite while every assertion still passes.
        const firstArrival = barrier.arrive(`writes-for-${EMAIL}`).then(
            () => undefined,
            () => undefined,
        );
        const failure = await barrier.arrive(`writes-for-${EMAIL}`).then(
            () => undefined,
            (reason: unknown) => reason,
        );

        expect(failure, 'a repeated refused label was counted as two participants').toBeInstanceOf(Error);
        expect((failure as Error).message).toContain('Concurrency barrier timed out');
        expect(new Set(barrier.arrivedLabels).size).toBe(1);
        await firstArrival;
    });

    it('keeps a safe label intact, because the diagnostic has to stay readable', async () => {
        const barrier = new ConcurrencyBarrier(2, { timeoutMs: 20, expectedLabels: ['adjust', 'remove'] });

        const failure = await barrier.arrive('adjust').then(
            () => undefined,
            (reason: unknown) => reason,
        );

        const message = (failure as Error).message;
        expect(message).toContain('Arrived: adjust');
        expect(message).toContain('Did not arrive: remove');
    });

    // ★ RENDERED-IDENTITY OWNERSHIP. The ordinal that makes a refused label safe is itself a string a
    // caller could pass, so the substitute and the accepted set overlap — and the identity a barrier
    // deduplicates by is exactly what the release threshold counts. Two participants sharing one identity
    // therefore do not leak anything; they HANG, which is a worse failure than the one the guard prevents.
    // Both arrival orders are covered because only one of them collided, and an implementation can be
    // right in one order and wrong in the other.
    describe('the identity a barrier deduplicates by is never shared by two participants', () => {
        it('keeps them distinct when the REFUSED label arrives first and claims the ordinal', async () => {
            // The order that collided. The refused label renders to `<participant-1>`; the accepted label is
            // literally `<participant-1>`, passes the character allowlist untouched, and used to be handed
            // the identity the first one already owned.
            const barrier = new ConcurrencyBarrier(2, { timeoutMs: 5_000 });
            const refused = barrier.arrive(`writes-for-${EMAIL}`);
            const collides = barrier.arrive('<participant-1>');

            await expect(Promise.all([refused, collides])).resolves.toEqual([undefined, undefined]);
            expect(barrier.released, 'two participants were merged into one identity').toBe(true);
            expect(new Set(barrier.arrivedLabels).size).toBe(2);
            expect(barrier.arrivedLabels.join(' ').includes(EMAIL)).toBe(false);
        });

        it('keeps them distinct when the ORDINAL-SHAPED label arrives first', async () => {
            // The opposite order, which happened not to collide. Asserted so it cannot start to.
            const barrier = new ConcurrencyBarrier(2, { timeoutMs: 5_000 });
            const accepted = barrier.arrive('<participant-1>');
            const refused = barrier.arrive(`writes-for-${EMAIL}`);

            await expect(Promise.all([accepted, refused])).resolves.toEqual([undefined, undefined]);
            expect(barrier.released).toBe(true);
            expect(new Set(barrier.arrivedLabels).size).toBe(2);
        });

        it('keeps them distinct when the ordinal-shaped label came from expectedLabels', async () => {
            // The constructor resolves `expectedLabels` through the same map, so it can claim an ordinal
            // before any arrival — a third ordering, and the one no arrival-only test reaches.
            const barrier = new ConcurrencyBarrier(2, {
                timeoutMs: 5_000,
                expectedLabels: ['<participant-1>', '<participant-2>'],
            });
            const first = barrier.arrive(`writes-for-${EMAIL}`);
            const second = barrier.arrive(`reads-for-${EMAIL}`);

            await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
            expect(barrier.released).toBe(true);
            expect(new Set(barrier.arrivedLabels).size).toBe(2);
            expect(barrier.arrivedLabels.join(' ').includes(EMAIL)).toBe(false);
        });

        it('still counts a repeat arrival once when its identity was ordinalised twice over', async () => {
            // Stability has to survive the ownership stepping: the same raw label must resolve to the same
            // identity on its second arrival even though reaching that identity took two attempts.
            const barrier = new ConcurrencyBarrier(3, { timeoutMs: 60, expectedLabels: ['<participant-1>'] });
            const first = barrier.arrive(`writes-for-${EMAIL}`).then(
                () => undefined,
                () => undefined,
            );
            const repeat = await barrier.arrive(`writes-for-${EMAIL}`).then(
                () => undefined,
                (reason: unknown) => reason,
            );

            // Three expected, two distinct identities so far, so it must NOT have released.
            expect(repeat, 'a repeated label was counted twice').toBeInstanceOf(Error);
            expect(new Set(barrier.arrivedLabels).size).toBe(1);
            await first;
        });

        it('lets a pair driver run when the REFUSED label is A and the ordinal-shaped one is B', async () => {
            // ★ THE SYMMETRIC DIRECTION, and the one that survived the first fix. The ordinal substitute is
            // itself a string a caller can pass, so the collision is possible either way round: here A is
            // refused and renders `<participant-1>`, and B is literally `<participant-1>`, accepted
            // untouched by the character allowlist. Advancing B only when B had itself been refused covered
            // the other direction and left this one, and the pair was rejected as indistinguishable when it
            // was nothing of the kind. An implementation can be right in one direction and wrong in the
            // other, so both are asserted.
            const journal: RunnerJournal = { calls: [] };
            const dataSource = createFakeDataSource(
                [createFakeRunner(journal), createFakeRunner(journal)],
                journal,
            );

            const result = await runSequentialPair(dataSource, {
                a: inertParticipant(`writes-for-${EMAIL}`),
                b: inertParticipant('<participant-1>'),
            });

            expect(result.a.status).toBe('fulfilled');
            expect(result.b.status).toBe('fulfilled');
            expect(result.a.label).not.toBe(result.b.label);
            expect(`${String(result.a.label)} ${String(result.b.label)}`.includes(EMAIL)).toBe(false);
        });

        it('still refuses a pair the caller named IDENTICALLY, which is a different question', async () => {
            // Collision avoidance must not swallow the caller mistake it sits next to. Two participants
            // named the same thing cannot be told apart in any diagnostic, so the pair is unusable as
            // evidence and is refused — and the refusal is keyed on the RAW labels, so ordinalising a
            // rendered collision cannot quietly turn this into two silently-renamed participants.
            const journal: RunnerJournal = { calls: [] };
            const dataSource = createFakeDataSource(
                [createFakeRunner(journal), createFakeRunner(journal)],
                journal,
            );

            await expect(
                runSequentialPair(dataSource, {
                    a: inertParticipant('writes-twice'),
                    b: inertParticipant('writes-twice'),
                }),
            ).rejects.toThrow(/must be distinguishable/);
        });

        it('refuses an identically-named pair even when both labels were themselves refused', async () => {
            // The same rule under redaction: two equal refused labels are still one caller mistake, and the
            // refusal must fire on the raw equality rather than be hidden by both rendering to an ordinal.
            const journal: RunnerJournal = { calls: [] };
            const dataSource = createFakeDataSource(
                [createFakeRunner(journal), createFakeRunner(journal)],
                journal,
            );

            const attempt = runSequentialPair(dataSource, {
                a: inertParticipant(`writes-for-${EMAIL}`),
                b: inertParticipant(`writes-for-${EMAIL}`),
            });

            await expect(attempt).rejects.toThrow(/must be distinguishable/);
            // And the refusal itself reproduces nothing of the label it is complaining about.
            await expect(attempt).rejects.not.toThrow(new RegExp(EMAIL.replace('.', '\\.')));
        });

        it('lets a pair driver run when one label is ordinal-shaped and the other is refused', async () => {
            // The same overlap in the two-label resolver. Before the ordinal stepped past A, this pair was
            // rejected outright as indistinguishable — loud rather than silent, but still a legitimate pair
            // refused. It must simply run.
            const journal: RunnerJournal = { calls: [] };
            const dataSource = createFakeDataSource(
                [createFakeRunner(journal), createFakeRunner(journal)],
                journal,
            );

            const result = await runSequentialPair(dataSource, {
                a: inertParticipant('<participant-2>'),
                b: inertParticipant(`writes-for-${EMAIL}`),
            });

            expect(result.a.status).toBe('fulfilled');
            expect(result.b.status).toBe('fulfilled');
            expect(result.a.label).not.toBe(result.b.label);
            expect(`${String(result.a.label)} ${String(result.b.label)}`.includes(EMAIL)).toBe(false);
        });
    });
});
