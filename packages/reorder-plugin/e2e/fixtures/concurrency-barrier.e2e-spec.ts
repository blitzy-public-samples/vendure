import { DataSource, EntityManager, QueryRunner } from 'typeorm';
import { describe, expect, it } from 'vitest';

import { runSequentialPair } from './concurrency-barrier';

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
 * [e2e-common/vitest.config.mts:L7], which owns everything under `e2e/`; the package's unit run reaches
 * into `src` and nowhere else, so a `.spec.ts` here would breach that boundary. Its sibling
 * `migration-state.e2e-spec.ts` sits here for exactly the same reason.
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
        // With a depth to compare, the harness *could* have told its own nested level from an outer one and
        // carried on — which is precisely what it used to do: it treated the substituted `active: true` as
        // proof of a foreign owner, opened and committed a level inside it, and then, because a foreign
        // connection is deliberately never released and never quarantined, left the pool connection it had
        // taken with nobody responsible for giving it back. Certainty, not the counter, decides.
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

        // A NOTE ON WHICH OF THESE TWO CASES FALSIFIES WHICH CHANGE, so a later reader does not mistake one
        // for the other. The foreign case above is the one that fails without the certainty check, because
        // there a substituted value produced a positive certification. Here the baseline was inactive, so
        // the value comparison already disagreed and the runner was already quarantined; what this case
        // pins down is the OWNERSHIP SPLIT — that the same unreadable state disposes of a borrowed
        // connection by quarantine and a foreign one by report alone, and that the borrowed one is never
        // released on the way.
    });
});
