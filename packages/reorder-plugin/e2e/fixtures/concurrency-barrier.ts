/**
 * A deterministic rendezvous — a *barrier* — for e2e tests that must **prove** a race rather
 * than merely provoke one, together with the two-connection transaction drivers built on it.
 *
 * 1. **The barrier is explicit, and the harness owns it.** Both participants are held past the
 *    point the race is about — after each has performed its read or precheck, and **before either
 *    writes** — then released together. The mechanism belongs to the test, not to the platform: two
 *    transactions opened on two connections, each advanced to its own pre-write point, then
 *    both instructed to write. {@link runBarrieredPair} is that mechanism — it takes a precheck and
 *    a write per participant and puts the rendezvous between them itself, rather than asking a test
 *    author to place it correctly — and {@link ConcurrencyBarrier} is the rendezvous it is built
 *    from. It then **certifies** what it claims: a pair in which either side was not held and
 *    released before writing is refused rather than returned.
 * 2. **The engine is named, and sql.js is excluded from concurrency evidence.** See
 *    "Which engines evidence a race" below, and {@link supportsForcedInterleaving}.
 * 3. **A constraint-shape / sequential assertion carries the remaining engines, and it is a
 *    different assertion** — including a duplicate written straight through the repository so
 *    that no service code can intercept it. {@link runSequentialPair} is the sequential half.
 *    Neither obligation substitutes for the other: both are required.
 *
 * A forced-barrier or forced-interleaving assertion runs on `e2e-mariadb`, `e2e-mysql` and
 * `e2e-postgres` **only**. A lost-update probe on an accumulating column, a unique-index race
 * with one winner and one violation, and a mid-transaction failure injection all belong to that
 * class. `e2e-sqljs` is excluded from all of it: sql.js is the in-process WebAssembly SQLite
 * build that `@vendure/testing` ships as an initializer (`packages/testing/src/index.ts:L12`,
 * implemented in `packages/testing/src/initializers/sqljs-initializer.ts`), so two "concurrent"
 * transactions there run in one process against one in-memory database and cannot interleave. A
 * test written as though they could would pass by serialising, which is the worst kind of green.
 *
 * The reason is in the platform's own source rather than in a preference. The shipped scheduler
 * strategy takes a pessimistic row lock only on PostgreSQL, MySQL and MariaDB
 * (`packages/core/src/plugin/default-scheduler-plugin/default-scheduler-strategy.ts:L278-L279`,
 * whose predicate {@link FORCED_INTERLEAVING_ENGINES} mirrors) and falls back to a non-locking
 * path on SQLite and sql.js, whose own comment records that the fallback works for
 * single-connection scenarios and may race with multiple connections (same file, L317-L336).
 */
import { RequestContext, TransactionalConnection } from '@vendure/core';
import { DataSource, EntityManager, QueryRunner } from 'typeorm';

import { describeTeardownStage, redactTeardownDiagnostic } from './diagnostic-redaction';

/**
 * A brand marking an error THIS MODULE AUTHORED, so its own prose can be reproduced while anything
 * foreign is measured.
 *
 * ★ **WHY PROVENANCE RATHER THAN CONTENT.** This harness's diagnostics carry a rejection reason, and that
 * channel is MIXED: the reason is usually this module's own long explanation of what it refused and why —
 * the actual diagnosis, and reproducing it verbatim is the whole point — but it can also be whatever a
 * participant's `write()` rejected with, and a participant writes straight through the repository. So the
 * same field holds both the text that must survive intact and the `QueryFailedError` whose `query` and
 * `parameters` must never be printed.
 *
 * Redacting the whole channel destroys the diagnosis; reproducing the whole channel publishes the
 * statement. Neither is acceptable, and no inspection of the TEXT can tell them apart — a message that
 * looks like prose can be a driver's, and a driver code can appear in prose. What CAN tell them apart is
 * where the error came from, which is known for certain at the moment it is constructed. Hence the stamp:
 * {@link harnessError} is the only way this module makes an error, and {@link describeReason} reproduces a
 * stamped message and measures everything else.
 */
const HARNESS_AUTHORED = Symbol('reorder-plugin.concurrency-barrier.harness-authored');

/**
 * The one constructor for an error THIS MODULE authors. Stamped, so {@link describeReason} may reproduce it.
 *
 * Every `new Error` in this file goes through here. A foreign error — a driver's, a filesystem's, a
 * participant's — is never constructed here and therefore never stamped, which is what makes the default
 * fail CLOSED: an error nobody stamped is measured rather than printed.
 */
function harnessError(message: string): Error {
    return Object.assign(new Error(message), { [HARNESS_AUTHORED]: true });
}

/** Whether a value is an error this module authored, and whose text is therefore its own. */
function isHarnessAuthored(value: unknown): value is Error {
    return value instanceof Error && (value as unknown as Record<symbol, unknown>)[HARNESS_AUTHORED] === true;
}

/**
 * Describes a rejection reason for a diagnostic: this module's own prose verbatim, anything else MEASURED.
 *
 * See {@link HARNESS_AUTHORED} for why the decision is made on provenance. The measured form names the
 * error class, the enumerated driver code and errno, how the failure classifies and which schema objects
 * its message mentioned — which is what a reader of a failed race needs — and reproduces no part of the
 * message, the statement or its bound parameters.
 */
function describeReason(reason: unknown): string {
    return isHarnessAuthored(reason) ? reason.message : redactTeardownDiagnostic(reason);
}

/**
 * A participant label, kept when it is safe and replaced by a DIAGNOSTIC ORDINAL when it is not.
 *
 * ★ **WHY AN ORDINAL RATHER THAN ONE SHARED CONSTANT.** A label is not only rendered — it is also the
 * IDENTITY a repeat arrival is deduplicated by and the thing that tells two participants apart. So
 * substituting the single `<unrenderable-stage-label>` that `describeTeardownStage` returns would merge two
 * distinct participants into one, take the distinct-arrival count below the release threshold, and turn a
 * leak into a hang. An ordinal is safe AND distinct, which is what this boundary actually needs.
 *
 * @param raw - The caller's label.
 * @param ordinal - The number to use if the label is refused. Callers must make it unique among the labels
 * they are resolving together.
 */
function safeParticipantLabel(raw: string, ordinal: number): string {
    return describeTeardownStage(raw) === raw ? raw : `<participant-${String(ordinal)}>`;
}

/**
 * @description
 * The database engines whose drivers give a test two genuinely concurrent transactions, and
 * therefore the only engines on which a forced-interleaving assertion is evidence. These are the
 * three engine jobs that run a real database server the suite can open two independent
 * connections against: `e2e-mariadb`, `e2e-mysql` and `e2e-postgres`.
 *
 * The list mirrors the platform's own predicate for "supports pessimistic locking" in
 * `packages/core/src/plugin/default-scheduler-plugin/default-scheduler-strategy.ts:L278-L279`,
 * rather than being chosen here, so that the fixture and the platform cannot drift apart.
 */
export const FORCED_INTERLEAVING_ENGINES: readonly string[] = ['postgres', 'mysql', 'mariadb'];

/**
 * @description
 * The engines that serve a test effectively one connection, and are therefore excluded from
 * every concurrency claim. `sqljs` is the in-process WebAssembly build; `sqlite` and
 * `better-sqlite3` are the native drivers, which the coverage matrix reports as unverified
 * because the published test harness ships no initializer for them.
 */
export const SINGLE_CONNECTION_ENGINES: readonly string[] = ['sqljs', 'sqlite', 'better-sqlite3'];

/**
 * @description
 * The engines on which a transaction that will write only a reorder list LINE holds the parent list row
 * EXCLUSIVELY rather than shared.
 *
 * Declared here beside the other engine sets so a suite asserting a lock clause and the service choosing one
 * cannot drift apart silently. The reason is measured rather than preferential: on the MySQL family two
 * transactions holding the parent shared deadlock at the line row once that row has been removed beneath
 * them, and because every mutation runs inside a nested savepoint scope, such a deadlock destroys the
 * savepoint and the platform's unwind then reports `SAVEPOINT typeorm_1 does not exist` instead of the
 * retriable deadlock. The plugin's own account of it is at
 * `ENGINES_REQUIRING_EXCLUSIVE_PARENT_FOR_LINE_WRITES` in `src/service/reorder-list.service.ts`.
 */
export const EXCLUSIVE_PARENT_FOR_LINE_WRITE_ENGINES: readonly string[] = ['mysql', 'mariadb'];

/**
 * @description
 * The one-sentence reason sql.js is excluded from concurrency evidence, exported so that a suite
 * can put it in a skip message or a comment verbatim instead of paraphrasing it differently in
 * each file.
 */
export const SQLJS_EXCLUSION_REASON: string =
    'sql.js is the in-process WebAssembly SQLite build, so two transactions run in one process ' +
    'against one in-memory database and cannot be held at a barrier and released together; a ' +
    'forced interleaving asserted there would pass by serialising rather than by interleaving.';

/**
 * @description
 * Resolves the engine the current e2e run is configured against, mirroring the harness default
 * exactly: `process.env.DB || 'sqljs'`, as `getDbConfig()` in `e2e-common/test-config.ts:L106`
 * resolves it.
 */
export function resolveConfiguredEngine(): string {
    return process.env.DB || 'sqljs';
}

/**
 * @description
 * Whether a forced interleaving is evidence on the given engine — the guard that keeps a barrier
 * assertion off the engines that cannot honour it.
 *
 * Pair the gated barrier case with an **ungated** sequential case, so that the sql.js job runs a
 * real assertion rather than nothing. A skipped job is not evidence; a sequential run is.
 */
export function supportsForcedInterleaving(
    engineOrDataSource?: string | { options: { type: string } },
): boolean {
    let engine: string;
    if (typeof engineOrDataSource === 'string') {
        engine = engineOrDataSource;
    } else if (engineOrDataSource) {
        engine = engineOrDataSource.options.type;
    } else {
        engine = resolveConfiguredEngine();
    }
    // The exclusion is stated first because it is the ruling: a single-connection engine is
    // never barrier evidence, whatever else it can do. The inclusion is then a closed list, so
    // an engine nobody has assessed is treated as unable rather than assumed able.
    if (SINGLE_CONNECTION_ENGINES.indexOf(engine) !== -1) {
        return false;
    }
    return FORCED_INTERLEAVING_ENGINES.indexOf(engine) !== -1;
}

/**
 * @description
 * How long a participant may wait at a rendezvous before the barrier gives up and fails with a
 * message naming who did not arrive.
 *
 * This is a **control value that bounds a wait**, not a performance target and not an expectation
 * about how quickly anything runs. It is deliberately well below the e2e runner's own per-test
 * timeout (`e2e-common/vitest.config.mts:L12` allows 15s locally, 30s in CI and 1800s under
 * `E2E_DEBUG`) for one reason: whichever limit fires first is the message the engineer reads, and
 * "participant `b` never arrived at the barrier" is a diagnosis, whereas "test timed out" is not.
 */
export const DEFAULT_BARRIER_TIMEOUT_MS = 5000;

/**
 * @description
 * How long {@link runBarrieredPair} waits for **both** participant chains to settle before declaring the
 * pair abandoned, reclaiming its connections and throwing a named diagnosis.
 *
 * ★ This is a different bound from {@link DEFAULT_BARRIER_TIMEOUT_MS} and neither replaces the other. The
 * rendezvous timeout can only reject a participant that is *waiting at the rendezvous*; one blocked on a
 * row lock it took **before** it arrived, or on a promise a fixture forgot to settle, is not waiting there,
 * so that timer never fires for it — and where both are stuck short of arrival it never even starts.
 * Without a whole-pair deadline that case surfaces as the test runner's own timeout, which names nothing
 * and reclaims nothing. Deliberately longer than the rendezvous timeout, so that the more specific
 * diagnosis is the one normally reported.
 *
 * @since 3.8.0
 */
export const DEFAULT_PAIR_TIMEOUT_MS = 9000;

/**
 * @description
 * The budget for a single teardown action — one rollback, one release, one pool destruction.
 *
 * Abandonment is usually caused by a stalled statement, and a stalled statement is precisely what leaves
 * `rollbackTransaction()` queued behind it forever. Awaiting that without a bound moves the hang from the
 * participant into the teardown, where it is worse: the release never happens, the sibling is never
 * reclaimed, and the named diagnosis is never thrown. Every action here is therefore bounded, and an
 * action that exceeds its budget is *reported* rather than waited on.
 *
 * @since 3.8.0
 */
export const DEFAULT_CLEANUP_ACTION_TIMEOUT_MS = 500;

/**
 * @description
 * How long the pair watchdog waits for a teardown another side has already claimed.
 *
 * Bounded because the thing being waited on is: a claimed cleanup is at most a small number of bounded
 * actions, so a multiple of one action's budget covers it, and exceeding that is itself reportable rather
 * than something to sit on.
 *
 * @since 3.8.0
 */
export const CLAIMED_CLEANUP_WAIT_MS = 4 * DEFAULT_CLEANUP_ACTION_TIMEOUT_MS;

/**
 * @description
 * The worst-case wall time {@link runBarrieredPair} can occupy: its deadline plus the bounded teardown
 * that follows an abandonment. Published so a suite can set its own test timeout above it and get this
 * fixture's named diagnosis rather than the runner's anonymous one.
 *
 * @since 3.8.0
 */
export const DEFAULT_PAIR_BUDGET_MS = DEFAULT_PAIR_TIMEOUT_MS + 4 * DEFAULT_CLEANUP_ACTION_TIMEOUT_MS;

export interface ConcurrencyBarrierOptions {
    /**
     * How long a participant may wait at the rendezvous before the harness fails loudly. A
     * control value bounding a wait, not a performance expectation. Must be a finite number
     * greater than zero; there is deliberately no way to disable it, because an unbounded wait is
     * the silent hang this fixture exists to prevent. Defaults to
     * {@link DEFAULT_BARRIER_TIMEOUT_MS}.
     */
    timeoutMs?: number;
    /**
     * When `true` (the default), the barrier releases itself as soon as every participant has
     * arrived. Set it to `false` to release manually with {@link ConcurrencyBarrier.release},
     * which is what makes a three-phase choreography possible — hold, assert something about the
     * held state, then release.
     */
    autoRelease?: boolean;
    /**
     * The labels this barrier expects, when they are known up front. Supplying them is what lets
     * a timeout name the participants that did **not** arrive rather than only those that did;
     * {@link runBarrieredPair} always supplies both of its labels. When omitted, a timeout still
     * names every arrival and states how many are outstanding.
     */
    expectedLabels?: readonly string[];
}

interface BarrierWaiter {
    label: string;
    resolve: () => void;
    reject: (reason: Error) => void;
}

/**
 * @description
 * A rendezvous that holds every participant until all of them have arrived, then releases them
 * together. This is the primitive the whole module is built on, and it is exported because it is
 * useful on its own — see the request-level example below, and read the limitation stated with it.
 *
 * The barrier never hangs. If the timeout elapses before release, every waiter is rejected with a
 * message naming who arrived and who did not — see {@link ConcurrencyBarrierOptions.timeoutMs}.
 */
export class ConcurrencyBarrier {
    private readonly timeoutMs: number;
    private readonly autoRelease: boolean;
    private readonly expectedLabels: readonly string[];
    private readonly labels: string[] = [];
    /**
     * Every caller label this barrier has seen, mapped to the label it renders and deduplicates by.
     *
     * ★ THE MAP, RATHER THAN NORMALISING AT EACH USE, IS WHAT KEEPS THE IDENTITY STABLE. `arrive()` may be
     * called repeatedly with the same label and must count it once; the same raw label therefore has to
     * resolve to the same safe label every time, and two DIFFERENT refused labels have to resolve to two
     * different safe ones or the release threshold is never reached. A map keyed by the raw label delivers
     * both, and it is per-instance because the ordinals it hands out are only meaningful within one
     * rendezvous.
     */
    private readonly safeLabels = new Map<string, string>();
    /**
     * The inverse of {@link ConcurrencyBarrier.safeLabels}: which raw label owns each rendered one.
     *
     * Kept alongside rather than derived, because the question asked of it is "is this candidate already
     * SOMEBODY ELSE'S identity", which a forward map answers only by scanning its values — and getting that
     * question slightly wrong is what let two participants share one identity and hang the rendezvous. See
     * {@link ConcurrencyBarrier.safeLabel}.
     */
    private readonly renderedOwners = new Map<string, string>();
    private readonly waiters: BarrierWaiter[] = [];
    private timer: ReturnType<typeof setTimeout> | undefined = undefined;
    private hasReleased = false;
    private failure: Error | undefined = undefined;

