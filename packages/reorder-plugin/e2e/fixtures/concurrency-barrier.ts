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
 * 1. **The barrier is explicit.** Both participants are held past the point the race is about —
 *    after each has performed its read or precheck, and **before either commits** — then
 *    released together. The mechanism belongs to the test, not to the platform: two
 *    transactions opened on two connections, each advanced to its own pre-write point, then
 *    both instructed to write. {@link runBarrieredPair} is that mechanism, and
 *    {@link ConcurrencyBarrier} is the rendezvous it is built from.
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
 * been ordered by the time anybody waits.
 *
 * The barrier never hangs. If the timeout elapses before release, every waiter is rejected with a
 * message naming who arrived and who did not — see {@link ConcurrencyBarrierOptions.timeoutMs}.
 *
 * @example
 * ```ts
 * // Transaction-level use: normally you want runBarrieredPair(), which owns a barrier for you.
 * const barrier = new ConcurrencyBarrier(2);
 *
 * async function participant(label: string, manager: EntityManager) {
 *     const existing = await manager.findOne(ReorderList, { where: { nameKey } }); // the precheck
 *     await barrier.arrive(label);                                                // hold here
 *     await manager.insert(ReorderList, { nameKey, customerId, channelId });      // then write
 *     return existing;
 * }
 * ```
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
 * provably open and provably past their read at the moment both are told to write. Assert the two
 * callers' results at the request level; assert the interleaving at the transaction level. Do not
 * present the request-level release as the barrier.
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
     * release simply clears the timer, because nothing is left waiting.
     */
    dispose(reason?: unknown): void {
        if (this.failure) {
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
            'check that each participant awaits arrive() after its read or precheck and that no ' +
            'participant failed before reaching it.'
        );
    }
}

/**
 * @description
 * What a participant body is handed. Each participant gets its **own** connection: two
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
     * Awaited at the pre-write point: **after** this participant's read or precheck, and
     * **before** its write. That placement is what makes the test evidence — see
     * {@link ConcurrencyBarrier}. Under {@link runSequentialPair} it resolves immediately.
     */
    arrive(): Promise<void>;
}

/**
 * @description
 * One side of a barriered or sequential pair: the work to run inside its own transaction, which
 * must await {@link BarrierParticipantContext.arrive} between its read and its write.
 */
export type BarrierParticipant<T> = (ctx: BarrierParticipantContext) => Promise<T>;

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
     * Whether this participant actually reached the rendezvous. Reported truthfully rather than
     * assumed: a participant that threw before its `arrive()` never reached the window the race is
     * about, so an assertion about the interleaving would be meaningless for it.
     */
    arrived: boolean;
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
 * One side of a pair, as supplied by the caller. The label defaults to `'a'` or `'b'`; give it a
 * descriptive name and it shows up in every outcome and in the timeout diagnosis.
 */
export interface BarrierParticipantSpec<T> {
    /** A name for this participant. Must differ from its sibling's. */
    label?: string;
    /** The body to run inside this participant's own transaction. */
    run: BarrierParticipant<T>;
}

/**
 * @description
 * The two participants of a pair.
 */
