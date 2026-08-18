/**
 * A deterministic rendezvous — a *barrier* — for e2e tests that must **prove** a race rather
 * than merely provoke one, together with the two-connection transaction drivers built on it.
 *
 * ## Why this module exists
 *
 * A race claim is evidence only if the interleaving under test is the interleaving that
 * actually occurred. Two requests fired from one test process are ordinarily serialised by the
 * client, the connection pool or the transaction, so a test written that way passes having
 * proved *sequencing* and not concurrency — and it would keep passing if the very constraint it
 * claims to exercise were dropped. That failure is silent, which is why it needs a fixture
 * rather than a convention.
 *
 * The shipped load test at `packages/core/e2e/parallel-transactions.e2e-spec.ts:L37-L60`
 * coordinates two dozen mutations with `Promise.all` alone. It is a good load test, and it is
 * exactly the shape this module replaces for a race claim: `Promise.all` has no rendezvous at
 * all. It starts both calls and then waits for both to finish, which is not the same thing as
 * holding both past the point the race is about and letting go of both at once.
 *
 * Three obligations follow from that, and this module exists to make all three cheap:
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
 * ## Which engines evidence a race
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
 *
 * Two consequences are stated here so that nobody has to re-derive them:
 *
 * - **A claim naming all four engines for a forced interleaving is a defect, not a stricter
 *   test.** It overstates what one of the four observed. Name the three, and state the sql.js
 *   exclusion rather than implying the coverage.
 * - **`e2e-sqljs` carries the sequential and shape-level form of the same behaviour instead** —
 *   the same two requests issued one after the other, the same constraint violated by a single
 *   forbidden write. That is a real assertion about the same contract, and it is what keeps the
 *   sql.js job meaningful rather than skipped. {@link runSequentialPair} exists so that the
 *   sql.js job runs an assertion instead of nothing, which is why this module ships a sequential
 *   driver and not merely a skip helper.
 *
 * **This module governs the concurrency half only.** Migration and constraint obligations stay
 * on all four engines, because applying a migration, reverting it and violating a constraint are
 * not concurrency behaviours.
 *
 * ## Do not transplant the sibling fixture's engine rule onto this one
 *
 * `./query-capture.ts` has the **inverse** posture, deliberately: a statement count is
 * deterministic and cheap on sql.js, so the counted form of a claim is fixed *to* the sql.js job
 * while the behaviour it evidences is asserted on all four. Barriers exclude sql.js; statement
 * counts prefer it. The two modules are also kept independent on purpose — they share no helper,
 * so a suite that needs only query capture does not transitively pull this one in. If both need
 * the same few engine lines, duplicate them.
 *
 * ## Attribution
 *
 * `review_rules` was called for the entire document and returned exactly
 * "No user rules provided." **No user-specified rule governs this file, and no rule forced it
 * into scope; there is no rule to cite here.** Every constraint this module encodes is instead
 * *prompt-derived* (technical specification §0.5.2.5 "Proving the Implementation", §0.7.5 the
 * engine coverage matrix, and §0.8.2 "Engine Evidence Discipline") and/or *ticket-derived*
 * (`tickets/EPIC-001-reorder-and-replenishment.md` §7.8 the race-evidence rule, §11.6.1 the
 * lifecycle and isolation contract, §11.6.3 which engines evidence a race; and the barrier
 * clauses of STORY-001-01-01 AC-4 and AC-7, STORY-001-01-02 AC-6 and its concurrent-add
 * scenario, and STORY-001-01-03's adjust-versus-remove scenario). The absence of a rules
 * document is not licence to lower the bar, and it has not been treated as one: this file is
 * held to enterprise-standard best practice instead — complete documentation on every exported
 * symbol, deterministic teardown on every path, loud named failure instead of a silent hang, no
 * console output, no swallowed rejection.
 */
import { DataSource, EntityManager, QueryRunner } from 'typeorm';

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
 *
 * Two transactions on any of these cannot be held past a barrier and released together, so a
 * forced interleaving asserted here proves nothing about a deployment and can pass while the
 * concurrent path is broken. Use {@link runSequentialPair} on these engines instead.
 */
export const SINGLE_CONNECTION_ENGINES: readonly string[] = ['sqljs', 'sqlite', 'better-sqlite3'];

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
 *
 * The point of mirroring rather than importing is that this is evaluable at **collection** time,
 * before any server exists — which is what makes `it.skipIf(...)` work at all — and that reading
 * one environment variable cannot pull in `testConfig()`, whose port is derived from the calling
 * file's position in its own directory and would therefore be wrong when called from here.
 *
 * @example
 * ```ts
 * // Report the engine in the test name, so a CI log says which engine observed the race.
 * it(`refuses the duplicate on ${resolveConfiguredEngine()}`, async () => {
 *     // ...
 * });
 * ```
 */
export function resolveConfiguredEngine(): string {
    return process.env.DB || 'sqljs';
}