    constructor(
        private readonly participantCount: number,
        options: ConcurrencyBarrierOptions = {},
    ) {
        if (!isPositiveInteger(participantCount)) {
            throw harnessError(
                'ConcurrencyBarrier requires a participantCount that is an integer of at least 1, ' +
                    `but received ${describeUnknown(participantCount)}.`,
            );
        }
        const timeoutMs = options.timeoutMs === undefined ? DEFAULT_BARRIER_TIMEOUT_MS : options.timeoutMs;
        if (typeof timeoutMs !== 'number' || !isFinite(timeoutMs) || timeoutMs <= 0) {
            throw harnessError(
                'ConcurrencyBarrier requires a timeoutMs that is a finite number greater than 0 ' +
                    `(an unbounded wait is the hang this fixture exists to prevent), but received ${describeUnknown(
                        options.timeoutMs,
                    )}.`,
            );
        }
        this.timeoutMs = timeoutMs;
        this.autoRelease = options.autoRelease !== false;
        // ★ NORMALISED AT INTAKE, like every other label this class holds. `expectedLabels` is rendered
        // by `describeTimeout()` — the diagnostic a hung rendezvous produces, and therefore the one most
        // likely to be read in a build log — so a caller who names its expected participants after the
        // rows they act on would publish them from there.
        this.expectedLabels = (options.expectedLabels === undefined ? [] : options.expectedLabels).map(
            label => this.safeLabel(label),
        );
    }

    /**
     * @description
     * Registers this participant's arrival and returns a promise that resolves **only** once the
     * barrier is released. With `autoRelease` (the default) the barrier releases itself the moment
     * the number of distinct arrived labels reaches the participant count.
     *
     * Calling it more than once with the same label is safe: the label counts once towards the
     * release threshold, and every returned promise resolves on release. Calling it after the
     * barrier has already been released resolves immediately, and calling it after
     * {@link ConcurrencyBarrier.dispose} or after a timeout rejects with a message that says so
     * rather than waiting for a limit that will never come.
     */
    arrive(rawLabel: string): Promise<void> {
        // ★ THE FIRST THING DONE WITH A CALLER'S LABEL, BEFORE IT IS STORED OR RENDERED ANYWHERE. This is
        // the EXPORTED primitive: `runBarrieredPair` and `runSequentialPair` resolve their labels before
        // they get here, but a suite may drive this class directly, and then this method is the only
        // boundary a label crosses. Normalising here rather than at each render site covers the late-arrival
        // rejection below, `describeTimeout()`, `arrivedLabels`, and any site added later.
        const label = this.safeLabel(rawLabel);
        if (this.failure) {
            return Promise.reject(
                harnessError(
                    `Participant '${label}' arrived at a concurrency barrier that is no longer ` +
                        // The stored failure is ALWAYS harness-authored — `dispose()` converts a foreign
                        // reason before storing it — so `describeReason` reproduces this module's own
                        // explanation and would measure anything else. Replaying `.message` unconditionally,
                        // which this did, is what published a caller's driver error from here.
                        `usable. The barrier failed earlier with: ${describeReason(this.failure)}`,
                ),
            );
        }
        if (this.labels.indexOf(label) === -1) {
            this.labels.push(label);
        }
        if (this.hasReleased) {
            return Promise.resolve();
        }
        // The timer starts on the first arrival rather than at construction, so a barrier that is
        // built and never used holds no timer and cannot keep the process alive.
        this.startTimer();
        const waited = new Promise<void>((resolve, reject) => {
            // Registered synchronously, so it is already in place if the auto-release below fires.
            this.waiters.push({ label, resolve, reject });
        });
        if (this.autoRelease && this.labels.length >= this.participantCount) {
            this.release();
        }
        return waited;
    }

    /**
     * @description
     * Releases every waiting participant at once. Idempotent, and a no-op once the barrier has
     * been disposed or has timed out, so it is safe to call from a `finally` block without
     * checking anything first.
     */
    release(): void {
        if (this.failure || this.hasReleased) {
            return;
        }
        this.hasReleased = true;
        this.clearTimer();
        const waiting = this.waiters.splice(0, this.waiters.length);
        for (const waiter of waiting) {
            waiter.resolve();
        }
    }

    /**
     * @description
     * The distinct labels that have arrived, in arrival order. A copy, so a caller cannot mutate
     * the barrier's own state through it.
     */
    get arrivedLabels(): string[] {
        return this.labels.slice();
    }

    /**
     * @description
     * The expected labels that have **not** arrived. Empty where no `expectedLabels` were supplied, since
     * there is then nothing to compare against. This is what lets an abandonment name the participant that
     * never turned up rather than merely reporting a count.
     */
    get missingLabels(): string[] {
        return this.expectedLabels.filter(label => this.labels.indexOf(label) === -1);
    }

    /**
     * @description
     * Whether the barrier has been released. `false` both before release and after a disposal or
     * timeout, since neither of those releases anybody.
     */
    get released(): boolean {
        return this.hasReleased;
    }

    /**
     * @description
     * Abandons the barrier, rejecting every participant still waiting so that a failing test
     * cannot leave a promise dangling, and clearing the timeout so that a finished test cannot be
     * held open by a pending timer. Any later arrival rejects with the same reason.
     */
    dispose(reason?: unknown): void {
        if (this.failure) {
            return;
        }
        if (this.hasReleased) {
            // A released barrier has nobody left to reject, so the only thing left to do is make
            // sure no timer outlives the test. Recording a failure here would be worse than
            // useless: arrive() consults `failure` before `hasReleased`, so a later arrival would
            // reject even though this rendezvous completed successfully — and the tidy-up call the
            // drivers in this module make when they finish would be the thing that poisoned it.
            this.clearTimer();
            return;
        }
        // Converted BEFORE it is stored and before any waiter is rejected with it, so nothing downstream
        // holds a foreign error: see {@link asHarnessFailure}.
        this.failure = asHarnessFailure(
            reason,
            'The concurrency barrier was disposed before it was released.',
        );
        this.clearTimer();
        const waiting = this.waiters.splice(0, this.waiters.length);
        for (const waiter of waiting) {
            waiter.reject(this.failure);
        }
    }

    /**
     * Resolves a caller's label to the one this barrier stores, renders and deduplicates by.
     *
     * Two properties, and BOTH are required for correctness rather than for tidiness. Stable per raw label,
     * so arriving twice with one label still counts once. And INJECTIVE across raw labels, so two distinct
     * participants can never resolve to one identity — because that identity is what the release threshold
     * counts, and merging two participants holds the count below it and hangs the rendezvous. A guard that
     * turns a disclosure into a deadlock is not an improvement.
     *
     * ★ **OWNERSHIP IS CHECKED FOR EVERY LABEL, NOT ONLY FOR A REFUSED ONE.** An earlier revision checked
     * for a collision only while the candidate differed from the raw label — that is, only on the refused
     * path — on the assumption that an accepted label is its own identity and cannot clash. It can. If a
     * refused label arrives first it is rendered `<participant-1>`, and a later caller whose label is
     * literally `<participant-1>` passes the character allowlist, is accepted unchanged, and lands on an
     * identity the first raw label already owns. Both then deduplicate to one arrival and a two-party
     * barrier times out. So the reverse map below is consulted for every candidate whatever its provenance,
     * and any candidate already owned by a DIFFERENT raw label is ordinalised — including one that arrived
     * safe.
     */
    private safeLabel(rawLabel: string): string {
        const known = this.safeLabels.get(rawLabel);
        if (known !== undefined) {
            return known;
        }
        let ordinal = this.safeLabels.size + 1;
        let safe = safeParticipantLabel(rawLabel, ordinal);
        // Terminates: each turn tries a fresh ordinal and only finitely many are owned.
        while (this.renderedOwners.has(safe) && this.renderedOwners.get(safe) !== rawLabel) {
            ordinal += 1;
            safe = `<participant-${String(ordinal)}>`;
        }
        this.safeLabels.set(rawLabel, safe);
        this.renderedOwners.set(safe, rawLabel);
        return safe;
    }

    private startTimer(): void {
        if (this.timer !== undefined) {
            return;
        }
        this.timer = setTimeout(() => this.onTimeout(), this.timeoutMs);
    }

    private clearTimer(): void {
        if (this.timer !== undefined) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
    }

    private onTimeout(): void {
        this.timer = undefined;
        if (this.hasReleased || this.failure) {
            return;
        }
        this.dispose(harnessError(this.describeTimeout()));
    }

    /**
     * Builds the diagnosis a timeout reports. Naming who is missing is the whole point: without
     * it, a barrier that is never released is indistinguishable from a slow test.
     */
    private describeTimeout(): string {
        const arrived = this.labels.length ? this.labels.join(', ') : 'none';
        const missing = this.expectedLabels.filter(label => this.labels.indexOf(label) === -1);
        const missingText = this.expectedLabels.length
            ? missing.length
                ? missing.join(', ')
                : 'none — every expected participant arrived, so the barrier was never released'
            : `unknown (${String(
                  Math.max(this.participantCount - this.labels.length, 0),
              )} still outstanding; pass expectedLabels to name them)`;
        return (
            `Concurrency barrier timed out after ${String(this.timeoutMs)}ms waiting for ` +
            `${String(this.participantCount)} participant(s). Arrived: ${arrived}. Did not arrive: ` +
            `${missingText}. Every waiting participant has been rejected rather than left to hang; ` +
            'check that every participant reaches the rendezvous — under the drivers in this module ' +
            'that means its connection, its transaction and its precheck all succeeded — and that a ' +
            'barrier released by hand is actually released.'
        );
    }
}

/**
 * @description
 * What a participant phase is handed. Each participant gets its **own** connection: two
 * participants never share one, which is the whole point — a shared connection cannot hold two
 * open transactions, so it cannot interleave.
 */
export interface BarrierParticipantContext {
    readonly label: string;
    /**
     * This participant's own query runner, with its transaction already open. Use it for raw SQL,
     * for `setLock('pessimistic_write')` query builders, or to reach the driver — and remember to
     * escape identifiers with `dataSource.driver.escape(name)` so the statement is not
     * engine-specific.
     */
    readonly queryRunner: QueryRunner;
    /** Convenience for `queryRunner.manager` — the entity manager bound to this transaction. */
    readonly manager: EntityManager;
    /**
     * Whether the pair has been abandoned by its whole-pair deadline. A phase that waits on anything
     * other than the database — a promise a fixture owns, say — should consult this and give up.
     */
    readonly cancelled: () => boolean;
    /**
     * Registers a listener invoked once if the pair is abandoned, so a phase blocked on something this
     * harness cannot reach can be unblocked. Registering after abandonment invokes it immediately.
     */
    readonly onCancelled: (listener: () => void) => void;
}

/**
 * @description
 * What the write phase is handed: everything the precheck had, plus whatever the precheck returned.
 */
export interface BarrierWriteContext<P> extends BarrierParticipantContext {
    /**
     * This participant's own precheck result, carried across the rendezvous so that the write can
     * assert on what it saw *before* either participant wrote — which is the observation a race
     * claim rests on.
     */
    readonly precheckResult: P;
}

/**
 * @description
 * Binds a request context to one participant's own open transaction, so that a **real service
 * operation** invoked from a write phase runs on the connection the barrier is holding.
 *
 * Obtained from {@link createTransactionBinder}, which verifies the mechanism before returning one.
 */
export interface TransactionBinder {
    /**
     * Returns a **copy** of `ctx` bound to `manager`'s transaction. The context is copied rather than
     * mutated, exactly as the platform's own wrapper does, so one authenticated context can be bound
     * independently for each of the two participants.
     */
    bind(ctx: RequestContext, manager: EntityManager): RequestContext;
    /**
     * The entity manager a context is bound to, or `undefined` for a context carrying no transaction.
     *
     * Exported so a suite can assert the binding rather than trust it: a write phase that silently lost
     * its binding would run the operation under test on a connection of the platform's choosing, and the
     * run would report a clean serialisation while evidencing nothing.
     */
    managerOf(ctx: RequestContext): EntityManager | undefined;
}

/**
 * @description
 * Returns the given context as the **Shop API** context the operation under test is only ever reached
 * through, leaving the original untouched.
 *
 * That difference is not cosmetic. It decides which branch of any api-type-sensitive code a race exercises, so
 * a regression that skipped a lock, an atomic accumulation or a limit check *only* on the Shop API would leave
 * every forced ordering green: the races would be proving the `custom` branch, and the sequential HTTP tests
 * that do go through the Shop API cannot force an interleaving. The whole point of driving these races at the
 * service seam is to exercise the path a buyer reaches, and an api type no buyer's request produces defeats
 * it as surely as the wrong permission set would.
 */
export function asShopApiContext(ctx: RequestContext): RequestContext {
    const before = ctx.apiType;
    // `copy()` is the platform's own shallow copy, which is what the transaction binder also builds on, so the
    // private field carrying the api type is an own property of the copy and reassigning it cannot reach the
    // original. The cast is confined to this one line.
    const shopCtx = ctx.copy();
    (shopCtx as unknown as { _apiType: RequestContext['apiType'] })._apiType = 'shop';
    if (shopCtx.apiType !== 'shop') {
        throw harnessError(
            'asShopApiContext could not set the api type: the copy still reports ' +
                `'${shopCtx.apiType}'. RequestContext no longer carries the api type where this fixture ` +
                'writes it, so every barriered race would run as the Custom API rather than the Shop API ' +
                'that a buyer reaches — which is the one thing this helper exists to prevent.',
        );
    }
    if (ctx.apiType !== before) {
        throw harnessError(
            `asShopApiContext mutated the context it was given: it reported '${before}' before the copy and ` +
                `'${ctx.apiType}' after. RequestContext.copy() is no longer producing an independent object, ` +
                'so a single call would silently change the api type of every other use of that context.',
        );
    }
    return shopCtx;
}

/**
 * @description
 * Builds a {@link TransactionBinder} for the **running** server, and proves it works before returning it.
 *
 * A race claim is about the implementation only if the rendezvous sits inside the operation under test.
 * Without binding, a write phase can only issue statements itself — measuring a statement a test author
 * wrote rather than the one the service issues — or call the published operation over HTTP, which opens a
 * transaction of the server's own choosing on a connection this module has never touched. Two such calls
 * can be serialised end to end by the server, and then a count-then-insert with no lock, a
 * read-compute-save accumulation, or a write reported as applied over a row it never matched all pass,
 * because the two writes never overlapped in the first place.
 */
export async function createTransactionBinder(
    connection: TransactionalConnection,
): Promise<TransactionBinder> {
    const key = await discoverTransactionManagerKey(connection);
    const binder: TransactionBinder = {
        bind(ctx: RequestContext, manager: EntityManager): RequestContext {
            const bound = ctx.copy();
            (bound as unknown as Record<symbol, EntityManager>)[key] = manager;
            return bound;
        },
        managerOf(ctx: RequestContext): EntityManager | undefined {
            return (ctx as unknown as Record<symbol, EntityManager | undefined>)[key];
        },
    };
    await assertBindingIsHonoured(connection, binder);
    return binder;
}

/**
 * Asks the platform which symbol it stores a transaction's entity manager under.
 */
async function discoverTransactionManagerKey(connection: TransactionalConnection): Promise<symbol> {
    let discovered: symbol | undefined;
    await connection.withTransaction(RequestContext.empty(), innerCtx => {
        for (const candidate of Object.getOwnPropertySymbols(innerCtx)) {
            const value = (innerCtx as unknown as Record<symbol, unknown>)[candidate];
            if (
                typeof value === 'object' &&
                value !== null &&
                typeof (value as { getRepository?: unknown }).getRepository === 'function' &&
                (value as { queryRunner?: unknown }).queryRunner !== undefined
            ) {
                discovered = candidate;
            }
        }
        return Promise.resolve();
    });
    if (discovered === undefined) {
        throw harnessError(
            'createTransactionBinder could not discover the symbol the platform stores a transactional ' +
                'entity manager under: no symbol-keyed entity manager was present on a context inside ' +
                'TransactionalConnection.withTransaction. The transaction contract this fixture binds to ' +
                'has changed, and every barriered race invoking a service directly would otherwise run ' +
                'unbound.',
        );
    }
    return discovered;
}

/**
 * Proves, once, that a context bound by this binder is honoured: a transaction opened on it inherits the
 * very query runner supplied rather than taking one of its own.
 */
async function assertBindingIsHonoured(
    connection: TransactionalConnection,
    binder: TransactionBinder,
): Promise<void> {
    const runner = connection.rawConnection.createQueryRunner();
    try {
        // CONNECTED AND OPENED INSIDE the protected region. A `startTransaction` that throws after `connect`
        // succeeded would otherwise leave a connected runner with no `finally` to reclaim it, and this helper
        // runs once per suite that uses the barrier — so the leak would be permanent for that run.
        await runner.connect();
        await runner.startTransaction();

        let observed: QueryRunner | undefined;
        await connection.withTransaction(binder.bind(RequestContext.empty(), runner.manager), innerCtx => {
            observed = binder.managerOf(innerCtx)?.queryRunner;
            return Promise.resolve();
        });
        if (observed !== runner) {
            throw harnessError(
                'createTransactionBinder produced a binding the platform did not honour: a transaction ' +
                    'opened on a bound context ran on a different query runner than the one supplied, so a ' +
                    'barriered race invoking a service directly would not interleave at all.',
            );
        }
    } finally {
        // NESTED, so the release is not conditional on the rollback succeeding. A rollback can fail on a
        // connection the server has already closed, and that is exactly the moment the runner most needs
        // reclaiming: a leaked one holds a pool slot for the rest of the suite.
        try {
            if (runner.isTransactionActive) {
                await runner.rollbackTransaction();
            }
        } finally {
            if (!runner.isReleased) {
                await runner.release();
            }
        }
    }
}