export interface BarrierParticipants<A, B> {
    /** The first participant. */
    a: BarrierParticipantSpec<A>;
    /** The second participant. */
    b: BarrierParticipantSpec<B>;
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
     * Commit each participant's transaction when its body resolves (the default), or roll it back
     * instead. A body that throws is always rolled back.
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
 * Runs two participants on **two independent connections**, each in its own transaction, held at a
 * rendezvous between its read and its write and released together. This is the canonical way to
 * evidence a race in this package, and the only one of the two drivers here that evidences an
 * interleaving.
 *
 * Gate it with {@link supportsForcedInterleaving}: it is evidence on `e2e-mariadb`, `e2e-mysql`
 * and `e2e-postgres` only, and {@link runSequentialPair} carries the same contract on the rest.
 * Nothing here weakens the migration and constraint obligations, which stay on all four engines.
 *
 * **What it guarantees.**
 * - Two query runners, each explicitly connected, so two pool connections are genuinely held —
 *   and it **refuses to run at all** on an engine whose driver hands the same runner to both,
 *   naming {@link supportsForcedInterleaving} and {@link runSequentialPair} in the error rather
 *   than letting the impossibility surface as an obscure "transaction already started".
 * - Both transactions open, and both past their read, at the moment both are told to write.
 * - Each participant ends only the transaction it opened itself, so one participant's failure can
 *   never roll back the other's work.
 * - Each participant is committed (or rolled back) **in its own chain, the instant its body
 *   returns** — never after waiting for its sibling. That is not a stylistic preference: on
 *   MySQL, MariaDB and PostgreSQL two transactions writing the same row *block* on a lock rather
 *   than erroring, so the second writer waits for the first to **commit**. A harness that awaited
 *   both bodies before committing either would deadlock, and would present as a test timeout
 *   rather than as a harness bug.
 * - Both outcomes are returned. A rejection is often the expected result, so nothing is rethrown
 *   and nothing is swallowed.
 * - Deterministic teardown on every path: every transaction is explicitly ended and every runner
 *   released, even when its sibling threw, when the rendezvous timed out, or when the transaction
 *   never started. A leaked query runner holds a pool connection, and the next test then hangs
 *   instead of failing — which is why teardown here is not politeness. Note when asserting on
 *   teardown that `isReleased` is a pool concept: the server drivers set it, while TypeORM's
 *   SQLite-family `release()` only clears cached metadata and leaves the flag false
 *   (`node_modules/typeorm/driver/sqlite-abstract/AbstractSqliteQueryRunner.js:L43-L47`), because
 *   there is no pool to return anything to.
 *
 * **Pool budget.** This driver holds two connections for the duration of the run while the server
 * is still serving requests from the same pool, so keep participant bodies short. Exhausting the
 * pool presents as a hang rather than as an error. Raising a pool setting is the suite's
 * configuration decision and is deliberately not taken here.
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
 *         const create = (label: string): BarrierParticipantSpec<number> => ({
 *             label,
 *             run: async ctx => {
 *                 // 1. the precheck the race is about
 *                 const rows: Array<{ id: number }> = await ctx.queryRunner.query(
 *                     `SELECT ${esc('id')} FROM ${esc('reorder_list')} WHERE ${esc('nameKey')} = ?`,
 *                     ['weekly restock'],
 *                 );
 *                 // 2. hold here, so both participants are inside the window together
 *                 await ctx.arrive();
 *                 // 3. only now write
 *                 await ctx.queryRunner.query(
 *                     `INSERT INTO ${esc('reorder_list')} (${esc('nameKey')}) VALUES (?)`,
 *                     ['weekly restock'],
 *                 );
 *                 return rows.length;
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
 *         expect(result.winner?.arrived).toBe(true);
 *         expect(result.loser).toBeDefined();
 *     },
 * );
 * ```
 */
export async function runBarrieredPair<A, B>(
    dataSource: DataSource,
    participants: BarrierParticipants<A, B>,
    options: RunBarrieredPairOptions = {},
): Promise<BarrierResult<A, B>> {
    const labels = resolveDistinctLabels(participants);
    const barrier = new ConcurrencyBarrier(2, {
        timeoutMs: options.timeoutMs,
        expectedLabels: labels,
    });
    const commitOnSuccess = options.commitOnSuccess !== false;
    const state: ChainState = { settled: 0, teardownErrors: [] };
    const runners = await createDistinctRunners(dataSource);

    // ★★ Both chains are started here, back to back, with no `await` between them, and each one
    // commits as soon as its own body returns. Do NOT "simplify" this into awaiting both bodies
    // and committing afterwards: on MySQL, MariaDB and PostgreSQL the second writer blocks on the
    // first writer's row lock until that transaction commits, so a harness that holds both
    // commits back deadlocks — and the symptom is an opaque test timeout, not a harness error.
    const chainA = runParticipantChain(
        runners[0],
        labels[0],
        participants.a.run,
        barrier,
        options.isolationLevel,
        commitOnSuccess,
        state,
    );
    const chainB = runParticipantChain(
        runners[1],
        labels[1],
        participants.b.run,
        barrier,
        options.isolationLevel,
        commitOnSuccess,
        state,
    );

    // Settle-collection is done by hand rather than with `Promise.all` (which short-circuits on
    // the first rejection and would abandon the other runner) or `Promise.allSettled` (which is
    // outside the es2015 lib surface this project type-checks e2e code against). Neither chain
    // ever rejects: each maps its own failure into a rejected outcome, so awaiting them in order
    // collects both regardless of which finished first.
    const outcomeA = await chainA;
    const outcomeB = await chainB;

    // Nothing is waiting by now; this exists to guarantee the timeout cannot outlive the test.
    barrier.dispose(new Error('The barriered pair has finished; its rendezvous is no longer in use.'));

    const result = assembleBarrierResult(outcomeA, outcomeB);
    assertNoTeardownFailure(state, result);
    return result;
}

/**
 * @description
 * Runs the **same two participant bodies** one after the other — `a` to completion, its
 * transaction committed or rolled back and its runner released, and only then `b` — returning the
 * **same result shape** as {@link runBarrieredPair}, so a suite can share its bodies between the
 * barrier case and the sequential case instead of writing them twice.
 * {@link BarrierParticipantContext.arrive} resolves immediately here, and `arrived` is reported
 * truthfully for whichever participant called it.
 *
 * **What this evidences:** single-connection correctness, replay idempotency, accumulation
 * arithmetic, and constraint shape — including a duplicate written straight through the repository
 * so that no service pre-check can intercept it. That is a real assertion about the same contract,
 * and it is what keeps the sql.js job meaningful rather than skipped: a skipped job is not
 * evidence, whereas a sequential run is.
 *
 * **What this does not evidence: interleaving.** Two bodies run in series were never inside the
 * same window, so a suite must not present this as a race. Pair it with a
 * {@link runBarrieredPair} case gated on {@link supportsForcedInterleaving} and let each assertion
 * claim only its own half.
 *
 * @example
 * ```ts
 * // Same bodies as the barrier case above; this one runs on every engine, sql.js included.
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
export async function runSequentialPair<A, B>(
    dataSource: DataSource,
    participants: BarrierParticipants<A, B>,
    options: RunSequentialPairOptions = {},
): Promise<BarrierResult<A, B>> {
    const labels = resolveDistinctLabels(participants);
    const commitOnSuccess = options.commitOnSuccess !== false;
    const state: ChainState = { settled: 0, teardownErrors: [] };

    // No barrier is created at all in this mode: `arrive()` resolves immediately, and there is no
    // timer to clear because there was never anything to wait for. Each runner is created
    // immediately before its own chain rather than both up front, so that on an engine whose
    // driver caches one runner the second participant legitimately reuses it once the first has
    // finished with it — which is exactly what "one after the other" means here.
    const outcomeA = await runParticipantChain(
        dataSource.createQueryRunner(),
        labels[0],
        participants.a.run,
        undefined,
        options.isolationLevel,
        commitOnSuccess,
        state,
    );
    const outcomeB = await runParticipantChain(
        dataSource.createQueryRunner(),
        labels[1],
        participants.b.run,
        undefined,
        options.isolationLevel,
        commitOnSuccess,
        state,
    );

    const result = assembleBarrierResult(outcomeA, outcomeB);
    assertNoTeardownFailure(state, result);
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
 * One participant's whole life cycle, as a single independent async chain:
 * `createQueryRunner` -> `connect` -> `startTransaction` -> body -> commit or roll back ->
 * release. It never rejects: every failure, including a failure at COMMIT, is mapped into a
 * rejected {@link BarrierOutcome} so that the caller can assert on it, because for a race claim a
 * rejection is frequently the expected result.
 *
 * Passing `barrier` as `undefined` selects sequential mode, where `arrive()` resolves immediately.
 */
async function runParticipantChain<T>(
    queryRunner: QueryRunner,
    label: string,
    run: BarrierParticipant<T>,
    barrier: ConcurrencyBarrier | undefined,
    isolationLevel: BarrierIsolationLevel | undefined,
    commitOnSuccess: boolean,
    state: ChainState,
): Promise<BarrierOutcome<T>> {
    let arrived = false;
    let startedTransaction = false;
    try {
        // connect() is called explicitly so that this participant is holding a pool connection of
        // its own before its transaction opens. Two participants must never share one connection:
        // a single connection cannot hold two open transactions, so it cannot interleave, and a
        // test built on it would prove serialisation.
        await queryRunner.connect();
        // The isolation level is whatever the caller asked for. Omitted means the engine's own
        // default, which differs between engines and is then part of what the test asserts.
        await queryRunner.startTransaction(isolationLevel);
        startedTransaction = true;
        const value = await run({
            label,
            queryRunner,
            manager: queryRunner.manager,
            arrive: async () => {
                if (barrier !== undefined) {
                    await barrier.arrive(label);
                }
                arrived = true;
            },
        });
        // End the transaction here, in this participant's own chain, the moment its body returns.
        // See the note in runBarrieredPair: waiting for the sibling before committing deadlocks on
        // every engine that blocks a second writer on a row lock. A failure raised by COMMIT is
        // this participant's own outcome and not a harness fault — under SERIALIZABLE that is
        // exactly where a serialization failure surfaces, and it is a genuine race result.
        if (startedTransaction && queryRunner.isTransactionActive) {
            if (commitOnSuccess) {
                await queryRunner.commitTransaction();
            } else {
                await queryRunner.rollbackTransaction();
            }
        }
        const settledOrder = state.settled++;
        return { label, arrived, settledOrder, status: 'fulfilled', value };
    } catch (reason) {
        // `startedTransaction` is the guard, not `isTransactionActive` alone: a participant must
        // only ever end a transaction it opened itself. Where a driver hands the same runner to
        // both participants, the second one's startTransaction fails against a transaction that
        // belongs to the first, and rolling that back would destroy its sibling's work.
        if (startedTransaction && queryRunner.isTransactionActive) {
            try {
                await queryRunner.rollbackTransaction();
            } catch (rollbackError) {
                state.teardownErrors.push(
                    `rolling back the transaction for '${label}' failed: ${describeUnknown(rollbackError)}`,
                );
            }
        }
        const settledOrder = state.settled++;
        return { label, arrived, settledOrder, status: 'rejected', reason };
    } finally {
        // Unconditional teardown. Every runner is released even when its sibling threw, when the
        // rendezvous timed out, or when the transaction never opened at all, because a leaked
        // query runner holds a pool connection and the next test then hangs rather than failing.
        if (!queryRunner.isReleased) {
            try {
                await queryRunner.release();
            } catch (releaseError) {
                state.teardownErrors.push(
                    `releasing the connection for '${label}' failed: ${describeUnknown(releaseError)}`,
                );
            }
        }
        // A participant that finished without reaching the rendezvous leaves its sibling waiting
        // for a partner that is never coming. Disposing turns that into an immediate named failure
        // on both sides instead of a wait that runs out the timeout. Note that the sibling's wait is
        // FAILED here, never satisfied: releasing it would let a half-populated pair look like a
        // completed interleaving.
        if (barrier !== undefined && !arrived && !barrier.released) {
            barrier.dispose(
                new Error(
                    `Participant '${label}' finished without reaching the barrier — it either ` +
                        'failed beforehand or never awaited arrive() — so the rendezvous was ' +
                        'abandoned and every waiting participant rejected at once, rather than ' +
                        'left to run out the timeout.',
                ),
            );
        }
    }
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
        await releaseQuietly(first);
        throw creationError;
    }
    if (first === second) {
        await releaseQuietly(first);
        throw new Error(
            'runBarrieredPair cannot evidence anything on this engine: its driver returned the ' +
                'same QueryRunner for both participants, so the two would share one connection and ' +
                'one transaction and could never interleave. That is the single-connection family ' +
                `(${SINGLE_CONNECTION_ENGINES.join(', ')}), whose TypeORM driver caches one query ` +
                'runner. Gate the barrier case with it.skipIf(!supportsForcedInterleaving()) and let ' +
                'runSequentialPair carry the sequential form of the same contract here.',
        );
    }
    return [first, second];
}

/**
 * Releases a runner that is being abandoned before any participant used it. A failure here has
 * nothing to add to the error that is about to be thrown, so it is deliberately not aggregated.
 */
async function releaseQuietly(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.isReleased) {
        return;
    }
    try {
        await queryRunner.release();
    } catch {
        // Intentionally ignored: the caller is already throwing a more informative error, and
        // replacing it with a teardown failure would hide the diagnosis.
    }
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
 * Reports teardown failures rather than hiding them, and carries both participant outcomes in the
 * message so that raising this cannot mask what the two callers actually observed.
 */
function assertNoTeardownFailure<A, B>(state: ChainState, result: BarrierResult<A, B>): void {
    if (state.teardownErrors.length === 0) {
        return;
    }
    throw new Error(
        'The concurrency harness could not tear a participant down cleanly. This is raised rather ' +
            'than hidden because a leaked query runner holds a pool connection, and the next test ' +
            `then hangs instead of failing. Teardown failures: ${state.teardownErrors.join(' | ')}. ` +
            'The participant outcomes are carried here so that they are not lost: ' +
            `${summariseOutcome(result.a)}; ${summariseOutcome(result.b)}.`,
    );
}

/**
 * A one-line, assertion-free description of an outcome, for use inside a harness error message.
 */
function summariseOutcome(outcome: BarrierOutcome<unknown>): string {
    const arrival = `arrived: ${String(outcome.arrived)}`;
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
function resolveDistinctLabels<A, B>(participants: BarrierParticipants<A, B>): [string, string] {
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