/**
 * @description
 * Whether a forced interleaving is evidence on the given engine — the guard that keeps a barrier
 * assertion off the engines that cannot honour it.
 *
 * Accepts an explicit engine name, a `DataSource`-shaped object (so a suite can gate on
 * `dataSource.options.type` once a server exists), or nothing at all, in which case the
 * configured engine is resolved with {@link resolveConfiguredEngine}. An unrecognised engine
 * returns `false`: a barrier claim is only ever made on an engine known to support one.
 *
 * Pair the gated barrier case with an **ungated** sequential case, so that the sql.js job runs a
 * real assertion rather than nothing. A skipped job is not evidence; a sequential run is.
 *
 * @example
 * ```ts
 * // The forced interleaving: the three server engines only.
 * it.skipIf(!supportsForcedInterleaving())(
 *     'leaves exactly one row when two creates race for the same name',
 *     async () => {
 *         const result = await runBarrieredPair(dataSource, { a: participantA, b: participantB });
 *         expect(result.winner).toBeDefined();
 *         expect(result.loser).toBeDefined();
 *     },
 * );
 *
 * // The sequential half of the same contract: every engine, sql.js included.
 * it('refuses a directly written duplicate on any engine', async () => {
 *     const result = await runSequentialPair(dataSource, { a: participantA, b: participantB });
 *     expect(result.rejected.length).toBe(1);
 * });
 *
 * // Once a server exists, the same guard can read the engine off the data source.
 * expect(supportsForcedInterleaving(dataSource)).toBe(supportsForcedInterleaving());
 * ```
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

/**
 * @description
 * Options for {@link ConcurrencyBarrier}.
 */
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
 * **Where `arrive()` goes decides whether the test is evidence.** It belongs *after* the read or
 * precheck the race is about and *before* the write. Awaiting it before the read proves nothing
 * about the window the constraint exists to survive, because neither participant has looked at
 * the data yet; awaiting it after the write proves nothing at all, because the writes have already
 * been ordered by the time anybody waits. And it must be **awaited**, not merely called: a call whose
 * promise nobody waits on registers the arrival and then carries straight on into the write, which is
 * the same false green under a different disguise.
 *
 * That obligation is exactly why the transaction-level drivers in this module do **not** hand it to a
 * participant. {@link runBarrieredPair} takes a precheck and a write, holds the participants itself
 * between the two, and certifies afterwards that both were released before either wrote — see
 * {@link BarrierOutcomeBase.releasedBeforeWrite}. Reach for this primitive directly only where you
 * need something the drivers do not model, such as the request-level release below or a three-phase
 * choreography with `autoRelease: false`, and accept that the ordering is then yours to get right.
 *
 * The barrier never hangs. If the timeout elapses before release, every waiter is rejected with a
 * message naming who arrived and who did not — see {@link ConcurrencyBarrierOptions.timeoutMs}.
 *
 * @example
 * ```ts
 * // Request-level use: two independent clients released at the same instant.
 * const barrier = new ConcurrencyBarrier(2);
 *
 * const first = (async () => {
 *     await barrier.arrive('client-1');
 *     return shopClient1.query(CREATE_REORDER_LIST, { input: { name: 'Weekly restock' } });
 * })();
 * const second = (async () => {
 *     await barrier.arrive('client-2');
 *     return shopClient2.query(CREATE_REORDER_LIST, { input: { name: 'Weekly restock' } });
 * })();
 * ```
 *
 * **The honest limit of that second example.** Releasing two requests at the same instant is
 * *necessary* to assert what each of the two callers received, and it is categorically better
 * than `Promise.all`, which has no rendezvous at all. But on its own it is **not** the
 * interleaving proof: the server may still serialise the two requests in its connection pool or
 * inside its own transaction, which is exactly the silent failure described at the top of this
 * file. The interleaving is proved by {@link runBarrieredPair}, where both transactions are
 * provably open, provably past their prechecks and provably released before either write begins.
 * Assert the two callers' results at the request level; assert the interleaving at the transaction
 * level. Do not present the request-level release as the barrier.
 */
export class ConcurrencyBarrier {
    private readonly timeoutMs: number;
    private readonly autoRelease: boolean;
    private readonly expectedLabels: readonly string[];
    private readonly labels: string[] = [];
    private readonly waiters: BarrierWaiter[] = [];
    private timer: ReturnType<typeof setTimeout> | undefined = undefined;
    private hasReleased = false;
    private failure: Error | undefined = undefined;