/**
 * @description
 * The read or precheck the race is about, run **before** the rendezvous. Whatever it returns is
 * handed to the write phase as {@link BarrierWriteContext.precheckResult}, so the two phases need no
 * shared mutable variable between them.
 */
export type BarrierPrecheck<P> = (ctx: BarrierParticipantContext) => Promise<P>;

/**
 * @description
 * The write, run **only after both participants are held at the rendezvous and released together**.
 *
 * The split into two phases is not a stylistic preference and it is not the caller's to observe: the
 * driver runs both prechecks, holds both participants itself, releases them, and only then invokes
 * either write. Handing the body a single function plus an `arrive()` it was expected to await between its
 * read and its write could not certify what it claimed — a body that called `arrive()` without awaiting it,
 * or that returned by a path which skipped it, could write and commit while its sibling was still short of
 * the pre-write point, and the run would still look like a proven one-winner race. Ordering the phases here
 * removes the possibility rather than documenting the obligation.
 */
export type BarrierWrite<P, T> = (ctx: BarrierWriteContext<P>) => Promise<T>;

/**
 * @description
 * The transaction isolation levels TypeORM accepts on `startTransaction`. Declared here rather
 * than imported because TypeORM does not re-export its own `IsolationLevel` type from the package
 * root; the members are identical, so a value of this type is accepted there unchanged.
 */
export type BarrierIsolationLevel =
    | 'READ UNCOMMITTED'
    | 'READ COMMITTED'
    | 'REPEATABLE READ'
    | 'SERIALIZABLE';

/**
 * @description
 * The fields every outcome carries, whatever its status.
 */
export interface BarrierOutcomeBase {
    label: string;
    /**
     * Whether this participant **registered** at the rendezvous — recorded the moment it does so,
     * before the release is awaited. That timing is deliberate, and it is what makes the field a
     * diagnosis rather than a restatement of the outcome: a participant held at the barrier and then
     * rejected by a timeout or by its sibling's disposal provably reached the pre-write window, and
     * reporting it as `false` would point the reader at the wrong participant.
     */
    arrived: boolean;
    /**
     * Whether this participant was **released from the rendezvous before its write phase began** —
     * the property a race claim actually rests on, and the one {@link runBarrieredPair} certifies for
     * both participants before it returns anything.
     *
     * It can only be `true` because the driver itself awaited the release between the two phases, so
     * no caller can weaken it: there is no `arrive()` to forget to await. It is `false` where the
     * participant never registered, and where it registered but the rendezvous was abandoned or timed
     * out instead of releasing — in which case its write never ran at all.
     */
    releasedBeforeWrite: boolean;
    /**
     * Index of this participant in settle order — `0` for whichever body finished (and committed
     * or rolled back) first, `1` for the other. Under {@link runSequentialPair} it is always `0`
     * for `a` and `1` for `b`.
     */
    settledOrder: number;
}

/**
 * @description
 * The result of one participant. A rejection is **frequently the expected outcome** — the loser of
 * a unique-index race, or a caller told the row it addressed is gone — so it is returned here
 * rather than thrown, and nothing about it is logged away.
 */
export type BarrierOutcome<T> =
    | (BarrierOutcomeBase & { status: 'fulfilled'; value: T })
    | (BarrierOutcomeBase & { status: 'rejected'; reason: unknown });

/**
 * @description
 * Both outcomes of a pair, plus the two derived views a race assertion needs.
 */
export interface BarrierResult<A, B> {
    a: BarrierOutcome<A>;
    b: BarrierOutcome<B>;
    /**
     * The single fulfilled outcome when exactly one fulfilled and exactly one rejected; otherwise
     * `undefined`. Deliberately `undefined` in every ambiguous case, so that a both-succeeded or
     * both-failed run cannot be silently misread as a clean one-winner race — use
     * {@link BarrierResult.fulfilled} and {@link BarrierResult.rejected} for those.
     */
    winner: BarrierOutcome<A | B> | undefined;
    /**
     * The single rejected outcome under the same one-fulfilled/one-rejected condition; otherwise
     * `undefined`. Asserting on this is not optional for a race claim: the final stored state and
     * **the result the losing caller received** are two different assertions, because an
     * implementation that reports success for a write which affected nothing passes a count-only
     * assertion.
     */
    loser: BarrierOutcome<A | B> | undefined;
    /**
     * Every fulfilled outcome, always populated. Both participants fulfilling can be entirely
     * correct — a duplicate-insert race whose loser catches the violation and reconciles it into
     * an accumulation ends with two successful callers and one row.
     */
    fulfilled: Array<BarrierOutcome<A | B>>;
    /** Every rejected outcome, always populated. */
    rejected: Array<BarrierOutcome<A | B>>;
}

/**
 * @description
 * One side of a pair, as supplied by the caller: the read the race is about, and the write it is
 * about. Both run inside this participant's own transaction, and the driver — not the caller — puts
 * the rendezvous between them. The label defaults to `'a'` or `'b'`; give it a descriptive name and it
 * shows up in every outcome and in the timeout diagnosis.
 */
export type BarrierParticipantSpec<T, P = undefined> = BarrierParticipantPhases<T, P> &
    BarrierPrecheckRequirement<P>;

/**
 * @description
 * The two phases of a participant. `P` is the type of this participant's precheck result, and it is
 * what makes the two phases agree: whatever the precheck resolves to is exactly what the write is
 * handed as {@link BarrierWriteContext.precheckResult}. It defaults to `undefined`, which is a
 * participant that declares no precheck — and `undefined` is then precisely what its write receives.
 */
export interface BarrierParticipantPhases<T, P> {
    /** A name for this participant. Must differ from its sibling's. */
    label?: string;
    /**
     * The read or precheck the race is about, run before the rendezvous. Omit it where the race has no
     * read to hold — the line-bound race, whose precheck *is* its conditional write, is the shipped
     * example — and its result type is then `undefined`. Whatever it returns reaches the write as
     * {@link BarrierWriteContext.precheckResult}.
     */
    precheck?: BarrierPrecheck<P>;
    /**
     * The write, run only once **both** participants are held and released together. Everything the
     * race is about — the insert, the conditional update, the delete — belongs here, and anything read
     * beforehand belongs in {@link BarrierParticipantPhases.precheck}.
     */
    write: BarrierWrite<P, T>;
}

/**
 * @description
 * Makes the precheck **required** for any participant whose precheck result type cannot be `undefined`,
 * and leaves it optional for any that can.
 */
export type BarrierPrecheckRequirement<P> = undefined extends P
    ? unknown
    : {
          /** Required, because this participant's write has been promised a precheck result. */
          precheck: BarrierPrecheck<P>;
      };

/**
 * @description
 * The two participants of a pair. `PA` and `PB` are inferred from each side's precheck and exist only
 * so that each write receives its own precheck result typed; a caller who declares no precheck can
 * ignore them entirely, and defaults them to `undefined` — which is exactly what such a write is
 * handed.
 */
export interface BarrierParticipants<A, B, PA = undefined, PB = undefined> {
    a: BarrierParticipantSpec<A, PA>;
    b: BarrierParticipantSpec<B, PB>;
}

export interface RunBarrieredPairOptions {
    /**
     * The isolation level to open **both** transactions at. Chosen by the caller and never
     * defaulted here: MySQL and MariaDB default to `REPEATABLE READ` while PostgreSQL defaults to
     * `READ COMMITTED`, and the observable outcome of a lost-update probe can differ between them,
     * so a suite that cares must say which level it asked for. Omit it to accept each engine's own
     * default — which is a legitimate choice, and is then the thing the test is asserting against.
     */
    isolationLevel?: BarrierIsolationLevel;
    /**
     * How long a participant may wait at the rendezvous. A control value bounding a wait, not a
     * performance expectation. Defaults to {@link DEFAULT_BARRIER_TIMEOUT_MS}.
     */
    timeoutMs?: number;
    /**
     * How long the pair as a whole may take before it is abandoned, its connections reclaimed and a
     * named diagnosis thrown. Defaults to {@link DEFAULT_PAIR_TIMEOUT_MS}. See that constant for why
     * this is not the same bound as {@link RunBarrieredPairOptions.timeoutMs}.
     */
    pairTimeoutMs?: number;
    /**
     * Commit each participant's transaction when its write resolves (the default), or roll it back
     * instead. A phase that throws is always rolled back.
     */
    commitOnSuccess?: boolean;
}

export interface RunSequentialPairOptions {
    /** As {@link RunBarrieredPairOptions.isolationLevel}. */
    isolationLevel?: BarrierIsolationLevel;
    /** As {@link RunBarrieredPairOptions.commitOnSuccess}. */
    commitOnSuccess?: boolean;
}

/**
 * @description
 * Runs two participants on **two independent connections**, each in its own transaction, each
 * advanced through its own precheck, then held at a rendezvous and released together before either
 * writes. This is the canonical way to evidence a race in this package, and the only one of the two
 * drivers here that evidences an interleaving.
 *
 * Gate it with {@link supportsForcedInterleaving}: it is evidence on `e2e-mariadb`, `e2e-mysql`
 * and `e2e-postgres` only, and {@link runSequentialPair} carries the same contract on the rest.
 * Nothing here weakens the migration and constraint obligations, which stay on all four engines.
 */
export async function runBarrieredPair<A, B, PA = undefined, PB = undefined>(
    dataSource: DataSource,
    participants: BarrierParticipants<A, B, PA, PB>,
    options: RunBarrieredPairOptions = {},
): Promise<BarrierResult<A, B>> {
    const labels = resolveDistinctLabels(participants);
    const barrier = new ConcurrencyBarrier(2, {
        timeoutMs: options.timeoutMs,
        expectedLabels: labels,
    });
    const commitOnSuccess = options.commitOnSuccess !== false;
    // Validated before a single connection is taken, deliberately. A bad deadline discovered after the
    // runners exist would have to unwind them, and the failure a caller sees should be about their
    // configuration rather than about cleanup.
    const pairTimeoutMs = resolvePairTimeout(options.pairTimeoutMs);
    const state: ChainState = { settled: 0, teardownErrors: [] };
    const token: CancellationToken = { cancelled: false, listeners: [] };
    // One claim per runner, so a chain's own teardown and the watchdog's reclaim can never both run.
    const claims: CleanupClaim[] = [
        {
            claimed: false,
            baseline: { active: false, depth: undefined, certain: false },
            ownsTransaction: false,
            ownsRunner: false,
            connectionAcquired: false,
            completion: undefined,
        },
        {
            claimed: false,
            baseline: { active: false, depth: undefined, certain: false },
            ownsTransaction: false,
            ownsRunner: false,
            connectionAcquired: false,
            completion: undefined,
        },
    ];
    const runners = await createDistinctRunners(dataSource);

    // ★★ Both chains are started here, back to back, with no `await` between them, and each one
    // commits as soon as its own write returns. Do NOT "simplify" this into awaiting both writes
    // and committing afterwards: on MySQL, MariaDB and PostgreSQL the second writer blocks on the
    // first writer's row lock until that transaction commits, so a harness that holds both
    // commits back deadlocks — and the symptom is an opaque test timeout, not a harness error.
    const chainA = runParticipantChain(
        runners[0],
        labels[0],
        normaliseParticipantSpec(participants.a),
        barrier,
        options.isolationLevel,
        commitOnSuccess,
        state,
        token,
        dataSource,
        claims[0],
    );
    const chainB = runParticipantChain(
        runners[1],
        labels[1],
        normaliseParticipantSpec(participants.b),
        barrier,
        options.isolationLevel,
        commitOnSuccess,
        state,
        token,
        dataSource,
        claims[1],
    );

    // Settle-collection is done by hand rather than with `Promise.all` (which short-circuits on
    // the first rejection and would abandon the other runner) or `Promise.allSettled` (which is
    // outside the es2015 lib surface this project type-checks e2e code against). Neither chain
    // ever rejects: each maps its own failure into a rejected outcome, so tracking them individually
    // collects both regardless of which finished first — and, unlike awaiting them in sequence, it
    // records *which* one is still running when the deadline arrives.
    const tracked = [trackChain(chainA, labels[0]), trackChain(chainB, labels[1])];
    const abandoned = await raceAgainstDeadline(tracked, pairTimeoutMs);

    if (abandoned) {
        // ★ The pair is over, and the three things that must happen now are independent of each other.
        //
        // First every participant waiting on something this harness cannot reach is told to give up. Then
        // the rendezvous is disposed, so a participant still waiting there fails immediately instead of
        // running out its own timer. Then every unsettled participant's connection is reclaimed *from
        // here*, because its chain is blocked and will never reach its own `finally` — and a released
        // connection is also what unblocks a body stuck inside the driver, which is the only cancellation
        // mechanism TypeORM offers portably. Because that reclaim takes each runner's cleanup claim, it
        // cannot tear down concurrently with a chain that did reach its own teardown.
        cancelToken(token, state);
        barrier.dispose(
            harnessError(
                `The barriered pair exceeded its ${String(pairTimeoutMs)}ms deadline and was abandoned, so ` +
                    'the rendezvous was failed and both connections were reclaimed.',
            ),
        );
        await reclaimAbandonedRunners(runners, tracked, state, dataSource, claims);
        throw harnessError(buildAbandonedPairMessage(tracked, pairTimeoutMs, state, barrier));
    }

    // Nothing is waiting by now; this exists to guarantee the timeout cannot outlive the test. On a
    // barrier that released normally this only clears the timer, so it cannot invalidate a
    // rendezvous a caller still holds — see ConcurrencyBarrier.dispose.
    barrier.dispose(harnessError('The barriered pair has finished; its rendezvous is no longer in use.'));

    const result = assembleBarrierResult(
        tracked[0].outcome as BarrierOutcome<A>,
        tracked[1].outcome as BarrierOutcome<B>,
    );
    // `true`: this driver's whole claim is the interleaving, so a run in which either participant was
    // not held at the rendezvous and released from it before writing is refused rather than returned.
    // The chains already refuse to *commit* such a participant; this refuses to hand the caller a
    // *result* built from a pair that was never inside the window together, however that came about.
    assertHarnessIntegrity(state, result, true);
    // A completed run whose teardown reported anything is not usable as evidence: a leaked connection or
    // an unclosed level is a failure at the point it happened rather than an unexplained hang two tests
    // later.
    assertNoTeardownFailure(state, result);
    return result;
}

/**
 * @description
 * Runs the **same two participant specs** one after the other — `a`'s precheck and write to
 * completion, its transaction committed or rolled back and its connection released, and only then `b` —
 * returning the **same result shape** as {@link runBarrieredPair}, so a suite can share its
 * participants between the barrier case and the sequential case instead of writing them twice.
 *
 * **What this evidences:** single-connection correctness, replay idempotency, accumulation
 * arithmetic, and constraint shape — including a duplicate written straight through the repository
 * so that no service pre-check can intercept it. That is a real assertion about the same contract,
 * and it is what keeps the sql.js job meaningful rather than skipped: a skipped job is not
 * evidence, whereas a sequential run is.
 */
export async function runSequentialPair<A, B, PA = undefined, PB = undefined>(
    dataSource: DataSource,
    participants: BarrierParticipants<A, B, PA, PB>,
    options: RunSequentialPairOptions = {},
): Promise<BarrierResult<A, B>> {
    const labels = resolveDistinctLabels(participants);
    const commitOnSuccess = options.commitOnSuccess !== false;
    const state: ChainState = { settled: 0, teardownErrors: [] };
    // Never cancelled in this mode: there is no whole-pair watchdog because there is no pair running
    // concurrently to abandon. The token exists so that a phase written for either driver can consult
    // `ctx.cancelled()` unconditionally rather than guarding on which one is running it.
    const token: CancellationToken = { cancelled: false, listeners: [] };

    // No barrier is created at all in this mode, so there is no timer to clear because there was
    // never anything to wait for. Each runner is created immediately before its own chain rather
    // than both up front, so that on an engine whose driver caches one runner the second participant
    // legitimately reuses it once the first has finished with it and returned it to its baseline —
    // which is exactly what "one after the other" means here.
    const outcomeA = await runParticipantChain(
        dataSource.createQueryRunner(),
        labels[0],
        normaliseParticipantSpec(participants.a),
        undefined,
        options.isolationLevel,
        commitOnSuccess,
        state,
        token,
        dataSource,
    );
    const outcomeB = await runParticipantChain(
        dataSource.createQueryRunner(),
        labels[1],
        normaliseParticipantSpec(participants.b),
        undefined,
        options.isolationLevel,
        commitOnSuccess,
        state,
        token,
        dataSource,
    );

    const result = assembleBarrierResult(outcomeA, outcomeB);
    // `false`: there is no rendezvous in this mode, so being held at one is not a precondition of
    // anything and both participants running unheld is exactly what was asked for. Teardown failures
    // are still reported, because a leaked connection is a leaked connection in either mode.
    assertHarnessIntegrity(state, result, false);
    return result;
}

// Internals. Nothing below this line is exported: the module's surface is the barrier, the two
// drivers, the engine guards and the types they use.

/**
 * State shared by the two chains of one run: the settle counter behind
 * `BarrierOutcomeBase.settledOrder`, and the teardown failures collected from both sides so that
 * they can be reported together instead of one masking the other.
 */
interface ChainState {
    settled: number;
    teardownErrors: string[];
}

/**
 * A chain being watched: its label, whether it has settled, and its outcome once it has.
 *
 * Settlement has to be observable **synchronously** so that the whole-pair deadline can report *which*
 * participant is still running, which is the whole value of the diagnosis over the test runner's own
 * timeout.
 */
interface TrackedChain {
    readonly label: string;
    settled: boolean;
    outcome: BarrierOutcome<unknown> | undefined;
    readonly done: Promise<void>;
}

/**
 * Wraps a participant chain so that its settlement is observable synchronously. The returned `done`
 * promise never rejects, because a chain never rejects — it maps its own failure into its outcome.
 */
function trackChain<T>(chain: Promise<BarrierOutcome<T>>, label: string): TrackedChain {
    const tracked: TrackedChain = { label, settled: false, outcome: undefined, done: Promise.resolve() };
    const mutable = tracked as {
        settled: boolean;
        outcome: BarrierOutcome<unknown> | undefined;
        done: Promise<void>;
    };
    mutable.done = chain.then(
        outcome => {
            mutable.settled = true;
            mutable.outcome = outcome as BarrierOutcome<unknown>;
        },
        reason => {
            // Defensive: a chain is written never to reject, so reaching here means the harness itself
            // is broken. Recording it as a rejected outcome keeps the pair reportable either way.
            mutable.settled = true;
            mutable.outcome = {
                label,
                arrived: false,
                releasedBeforeWrite: false,
                settledOrder: -1,
                status: 'rejected',
                reason,
            } as BarrierOutcome<unknown>;
        },
    );
    return tracked;
}

/**
 * Resolves `false` once every chain has settled, or `true` when `deadlineMs` elapses first. The timer is
 * always cleared, so it can never outlive the call and hold the process open.
 */
async function raceAgainstDeadline(tracked: TrackedChain[], deadlineMs: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expiry = new Promise<boolean>(resolve => {
        timer = setTimeout(() => resolve(true), deadlineMs);
    });
    const all = Promise.all(tracked.map(entry => entry.done)).then(() => false);
    try {
        return await Promise.race([all, expiry]);
    } finally {
        if (timer !== undefined) {
            clearTimeout(timer);
        }
    }
}

/**
 * Validates the whole-pair deadline and returns it, or throws a named configuration error.
 *
 * Held to the same standard as the rendezvous timeout, for the same reason: a zero, negative, `NaN` or
 * infinite value does not produce a bounded wait, it produces an immediate abandonment or a timer that
 * never fires — and an unbounded wait is the hang this fixture exists to prevent.
 */
function resolvePairTimeout(pairTimeoutMs: number | undefined): number {
    const resolved = pairTimeoutMs === undefined ? DEFAULT_PAIR_TIMEOUT_MS : pairTimeoutMs;
    if (typeof resolved !== 'number' || !isFinite(resolved) || resolved <= 0) {
        throw harnessError(
            'runBarrieredPair requires a pairTimeoutMs that is a finite number greater than 0 ' +
                '(an unbounded pair is the hang the whole-pair deadline exists to prevent), but received ' +
                `${describeUnknown(pairTimeoutMs)}.`,
        );
    }
    return resolved;
}

/**
 * Settles `action` within `budgetMs`, returning what happened rather than throwing: `'settled'`,
 * `'failed'` with the reason, or `'unsettled'` when the budget ran out.
 *
 * ★ The unsettled case is the one that matters and is not hypothetical. Abandonment is usually caused by
 * a stalled statement, and a stalled statement is precisely what leaves `rollbackTransaction()` queued
 * behind it forever. Awaiting that without a bound moves the hang from the participant into the
 * watchdog's own teardown, where it is worse: the release never happens, the sibling is never reclaimed,
 * and the named diagnosis is never thrown. Abandoning the *attempt* keeps teardown moving; the abandoned
 * promise is left to settle or not on its own, and is reported as unsettled either way.
 */
async function attemptWithinBudget(
    action: () => Promise<unknown>,
    budgetMs: number,
): Promise<{ outcome: 'settled' | 'failed' | 'unsettled'; reason?: unknown }> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expiry = new Promise<{ outcome: 'unsettled' }>(resolve => {
        timer = setTimeout(() => resolve({ outcome: 'unsettled' }), budgetMs);
    });
    let attempt: Promise<{ outcome: 'settled' | 'failed'; reason?: unknown }>;
    try {
        attempt = action().then(
            () => ({ outcome: 'settled' as const }),
            (reason: unknown) => ({ outcome: 'failed' as const, reason }),
        );
    } catch (reason) {
        // A synchronous throw from the action itself, which a driver double can produce.
        if (timer !== undefined) {
            clearTimeout(timer);
        }
        return { outcome: 'failed', reason };
    }
    try {
        return await Promise.race([attempt, expiry]);
    } finally {
        if (timer !== undefined) {
            clearTimeout(timer);
        }
    }
}

/**
 * Reads a runner flag without ever throwing, falling back to `fallback` when the accessor fails.
 *
 * The fallback is the caller's fail-closed answer, and it differs per flag: an unreadable
 * `isTransactionActive` must read as **active**, so live work is never released, while an unreadable
 * `isReleased` must read as **not released**, so a release is attempted rather than a leak assumed away.
 */
function readRunnerFlag(read: () => boolean, fallback: boolean): boolean {
    try {
        return read();
    } catch {
        return fallback;
    }
}

/**
 * Single-owner token deciding which side performs one runner's teardown.
 *
 * ★ Two sides can want to tear the same runner down at the same moment: the participant's own chain, in
 * its `catch`/`finally`, and the pair watchdog, once the deadline has abandoned the pair. Letting both
 * proceed means two concurrent `rollbackTransaction()` or `release()` calls on one connection, whose
 * outcome is driver-specific and includes releasing a connection out from under an in-flight rollback —
 * which is precisely the pool contamination this file goes to some length to avoid. So the teardown has
 * exactly one owner: whoever claims first does it, and the other side does nothing at all.
 */
interface CleanupClaim {
    claimed: boolean;
    /**
     * The transaction state the chain found on this runner before it opened anything, shared so that the
     * watchdog measures against the same baseline the chain would have.
     */
    baseline: TransactionState;
    /**
     * Whether the transaction currently on this runner was opened by **this** harness. Set synchronously
     * immediately before `startTransaction()`, because every installed driver marks the runner
     * transactional before it issues BEGIN.
     */
    ownsTransaction: boolean;
    /**
     * Whether the connection itself was borrowed by this chain, as opposed to arriving already inside
     * somebody else's transaction. Tracked separately from {@link CleanupClaim.ownsTransaction} because
     * `release()` hands the connection back without ending anything open on it.
     */
    ownsRunner: boolean;
    /**
     * Whether the chain got as far as `connect()`, so a watchdog can tell a runner that is holding a pool
     * connection from one that never took one. The two need opposite handling when the runner's state
     * cannot be read: the first must be quarantined, the second must be left alone.
     */
    connectionAcquired: boolean;
    /**
     * The cleanup the claim's owner is running, once it has started.
     *
     * ★ Assigned synchronously in the same turn as the claim, so a watchdog that finds the claim taken
     * always finds this too and can **await** it. Skipping a claimed runner without waiting is the other
     * half of the problem: the pair could throw its abandonment error while the chain's rollback, release
     * or `DataSource.destroy()` was still in flight, losing every diagnostic appended after the message
     * was built and leaving the next test to race a pending teardown.
     */
    completion: Promise<void> | undefined;
}

/**
 * Claims a runner's teardown, returning whether the caller now owns it. `undefined` means no other side
 * exists to contend with — sequential mode has no watchdog — so the caller owns it by default.
 *
 * Synchronous by design: a claim decided across an `await` would let both sides pass the check before
 * either recorded it.
 */
function claimCleanup(claim: CleanupClaim | undefined): boolean {
    if (claim === undefined) {
        return true;
    }
    if (claim.claimed) {
        return false;
    }
    claim.claimed = true;
    return true;
}

/**
 * Waits, within a bound, for the cleanup the claim's owner is already running.
 *
 * The wait is bounded because the thing being waited on is: the owner's cleanup is a small number of
 * bounded actions, so a multiple of one action's budget covers it, and exceeding that is itself
 * reportable rather than something to sit on. A claim taken with no completion published cannot happen —
 * the owner assigns it in the same synchronous step — but it is treated as nothing to wait for rather
 * than as an error, since the alternative would be to block on a promise that will never exist.
 */
async function awaitClaimedCleanup(
    claim: CleanupClaim | undefined,
    label: string,
    errors: string[],
): Promise<void> {
    const completion = claim === undefined ? undefined : claim.completion;
    if (completion === undefined) {
        return;
    }
    const waited = await attemptWithinBudget(() => completion, CLAIMED_CLEANUP_WAIT_MS);
    if (waited.outcome === 'unsettled') {
        errors.push(
            `the cleanup already running for '${label}' had not finished within ` +
                `${String(CLAIMED_CLEANUP_WAIT_MS)}ms when the pair was abandoned, so its own diagnostics ` +
                'may be incomplete and its connection may still be in the process of being returned',
        );
    }
}

/**
 * @description
 * **The** cleanup path for a query runner. Every caller uses this one — the participant's own chain, the
 * pair watchdog, the sequential runner, and the pre-chain unwinding that runs before any chain exists —
 * because a second, unbounded path is exactly how a connection escapes the rules below.
 *
 * 1. **Every step is bounded** by {@link DEFAULT_CLEANUP_ACTION_TIMEOUT_MS}. A rollback queued behind the
 *    stalled statement that caused the abandonment does not return, and an unbounded `await` on it hangs
 *    whichever side owns cleanup. If that side is the participant's chain, the watchdog then sees an
 *    unsettled chain, finds the cleanup claim already taken, and correctly declines to race it — so an
 *    unbounded owner means *nobody* quarantines and *nobody* destroys the pool. A single-owner claim is
 *    only safe because the owner's whole cleanup is bounded.
 */
async function settleRunner(
    queryRunner: QueryRunner,
    label: string,
    state: ChainState,
    dataSource: DataSource,
    baseline: TransactionState,
    ownsRunner: boolean,
    connectionAcquired: boolean,
): Promise<void> {
    if (readRunnerFlag(() => queryRunner.isReleased, false)) {
        // Already released, by this path or the other side of the claim. Nothing left to do, and
        // "unreadable" resolves to "not released" so a leak is attempted rather than assumed away.
        return;
    }
    // ★ READ THE STATE BEFORE ACTING ON IT. Rule 7 has to know whether the thing it is about to restore
    // and certify can be read at all, and it has to know that before rule 3 issues a single rollback
    // against a state nobody can see. Reading here rather than inside the certification is also what makes
    // the *transition* case reachable: a flag that was observed at the baseline and has since stopped
    // reading leaves `baseline.certain` true, so nothing but this reading can notice it.
    const observed = readTransactionState(queryRunner);
    if (!baseline.certain || !observed.certain) {
        // RULE 7. Uncertifiable, from whichever end. What happens next is decided by what this harness is
        // actually holding, never by rule 2's substituted value — see the rule's own text above.
        const when = baseline.certain
            ? 'was readable when this participant began and cannot be read now'
            : 'could not be read when this participant began';
        if (!connectionAcquired) {
            // Nothing was ever taken out of the pool, so there is nothing to give back, quarantine or leak.
            state.teardownErrors.push(
                `the transaction state of the runner for '${label}' ${when}, so this participant was ` +
                    'refused before it took a pool connection. Nothing was acquired, nothing is open and ' +
                    'nothing is being held: the runner is left exactly as it was handed over',
            );
            return;
        }
        if (baseline.certain && !ownsRunner) {
            // Genuinely foreign, and known to be so because the baseline flag was OBSERVED active. Rule 6
            // governs: releasing would publish live foreign work to the next borrower, and destroying the
            // pool would end an outer run this harness never started, so it does neither — loudly.
            state.teardownErrors.push(
                `the runner for '${label}' arrived inside a transaction this harness did not open, and ` +
                    `its transaction state ${when}, so nothing above that outer transaction can be ` +
                    'certified as closed. It was neither released nor quarantined, because the connection ' +
                    'belongs to that owner and this harness only lost sight of it',
            );
            return;
        }
        // Ours — or, where the baseline itself was substituted, not demonstrably anybody else's while a
        // connection is out. Either way rule 5 applies: reported by name, not released, and the owning pool
        // destroyed, so a later test fails on a closed connection instead of inheriting this one.
        state.teardownErrors.push(
            `the transaction state of the runner for '${label}' ${when}, so the connection it is holding ` +
                'cannot be certified as clean, and cannot be shown to belong to anybody else either. It is ' +
                'quarantined rather than released',
        );
        await quarantineRunner(label, state.teardownErrors, dataSource);
        return;
    }
    // Bounded, and only ever the levels above the baseline. `restoreTransactionBaseline` records its own
    // diagnostics, so a failure inside it is already on the record; what this adds is the guarantee that
    // it cannot sit here forever behind a stalled statement.
    const restored = await attemptWithinBudget(
        () => restoreTransactionBaseline(queryRunner, baseline, label, state),
        DEFAULT_CLEANUP_ACTION_TIMEOUT_MS,
    );
    if (restored.outcome === 'failed') {
        state.teardownErrors.push(
            `restoring the transaction state for '${label}' failed: ${describeReason(restored.reason)}`,
        );
    } else if (restored.outcome === 'unsettled') {
        state.teardownErrors.push(
            `restoring the transaction state for '${label}' did not settle within ` +
                `${String(DEFAULT_CLEANUP_ACTION_TIMEOUT_MS)}ms, so the connection cannot be proven clean`,
        );
    }
    // Re-read rather than trusting the outcome: a rollback can report success while the driver still
    // considers a level open, and it is the state the pool will act on that matters.
    const quiescent = restored.outcome === 'settled' && isCertainlyAtBaseline(queryRunner, baseline);

    if (!ownsRunner) {
        // Rule 6. Not ours to return, and not ours to destroy the pool over. Reached only where the
        // baseline was genuinely OBSERVED to be active, so "belongs to that owner" is a fact rather than a
        // fallback — the uncertain case is handled above and never lands here.
        if (!quiescent) {
            state.teardownErrors.push(
                `the runner for '${label}' arrived inside a transaction this harness did not open and ` +
                    'could not be returned to the state it was found in, so a level this harness opened ' +
                    "may still be open inside its owner's transaction. It was neither released nor " +
                    'quarantined, because the connection belongs to that owner',
            );
        }
        return;
    }

    if (!quiescent) {
        await quarantineRunner(label, state.teardownErrors, dataSource);
        return;
    }

    const release = await attemptWithinBudget(() => queryRunner.release(), DEFAULT_CLEANUP_ACTION_TIMEOUT_MS);
    if (release.outcome === 'failed') {
        state.teardownErrors.push(
            `releasing the connection for '${label}' failed: ${describeReason(release.reason)}`,
        );
        await quarantineRunner(label, state.teardownErrors, dataSource);
        return;
    }
    if (release.outcome === 'unsettled') {
        state.teardownErrors.push(
            `releasing the connection for '${label}' did not settle within ` +
                `${String(DEFAULT_CLEANUP_ACTION_TIMEOUT_MS)}ms`,
        );
        await quarantineRunner(label, state.teardownErrors, dataSource);
    }
}

/**
 * Reports a connection as unreturnable and destroys the owning pool, because there is no portable way to
 * cancel an in-flight statement through TypeORM's `QueryRunner` surface.
 *
 * Destroying the `DataSource` is bounded like every other cleanup action, and its own failure is recorded
 * too — an undestroyable pool is worse news than a destroyed one and must not be silent.
 */
async function quarantineRunner(label: string, errors: string[], dataSource: DataSource): Promise<void> {
    errors.push(
        `the connection for '${label}' could not be proven quiescent, so it was NOT released: returning ` +
            'it to the pool would hand live work to whichever test drew it next. It is reported as ' +
            'leaked and the owning DataSource is being destroyed, so later tests fail on a closed pool ' +
            'rather than inheriting this one',
    );
    const destroyed = await attemptWithinBudget(
        () => (dataSource.isInitialized ? dataSource.destroy() : Promise.resolve()),
        DEFAULT_CLEANUP_ACTION_TIMEOUT_MS,
    );
    if (destroyed.outcome === 'failed') {
        errors.push(
            `destroying the DataSource after quarantining '${label}' failed: ${describeReason(destroyed.reason)}`,
        );
    } else if (destroyed.outcome === 'unsettled') {
        errors.push(
            `destroying the DataSource after quarantining '${label}' did not settle within ` +
                `${String(DEFAULT_CLEANUP_ACTION_TIMEOUT_MS)}ms, so the pool may still hold the live connection`,
        );
    }
}

/**
 *
 * Rolls back and releases the runner of every chain that has not settled.
 *
 * Three properties make this teardown rather than a second hang, and all three are load-bearing:
 *
 *  - **Every action is bounded** by {@link DEFAULT_CLEANUP_ACTION_TIMEOUT_MS}, so a rollback queued behind
 *    the stalled statement that caused the abandonment cannot stop the release that follows it.
 *  - **Every runner is attempted**, and both are attempted **concurrently**, so neither the failure nor
 *    the stalling of one can prevent the other from being reclaimed.
 *  - **Nothing is discarded.** A failure and an unsettled attempt are equally recorded in
 *    `state.teardownErrors` and reported alongside the abandonment, never in place of it.
 */