    constructor(
        private readonly participantCount: number,
        options: ConcurrencyBarrierOptions = {},
    ) {
        if (!isPositiveInteger(participantCount)) {
            throw new Error(
                'ConcurrencyBarrier requires a participantCount that is an integer of at least 1, ' +
                    `but received ${describeUnknown(participantCount)}.`,
            );
        }
        const timeoutMs = options.timeoutMs === undefined ? DEFAULT_BARRIER_TIMEOUT_MS : options.timeoutMs;
        if (typeof timeoutMs !== 'number' || !isFinite(timeoutMs) || timeoutMs <= 0) {
            throw new Error(
                'ConcurrencyBarrier requires a timeoutMs that is a finite number greater than 0 ' +
                    `(an unbounded wait is the hang this fixture exists to prevent), but received ${describeUnknown(
                        options.timeoutMs,
                    )}.`,
            );
        }
        this.timeoutMs = timeoutMs;
        this.autoRelease = options.autoRelease !== false;
        this.expectedLabels = options.expectedLabels === undefined ? [] : options.expectedLabels.slice();
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
    arrive(label: string): Promise<void> {
        if (this.failure) {
            return Promise.reject(
                new Error(
                    `Participant '${label}' arrived at a concurrency barrier that is no longer ` +
                        `usable. The barrier failed earlier with: ${this.failure.message}`,
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
     *
     * Idempotent: the first reason wins, and a second call is a no-op. Calling it after a normal
     * release simply clears the timer, because nothing is left waiting — and a later arrival still
     * resolves immediately, exactly as {@link ConcurrencyBarrier.arrive} documents.
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
        this.failure = asError(reason, 'The concurrency barrier was disposed before it was released.');
        this.clearTimer();
        const waiting = this.waiters.splice(0, this.waiters.length);
        for (const waiter of waiting) {
            waiter.reject(this.failure);
        }
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
        this.dispose(new Error(this.describeTimeout()));
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
    /** This participant's label, as it appears in every outcome and every diagnostic message. */
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
     *
     * A participant that declares no precheck receives `undefined` here, and its `P` is `undefined` to
     * say so — {@link BarrierPrecheckRequirement} is what holds the two in step, by requiring a precheck
     * of any participant whose `P` excludes `undefined`. This type therefore never promises a value that
     * no phase produced.
     */
    readonly precheckResult: P;
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
 * either write. An earlier revision of this module instead handed the body a single function plus an
 * `arrive()` it was expected to await between its read and its write, and that design could not
 * certify what it claimed — a body that called `arrive()` without awaiting it, or that returned by a
 * path which skipped it, could write and commit while its sibling was still short of the pre-write
 * point, and the run still looked like a proven one-winner race. Ordering the phases here removes the
 * possibility rather than documenting the obligation.
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
    /** The participant's label. */
    label: string;
    /**
     * Whether this participant **registered** at the rendezvous — recorded the moment it does so,
     * before the release is awaited. That timing is deliberate, and it is what makes the field a
     * diagnosis rather than a restatement of the outcome: a participant held at the barrier and then
     * rejected by a timeout or by its sibling's disposal provably reached the pre-write window, and
     * reporting it as `false` would point the reader at the wrong participant.
     *
     * A participant whose precheck (or connection, or transaction) failed before the rendezvous reads
     * `false`, and an assertion about the interleaving is meaningless for it — which is why
     * {@link runBarrieredPair} refuses to return a result at all in that case.
     *
     * Registration alone is **not** proof that the interleaving happened, and this field is not what
     * certifies a run: see {@link BarrierOutcomeBase.releasedBeforeWrite}.
     *
     * Under {@link runSequentialPair} there is no rendezvous, so this is always `false` and nothing
     * requires otherwise.
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
     *
     * Always `false` under {@link runSequentialPair}, which makes no interleaving claim.
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
    /** The outcome of participant `a`. */
    a: BarrierOutcome<A>;
    /** The outcome of participant `b`. */
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
 *
 * Declared separately from {@link BarrierPrecheckRequirement} so that `precheck` is always an
 * inference site: `P` is inferred here from the precheck a caller actually wrote, without the caller
 * naming a single type argument.
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
 *
 * ★ This layer is what keeps {@link BarrierWriteContext.precheckResult} honest, and it exists because
 * an earlier revision was not. That revision declared `precheck?: BarrierPrecheck<P>` beside
 * `precheckResult: P`, which let a caller declare `BarrierParticipantSpec<void, number>`, omit the
 * precheck entirely, compile cleanly — and receive `undefined` in a parameter the type had promised was
 * a `number`. The fixture had to fabricate that value with a cast to satisfy its own signature, and the
 * first `precheckResult * 2` in a write phase would have been a run-time fault the compiler had already
 * signed off on. Correlating the two shapes removes the possibility instead of documenting it: there is
 * nothing left to fabricate, and the cast is gone.
 *
 * Three ways to declare a participant follow from it, and each gets exactly what it asked for:
 *
 * - a precheck declared: its result type is precise, and the write needs no narrowing;
 * - no precheck: `P` is `undefined`, and the write is handed `undefined`;
 * - a precheck that may legitimately be absent: declare `P` as `T | undefined`, and the write narrows.
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
    /** The first participant. */
    a: BarrierParticipantSpec<A, PA>;
    /** The second participant. */
    b: BarrierParticipantSpec<B, PB>;
}

/**
 * @description
 * Options for {@link runBarrieredPair}.
 */
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

/**
 * @description
 * Options for {@link runSequentialPair}.
 */
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
 *
 * **What it guarantees.**
 * - Two query runners, each explicitly connected, so two pool connections are genuinely held —
 *   and it **refuses to run at all** on an engine whose driver hands the same runner to both,
 *   naming {@link supportsForcedInterleaving} and {@link runSequentialPair} in the error rather
 *   than letting the impossibility surface as an obscure "transaction already started". It refuses
 *   just as plainly if a runner arrives already carrying a transaction, because a nested level
 *   inside somebody else's transaction is not an independent transaction and could not interleave.
 * - **The ordering is the driver's, not the caller's.** Both prechecks run to completion, both
 *   participants are then registered at the rendezvous by the driver itself, and only once both are
 *   released does either write begin. There is no `arrive()` for a body to forget to await, so the
 *   one thing that could previously produce false-green evidence — a write starting while the
 *   sibling was still short of the pre-write point — is not expressible.
 * - **Both participants were provably held and released before writing, or there is no result.**
 *   `assertHarnessIntegrity` refuses to return a pair in which either side did not register at the
 *   rendezvous or was not released from it before its write, and each outcome carries
 *   {@link BarrierOutcomeBase.releasedBeforeWrite} so a suite can assert it directly. A participant
 *   that fails before the rendezvous is rolled back rather than committed and its sibling's wait is
 *   failed at once rather than left to run out the timeout.
 * - Each participant ends only the transaction levels it opened itself, so one participant's failure
 *   can never roll back the other's work, and a level that was open before it started is never
 *   touched.
 * - Each participant is committed (or rolled back) **in its own chain, the instant its write
 *   returns** — never after waiting for its sibling. That is not a stylistic preference: on
 *   MySQL, MariaDB and PostgreSQL two transactions writing the same row *block* on a lock rather
 *   than erroring, so the second writer waits for the first to **commit**. A harness that awaited
 *   both bodies before committing either would deadlock, and would present as a test timeout
 *   rather than as a harness bug.
 * - Both outcomes are returned. A rejection is often the expected result, so nothing is rethrown
 *   and nothing is swallowed.
 * - **A fulfilled outcome means the work completed as asked.** A participant whose transaction could
 *   not be finished — a commit that unwound nothing, or nesting left open by its own write phase — is
 *   reported *rejected*, carrying the reason, rather than fulfilled over work the teardown then rolls
 *   back. Cleanup here is cleanup, never a silent stand-in for COMMIT.
 * - Deterministic teardown on every path: every transaction this driver opened is explicitly ended and
 *   every connection it borrowed released, even when its sibling threw, when the rendezvous timed out,
 *   or when the transaction never started. A leaked query runner holds a pool connection, and the next
 *   test then hangs instead of failing — which is why teardown here is not politeness.
 * - **A connection it did not borrow is never released.** A runner handed in already inside a
 *   transaction belongs to an outer owner, and `release()` ends nothing: it would publish that
 *   transaction and its locks to the next borrower of the same connection while leaving its owner a
 *   runner whose every query throws. Such a runner is restored to the state it arrived in and left
 *   connected. Note when asserting on teardown that `isReleased` is a pool concept: the server drivers
 *   set it, while TypeORM's SQLite-family `release()` only clears cached metadata and leaves the flag
 *   false (`node_modules/typeorm/driver/sqlite-abstract/AbstractSqliteQueryRunner.js:L43-L47`), because
 *   there is no pool to return anything to.
 *
 * **Pool budget.** This driver holds two connections for the duration of the run while the server
 * is still serving requests from the same pool, so keep both phases short. Exhausting the pool
 * presents as a hang rather than as an error. Raising a pool setting is the suite's configuration
 * decision and is deliberately not taken here.
 *
 * @example
 * ```ts
 * import { TransactionalConnection } from '\@vendure/core';
 *
 * // The suite owns the DataSource; this module never fetches or constructs one.
 * const dataSource = server.app.get(TransactionalConnection).rawConnection;
 * const esc = (name: string) => dataSource.driver.escape(name);
 *
 * it.skipIf(!supportsForcedInterleaving())(
 *     'leaves exactly one row when two creates race for the same name',
 *     async () => {
 *         const create = (label: string): BarrierParticipantSpec<void, number> => ({
 *             label,
 *             // Phase 1 — the read the race is about. Both of these finish before either write
 *             // starts, which is what puts both participants inside the window together.
 *             precheck: async ctx => {
 *                 const rows: Array<{ id: number }> = await ctx.queryRunner.query(
 *                     `SELECT ${esc('id')} FROM ${esc('reorder_list')} WHERE ${esc('nameKey')} = ?`,
 *                     ['weekly restock'],
 *                 );
 *                 return rows.length;
 *             },
 *             // Phase 2 — invoked only after both participants have been released together.
 *             write: async ctx => {
 *                 expect(ctx.precheckResult).toBe(0); // neither saw a row before either wrote
 *                 await ctx.queryRunner.query(
 *                     `INSERT INTO ${esc('reorder_list')} (${esc('nameKey')}) VALUES (?)`,
 *                     ['weekly restock'],
 *                 );
 *             },
 *         });
 *
 *         const result = await runBarrieredPair(dataSource, {
 *             a: create('first-writer'),
 *             b: create('second-writer'),
 *         });
 *
 *         // Assert the final state AND which result the losing caller received.
 *         expect(result.fulfilled.length).toBe(1);
 *         expect(result.winner?.releasedBeforeWrite).toBe(true);
 *         expect(result.loser).toBeDefined();
 *     },
 * );
 * ```
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
            baseline: { active: false, depth: undefined },
            ownsTransaction: false,
            ownsRunner: false,
            completion: undefined,
        },
        {
            claimed: false,
            baseline: { active: false, depth: undefined },
            ownsTransaction: false,
            ownsRunner: false,
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
        //
        // ★ Reaching here does NOT imply the rendezvous timeout already fired. It starts on first
        // arrival, this deadline starts with the chains, so a late first arrival — or none at all —
        // leaves this the first and only report. That is why the message states the rendezvous position
        // outright instead of assuming a rendezvous failure was already raised.
        cancelToken(token, state);
        barrier.dispose(
            new Error(
                `The barriered pair exceeded its ${String(pairTimeoutMs)}ms deadline and was abandoned, so ` +
                    'the rendezvous was failed and both connections were reclaimed.',
            ),
        );
        await reclaimAbandonedRunners(runners, tracked, state, dataSource, claims);
        throw new Error(buildAbandonedPairMessage(tracked, pairTimeoutMs, state, barrier));
    }

    // Nothing is waiting by now; this exists to guarantee the timeout cannot outlive the test. On a
    // barrier that released normally this only clears the timer, so it cannot invalidate a
    // rendezvous a caller still holds — see ConcurrencyBarrier.dispose.
    barrier.dispose(new Error('The barriered pair has finished; its rendezvous is no longer in use.'));

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
 * There is no rendezvous in this mode, so `arrived` and `releasedBeforeWrite` are both `false` on
 * both outcomes and nothing requires otherwise; the two phases simply run back to back.
 *
 * **What this evidences:** single-connection correctness, replay idempotency, accumulation
 * arithmetic, and constraint shape — including a duplicate written straight through the repository
 * so that no service pre-check can intercept it. That is a real assertion about the same contract,
 * and it is what keeps the sql.js job meaningful rather than skipped: a skipped job is not
 * evidence, whereas a sequential run is.
 *
 * **What this does not evidence: interleaving.** Two participants run in series were never inside the
 * same window, so a suite must not present this as a race. Pair it with a
 * {@link runBarrieredPair} case gated on {@link supportsForcedInterleaving} and let each assertion
 * claim only its own half.
 *
 * **Running inside an outer transaction is supported here, and only here.** Where a suite's own
 * transaction is already open on the runner this obtains — which is what happens on the
 * single-connection family, whose driver caches one runner — each participant opens a nested level,
 * closes exactly that level, and leaves the outer transaction active at the depth it was found. The
 * outer connection is **not** released either, so it remains its owner's to use and to commit; a
 * borrowed-and-released connection would take the outer transaction's locks to whoever borrowed it
 * next. {@link runBarrieredPair} refuses that situation outright instead, because a savepoint inside
 * somebody else's transaction cannot race against anything.
 *
 * @example
 * ```ts
 * // Same participants as the barrier case above; this one runs on every engine, sql.js included.
 * it('reconciles a duplicate add to a single line on any engine', async () => {
 *     const result = await runSequentialPair(dataSource, {
 *         a: create('first-writer'),
 *         b: create('second-writer'),
 *     });
 *
 *     expect(result.a.settledOrder).toBe(0);
 *     expect(result.b.settledOrder).toBe(1);
 *     expect(result.rejected.length).toBe(1);
 *     expect(result.loser?.label).toBe('second-writer');
 * });
 * ```
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
    //
    // No cleanup claim is passed either: with no watchdog there is no second side to contend with, so
    // each chain owns its own teardown outright — which is what `claimCleanup(undefined)` means.
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

// ---------------------------------------------------------------------------------------------
// Internals. Nothing below this line is exported: the module's surface is the barrier, the two
// drivers, the engine guards and the types they use.
// ---------------------------------------------------------------------------------------------

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
        throw new Error(
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
     *
     * ★ Shared rather than local, because the watchdog needs the same fact the chain has. A deadline that
     * fires while a chain is still stalled in `connect()`, on a runner that arrived carrying somebody
     * else's transaction, would otherwise assume ownership and roll back work this harness never opened.
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
 * The rules, in order, and why each is the way round it is:
 *
 * 1. **Every step is bounded** by {@link DEFAULT_CLEANUP_ACTION_TIMEOUT_MS}. A rollback queued behind the
 *    stalled statement that caused the abandonment does not return, and an unbounded `await` on it hangs
 *    whichever side owns cleanup. If that side is the participant's chain, the watchdog then sees an
 *    unsettled chain, finds the cleanup claim already taken, and correctly declines to race it — so an
 *    unbounded owner means *nobody* quarantines and *nobody* destroys the pool. A single-owner claim is
 *    only safe because the owner's whole cleanup is bounded.
 * 2. **Transaction state is read fail-closed.** An accessor that throws yields "a transaction is active",
 *    never "there is none": assuming none leads directly to releasing live work. See
 *    {@link readRunnerFlag}.
 * 3. **Only the levels this chain opened are ever closed**, measured against the baseline it recorded
 *    before opening anything, and a transaction it did not open is never rolled back — ending somebody
 *    else's transaction is its own kind of damage. That is {@link restoreTransactionBaseline}, and this
 *    function bounds it rather than replacing it.
 * 4. **`release()` happens only after the runner is *proven* quiescent** — back at its baseline by
 *    {@link isCertainlyAtBaseline}, which is a positive statement rather than the absence of a negative.
 *    `release()` cancels nothing. TypeORM's PostgreSQL runner invokes its pool release callback
 *    immediately (`node_modules/typeorm/driver/postgres/PostgresQueryRunner.js:88-107`) and the MySQL
 *    runner calls `databaseConnection.release()` immediately
 *    (`node_modules/typeorm/driver/mysql/MysqlQueryRunner.js:73-77`), so releasing a runner whose
 *    rollback failed, never settled, or left a level open hands live work to whichever test draws that
 *    connection next.
 * 5. **Anything else quarantines**, including a release that fails or never settles: the runner is not
 *    released, the connection is reported as leaked by name, and the owning `DataSource` is destroyed.
 *    Destroying the pool is drastic on purpose — every later test then fails loudly on a closed
 *    connection instead of quietly inheriting a stranger's transaction.
 * 6. **A connection this chain did not borrow is never released and never quarantined.** A runner that
 *    arrived inside an outer transaction belongs to that transaction's owner, which is a *supported*
 *    situation in {@link runSequentialPair}: the chain opens a nested level, closes exactly that level,
 *    and leaves the outer transaction active at the depth it was found. Releasing it would publish a
 *    foreign transaction and its locks to the next borrower; destroying the pool would take down a
 *    legitimate outer run. Its failure to return to baseline is still reported, loudly.
 *
 * Diagnostics are appended to `errors` rather than thrown, so a participant's own outcome — the thing the
 * test is actually about — survives, and every teardown failure still reaches the reader.
 */
async function settleRunner(
    queryRunner: QueryRunner,
    label: string,
    state: ChainState,
    dataSource: DataSource,
    baseline: TransactionState,
    ownsRunner: boolean,
): Promise<void> {
    if (readRunnerFlag(() => queryRunner.isReleased, false)) {
        // Already released, by this path or the other side of the claim. Nothing left to do, and
        // "unreadable" resolves to "not released" so a leak is attempted rather than assumed away.
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
            `restoring the transaction state for '${label}' failed: ${describeUnknown(restored.reason)}`,
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
        // Rule 6. Not ours to return, and not ours to destroy the pool over.
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
            `releasing the connection for '${label}' failed: ${describeUnknown(release.reason)}`,
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
            `destroying the DataSource after quarantining '${label}' failed: ${describeUnknown(
                destroyed.reason,
            )}`,
        );
    } else if (destroyed.outcome === 'unsettled') {
        errors.push(
            `destroying the DataSource after quarantining '${label}' did not settle within ` +
                `${String(DEFAULT_CLEANUP_ACTION_TIMEOUT_MS)}ms, so the pool may still hold the live connection`,
        );
    }
}

/**
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
                // arrived carrying a foreign transaction, so nothing of its owner's is touched.
                claim === undefined ? { active: false, depth: undefined } : claim.baseline,
                claim === undefined ? true : claim.ownsRunner,
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
                `a cancellation listener threw while the pair was being abandoned: ${describeUnknown(
                    listenerError,
                )}`,
            );
        }
    }
}

/**
 * Builds the abandonment message: which participants did not settle, what is known about the ones that
 * did, and any failure met while reclaiming. Naming the stuck participant is the whole point — the test
 * runner's own timeout names nothing.
 *
 * ★ It states the rendezvous position outright rather than assuming a rendezvous failure was already
 * raised, because the two timers start at different moments — the rendezvous timer on first arrival, this
 * one with the chains — so which reports first is a tendency and not a guarantee.
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
    throw new Error(
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
 *
 * **The rendezvous sits between the two phases and is entered by this function, never by the
 * caller's code.** That is what makes the interleaving certifiable rather than merely requested:
 * there is no `arrive()` a phase could call without awaiting, and therefore no way for a write to
 * begin while its sibling is still short of the pre-write point.
 *
 * Passing `barrier` as `undefined` selects sequential mode, where there is no rendezvous at all and
 * the two phases simply run back to back.
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
    let baseline: TransactionState = { active: false, depth: undefined };
    // Whether the CONNECTION is this participant's to give back, which is a different question from
    // whether a transaction level is its to close. A runner that arrived already inside a transaction
    // belongs to an outer owner: releasing it would return a connection to the pool with somebody
    // else's transaction (and its locks) still open on it, and would leave that owner holding a
    // runner it can no longer use. Such a runner is restored to its baseline and then left alone.
    //
    // Decided here, from the flag alone, so that even a `connect()` that throws cannot reach the
    // teardown with the question still open; refined from the full baseline reading below.
    let ownsRunner = !queryRunner.isTransactionActive;
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
    // Running twice must not report one failure twice, which is what the flag is for.
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
                `restoring the transaction state for '${label}' failed: ${describeUnknown(restored.reason)}`,
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
        // connect() is called explicitly so that this participant is holding a pool connection of
        // its own before its transaction opens. Two participants must never share one connection:
        // a single connection cannot hold two open transactions, so it cannot interleave, and a
        // test built on it would prove serialisation.
        await queryRunner.connect();
        // Read the transaction state BEFORE opening one. A level that is already open belongs to
        // somebody else, and every close below is measured against this reading.
        baseline = readTransactionState(queryRunner);
        // An already-open transaction makes the CONNECTION foreign too, not just the level. This is
        // decided here, before anything is opened on the runner and before any path can release it,
        // so the refusals below are genuinely refusals to touch it.
        ownsRunner = !baseline.active;
        // Published to the shared record in the same synchronous step, so the watchdog measures against
        // the same baseline and the same connection ownership this chain would, rather than assuming
        // either. A deadline that fires while this chain is still stalled would otherwise have to guess,
        // and guessing here means rolling back or releasing work that was never this harness's.
        if (claim !== undefined) {
            claim.baseline = baseline;
            claim.ownsRunner = ownsRunner;
        }
        if (baseline.active && baseline.depth === undefined) {
            // ★ Refused in BOTH modes, including the sequential nesting this module otherwise
            // supports. A level opened on this runner could never be shown to have been closed
            // again: with a transaction already open, the public `isTransactionActive` flag reads
            // `true` before and after, so it cannot distinguish this participant's level from the
            // one it found, and the nesting counter that could is not observable here. Nesting
            // anyway would let a participant be reported fulfilled over a level it never closed —
            // and under `commitOnSuccess: false`, over work it was asked to discard and did not.
            // A harness that cannot certify restoration must not begin, so this refuses instead.
            throw new Error(
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
            throw new Error(
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
                        `driver stopped reporting a transaction depth: ${describeUnknown(closeError)}`,
                );
            }
            throw new Error(
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
            throw new Error(
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
                                describeUnknown(listenerError),
                        );
                        throw listenerError;
                    }
                    return;
                }
                token.listeners.push(listener);
            },
        };
        // Phase 1. The read the race is about, run to completion before anybody is held. A participant
        // that declared none is typed to receive `undefined` here, so nothing has to be fabricated.
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
        // Phase 2. The write, now that both participants are provably inside the window together.
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
                throw new Error(
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
        // Restore the runner before counting the settle order, so that this participant counts as
        // finished only once its transaction has actually been ended — including the half-started
        // transaction a failed startTransaction can leave behind.
        await restoreBaseline();
        const settledOrder = state.settled++;
        return { label, arrived, releasedBeforeWrite, settledOrder, status: 'rejected', reason };
    } finally {
        // Teardown on every path — a sibling that threw, a rendezvous that timed out, a transaction that
        // never opened — because a leaked query runner holds a pool connection and the next test then
        // hangs rather than failing.
        //
        // ★ It is gated on the cleanup CLAIM rather than being unconditional. Once the pair watchdog has
        // abandoned this runner it owns the teardown, and two sides rolling back or releasing one
        // connection concurrently is the hazard {@link CleanupClaim} exists for.
        //
        // ★ Everything goes through {@link settleRunner}, which is the one bounded path: it ends only the
        // levels this chain opened (measured against the baseline recorded before anything was opened, so
        // a foreign transaction is never rolled back), it releases ONLY once the runner is provably back
        // at that baseline, it quarantines rather than releasing anything it cannot prove — because
        // `release()` hands the connection back without ending anything open on it — and it never
        // releases a connection this chain did not borrow, which is what keeps the supported
        // outer-transaction mode of {@link runSequentialPair} intact.
        //
        // The order inside it is not stylistic: a query issued on a released runner throws
        // (`driver/mysql/MysqlQueryRunner.js:L143-L144`), so a rollback attempted after the release could
        // not run at all. `restoreBaseline` above has normally finished with the transaction already, and
        // re-entry is a no-op.
        if (ownCleanup()) {
            // The promise is published on the shared claim BEFORE it is awaited, with no `await` in
            // between, so a watchdog that finds this claim taken can wait for this exact cleanup rather
            // than returning while it is still in flight and losing every diagnostic appended after.
            const cleanup = (async (): Promise<void> => {
                await restoreBaseline();
                await settleRunner(queryRunner, label, state, dataSource, baseline, ownsRunner);
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
                new Error(
                    `Participant '${label}' finished without reaching the barrier — its connection, ` +
                        'its transaction or its precheck failed beforehand — so the rendezvous was ' +
                        'abandoned and every waiting participant rejected at once, rather than ' +
                        'left to run out the timeout.',
                ),
            );
        }
    }
}

/**
 * The single-shaped internal view of a participant.
 *
 * The public {@link BarrierParticipantSpec} is {@link BarrierParticipantPhases} intersected with the
 * conditional {@link BarrierPrecheckRequirement}, so that a caller declaring no precheck cannot be
 * promised a precheck result that will never arrive. That conditional is what a caller needs and what
 * this module does not: the precheck result is a value read from one phase and passed straight into the
 * next without ever being inspected here. So the requirement layer is dropped once, at the driver
 * boundary, by {@link normaliseParticipantSpec}, and the rest of the module works against this single
 * shape — rather than the alternative of specialising the chain per participant kind, which would put
 * the very ordering these fixtures certify into two places that could drift apart.
 */
interface NormalisedParticipantSpec<T> {
    label?: string;
    precheck?: (ctx: BarrierParticipantContext) => Promise<unknown>;
    write: (ctx: BarrierWriteContext<unknown>) => Promise<T>;
}

/**
 * Narrows a caller's participant to {@link NormalisedParticipantSpec}.
 *
 * Every participant a caller can declare is structurally assignable to this shape in everything except
 * the precheck result type, which this module treats as opaque, so the conversion is sound: however the
 * caller declared its participant, its write receives precisely the value its own precheck produced —
 * `undefined` when it declared none. The caller's own types are unaffected; this narrowing is internal
 * and is not visible to them.
 */
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
 */
function readTransactionState(queryRunner: QueryRunner): TransactionState {
    const depth = (queryRunner as unknown as TransactionDepthCarrier).transactionDepth;
    return {
        active: queryRunner.isTransactionActive,
        depth: typeof depth === 'number' && isFinite(depth) ? depth : undefined,
    };
}

/**
 * Whether the runner currently carries anything **above** the baseline — that is, anything this
 * participant is responsible for. Where both depths are readable the comparison is on depth, which is
 * what distinguishes a nested level this participant added from the outer level it found; otherwise
 * the public flag is the only evidence available, and a transaction that was not active at the
 * baseline and is active now must be this participant's.
 *
 * `false` here means "nothing observably above the baseline", which is weaker than "back at the
 * baseline": see {@link isCertainlyAtBaseline} for the positive statement, and use that one wherever
 * proof rather than the absence of contrary evidence is what a decision rests on.
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
 *
 * The two are not complementary because there is a middle case: a runner whose flag reads the same as
 * it did at the baseline while the counter that would distinguish its levels is unreadable. Nothing
 * about that state is evidence either way, so `hasStateAboveBaseline` reports nothing above the
 * baseline and this reports nothing certifiably at it, and a caller that needs proof rather than the
 * absence of contrary proof asks this one. A participant is only reported fulfilled where this holds.
 *
 * Proof takes one of two forms, and which one applies is decided by the baseline alone rather than by
 * what happens to be readable afterwards:
 *
 * - A baseline that **had** a readable depth is only matched by a readable, equal depth with the flag as
 *   it was. A depth that has since become unreadable is not proof of anything and does not fall back to
 *   the flag: the flag cannot see a nested level, so accepting it here would certify a runner carrying
 *   one. That is the difference between "no contrary evidence" and "evidence", and this function is the
 *   one that must mean the second.
 * - A baseline that had **no** readable depth is matched by nothing open at the baseline and nothing open
 *   now, which is the strongest statement a driver without a counter permits, and is exactly the state a
 *   clean unwind leaves on one.
 */
function isCertainlyAtBaseline(queryRunner: QueryRunner, baseline: TransactionState): boolean {
    const current = readTransactionState(queryRunner);
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
 *
 * ★ Every close is aimed by OBSERVED state, never by a count of the levels this chain opened, and that
 * is a safety property rather than a preference. Where the runner had nothing open to begin with,
 * observed state already identifies this chain's work exactly — anything active is its own, and a depth
 * above the baseline is its own — so a count would add nothing. Where the runner arrived inside somebody
 * else's transaction, a count would add something dangerous: a close aimed on the strength of "one is
 * owed" cannot tell this chain's level from the one it found, so as soon as a close stops being
 * observable it starts landing on the outer owner's transaction and rolling back work that was never
 * this chain's to end. An earlier revision of this function was driven that way and did exactly that.
 * Which is why the nesting cases that cannot be observed are refused before they begin, in
 * {@link runParticipantChain}, rather than unwound on faith here.
 */
async function endTransactionLevels(
    queryRunner: QueryRunner,
    baseline: TransactionState,
    how: 'commit' | 'rollback',
): Promise<void> {
    let steps = 0;
    while (hasStateAboveBaseline(queryRunner, baseline)) {
        if (steps >= MAX_TRANSACTION_UNWIND_STEPS) {
            throw new Error(
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
            throw new Error(
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
 *
 * Three distinct failures are recorded, because they are three different diagnoses:
 *
 * - a rollback that **raised** — either the statement itself failed, or the unwind could not be
 *   completed because a close returned without ending anything or the step bound was reached;
 * - a level still open **after** the unwind, meaning the connection is going back to the pool with a
 *   transaction and its locks still on it — observable because TypeORM clears its flag only once
 *   ROLLBACK has actually returned (`driver/mysql/MysqlQueryRunner.js:L133-L134`);
 * - bookkeeping that did not return to the baseline even though nothing is open — including a depth that
 *   was readable when this participant started and is no longer readable now, which is the loss of the
 *   only evidence there was rather than evidence of cleanliness — which matters because the
 *   SQLite-family drivers cache one runner and hand it back to the next caller
 *   (`driver/sqljs/SqljsDriver.js:L46-L50`) while their `release()` clears only cached metadata
 *   (`driver/sqlite-abstract/AbstractSqliteQueryRunner.js:L43-L47`). A depth left below its baseline
 *   there would make the NEXT participant open a savepoint instead of a transaction.
 *
 * Every one of the three fails the run through {@link assertHarnessIntegrity} rather than being allowed
 * to poison whatever runs next, and none of them replaces the participant's own error, which the chain
 * carries separately in its outcome.
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
                `rolling back the transaction for '${label}' failed: ${describeUnknown(rollbackError)}`,
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
 *
 * Where the counter was never readable at all there is nothing to compare and nothing to repair, and
 * the public flag has already been checked by the caller. ★ Where it was readable at the baseline and
 * is *not* readable now, this reports failure. An unreadable value is not evidence that the bookkeeping
 * matches — it is the loss of the only evidence there was — and a depth that has become invisible is
 * exactly the state in which a cached, re-handed runner would go on to open a savepoint where the next
 * participant asked for a transaction. Since this function's whole purpose is to certify the runner is
 * clean, it fails closed and lets its caller report the baseline and the state observed.
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
 *
 * Either refusal abandons the runner it had already taken, and if that runner cannot be released the
 * failure is attached to the error rather than dropped — see {@link attachTeardownNote}. A held pool
 * connection is what makes a later test hang instead of fail, so it is never the cheaper thing to
 * discard on the way out.
 */
async function createDistinctRunners(dataSource: DataSource): Promise<[QueryRunner, QueryRunner]> {
    const first = dataSource.createQueryRunner();
    let second: QueryRunner;
    try {
        second = dataSource.createQueryRunner();
    } catch (creationError) {
        throw attachTeardownNote(
            asError(creationError, 'Creating the second query runner for a barriered pair failed.'),
            await releaseAbandonedRunner(first),
        );
    }
    if (first === second) {
        throw attachTeardownNote(
            new Error(
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
 *
 * ★ A runner already inside a transaction is deliberately **not** released. On the single-connection
 * family — which is precisely the family that reaches the `first === second` refusal — the runner this
 * abandons is the driver's own cached instance, so an active transaction on it belongs to whoever is
 * using it, and `release()` would neither end that transaction nor leave its owner a usable runner. The
 * abandonment says so rather than doing it quietly.
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
            `connection: ${describeUnknown(released.reason)}`
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
 * Both participant outcomes are carried in the message either way, so raising cannot lose what the
 * two callers actually observed — including the underlying rejection that explains why a
 * participant never got as far as the rendezvous.
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
    throw new Error(
        'The concurrency harness cannot certify this run, so it is raising rather than returning a ' +
            'result that would be read as evidence. A rendezvous that did not happen proves nothing ' +
            'about an interleaving, and a query runner that was not torn down cleanly holds a pool ' +
            `connection until the next test hangs instead of failing. Problems: ${problems.join(
                ' | ',
            )}. The participant outcomes are carried here so that they are not lost: ` +
            `${summariseOutcome(result.a)}; ${summariseOutcome(result.b)}.`,
    );
}

/**
 * A one-line, assertion-free description of an outcome, for use inside a harness error message.
 */
function summariseOutcome(outcome: BarrierOutcome<unknown>): string {
    const arrival = `arrived: ${String(outcome.arrived)}, releasedBeforeWrite: ${String(
        outcome.releasedBeforeWrite,
    )}`;
    if (outcome.status === 'fulfilled') {
        return `'${outcome.label}' fulfilled (${arrival})`;
    }
    return `'${outcome.label}' rejected with ${describeUnknown(outcome.reason)} (${arrival})`;
}

/**
 * Resolves both labels, defaulting them to `'a'` and `'b'`, and refuses a pair that cannot be told
 * apart — a label identifies an outcome and names a missing participant in the timeout diagnosis,
 * so two identical labels would make both unreadable.
 */
function resolveDistinctLabels<A, B, PA, PB>(
    participants: BarrierParticipants<A, B, PA, PB>,
): [string, string] {
    const labelA = participants.a.label === undefined ? 'a' : participants.a.label;
    const labelB = participants.b.label === undefined ? 'b' : participants.b.label;
    if (labelA === labelB) {
        throw new Error(
            `Both participants are labelled '${labelA}', but the two must be distinguishable: a ` +
                'label identifies an outcome and names a missing participant when the rendezvous ' +
                'times out.',
        );
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
function asError(reason: unknown, fallbackMessage: string): Error {
    if (reason instanceof Error) {
        return reason;
    }
    if (reason === undefined) {
        return new Error(fallbackMessage);
    }
    return new Error(`${fallbackMessage} Reason: ${describeUnknown(reason)}`);
}

/**
 * Describes an unknown value for a message. Total by construction: a value that cannot be
 * serialised or stringified still produces a string rather than throwing from inside an error
 * path, which would replace a real diagnosis with a secondary failure.
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