async function reclaimAbandonedRunners(
    runners: QueryRunner[],
    tracked: TrackedChain[],
    state: ChainState,
    dataSource: DataSource,
    claims: CleanupClaim[],
): Promise<void> {
    const reclaims: Array<Promise<void>> = [];
    for (let index = 0; index < tracked.length; index++) {
        if (tracked[index].settled) {
            continue;
        }
        const runner = runners[index];
        if (runner === undefined) {
            continue;
        }
        const claim = claims[index];
        if (!claimCleanup(claim)) {
            // The participant's own chain reached its teardown first and owns this runner's cleanup.
            // Doing it here as well would race it — two concurrent rollbacks or releases on one
            // connection — so the claim decides, once, which side is responsible. But declining is only
            // half of it: the pair must also WAIT for that owner, or it throws its abandonment error
            // while a rollback, release or pool teardown is still running, and every diagnostic the
            // owner appends afterwards is lost. The wait is bounded like everything else here.
            reclaims.push(awaitClaimedCleanup(claim, tracked[index].label, state.teardownErrors));
            continue;
        }
        reclaims.push(
            settleRunner(
                runner,
                tracked[index].label,
                state,
                dataSource,
                // The real facts, published by the chain, rather than assumptions. A runner still stalled
                // in `connect()` reaches here with its recorded baseline and with `ownsRunner` false if it
                // arrived carrying a foreign transaction, so nothing of its owner's is touched — and with
                // `connectionAcquired` telling this side whether a pool connection is actually out, which
                // is what decides between quarantining an uncertain runner and leaving it alone.
                claim === undefined ? { active: false, depth: undefined, certain: false } : claim.baseline,
                claim === undefined ? true : claim.ownsRunner,
                claim === undefined ? false : claim.connectionAcquired,
            ),
        );
    }
    // `Promise.all` is safe here precisely because `settleRunner` never rejects: it converts every
    // outcome into a recorded diagnostic. Running the two concurrently is what stops a stalled rollback
    // on one connection from delaying the other's release by its whole budget.
    await Promise.all(reclaims);
}

/**
 * A one-shot cancellation signal shared by a pair and its participants. Deliberately hand-rolled rather
 * than `AbortController`: the e2e compiler project type-checks against the `es2015` lib surface, where
 * neither `AbortController` nor `AbortSignal` is declared, and the only thing needed here is "has the
 * pair been abandoned, and tell me when".
 */
interface CancellationToken {
    cancelled: boolean;
    readonly listeners: Array<() => void>;
}

/**
 * Marks a token cancelled and runs every listener once.
 *
 * A listener that throws does not stop its siblings from running — teardown must not be derailed by one
 * hook — but its failure is **recorded**, not discarded. A cancellation listener typically exists to
 * settle the promise its participant is blocked on, so one that throws is the reason that participant
 * stays stuck; swallowing it would delete the explanation for the very hang being reported.
 */
function cancelToken(token: CancellationToken, state: ChainState): void {
    if (token.cancelled) {
        return;
    }
    token.cancelled = true;
    const listeners = token.listeners.slice();
    token.listeners.length = 0;
    for (const listener of listeners) {
        try {
            listener();
        } catch (listenerError) {
            state.teardownErrors.push(
                `a cancellation listener threw while the pair was being abandoned: ${describeReason(listenerError)}`,
            );
        }
    }
}

/**
 * Builds the abandonment message: which participants did not settle, what is known about the ones that
 * did, and any failure met while reclaiming. Naming the stuck participant is the whole point — the test
 * runner's own timeout names nothing.
 */
function buildAbandonedPairMessage(
    tracked: TrackedChain[],
    deadlineMs: number,
    state: ChainState,
    barrier: ConcurrencyBarrier,
): string {
    const unsettled = tracked.filter(entry => !entry.settled).map(entry => entry.label);
    const settled = tracked.filter(entry => entry.settled);
    const parts: string[] = [
        `The barriered pair did not settle within ${String(deadlineMs)}ms and was abandoned. ` +
            `Still running: ${unsettled.length ? unsettled.join(', ') : 'none'}.`,
    ];
    for (const entry of settled) {
        parts.push(
            `Participant '${entry.label}' had already settled as ` +
                `${entry.outcome === undefined ? 'an unknown outcome' : summariseOutcome(entry.outcome)}.`,
        );
    }
    const arrived = barrier.arrivedLabels;
    const missing = barrier.missingLabels;
    parts.push(
        `At the rendezvous: arrived ${arrived.length ? arrived.join(', ') : 'none'}; ` +
            `still expected ${missing.length ? missing.join(', ') : 'none'}.`,
    );
    parts.push(
        'A participant blocked on a row lock it took BEFORE arriving is never waiting at the ' +
            'rendezvous, so the rendezvous timeout cannot reject it — this deadline is what bounds ' +
            'that case.',
    );
    if (state.teardownErrors.length) {
        parts.push(`Reclaiming the abandoned connections reported: ${state.teardownErrors.join('; ')}.`);
    }
    return parts.join(' ');
}

/**
 * Fails a completed run whose teardown reported anything, so that a leaked connection or an unclosed
 * transaction is a test failure at the point it happened rather than an unexplained hang two tests later.
 */
function assertNoTeardownFailure<A, B>(state: ChainState, result: BarrierResult<A, B>): void {
    if (!state.teardownErrors.length) {
        return;
    }
    throw harnessError(
        'The barriered pair completed but its teardown reported a problem, so the run is not usable as ' +
            `evidence: ${state.teardownErrors.join('; ')}. Outcomes were ` +
            `${summariseOutcome(result.a)} and ${summariseOutcome(result.b)}.`,
    );
}

/**
 * One participant's whole life cycle, as a single independent async chain: `connect` ->
 * `startTransaction` -> precheck -> rendezvous -> write -> commit or roll back -> restore the runner
 * to the transaction state it arrived in -> release. It never rejects: every failure, including a
 * failure at COMMIT, is mapped into a rejected {@link BarrierOutcome} so that the caller can assert
 * on it, because for a race claim a rejection is frequently the expected result.
 */
async function runParticipantChain<T>(
    queryRunner: QueryRunner,
    label: string,
    spec: NormalisedParticipantSpec<T>,
    barrier: ConcurrencyBarrier | undefined,
    isolationLevel: BarrierIsolationLevel | undefined,
    commitOnSuccess: boolean,
    state: ChainState,
    token: CancellationToken,
    dataSource: DataSource,
    claim?: CleanupClaim,
): Promise<BarrierOutcome<T>> {
    let arrived = false;
    let releasedBeforeWrite = false;
    // Claims this runner's teardown once and remembers it, so the failure path and the `finally` are one
    // indivisible responsibility rather than two separately-claimable steps. `undefined` means there is
    // no watchdog to contend with — sequential mode — so this chain owns it by default.
    let cleanupOwned = false;
    const ownCleanup = (): boolean => {
        if (!cleanupOwned) {
            cleanupOwned = claimCleanup(claim);
        }
        return cleanupOwned;
    };
    // The transaction state of the runner as this participant found it. Everything this chain closes
    // is measured against it, so a level that was already open is never this participant's to end.
    let baseline: TransactionState = { active: false, depth: undefined, certain: false };
    // Whether the CONNECTION is this participant's to give back, which is a different question from
    // whether a transaction level is its to close. A runner that arrived already inside a transaction
    // belongs to an outer owner: releasing it would return a connection to the pool with somebody
    // else's transaction (and its locks) still open on it, and would leave that owner holding a
    // runner it can no longer use. Such a runner is restored to its baseline and then left alone.
    let ownsRunner = false;
    // Whether this chain got as far as taking a pool connection. Distinct from every ownership question
    // above: a runner that was never connected has nothing to release and nothing to quarantine, while one
    // that was connected must reach exactly one of those two outcomes.
    let connectionAcquired = false;
    // Whether this chain still has a transaction level of its own open. Derived from OBSERVED runner
    // state rather than from whether startTransaction() resolved — see the inner catch — and cleared
    // the moment everything this chain added has been closed, so the teardown can never reinterpret
    // a level that was never ours as ours.
    let ownsTransaction = false;
    let baselineRestorationAttempted = false;
    // Returns the runner to the transaction state it arrived in, once, from whichever of the failure
    // path and the `finally` is reached first. The failure path calls it so that the settle counter
    // is taken only after this participant has genuinely finished, its rollback included, which is
    // what BarrierOutcomeBase.settledOrder promises; the `finally` calls it so that a path which
    // never reaches the failure branch still cannot release a connection with a transaction on it.
    const restoreBaseline = async (): Promise<void> => {
        if (baselineRestorationAttempted) {
            return;
        }
        baselineRestorationAttempted = true;
        if (!ownsTransaction) {
            return;
        }
        // ★ BOUNDED, on the same budget and for the same reason as every step inside
        // {@link settleRunner}. `restoreTransactionBaseline` ends with `rollbackTransaction()`, and a
        // rollback queued behind a stalled statement never settles. Awaiting that here without a bound is
        // the one failure a single-owner {@link CleanupClaim} cannot survive: this chain either never
        // reaches its `finally` at all, or reaches it and stalls while holding the claim — and either way
        // the whole-pair watchdog finds a cleanup it must not race, so the connection is NEITHER released
        // NOR quarantined and the pool is never destroyed. Abandoning the *attempt* at the budget keeps
        // the participant's own cleanup moving and hands `settleRunner` a runner it can still prove, or
        // fail to prove, is back at its baseline. That is rule 1 of the teardown contract, and it applies
        // to the failure path exactly as it applies to the `finally`.
        const restored = await attemptWithinBudget(
            () => restoreTransactionBaseline(queryRunner, baseline, label, state),
            DEFAULT_CLEANUP_ACTION_TIMEOUT_MS,
        );
        if (restored.outcome === 'settled') {
            // Ownership is discharged only when the transaction was genuinely ended.
            ownsTransaction = false;
            return;
        }
        if (restored.outcome === 'failed') {
            state.teardownErrors.push(
                `restoring the transaction state for '${label}' failed: ${describeReason(restored.reason)}`,
            );
        } else {
            state.teardownErrors.push(
                `restoring the transaction state for '${label}' did not settle within ` +
                    `${String(DEFAULT_CLEANUP_ACTION_TIMEOUT_MS)}ms, so the connection cannot be proven ` +
                    'clean by the path that opened it',
            );
        }
        // `ownsTransaction` is deliberately LEFT SET: a level this chain opened may still be open, and
        // the teardown must go on treating it as this participant's own so that `settleRunner` makes its
        // second, equally bounded attempt and then QUARANTINES rather than releasing a connection whose
        // state it cannot certify.
    };
    try {
        // Read the transaction state FIRST, inside this `try` and before anything else touches the
        // runner. A level that is already open belongs to somebody else, and every close below is
        // measured against this reading. Two properties make this the right position for it. It is
        // still "before anything was opened", because `connect()` takes a pool connection and opens no
        // transaction — so the baseline means exactly what the closes below assume. And it is inside
        // the protected lifecycle, so a `connect()` that throws now reaches the teardown carrying REAL
        // facts rather than assumed ones, which is what lets that path give a connection back instead
        // of stranding it.
        baseline = readTransactionState(queryRunner);
        // An already-open transaction makes the CONNECTION foreign too, not just the level. This is
        // decided here, before anything is opened on the runner and before any path can release it,
        // so the refusals below are genuinely refusals to touch it.
        ownsRunner = !baseline.active;
        // Published to the shared record in the same synchronous step as the reading, so the watchdog
        // measures against the same baseline and the same connection ownership this chain would, rather
        // than assuming either. A deadline that fires while this chain is still stalled — in `connect()`
        // as much as anywhere later — would otherwise have to guess, and guessing here means rolling
        // back or releasing work that was never this harness's.
        if (claim !== undefined) {
            claim.baseline = baseline;
            claim.ownsRunner = ownsRunner;
        }
        if (!baseline.certain) {
            // ★ REFUSED BEFORE A CONNECTION IS TAKEN, because an unreadable flag is not evidence of
            // anything. The fail-closed value says `active: true` so that no later step can release live
            // work, but that value is a substitution rather than an observation — and proceeding on it
            // would mean classifying this runner as somebody else's on the strength of a fact nobody
            // established. That classification is what rule 6 then acts on: a "foreign" runner is
            // deliberately neither released nor quarantined, so a runner this harness had connected would
            // be left holding a pool connection that no side would ever give back.
            throw harnessError(
                `Participant '${label}' was handed a query runner whose transaction flag could not be ` +
                    'read at all, so nothing about its state can be certified: this harness cannot tell a ' +
                    'connection with nothing open on it from one already carrying somebody else\u2019s ' +
                    'transaction, and every close, commit and release it performs is measured against ' +
                    'that reading. It refuses BEFORE taking a pool connection, so nothing was acquired ' +
                    'and nothing is left open or held. Hand it a runner whose `isTransactionActive` can ' +
                    'be read, or investigate the driver: a getter that throws usually means the ' +
                    'connection behind it has already gone.',
            );
        }
        // connect() is called explicitly so that this participant is holding a pool connection of
        // its own before its transaction opens. Two participants must never share one connection:
        // a single connection cannot hold two open transactions, so it cannot interleave, and a
        // test built on it would prove serialisation.
        await queryRunner.connect();
        // Recorded the moment the connection is genuinely this chain's, and published for the watchdog in
        // the same step. It is what lets the teardown distinguish "nothing was ever acquired" from "a
        // connection is out and its state can no longer be read", which are the same `ownsRunner` and
        // demand opposite treatment: report and leave alone, versus quarantine.
        connectionAcquired = true;
        if (claim !== undefined) {
            claim.connectionAcquired = true;
        }
        if (baseline.active && baseline.depth === undefined) {
            // ★ Refused in BOTH modes, including the sequential nesting this module otherwise
            // supports. A level opened on this runner could never be shown to have been closed
            // again: with a transaction already open, the public `isTransactionActive` flag reads
            // `true` before and after, so it cannot distinguish this participant's level from the
            // one it found, and the nesting counter that could is not observable here. Nesting
            // anyway would let a participant be reported fulfilled over a level it never closed —
            // and under `commitOnSuccess: false`, over work it was asked to discard and did not.
            throw harnessError(
                `Participant '${label}' was handed a query runner that is already inside a ` +
                    'transaction and does not expose a nesting depth, so a level opened on it could ' +
                    'not be shown to have been closed again: the public transaction flag reads the ' +
                    'same before and after, and there is no counter to compare. This harness refuses ' +
                    'to nest where it cannot certify that it restored what it found. Hand it a runner ' +
                    'with no transaction open, or use a driver whose query runner reports its ' +
                    `transaction depth. Observed state: ${describeTransactionState(baseline)}.`,
            );
        }
        if (barrier !== undefined && baseline.active) {
            // Refused rather than nested. A transaction opened on this runner now would be a
            // SAVEPOINT inside somebody else's transaction — sharing its connection and its locks,
            // invisible to it, and impossible to commit independently — so it could not evidence an
            // interleaving whatever the test then asserted. Failing here also keeps the teardown
            // honest: nothing this chain does can reach a level it did not open, and — because
            // `ownsRunner` is already false — nothing releases the runner out from under its owner
            // either. The refusal leaves it exactly as it was found.
            throw harnessError(
                `Participant '${label}' was handed a query runner that is already inside a ` +
                    'transaction, so it cannot evidence an interleaving: anything it opened now would ' +
                    "be a savepoint nested inside somebody else's transaction, sharing that " +
                    'connection and its locks rather than racing against them. runBarrieredPair ' +
                    'refuses instead of nesting. Let it create and own the two connections it uses, ' +
                    'and use runSequentialPair where work legitimately runs inside an outer ' +
                    `transaction. Observed state: ${describeTransactionState(baseline)}.`,
            );
        }
        try {
            // The isolation level is whatever the caller asked for. Omitted means the engine's own
            // default, which differs between engines and is then part of what the test asserts.
            // Published before the await, for the same reason the local flag is set after it is not
            // enough: every installed driver marks the runner transactional before it issues BEGIN, so a
            // watchdog reading this record mid-start must already know the level may be ours.
            if (claim !== undefined) {
                claim.ownsTransaction = true;
            }
            await queryRunner.startTransaction(isolationLevel);
            ownsTransaction = true;
        } catch (startError) {
            // ★ A rejection here does NOT mean no transaction exists. TypeORM flips
            // `isTransactionActive` to true and only then issues the statements that open the
            // transaction — `driver/mysql/MysqlQueryRunner.js:L83` ahead of the isolation statement
            // at L93 and START TRANSACTION at L95, `driver/postgres/PostgresQueryRunner.js:L113`
            // ahead of L122-L124, `driver/sqlite-abstract/AbstractSqliteQueryRunner.js:L61` ahead of
            // its PRAGMA and BEGIN — so a failure from any of those statements can leave the runner
            // carrying a half-started transaction whose flag is set while its depth was never
            // incremented. On PostgreSQL that half-start is a genuinely open server-side transaction
            // (START TRANSACTION is issued before the isolation statement), which is exactly why it
            // has to be closed rather than merely noted. Claiming it here, only where it is above
            // the baseline this participant found, is what lets the teardown close it.
            ownsTransaction = hasStateAboveBaseline(queryRunner, baseline);
            throw startError;
        }
        // ★ Post-start certification, run before any caller phase. `startTransaction` resolving is not
        // by itself proof that this chain now holds a level it will be able to account for, and every
        // guarantee below it — that a fulfilled participant's work completed, that teardown restores
        // what it found, that nothing foreign is ended — rests on that accounting. So the state is read
        // once, here, while the situation is still unambiguous, and anything short of certifiable is
        // refused rather than carried into a caller's precheck and write.
        const opened = readTransactionState(queryRunner);
        const lostDepthReporting = baseline.depth !== undefined && opened.depth === undefined;
        if (lostDepthReporting) {
            // The counter was readable when this chain read its baseline and is gone now that its own
            // level is open: a driver that stopped publishing it across `startTransaction`. Nothing
            // afterwards could distinguish this chain's level from any other, on a clean runner or a
            // nested one, so it refuses either way. It closes the level it just opened first, because
            // this is the one moment when doing so is unambiguous — `startTransaction` has returned and
            // no caller code has run, so the innermost level is certainly this chain's. Ownership is
            // dropped before the attempt so no later blind close can follow it onto somebody else's
            // transaction, and a close that fails is reported and not retried.
            ownsTransaction = false;
            let closedTheLevel = true;
            try {
                await queryRunner.rollbackTransaction();
            } catch (closeError) {
                closedTheLevel = false;
                state.teardownErrors.push(
                    `the transaction level opened for '${label}' could not be closed again after its ` +
                        `driver stopped reporting a transaction depth: ${describeReason(closeError)}`,
                );
            }
            throw harnessError(
                `Participant '${label}' opened its transaction on a runner whose driver stopped ` +
                    'reporting a transaction depth in the process, so this chain could no longer tell ' +
                    `its own level from any other. The level it opened ${
                        closedTheLevel
                            ? 'has been closed again and the participant refused'
                            : 'COULD NOT be closed again, which is reported separately, and the ' +
                              'participant is refused'
                    }, rather than risk ending a transaction that is not this harness's to end. ` +
                    `Baseline was ${describeTransactionState(baseline)}, and the depth was unreadable ` +
                    'immediately afterwards.',
            );
        }
        if (!hasStateAboveBaseline(queryRunner, baseline)) {
            // `startTransaction` resolved and yet the runner looks exactly as it did beforehand: no
            // level this chain could later commit, roll back or account for. Proceeding would run the
            // caller's write outside any transaction this chain controls and then report it committed,
            // which is the false fulfilment this module exists to make impossible. Nothing observable
            // was opened, so nothing is closed here — closes are aimed by observed state, never by the
            // assumption that a resolved call must have done something.
            ownsTransaction = false;
            throw harnessError(
                `Participant '${label}' called startTransaction successfully and the runner is ` +
                    'unchanged, so no transaction level this chain can account for was opened. Its ' +
                    'write would then run outside any transaction this harness controls and could not ' +
                    'honestly be reported as committed, so the participant is refused. Baseline was ' +
                    `${describeTransactionState(baseline)}, and the state immediately after starting ` +
                    `was ${describeTransactionState(opened)}.`,
            );
        }
        const context: BarrierParticipantContext = {
            label,
            queryRunner,
            manager: queryRunner.manager,
            cancelled: () => token.cancelled,
            onCancelled: (listener: () => void) => {
                if (token.cancelled) {
                    // Registered after the pair was already abandoned, so it is invoked at once — the
                    // participant asked to be told, and it is already true.
                    try {
                        listener();
                    } catch (listenerError) {
                        // ★ Recorded AND rethrown, because by this point recording alone would be
                        // indistinguishable from swallowing it: the abandonment error has already been
                        // built and thrown, so anything appended to the teardown diagnostics now can
                        // never reach it. Rethrowing puts the failure where it can still be seen — in
                        // the phase that called `onCancelled`. A broken unblock hook is why the
                        // participant will not come back, which is precisely what must not be hidden.
                        state.teardownErrors.push(
                            `a cancellation listener registered by '${label}' after abandonment threw: ` +
                                describeReason(listenerError),
                        );
                        throw listenerError;
                    }
                    return;
                }
                token.listeners.push(listener);
            },
        };
        const precheckResult = spec.precheck === undefined ? undefined : await spec.precheck(context);
        if (barrier !== undefined) {
            // ★ The rendezvous, entered by the harness. Registration is recorded from the barrier's
            // own record before the release is awaited, so a participant held here and then rejected
            // by a timeout or by a sibling's disposal still reports the arrival it made — while
            // `releasedBeforeWrite`, which is what certifies the run, can only become true on the
            // line after the release has actually been awaited. Nothing a caller writes sits between
            // the two, which is the whole point of splitting the phases.
            const released = barrier.arrive(label);
            arrived = barrier.arrivedLabels.indexOf(label) !== -1;
            await released;
            releasedBeforeWrite = barrier.released;
        }
        const value = await spec.write({ ...context, precheckResult });
        // End the transaction here, in this participant's own chain, the moment its write returns.
        // See the note in runBarrieredPair: waiting for the sibling before committing deadlocks on
        // every engine that blocks a second writer on a row lock. A failure raised by COMMIT is
        // this participant's own outcome and not a harness fault — under SERIALIZABLE that is
        // exactly where a serialization failure surfaces, and it is a genuine race result. Only the
        // levels this chain added are closed, so a write phase that opened a nested level and left it
        // open is unwound too, and a level that predates this participant never is.
        if (ownsTransaction) {
            await endTransactionLevels(queryRunner, baseline, commitOnSuccess ? 'commit' : 'rollback');
            // ★ The post-condition that keeps `fulfilled` honest. A fulfilled outcome asserts that this
            // participant's work completed as asked — committed under `commitOnSuccess`, deliberately
            // discarded otherwise — so it may not be constructed while anything this chain opened is
            // still open. Anything left here would be rolled back by the `finally` moments later, which
            // would make a reported commit into a silent discard. Raising instead routes the run through
            // the catch below, so the participant is reported rejected and its state is cleaned up.
            if (!isCertainlyAtBaseline(queryRunner, baseline)) {
                throw harnessError(
                    `Participant '${label}' could not complete its transaction: the runner is not ` +
                        `certifiably back at the state it started from after the ` +
                        `${commitOnSuccess ? 'commit' : 'rollback'}, so this participant's work would ` +
                        'be rolled back by its own teardown and reporting it as fulfilled would ' +
                        `describe a ${commitOnSuccess ? 'commit' : 'rollback'} that cannot be shown ` +
                        `to have happened (baseline ${describeTransactionState(baseline)}, now ` +
                        `${describeTransactionState(readTransactionState(queryRunner))}).`,
                );
            }
            // Ownership is discharged the instant everything this chain opened is closed, so the
            // teardown below cannot mistake a foreign outer level for this participant's work.
            ownsTransaction = false;
        }
        const settledOrder = state.settled++;
        return { label, arrived, releasedBeforeWrite, settledOrder, status: 'fulfilled', value };
    } catch (reason) {
        await restoreBaseline();
        const settledOrder = state.settled++;
        return { label, arrived, releasedBeforeWrite, settledOrder, status: 'rejected', reason };
    } finally {
        // Teardown on every path — a sibling that threw, a rendezvous that timed out, a transaction that
        // never opened — because a leaked query runner holds a pool connection and the next test then
        // hangs rather than failing.
        //
        if (ownCleanup()) {
            // The promise is published on the shared claim BEFORE it is awaited, with no `await` in
            // between, so a watchdog that finds this claim taken can wait for this exact cleanup rather
            // than returning while it is still in flight and losing every diagnostic appended after.
            const cleanup = (async (): Promise<void> => {
                await restoreBaseline();
                await settleRunner(
                    queryRunner,
                    label,
                    state,
                    dataSource,
                    baseline,
                    ownsRunner,
                    connectionAcquired,
                );
            })();
            if (claim !== undefined) {
                claim.completion = cleanup;
            }
            await cleanup;
        }
        // A participant that finished without reaching the rendezvous leaves its sibling waiting
        // for a partner that is never coming. Disposing turns that into an immediate named failure
        // on both sides instead of a wait that runs out the timeout. Note that the sibling's wait is
        // FAILED here, never satisfied: releasing it would let a half-populated pair look like a
        // completed interleaving.
        if (barrier !== undefined && !arrived && !barrier.released) {
            barrier.dispose(
                harnessError(
                    `Participant '${label}' finished without reaching the barrier — its connection, ` +
                        'its transaction or its precheck failed beforehand — so the rendezvous was ' +
                        'abandoned and every waiting participant rejected at once, rather than ' +
                        'left to run out the timeout.',
                ),
            );
        }
    }
}

interface NormalisedParticipantSpec<T> {
    label?: string;
    precheck?: (ctx: BarrierParticipantContext) => Promise<unknown>;
    write: (ctx: BarrierWriteContext<unknown>) => Promise<T>;
}

function normaliseParticipantSpec<T, P>(spec: BarrierParticipantSpec<T, P>): NormalisedParticipantSpec<T> {
    return spec as unknown as NormalisedParticipantSpec<T>;
}

/**
 * The transaction state this module measures a participant against: TypeORM's public
 * `isTransactionActive` flag, and its nesting depth where the driver exposes one.
 *
 * Both halves are needed, because neither alone describes the state a runner can be left in. The
 * flag says whether a transaction is open but not how many nested levels are; the depth says how
 * many levels the driver believes it has but is also the counter that a rollback issued for a level
 * the driver never counted drives *below* where it started.
 */
interface TransactionState {
    active: boolean;
    depth: number | undefined;
    /**
     * Whether `active` was **observed** rather than substituted.
     *
     * It is read on **every** state reading and not only on the baseline one, because a getter can start
     * throwing at any point: a runner whose connection object is torn out mid-chain was readable when the
     * participant began and is not readable when its teardown runs. Both {@link isCertainlyAtBaseline} and
     * rule 7 of {@link settleRunner} therefore consult the reading in front of them rather than trusting
     * that the first one still holds.
     */
    certain: boolean;
}

/**
 * The one driver-internal member this module reads. `transactionDepth` is declared `protected` on
 * `BaseQueryRunner` (`node_modules/typeorm/query-runner/BaseQueryRunner.d.ts:L71`) and is absent from
 * the public `QueryRunner` interface, which publishes only `isReleased` and `isTransactionActive`, so
 * it is reached structurally. Every use is defensive: a driver that does not expose a numeric depth
 * simply yields `undefined` and this module falls back to the public flag alone.
 */
interface TransactionDepthCarrier {
    transactionDepth?: unknown;
}

/**
 * How many closes one unwind may attempt before it gives up and raises. A bound rather than a count of
 * levels, because the loop is driven by observed driver state; reaching it is a failure, never a
 * stopping point — see {@link endTransactionLevels}.
 */
const MAX_TRANSACTION_UNWIND_STEPS = 8;

/**
 * Reads the state a participant is measured against. Total: never throws, and never assumes the
 * depth counter exists.
 *
 * ★ BOTH READS ARE GUARDED, and total is a promise this function has to keep rather than a description of
 * a happy path. Every decision in the teardown is taken from what this returns, and it is called from
 * inside `finally` blocks and from the pair watchdog — so an accessor that throws here does not produce a
 * wrong answer, it produces no answer at all, and a connection is then neither released nor quarantined.
 * A driver double, a runner whose connection object has been torn out from under it, or a getter that
 * consults a closed pool can all throw.
 */
function readTransactionState(queryRunner: QueryRunner): TransactionState {
    let depth: unknown;
    try {
        depth = (queryRunner as unknown as TransactionDepthCarrier).transactionDepth;
    } catch {
        depth = undefined;
    }
    let active: boolean;
    let certain: boolean;
    try {
        active = queryRunner.isTransactionActive;
        certain = true;
    } catch {
        // Fail closed on the VALUE, and say so in the same breath: `certain: false` is what stops a caller
        // treating this substitution as an observation. {@link readRunnerFlag} states the same rule for the
        // reads that only need the value.
        active = true;
        certain = false;
    }
    return {
        active,
        certain,
        depth: typeof depth === 'number' && isFinite(depth) ? depth : undefined,
    };
}

/**
 * Whether the runner currently carries anything **above** the baseline — that is, anything this
 * participant is responsible for. Where both depths are readable the comparison is on depth, which is
 * what distinguishes a nested level this participant added from the outer level it found; otherwise
 * the public flag is the only evidence available, and a transaction that was not active at the
 * baseline and is active now must be this participant's.
 */
function hasStateAboveBaseline(queryRunner: QueryRunner, baseline: TransactionState): boolean {
    const current = readTransactionState(queryRunner);
    if (baseline.depth !== undefined && current.depth !== undefined && current.depth > baseline.depth) {
        return true;
    }
    return current.active && !baseline.active;
}

/**
 * Whether the runner can be **shown** to be back at the state it started from — the positive
 * counterpart to {@link hasStateAboveBaseline}, and deliberately not its negation.
 */
function isCertainlyAtBaseline(queryRunner: QueryRunner, baseline: TransactionState): boolean {
    const current = readTransactionState(queryRunner);
    if (!current.certain) {
        return false;
    }
    if (baseline.depth !== undefined) {
        return (
            current.depth !== undefined &&
            current.depth === baseline.depth &&
            current.active === baseline.active
        );
    }
    return !baseline.active && !current.active;
}

/**
 * Closes every transaction level above the baseline, innermost first, committing or rolling back as
 * asked, and **raises unless it finishes the job**. Failures propagate: on the success path a failed
 * COMMIT is the participant's own outcome, and on the teardown path the caller catches and reports.
 *
 * ★ Not finishing is a failure, not a stopping condition. The bound and the progress check exist
 * because this loop is driven by driver state rather than by a count of its own — a driver that
 * resolves a close without unwinding anything would otherwise spin here, and a silent spin inside
 * teardown is the hang this module refuses to ship — but *returning quietly* when either trips would
 * be worse than the spin. On the success path the caller would then construct a fulfilled outcome
 * over work that is still open, and the participant's own `finally` would roll that work back
 * afterwards: a test told its write committed when the database threw it away. So both conditions
 * raise, the success path turns into a rejected outcome, and cleanup goes back to being cleanup
 * instead of a silent substitute for COMMIT.
 */
async function endTransactionLevels(
    queryRunner: QueryRunner,
    baseline: TransactionState,
    how: 'commit' | 'rollback',
): Promise<void> {
    let steps = 0;
    while (hasStateAboveBaseline(queryRunner, baseline)) {
        if (steps >= MAX_TRANSACTION_UNWIND_STEPS) {
            throw harnessError(
                `${how === 'commit' ? 'Committing' : 'Rolling back'} the transaction did not reach the ` +
                    `state it started from within ${String(MAX_TRANSACTION_UNWIND_STEPS)} closes, so ` +
                    'work this participant opened is still open. Nesting this deep is a fixture using ' +
                    `savepoints it never closes (baseline ${describeTransactionState(baseline)}, now ` +
                    `${describeTransactionState(readTransactionState(queryRunner))}).`,
            );
        }
        steps++;
        const before = readTransactionState(queryRunner);
        if (how === 'commit') {
            await queryRunner.commitTransaction();
        } else {
            await queryRunner.rollbackTransaction();
        }
        const after = readTransactionState(queryRunner);
        const unwound =
            before.depth !== undefined && after.depth !== undefined
                ? after.depth < before.depth
                : before.active && !after.active;
        if (!unwound) {
            throw harnessError(
                `${how === 'commit' ? 'A commit' : 'A rollback'} returned without ending anything, so ` +
                    'the transaction cannot be unwound by repeating it and work this participant ' +
                    `opened is still open (baseline ${describeTransactionState(baseline)}, before ` +
                    `${describeTransactionState(before)}, after ${describeTransactionState(after)}).`,
            );
        }
    }
}

/**
 * Returns a runner to the transaction state it arrived in, and reports rather than hides anything that
 * goes wrong doing so. Called once per participant from whichever of the failure path and the `finally`
 * is reached first, so it covers every way a chain can end — the precheck threw, the rendezvous timed
 * out, the write threw, COMMIT failed, or `startTransaction` itself failed after the driver had already
 * flipped its transaction flag.
 *
 * It closes only what sits above the baseline, so a level that was open before this participant started
 * is never touched: where a driver hands the same runner to two participants, ending the first one's
 * transaction from the second one's teardown would destroy work that is not its own.
 */
async function restoreTransactionBaseline(
    queryRunner: QueryRunner,
    baseline: TransactionState,
    label: string,
    state: ChainState,
): Promise<void> {
    if (hasStateAboveBaseline(queryRunner, baseline)) {
        try {
            await endTransactionLevels(queryRunner, baseline, 'rollback');
        } catch (rollbackError) {
            state.teardownErrors.push(
                `rolling back the transaction for '${label}' failed: ${describeReason(rollbackError)}`,
            );
        }
    }
    if (hasStateAboveBaseline(queryRunner, baseline)) {
        state.teardownErrors.push(
            `the transaction for '${label}' was still active after its rollback, so the connection ` +
                'cannot be returned to the pool clean — a lock retained here is what makes a later ' +
                `test hang instead of fail (baseline ${describeTransactionState(
                    baseline,
                )}, now ${describeTransactionState(readTransactionState(queryRunner))})`,
        );
        return;
    }
    if (baseline.active && !readTransactionState(queryRunner).active) {
        // ★ The transaction that was ALREADY OPEN when this participant arrived is gone. Whatever ended
        // it — the participant's own phases, or a close that reached further than the level it aimed at —
        // this is the loss of work that was never this harness's to end, and it is reported before any
        // bookkeeping repair is attempted. Repairing the counter here would put it back to a value
        // describing a transaction that no longer exists, which reads as a clean restoration and would
        // leave the runner internally inconsistent as well: exactly the masking this reports instead.
        state.teardownErrors.push(
            `the transaction that was already open on the runner for '${label}' is no longer active, ` +
                "so work that was not this participant's to end has been ended — its owner cannot " +
                `commit or roll back what is gone (baseline ${describeTransactionState(
                    baseline,
                )}, now ${describeTransactionState(readTransactionState(queryRunner))})`,
        );
        return;
    }
    if (!normaliseTransactionDepth(queryRunner, baseline)) {
        state.teardownErrors.push(
            `the transaction bookkeeping for '${label}' did not return to the state it started in, ` +
                'so a driver that caches and re-hands this runner would open a savepoint instead of a ' +
                `transaction next time (baseline ${describeTransactionState(
                    baseline,
                )}, now ${describeTransactionState(readTransactionState(queryRunner))})`,
        );
        return;
    }
    if (!isCertainlyAtBaseline(queryRunner, baseline)) {
        // The counter and the flag are certified together, after any repair rather than instead of it.
        // A repair that leaves either one disagreeing with the baseline has restored bookkeeping and not
        // state, and this participant's runner goes no further without that being said out loud.
        state.teardownErrors.push(
            `the runner for '${label}' could not be certified as back at the state it started in, so ` +
                'it is not safe to hand on: a transaction flag or nesting depth that disagrees with ' +
                `the baseline changes what the next caller's startTransaction does (baseline ` +
                `${describeTransactionState(baseline)}, now ${describeTransactionState(
                    readTransactionState(queryRunner),
                )})`,
        );
    }
}

/**
 * Puts TypeORM's nesting counter back to the baseline after an unwind that drove it below, and reports
 * whether the state now matches.
 *
 * The undershoot is a real and reachable case rather than a hypothetical: `rollbackTransaction()`
 * decrements the counter unconditionally (`driver/mysql/MysqlQueryRunner.js:L136`, and identically in
 * the PostgreSQL and SQLite runners), so rolling back a half-started transaction — one whose flag the
 * driver set before the statement that would have incremented the counter failed — leaves the counter
 * one below where it started. Rolling back is still the right cleanup, because on PostgreSQL that
 * half-start is an open server-side transaction; what must not survive it is the corrupted counter, so
 * it is repaired here and verified afterwards.
 */
function normaliseTransactionDepth(queryRunner: QueryRunner, baseline: TransactionState): boolean {
    if (baseline.depth === undefined) {
        return true;
    }
    const current = readTransactionState(queryRunner);
    if (current.depth === undefined) {
        return false;
    }
    if (current.active !== baseline.active) {
        // ★ Not a counter problem, and so not this function's to paper over. A flag that disagrees with
        // the baseline means a transaction was opened or ended rather than miscounted, and writing a
        // number over it would describe a transaction that is not there — which is how the loss of an
        // outer transaction came to be reported as a clean restoration. The caller reports it instead.
        return false;
    }
    if (current.depth === baseline.depth) {
        return true;
    }
    if (current.depth > baseline.depth) {
        return false;
    }
    (queryRunner as unknown as { transactionDepth: number }).transactionDepth = baseline.depth;
    return readTransactionState(queryRunner).depth === baseline.depth;
}

/** Describes a transaction state for a diagnostic message. */
function describeTransactionState(state: TransactionState): string {
    const depth = state.depth === undefined ? 'unreadable' : String(state.depth);
    return `active=${String(state.active)}, depth=${depth}`;
}

/**
 * Takes two query runners for a barriered pair and refuses to proceed unless they are genuinely
 * distinct objects.
 *
 * This is the exclusion in {@link SINGLE_CONNECTION_ENGINES} enforced rather than merely
 * documented. TypeORM's SQLite-family drivers cache one query runner and hand the same instance
 * back on every call — `node_modules/typeorm/driver/sqljs/SqljsDriver.js:L46-L50`,
 * `driver/sqlite/SqliteDriver.js:L42-L46` and `driver/better-sqlite3/BetterSqlite3Driver.js:L40-L44`
 * all read `if (!this.queryRunner) this.queryRunner = new ...; return this.queryRunner` — whereas
 * the server drivers construct a new one each time (`driver/postgres/PostgresDriver.js:L425-L427`,
 * `driver/mysql/MysqlDriver.js:L358-L360`). Two participants sharing one runner share one
 * transaction, so the second's `startTransaction` fails against the first's and no interleaving is
 * possible. Failing here, by name, is far better than letting that surface as an obscure
 * "transaction already started" from inside a participant body.
 */
async function createDistinctRunners(dataSource: DataSource): Promise<[QueryRunner, QueryRunner]> {
    const first = dataSource.createQueryRunner();
    let second: QueryRunner;
    try {
        second = dataSource.createQueryRunner();
    } catch (creationError) {
        throw attachTeardownNote(
            asHarnessFailure(creationError, 'Creating the second query runner for a barriered pair failed.'),
            await releaseAbandonedRunner(first),
        );
    }
    if (first === second) {
        throw attachTeardownNote(
            harnessError(
                'runBarrieredPair cannot evidence anything on this engine: its driver returned the ' +
                    'same QueryRunner for both participants, so the two would share one connection ' +
                    'and one transaction and could never interleave. That is the single-connection ' +
                    `family (${SINGLE_CONNECTION_ENGINES.join(', ')}), whose TypeORM driver caches ` +
                    'one query runner. Gate the barrier case with ' +
                    'it.skipIf(!supportsForcedInterleaving()) and let runSequentialPair carry the ' +
                    'sequential form of the same contract here.',
            ),
            await releaseAbandonedRunner(first),
        );
    }
    return [first, second];
}

/**
 * Releases a runner that is being abandoned before any participant used it, and **describes** whatever
 * happened instead of discarding it — returning `undefined` when there is nothing to report.
 *
 * The reason this returns rather than swallows is that a runner which could not be released is a held
 * pool connection, which is the one failure this module treats as too consequential to hide anywhere
 * else. Its caller is already throwing, so the description is attached to that error by
 * {@link attachTeardownNote}: the primary diagnosis stays primary, and the leak is still on the record.
 */
async function releaseAbandonedRunner(queryRunner: QueryRunner): Promise<string | undefined> {
    // Both flags are read fail-closed: an unreadable `isReleased` reads as NOT released so a release is
    // attempted rather than a leak assumed away, and an unreadable `isTransactionActive` reads as ACTIVE
    // so live work is never returned to the pool. See {@link readRunnerFlag}.
    if (readRunnerFlag(() => queryRunner.isReleased, false)) {
        return undefined;
    }
    if (readRunnerFlag(() => queryRunner.isTransactionActive, true)) {
        return (
            "the query runner being abandoned is inside a transaction that is not this harness's to " +
            'end, so it has been left connected and unreleased rather than returned to the pool ' +
            "carrying somebody else's transaction and its locks"
        );
    }
    // Bounded like every other teardown action. This runs while its caller is already throwing, so a
    // release that never settles here would replace a named creation failure with an unexplained hang.
    const released = await attemptWithinBudget(
        () => queryRunner.release(),
        DEFAULT_CLEANUP_ACTION_TIMEOUT_MS,
    );
    if (released.outcome === 'failed') {
        return (
            'the abandoned query runner could also not be released, so it is still holding a pool ' +
            `connection: ${describeReason(released.reason)}`
        );
    }
    if (released.outcome === 'unsettled') {
        return (
            'releasing the abandoned query runner did not settle within ' +
            `${String(DEFAULT_CLEANUP_ACTION_TIMEOUT_MS)}ms, so it may still be holding a pool connection`
        );
    }
    return undefined;
}

/**
 * Combines a primary failure with something observed during the teardown that followed it, without
 * letting either hide the other.
 *
 * When there is nothing to add the primary error is returned **exactly as it arrived** — same object,
 * same type, same stack — because that error is the diagnosis and re-wrapping it would cost the reader
 * the frame where it came from. When there is, it is appended to that same error's message for the same
 * reason: the alternative is either to throw the teardown observation instead (which loses why the
 * runner was being abandoned at all) or to discard it (which loses a leaked connection, or the fact
 * that a runner was deliberately left to its owner).
 */
function attachTeardownNote(primary: Error, note: string | undefined): Error {
    if (note === undefined) {
        return primary;
    }
    primary.message =
        `${primary.message} A second fact from the teardown that followed is reported here rather ` +
        `than discarded: ${note}`;
    return primary;
}

/**
 * Builds the caller-facing result. `winner` and `loser` are populated only when exactly one
 * participant fulfilled and exactly one rejected; any other combination leaves both `undefined`,
 * so that a both-succeeded run (a duplicate-insert race whose loser reconciles) or a both-failed
 * run cannot be misread as a clean one-winner race.
 */
function assembleBarrierResult<A, B>(
    outcomeA: BarrierOutcome<A>,
    outcomeB: BarrierOutcome<B>,
): BarrierResult<A, B> {
    const outcomes: Array<BarrierOutcome<A | B>> = [outcomeA, outcomeB];
    const fulfilled = outcomes.filter(outcome => outcome.status === 'fulfilled');
    const rejected = outcomes.filter(outcome => outcome.status === 'rejected');
    const unambiguous = fulfilled.length === 1 && rejected.length === 1;
    return {
        a: outcomeA,
        b: outcomeB,
        winner: unambiguous ? fulfilled[0] : undefined,
        loser: unambiguous ? rejected[0] : undefined,
        fulfilled,
        rejected,
    };
}

/**
 *
 * The single gate a run passes before its result is handed to the caller. It refuses two classes of
 * outcome, and it refuses them together rather than one at a time, so that neither can mask the
 * other:
 *
 * 1. **A rendezvous that did not happen**, when `requireArrival` is set — which it is for
 *    {@link runBarrieredPair} and is not for {@link runSequentialPair}. A pair in which either
 *    participant never reached the barrier was never inside the same window, so the run is not race
 *    evidence and must not be returned as though it were. This is the check that stops a suite whose
 *    bodies forgot to arrive from reporting a clean one-winner race.
 * 2. **A participant that could not be torn down cleanly.** A leaked query runner holds a pool
 *    connection, and the next test then hangs instead of failing, which is why this is raised rather
 *    than hidden.
 *
 * Both participant outcomes are carried in the message either way, so raising cannot lose what the two
 * callers actually observed.
 */
function assertHarnessIntegrity<A, B>(
    state: ChainState,
    result: BarrierResult<A, B>,
    requireArrival: boolean,
): void {
    const problems: string[] = [];
    if (requireArrival) {
        const outcomes: Array<BarrierOutcome<A | B>> = [result.a, result.b];
        for (const outcome of outcomes) {
            if (!outcome.arrived) {
                problems.push(
                    `participant '${outcome.label}' never reached the rendezvous, so the two were ` +
                        'never inside the window the race is about and this run evidences no ' +
                        'interleaving',
                );
            } else if (!outcome.releasedBeforeWrite) {
                problems.push(
                    `participant '${outcome.label}' registered at the rendezvous but was never ` +
                        'released from it before its write phase, so its write never ran inside the ' +
                        'window and this run evidences no interleaving',
                );
            }
        }
    }
    for (const teardownError of state.teardownErrors) {
        problems.push(teardownError);
    }
    if (problems.length === 0) {
        return;
    }
    throw harnessError(
        'The concurrency harness cannot certify this run, so it is raising rather than returning a ' +
            'result that would be read as evidence. A rendezvous that did not happen proves nothing ' +
            'about an interleaving, and a query runner that was not torn down cleanly holds a pool ' +
            `connection until the next test hangs instead of failing. Problems: ${problems.join(
                ' | ',
            )}. The participant outcomes are carried here so that they are not lost: ` +
            `${summariseOutcome(result.a)}; ${summariseOutcome(result.b)}.`,
    );
}

function summariseOutcome(outcome: BarrierOutcome<unknown>): string {
    const arrival = `arrived: ${String(outcome.arrived)}, releasedBeforeWrite: ${String(
        outcome.releasedBeforeWrite,
    )}`;
    // The label was guarded at intake by `resolveDistinctLabels`, so it is this module's own text by the
    // time it reaches here.
    const label = outcome.label;
    if (outcome.status === 'fulfilled') {
        return `'${label}' fulfilled (${arrival})`;
    }
    return `'${label}' rejected with ${describeReason(outcome.reason)} (${arrival})`;
}

/**
 * Resolves both labels, defaulting them to `'a'` and `'b'`, and refuses a pair that cannot be told
 * apart — a label identifies an outcome and names a missing participant in the timeout diagnosis,
 * so two identical labels would make both unreadable.
 */
function resolveDistinctLabels<A, B, PA, PB>(
    participants: BarrierParticipants<A, B, PA, PB>,
): [string, string] {
    // ★ GUARDED HERE, AT INTAKE, RATHER THAN AT EVERY PLACE A LABEL IS RENDERED. A label is caller-supplied
    // and it is interpolated into roughly thirty-five diagnostics in this file — every teardown note, every
    // refusal, the abandonment message and the outcome summary. Every one of those is thrown, printed by the
    // runner and read in a build log, so a label carrying a value leaks from all of them at once; and the
    // natural way to make a per-item participant readable is to interpolate the item, which is exactly how
    // such a label appears. Refusing the shapes a value arrives in ONCE, where the caller's label becomes
    // the harness's, makes every render site safe — including the ones added after this comment, which is
    // the half that reviewing each render site cannot deliver. See `describeTeardownStage`.
    const rawA = participants.a.label === undefined ? 'a' : participants.a.label;
    const rawB = participants.b.label === undefined ? 'b' : participants.b.label;
    const labelA = safeParticipantLabel(rawA, 1);
    // ★ THE REFUSAL IS KEYED ON THE RAW LABELS, AND THE COLLISION AVOIDANCE ON THE RENDERED ONES. Those are
    // two different questions and conflating them gets one of them wrong whichever way it is conflated.
    //
    // Two participants the caller named IDENTICALLY are a caller mistake and stay refused: a label
    // identifies an outcome and names a missing participant when the rendezvous times out, so a pair that
    // cannot be told apart is unusable as evidence.
    if (rawA === rawB) {
        throw harnessError(
            `Both participants are labelled '${labelA}', but the two must be distinguishable: a ` +
                'label identifies an outcome and names a missing participant when the rendezvous ' +
                'times out.',
        );
    }
    // Two DISTINCT raw labels, on the other hand, must never end up sharing one rendered identity — and
    // that is possible in BOTH directions, because the ordinal substitute is itself a string a caller can
    // pass, so the substitute set and the accepted set overlap. Either the accepted label is A's and the
    // refused one is B's, or the refused one is A's and the accepted one is B's. An earlier revision
    // advanced B only when B ITSELF had been refused, which covered the first direction and left the
    // second: a refused A renders `<participant-1>`, an accepted B literally equal to `<participant-1>`
    // passes the character allowlist untouched, and the pair was rejected as indistinguishable when it was
    // nothing of the kind. So the advance below is unconditional on provenance and looks only at the
    // rendered value. It terminates because each turn tries a fresh ordinal and only one value is excluded.
    let ordinalForB = 2;
    let labelB = safeParticipantLabel(rawB, ordinalForB);
    while (labelB === labelA) {
        ordinalForB += 1;
        labelB = `<participant-${String(ordinalForB)}>`;
    }
    return [labelA, labelB];
}

/**
 * Whether a value is an integer of at least 1. Takes `unknown` deliberately, so that it also
 * guards a JavaScript caller who ignores the declared types.
 */
function isPositiveInteger(value: unknown): boolean {
    return typeof value === 'number' && isFinite(value) && Math.floor(value) === value && value >= 1;
}

/**
 * Normalises an arbitrary rejection reason into an `Error`, preserving it when it already is one
 * so that a caller's own stack survives.
 */
function asHarnessFailure(reason: unknown, fallbackMessage: string): Error {
    // An error THIS MODULE authored is its own text and travels intact, identity included, so a caller
    // that compares against a harness error still can.
    if (isHarnessAuthored(reason)) {
        return reason;
    }
    if (reason === undefined) {
        return harnessError(fallbackMessage);
    }
    // ★ A FOREIGN REASON IS CONVERTED BEFORE IT IS STORED OR REJECTED WITH, NOT WHEN IT IS PRINTED.
    // Returning it unchanged — which this did — is what let a caller's `QueryFailedError` become the
    // barrier's stored `failure`, be handed to every waiting participant, and have its `.message`
    // replayed verbatim by every later arrival. A driver error carries the statement and its bound
    // parameters as enumerable own properties, so each of those was a place they reached a build log.
    // Converting here means no downstream site has to remember: what is stored is already safe.
    return harnessError(`${fallbackMessage} Reason: ${redactTeardownDiagnostic(reason)}`);
}

/**
 * Describes a CALLER-SUPPLIED ARGUMENT for an argument-validation message. Total by construction: a value
 * that cannot be serialised or stringified still produces a string rather than throwing from inside an
 * error path, which would replace a real diagnosis with a secondary failure.
 *
 * ★ **NOT FOR A CAUGHT FAILURE OR A REJECTION REASON — USE `redactTeardownDiagnostic` FOR THOSE.** This
 * function reproduces the value it is given, and that is correct for the three things that still call it:
 * a participant count and two timeouts, each a number this package's own test passed in, where
 * `but received "abc"` is the whole diagnosis. It was also being used for every caught failure in this
 * file, and there it was wrong for two compounding reasons. A participant of this harness writes straight
 * through the repository, so its rejection is a TypeORM `QueryFailedError` — and TypeORM copies the driver's
 * error ONTO it, making `query` and `parameters` its own enumerable properties. So the `value.message`
 * branch published the driver's sentence, and the `JSON.stringify` branch published the statement and every
 * bound value with it, into a build log.
 *
 * The split is deliberate rather than incidental: the two jobs read alike and are opposites. One describes a
 * value the test chose, the other describes a value the database produced.
 */
function describeUnknown(value: unknown): string {
    if (typeof value === 'string') {
        return value;
    }
    if (value instanceof Error) {
        return value.message;
    }
    try {
        const serialised = JSON.stringify(value);
        return serialised === undefined ? String(value) : serialised;
    } catch {
        return '[a value that could not be described]';
    }
}

/**
 * @description
 * One participant's hold, installed on its own query runner and reporting whether it actually fired.
 */
export interface PreWriteHold {
    /**
     * Whether the participant was actually held. A race whose hold never fired proves nothing at all, so
     * this is asserted rather than assumed: a service that changed shape and stopped writing through this
     * runner would otherwise leave the pair looking interleaved when it never was.
     */
    readonly held: () => boolean;
    /** The statement the hold fired on, for a diagnostic that names what was about to run. */
    readonly heldBefore: () => string | undefined;
    /**
     * `'arrival'` when this hold was let go because every required participant had arrived AND every
     * participant that arrived earlier was still waiting at that moment; `undefined` otherwise.
     *
     * THIS IS THE ONLY THING THAT CERTIFIES A HOLD, and a whole-rendezvous flag is not a substitute for
     * it. A rendezvous that timed out one participant and then received the other's arrival later has
     * seen every participant arrive without any two of them ever overlapping, so a count of arrivals
     * cannot tell the two runs apart. This value can only be `'arrival'` for a hold that was still
     * waiting when the set completed.
     */
    readonly releasedBy: () => 'arrival' | undefined;
    /** Puts the runner's own `query` back. Call it in a `finally`. */
    readonly restore: () => void;
}

/**
 * @description
 * A rendezvous **inside** the operation under test, tripped immediately before its first write.
 */
export interface PreWriteRendezvous {
    /** Patches one participant's query runner. Returns the hold, which the caller must restore. */
    readonly install: (ctx: BarrierParticipantContext) => PreWriteHold;
    /** Every hold installed so far, so a test can certify each one rather than a whole-pair aggregate. */
    readonly holds: () => readonly PreWriteHold[];
    /** How many arrivals — held participants plus {@link PreWriteRendezvous.arriveExternally} — occurred. */
    readonly arrivedCount: () => number;
    /** How many holds were installed, so a test can assert every participant it patched actually fired. */
    readonly installedCount: () => number;
    /**
     * How many holds are still waiting. Asserted by the fixture's own self-checks so that a hold which was
     * rejected is proved to have left the waiting set with its timer cleared, rather than merely to have
     * rejected — a retained waiter would keep a timer alive past the end of the test that created it.
     */
    readonly waitingCount: () => number;
    /**
     * Whether the release came from the complete arrival set with every earlier participant still waiting.
     *
     * Latched: once the rendezvous has failed it can never become `true`, and it is never set by an arrival
     * that completed the count after an earlier participant had already been let go.
     */
    readonly releasedByArrival: () => boolean;
    /**
     * Why the rendezvous failed, or `undefined` while it is sound. A failure is **permanent**: every hold
     * still waiting is rejected, every later arrival throws, and no held write is ever delegated.
     */
    readonly failureReason: () => Error | undefined;
    /**
     * Counts an arrival made from OUTSIDE a held participant, releasing the pair once the threshold is met.
     *
     * This is what lets a rendezvous hold ONE real operation while the test itself supplies the conflicting
     * state the operation is about to collide with. Some operations cannot be held two at a time and the
     * reason is a property of the operation rather than of this harness: `createReorderList` takes a
     * pessimistic write lock on the owning customer row as its FIRST statement, so a second caller for the
     * same customer blocks there and can never reach its own write while the first is held. Holding one
     * caller and introducing the conflict from the test is the only way to put a real operation inside the
     * window between its own duplicate lookup and its own insert.
     */
    readonly arriveExternally: () => void;
    /**
     * Waits until at least `count` arrivals have occurred, resolving `true` if they did and `false` if the
     * wait expired or the rendezvous failed first. Returned rather than thrown so the caller can assert on
     * it: a test that carried on regardless would introduce its conflicting state before the operation had
     * reached its hold, and would then be exercising the ordinary pre-check path while claiming to exercise
     * the constraint.
     */
    readonly waitForArrivals: (count: number, timeoutMs?: number) => Promise<boolean>;
}

/** One waiting hold's internal state: how to let it go, how to refuse it, and its own timer. */
interface PreWriteHoldState {
    resolve: () => void;
    reject: (reason: Error) => void;
    timer: ReturnType<typeof setTimeout> | undefined;
    releasedBy: 'arrival' | undefined;
}

/**
 * @description
 * Holds every participant immediately before its FIRST WRITE, so that two real service operations are
 * simultaneously past their own reads and short of their own writes.
 *
 * WHY THE OUTER RENDEZVOUS IS NOT ENOUGH, WHICH IS THE WHOLE REASON THIS EXISTS. {@link runBarrieredPair}
 * holds both participants between their precheck and their write phase, so both service calls *start*
 * together. That is necessary and not sufficient: the operation's own duplicate lookup, quantity read or
 * capacity claim happens after the release, so the two operations may still run one after the other. A
 * service that counted and then inserted without a constraint, or read-computed-and-saved a quantity, would
 * then have the second caller observe the first caller's commit and produce a correct-looking final state —
 * the exact defect the race is supposed to catch, passing.
 *
 * @param options - `participants` is how many arrivals must occur before any hold is released; `tables`
 * restricts the hold to writes naming one of them, so a platform write elsewhere in the transaction cannot
 * trip it; `timeoutMs` bounds how long one hold may wait before the rendezvous is failed.
 */
export function createPreWriteRendezvous(options: {
    participants: number;
    tables: readonly string[];
    timeoutMs?: number;
}): PreWriteRendezvous {
    const timeoutMs = options.timeoutMs ?? DEFAULT_BARRIER_TIMEOUT_MS;
    const waiting = new Set<PreWriteHoldState>();
    const arrivalWatchers = new Set<{
        readonly count: number;
        readonly notify: (reached: boolean) => void;
    }>();
    const installedHolds: PreWriteHold[] = [];
    let arrived = 0;
    let holdArrivals = 0;
    let releasedByArrival = false;
    let failure: Error | undefined;

    /** Wakes every observer whose arrival threshold the current count has reached. */
    const notifyArrivalWatchers = (): void => {
        for (const watcher of [...arrivalWatchers]) {
            if (arrived >= watcher.count) {
                arrivalWatchers.delete(watcher);
                watcher.notify(true);
            }
        }
    };

    /**
     * Refuses ONE hold: takes it out of the waiting set, clears its timer, and rejects it.
     *
     * The `delete` result is the idempotence guard, so a hold that has already been released or refused is
     * left alone — which matters because a cancellation and a timeout can both fire for the same hold, and
     * because a hold refused synchronously during its own registration must not then be refused again.
     */
    const discardHold = (state: PreWriteHoldState, reason: Error): void => {
        if (!waiting.delete(state)) {
            return;
        }
        if (state.timer !== undefined) {
            clearTimeout(state.timer);
            state.timer = undefined;
        }
        state.reject(reason);
    };

    /**
     * Fails the rendezvous once and for all: every waiting hold is REJECTED (so its statement is never
     * delegated), every timer is cleared, and every watcher is woken with `false`.
     */
    const failRendezvous = (reason: Error): void => {
        if (failure !== undefined) {
            return;
        }
        failure = reason;
        for (const state of [...waiting]) {
            discardHold(state, reason);
        }
        for (const watcher of [...arrivalWatchers]) {
            arrivalWatchers.delete(watcher);
            watcher.notify(false);
        }
    };

    /** Lets every waiting hold go, recording on each one that ARRIVAL is what released it. */
    const releaseAllByArrival = (): void => {
        releasedByArrival = true;
        for (const state of [...waiting]) {
            waiting.delete(state);
            if (state.timer !== undefined) {
                clearTimeout(state.timer);
                state.timer = undefined;
            }
            state.releasedBy = 'arrival';
            state.resolve();
        }
    };

    const countArrival = (isHold: boolean): boolean => {
        if (failure !== undefined) {
            throw asHarnessFailure(failure, 'The pre-write rendezvous has already failed');
        }
        const earlierHoldArrivals = holdArrivals;
        if (isHold) {
            holdArrivals += 1;
        }
        arrived += 1;
        notifyArrivalWatchers();
        if (arrived < options.participants) {
            return false;
        }
        if (waiting.size !== earlierHoldArrivals) {
            failRendezvous(
                harnessError(
                    'The pre-write rendezvous completed its arrival count without the participants ever ' +
                        `overlapping: ${String(earlierHoldArrivals)} participant(s) had arrived earlier but ` +
                        `only ${String(waiting.size)} were still waiting, so at least one had already been ` +
                        'let go. A run in which the callers reached their writes one after the other is not ' +
                        'evidence of an interleaving and is refused rather than reported.',
                ),
            );
            throw asHarnessFailure(failure, 'The pre-write rendezvous refused a sequential arrival set');
        }
        return true;
    };

    const isTargetedWrite = (statement: string): boolean => {
        if (!/^\s*(?:insert|update|delete)\b/i.test(statement)) {
            return false;
        }
        const lowered = statement.toLowerCase();
        return options.tables.some(table => lowered.includes(table.toLowerCase()));
    };

    const arrive = async (ctx: BarrierParticipantContext, state: PreWriteHoldState): Promise<void> => {
        if (countArrival(true)) {
            // This arrival completed the set, so it is released by arrival exactly as its siblings are —
            // including the one-participant case, where it never joins the waiting set at all.
            state.releasedBy = 'arrival';
            releaseAllByArrival();
            return;
        }
        await new Promise<void>((resolve, reject) => {
            state.resolve = resolve;
            state.reject = reject;
            // ★ IN THE WAITING SET BEFORE ANYTHING THAT CAN FAIL THE RENDEZVOUS, AND THE ORDER IS THE WHOLE
            // POINT. `onCancelled` invokes its listener SYNCHRONOUSLY when the pair has already been
            // abandoned, so registering before joining the set would run `failRendezvous` over an empty set,
            // latch the failure, and then add this state to a set nothing will ever visit again — leaving the
            // intercepted statement pending for ever and hanging the suite's teardown rather than failing it.
            waiting.add(state);
            try {
                // Two ways this hold can be FAILED — never satisfied: its own bound, and the whole-pair
                // deadline this harness already owns. Both reject, so the intercepted write does not run.
                state.timer = setTimeout(() => {
                    failRendezvous(
                        harnessError(
                            `A pre-write hold for '${ctx.label}' waited ${String(timeoutMs)}ms without ` +
                                'every participant arriving. The rendezvous is failed rather than released: ' +
                                'letting this write proceed would allow a later arrival to complete the ' +
                                'count and report an overlap that never happened.',
                        ),
                    );
                }, timeoutMs);
                state.timer.unref?.();
                ctx.onCancelled(() => {
                    failRendezvous(
                        harnessError(
                            `The pair was abandoned while a pre-write hold for '${ctx.label}' was waiting, ` +
                                'so the rendezvous is failed rather than released.',
                        ),
                    );
                });
            } catch (registrationFailure: unknown) {
                // A context that cannot register a timer or a cancellation listener leaves this hold with no
                // way to ever be woken, so it is refused here rather than left to hang. Deterministic, and it
                // takes the rendezvous with it: a participant this harness cannot supervise must not write.
                failRendezvous(
                    asHarnessFailure(
                        registrationFailure,
                        `A pre-write hold for '${ctx.label}' could not register its own escapes, so it ` +
                            'cannot be supervised and is refused.',
                    ),
                );
            }
            if (failure !== undefined) {
                // Already failed — by a synchronous cancellation above, by the registration failure above, or
                // by a sibling between this hold's arrival and its registration. Refused now rather than left
                // waiting for an event that has already happened.
                discardHold(state, failure);
            }
        });
    };

    return {
        arrivedCount: () => arrived,
        installedCount: () => installedHolds.length,
        waitingCount: () => waiting.size,
        holds: () => installedHolds,
        releasedByArrival: () => releasedByArrival && failure === undefined,
        failureReason: () => failure,
        arriveExternally: () => {
            if (countArrival(false)) {
                releaseAllByArrival();
            }
        },
        waitForArrivals: (count: number, waitMs?: number): Promise<boolean> => {
            if (failure !== undefined) {
                return Promise.resolve(false);
            }
            if (arrived >= count) {
                return Promise.resolve(true);
            }
            return new Promise<boolean>(resolve => {
                // ONE-SHOT, AND IT RELEASES BOTH ESCAPES ON WHICHEVER PATH ANSWERS FIRST.
                //
                // A wait installs two of them — a watcher in `arrivalWatchers` and a bounded timer — and
                // exactly one is ever going to fire. Resolving the promise and leaving the other one alive
                // would keep a timer pending for the whole of `waitMs` after an ARRIVAL answered the wait,
                // holding this closure and the rendezvous state it captures reachable, and then firing inside
                // whichever LATER test happened to be running by the time it elapsed. It would be harmless to
                // this wait, which had already settled, and that is exactly what makes it worth guarding: an
                // escape that outlives the thing it was guarding is invisible until it fires somewhere it was
                // never meant to.
                let settled = false;
                let expiry: ReturnType<typeof setTimeout> | undefined;
                let watcher:
                    | { readonly count: number; readonly notify: (reached: boolean) => void }
                    | undefined;
                const settle = (reached: boolean): void => {
                    if (settled) {
                        return;
                    }
                    settled = true;
                    if (watcher !== undefined) {
                        arrivalWatchers.delete(watcher);
                        watcher = undefined;
                    }
                    if (expiry !== undefined) {
                        clearTimeout(expiry);
                        expiry = undefined;
                    }
                    resolve(reached);
                };
                watcher = { count, notify: settle };
                arrivalWatchers.add(watcher);
                // Bounded, so a run in which the held operation never reaches its write reports a failed
                // wait rather than hanging the suite until its whole-file timeout.
                expiry = setTimeout(
                    () => settle(failure === undefined && arrived >= count),
                    waitMs ?? timeoutMs,
                );
                expiry.unref?.();
            });
        },
        install: (ctx: BarrierParticipantContext): PreWriteHold => {
            const runner = ctx.queryRunner;
            const original = runner.query.bind(runner);
            const state: PreWriteHoldState = {
                resolve: () => undefined,
                reject: () => undefined,
                timer: undefined,
                releasedBy: undefined,
            };
            let heldBefore: string | undefined;
            const patched = async (
                statement: string,
                parameters?: unknown[],
                useStructuredResult?: boolean,
            ): Promise<unknown> => {
                if (heldBefore === undefined && isTargetedWrite(statement)) {
                    heldBefore = statement;
                    // Throws when the rendezvous fails, so the statement below is NOT reached. That is the
                    // whole point: a hold that was not released by arrival must not write.
                    await arrive(ctx, state);
                }
                return original(statement, parameters as never, useStructuredResult as never);
            };
            (runner as unknown as { query: typeof patched }).query = patched;
            const hold: PreWriteHold = {
                held: () => heldBefore !== undefined,
                heldBefore: () => heldBefore,
                releasedBy: () => state.releasedBy,
                restore: () => {
                    // The hold has already settled by the time a `finally` runs it, so this is the cleanup
                    // of last resort: it clears any timer that outlived its hold and takes the state out of
                    // the waiting set, so nothing this rendezvous created survives the test that made it.
                    if (state.timer !== undefined) {
                        clearTimeout(state.timer);
                        state.timer = undefined;
                    }
                    waiting.delete(state);
                    (runner as unknown as { query: typeof original }).query = original;
                },
            };
            installedHolds.push(hold);
            return hold;
        },
    };
}
