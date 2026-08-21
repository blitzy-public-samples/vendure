/**
 * The ONE implementation of the diagnostic redaction every end-to-end suite in this package uses.
 *
 * ★ **WHY THIS IS A FIXTURE AND NOT A HELPER INSIDE EACH SUITE.** What it decides is a security property —
 * whether a failing assertion publishes a session token, a buyer's address, a bound query parameter or the
 * layout of the machine that ran the suite into a build log. Four suites had a copy of it, and four copies
 * are four things to keep correct: the copies agreed only because they were kept byte-identical by hand, and
 * the first divergence would be invisible because a redaction that stops redacting still produces a string.
 * One module, imported by every suite, makes "every suite redacts identically" a fact about the code rather
 * than a fact about the discipline of whoever edits it next. Its own tests live beside it in
 * `diagnostic-redaction.e2e-spec.ts`, following the pattern `concurrency-barrier.e2e-spec.ts` sets.
 *
 * ★ **THE RULE, IN ONE SENTENCE.** Nothing that came from outside this package is reproduced: a caught
 * failure is MEASURED and described from fixed lists, and a stage label is refused outright if it carries a
 * shape a value arrives in. Both directions fail CLOSED — an unrecognised error class, an unanticipated
 * driver phrasing and an unexpected label all lose detail rather than gaining exposure.
 *
 * ★ **BOTH SINKS OF A FAILING ASSERTION ARE COVERED, AND THAT DISTINCTION IS EASY TO MISS.** A matcher
 * prints its ACTUAL as well as its message, so redacting only the message leaves the raw value published
 * through the actual. Callers therefore pass a redacted string, a count or a boolean as the actual, and use
 * these helpers for the message.
 */

/**
 * A stage label, rendered so that a label someone interpolated a VALUE into cannot publish it.
 *
 * ★ THE LABEL IS THE ONE THING HERE THAT IS REPRODUCED VERBATIM, AND THAT IS WHY IT NEEDS A GUARD OF ITS
 * OWN. Every stage name in this file is a short literal — `plugin rows`, `capture reset` — and keeping it
 * intact is what makes an aggregated failure say which step broke. But a stage is declared by whoever adds
 * one, and the natural way to make a per-item stage readable is to interpolate the item: an absolute
 * temporary directory, a file, an address. Reviewing every future stage for that is a process; refusing the
 * shapes a value arrives in is a property.
 *
 * Three shapes are refused, each chosen because no legitimate label in this file has it and each of the
 * disclosures actually seen does. A path separator — forward or back — means a filesystem path, which
 * describes the machine that ran the suite. An `@` means an address. And a label longer than the budget
 * means something was interpolated even where it carried neither, since every real label here is a few
 * words. A refused label is replaced wholesale rather than trimmed, because a trimmed path is still a path.
 */
export const TEARDOWN_STAGE_LABEL_BUDGET = 80;

/**
 * The characters a label may NOT contain, as an allowlist expressed by its complement.
 *
 * ★ **WHY AN ALLOWLIST OF CHARACTERS AND NOT A LIST OF THINGS TO REJECT.** Every label in this package is
 * ASCII words, digits, spaces and a few separators — `plugin rows`, `capture reset`, `dropping the
 * isolated database`. Anything outside that is a value someone interpolated, and enumerating the ways a
 * value can look is the denylist mistake this module exists to avoid. Two classes made the difference
 * concrete. A CONTROL CHARACTER — a newline, a carriage return, a `\u0007` — splits one log record into
 * two, and the second can be spelled to read like a step that passed (CWE-117); a ZERO-WIDTH or
 * bidirectional format character is invisible in a log yet carries data. Neither contains a path
 * separator, an `@`, or enough characters to exceed the budget, so all three of the original rules let
 * them straight through. The complement of a small allowlist refuses them and everything like them.
 */
const SAFE_STAGE_LABEL = /^[A-Za-z0-9 ,.:;()'"?!+=<>[\]{}#%&*_-]*$/;

/**
 * Renders a stage or participant label, replacing it wholesale when it carries a value.
 *
 * Four rules, each chosen because no legitimate label in this package breaks it and each of the
 * disclosures actually seen does: a path separator means a filesystem path, which describes the machine
 * that ran the suite; an `@` means an address; a character outside {@link SAFE_STAGE_LABEL} means a
 * control, format or non-ASCII value; and a label over {@link TEARDOWN_STAGE_LABEL_BUDGET} means something
 * was interpolated even where it carried none of the above. A refused label is replaced ENTIRELY rather
 * than trimmed or escaped, because a trimmed path is still a path and an escaped newline still reproduces
 * the text around it.
 */
export function describeTeardownStage(what: string): string {
    const carriesAValue =
        /[/\\@]/.test(what) || !SAFE_STAGE_LABEL.test(what) || what.length > TEARDOWN_STAGE_LABEL_BUDGET;
    return carriesAValue ? '<unrenderable-stage-label>' : what;
}

/**
 * The error classes a teardown diagnostic may NAME, as a fixed set.
 *
 * A class name comes from library code rather than from data, so naming one discloses nothing — but the
 * rule below is an allowlist rather than a test on the shape of the name, because "it looks like a class
 * name" is a judgement and this file is not the place to make one. A class not listed here is reported as
 * unrecognised, which costs a little readability and cannot cost anything else.
 */
export const TEARDOWN_DIAGNOSTIC_ERROR_CLASSES = new Set<string>([
    // The built-ins.
    'Error',
    'AggregateError',
    'AssertionError',
    'EvalError',
    'RangeError',
    'ReferenceError',
    'SyntaxError',
    'TypeError',
    'URIError',
    // TypeORM's own, which is what a raw statement against a core table fails with.
    'CannotConnectAlreadyConnectedError',
    'CannotExecuteNotConnectedError',
    'ColumnTypeUndefinedError',
    'ConnectionIsNotSetError',
    'EntityMetadataNotFoundError',
    'EntityNotFoundError',
    'OptimisticLockVersionMismatchError',
    'QueryFailedError',
    'QueryRunnerAlreadyReleasedError',
    'TransactionAlreadyStartedError',
    'TransactionNotStartedError',
    'TypeORMError',
    // The platform's, which a teardown stage going through a service would raise.
    'ForbiddenError',
    'IllegalOperationError',
    'InternalServerError',
    'UnauthorizedError',
    'UserInputError',
    // `typeof` results, for a rejection that is not an Error at all.
    'bigint',
    'boolean',
    'function',
    'number',
    'object',
    'string',
    'symbol',
    'undefined',
]);

/**
 * What a failure IS, expressed only in labels this file owns.
 *
 * Each entry pairs a label with the shapes the four drivers phrase that failure in. The label is what
 * reaches the log; the pattern only decides whether it does. Adding an engine means adding a pattern, and
 * a phrasing nobody anticipated simply produces no label — which is the fail-closed direction.
 */
export const TEARDOWN_DIAGNOSTIC_CLASSES: ReadonlyArray<readonly [string, RegExp]> = [
    ['unique-violation', /duplicate (entry|key)|unique constraint/],
    ['check-violation', /check constraint/],
    ['not-null-violation', /not[- ]null constraint|cannot be null/],
    ['foreign-key-violation', /foreign key/],
    ['missing-table', /no such table|unknown table|relation .* does not exist/],
    ['missing-column', /no such column|unknown column|column .* does not exist/],
    ['missing-object', /does not exist|doesn't exist/],
    ['deadlock', /deadlock/],
    ['lock-unavailable', /lock wait timeout|database is locked|could not obtain lock/],
    ['timeout', /statement timeout|query timeout|timed out|etimedout/],
    ['connection', /econnrefused|econnreset|epipe|not connected|connection (is )?(closed|lost|refused)/],
    ['transaction-state', /transaction is aborted|transaction already started|transaction not started/],
    ['syntax', /syntax error|sql syntax/],
    ['authorization', /permission denied|access denied|forbidden|unauthori[sz]ed/],
    ['filesystem', /enoent|eacces|no such file|illegal operation on a directory/],
    ['programming-error', /is not a function|cannot read propert|of undefined|of null/],
];

/**
 * The schema names a teardown diagnostic may report as MENTIONED, as a fixed list.
 *
 * These are the tables and named objects this suite's own statements address, so each is already a literal
 * elsewhere in this file. Reporting that a failure mentioned one of them is the difference between "the
 * teardown failed" and "the teardown failed on the session row", and it discloses no value: the name of a
 * table is not the content of one.
 */
export const TEARDOWN_DIAGNOSTIC_SCHEMA_NAMES: readonly string[] = [
    'administrator',
    'channel',
    'customer',
    'product_variant',
    'product_variant_price',
    'reorder_list',
    'reorder_list_line',
    'session',
    'user',
    'CHK_reorder_list_line_count_non_negative',
    'CHK_reorder_list_line_quantity_positive',
    'IDX_reorder_list_customer_channel',
    'UQ_reorder_list_customer_channel_name_key',
    'UQ_reorder_list_line_list_variant',
];

/**
 * One failure from a teardown stage, rendered so it can be read in a build log without carrying any part
 * of the message that produced it.
 *
 * ★ THE MESSAGE TEXT IS NEVER PROPAGATED — IT IS ONLY MEASURED. That is the whole difference from the
 * revision this replaces, which redacted every quoted run and let the rest through. Redacting the shapes
 * you thought of is a denylist wearing a redaction's clothes, and three real messages walk straight past
 * it: PostgreSQL reports the offending value in PARENTHESES (`Key (emailAddress)=(buyer@x.invalid) already
 * exists`), a stage that fails resolving a file reports an absolute path with no delimiter at all, and a
 * bare `session token 4f2c81b9` has nothing to quote. Under this rule none of them can leak, because
 * nothing from the message is reproduced: what is emitted is the error's CLASS, its driver CODE, a
 * classification drawn from a fixed list of labels, the schema names the message mentioned drawn from
 * another fixed list, and the message's LENGTH.
 *
 * A phrasing nobody anticipated therefore fails CLOSED. It classifies as `unclassified`, mentions nothing,
 * and is reported by length alone — less readable than a driver's own sentence and unable to publish a
 * credential, a buyer's address or a filesystem path. The stage NAME beside it is this file's own text and
 * says which table and which step, which is the datum that actually locates the fault.
 *
 * Bounded by construction rather than by a truncation budget: every part of the output is either a fixed
 * literal from one of the three lists above or a number, so there is no length to cap and no possibility
 * of a budget cutting a literal in half.
 */
export function redactTeardownDiagnostic(err: unknown): string {
    const raw = err instanceof Error ? err.message : String(err);
    const rawClass = err instanceof Error ? err.name : typeof err;
    const errorClass = TEARDOWN_DIAGNOSTIC_ERROR_CLASSES.has(rawClass)
        ? rawClass
        : '<unrecognised-error-class>';
    // A driver code is an enumerated constant the driver owns — MySQL's `ER_DUP_ENTRY`, SQLite's
    // `SQLITE_CONSTRAINT`, PostgreSQL's five-character SQLSTATE — and it is the most precise thing a log
    // can carry. Admitted only in exactly those three shapes, so no other value can arrive through it.
    const rawCode: unknown = err instanceof Error ? (err as { code?: unknown }).code : undefined;
    const code =
        typeof rawCode === 'string' && /^(ER_[A-Z_]{1,40}|SQLITE_[A-Z_]{1,40}|[0-9A-Z]{5})$/.test(rawCode)
            ? `/${rawCode}`
            : '';
    // A numeric `errno` is the same kind of thing as a string code, and some drivers carry only that one:
    // MySQL 8 reports 3572 for a refused `NOWAIT`, MariaDB 1205. Admitted only as a non-negative integer
    // below the width a driver enum ever occupies, so nothing else can arrive through it — and it is the datum
    // that lets a new engine spelling be added deliberately rather than guessed at.
    const rawErrno: unknown = err instanceof Error ? (err as { errno?: unknown }).errno : undefined;
    const errno =
        typeof rawErrno === 'number' && Number.isSafeInteger(rawErrno) && rawErrno >= 0 && rawErrno <= 99999
            ? `#${String(rawErrno)}`
            : '';
    const lowered = raw.toLowerCase();
    const labels = TEARDOWN_DIAGNOSTIC_CLASSES.filter(([, pattern]) => pattern.test(lowered)).map(
        ([label]) => label,
    );
    const mentioned = TEARDOWN_DIAGNOSTIC_SCHEMA_NAMES.filter(name =>
        new RegExp(`\\b${name}\\b`, 'i').test(raw),
    );
    return (
        `${errorClass}${code}${errno} [${labels.length === 0 ? 'unclassified' : labels.join('+')}] ` +
        `mentioning ${mentioned.length === 0 ? 'nothing recognised' : mentioned.join('+')} ` +
        `(message withheld, ${String(raw.length)} chars)`
    );
}

/**
 * Runs EVERY teardown stage, in order, whatever any of them does, and reports the failures afterwards.
 *
 * A linear `await a(); await b(); await c();` teardown stops at the first failure, stranding every later
 * stage — the plugin-row cleanup, the restoration of a core row a test changed, the client's channel
 * token — so one broken test leaves the next one running against state it never established. Collecting
 * the failures and raising them once at the end keeps the diagnosis and loses none of the cleanup.
 */
export async function runAllTeardownStages(
    stages: Array<{ what: string; run: () => Promise<void> }>,
): Promise<void> {
    const failures: string[] = [];
    for (const stage of stages) {
        try {
            await stage.run();
        } catch (err: unknown) {
            // NOTHING FROM THE CAUGHT MESSAGE IS CARRIED HERE — only a description of it. This aggregate is
            // thrown, printed by the runner and read in a build log, and a stage runs raw statements
            // against the `customer`, `user` and `session` rows of a live buyer, so a driver failure can
            // arrive carrying a value it echoed back. The stage NAME is this file's own text and is kept
            // verbatim, because it is what identifies the stage that failed. See
            // {@link redactTeardownDiagnostic} for why measuring the message beats redacting it.
            failures.push(`${describeTeardownStage(stage.what)}: ${redactTeardownDiagnostic(err)}`);
        }
    }
    if (failures.length > 0) {
        throw new Error(`Teardown did not complete cleanly — ${failures.join(' | ')}`);
    }
}

/**
 * One settled participant of the two-connection harness, as the harnesses in this package shape them.
 */
export interface SettledOutcomeLike {
    /** The participant's own name, supplied by the suite that wrote it. */
    label?: string;
    status: string;
    reason?: unknown;
}

/**
 * Settled participants rendered for a diagnostic WITHOUT reproducing why any of them rejected.
 *
 * ★ **WHY A RACE DIAGNOSTIC IS THE HARDEST ONE TO GET RIGHT, AND WHY IT BELONGS HERE.** A failed race has to
 * say more than "a participant rejected", or the failure is unactionable — which is exactly the pressure that
 * produced four separate copies of this rendering, each interpolating `reason.message`. And the reason a race
 * participant carries is the most sensitive error this package ever holds: these participants write straight
 * through the repository, so a rejection is a TypeORM `QueryFailedError` carrying the STATEMENT, its BOUND
 * PARAMETERS and the driver's own fields. Serialising the outcome instead does not help — an ordinary `Error`
 * stringifies to `{}` because its properties are non-enumerable, but `QueryFailedError` copies the driver's
 * error onto itself, so `query` and `parameters` become enumerable own properties and every one of them is
 * published.
 *
 * So a reason goes through {@link redactTeardownDiagnostic}, which names the error class, the enumerated driver
 * code and errno, the failure classification and the schema names the message mentioned — which is what a
 * reader of a failed race actually needs — and reproduces none of the message. A label goes through
 * {@link describeTeardownStage}, because a participant is named by whoever wrote the case, and the same
 * pressure that interpolates a reason interpolates an identifier into a name.
 *
 * @param outcomes - The settled participants, in the order the diagnostic should read.
 * @param describeFulfilledValue - How to describe a FULFILLED participant's value. A value is the suite's own
 * domain object rather than anything a driver produced, so each suite decides what about it is worth saying;
 * omitted, a fulfilled participant is reported as fulfilled and nothing more.
 */
export function describeSettledOutcomes<T extends SettledOutcomeLike>(
    outcomes: readonly T[],
    describeFulfilledValue?: (outcome: T) => string,
): string {
    return outcomes
        .map(outcome => {
            const label = outcome.label === undefined ? '' : describeTeardownStage(outcome.label);
            if (outcome.status === 'fulfilled') {
                const described = describeFulfilledValue ? describeFulfilledValue(outcome) : 'fulfilled';
                return label === '' ? described : `${label}=${described}`;
            }
            const rejection = `REJECTED: ${redactTeardownDiagnostic(outcome.reason)}`;
            return label === '' ? rejection : `${label} ${rejection}`;
        })
        .join(' | ');
}

/**
 * Re-raises a caught failure as a REDACTED one, and is the only sanctioned way to let a caught failure out.
 *
 * ★ **WHY A THROWING BOUNDARY RATHER THAN A REDACTION AT EACH CALL SITE.** {@link runAllTeardownStages}
 * already redacts everything it runs, so a QUEUED stage is safe. What it cannot cover is a helper called
 * DIRECTLY from the body of a test — a restoration driven mid-test so that the functional half can be
 * asserted while the server is still up. Those calls are outside the aggregator, so a raw failure from one
 * of them travels straight to the runner, and the failures that path raises are the worst ones available:
 * the statements are raw SQL binding CAPTURED CELLS, so a TypeORM `QueryFailedError` from one carries the
 * `customer`, `user` and `session` values the restoration was putting back — an address, a password hash, a
 * live session token — as its own enumerable `query` and `parameters`.
 *
 * Redacting at each of those call sites would work and would not stay working: the leak is created by
 * ADDING a call, and a call added later is a call nobody re-reviewed. Sanitising where the statement is
 * EXECUTED makes it a property of the boundary instead, so every caller — the three that exist and any
 * added afterwards — is covered without knowing this rule exists.
 *
 * The original is deliberately NOT attached as `cause`: a `cause` is walked and printed by the runner, so
 * chaining it would republish through the chain exactly what the message no longer says.
 *
 * @param what - Which step failed, as this file's own literal text. Passed through
 * {@link describeTeardownStage}, so a label with a value interpolated into it is refused rather than printed.
 * @param err - The caught failure. Measured by {@link redactTeardownDiagnostic}; never reproduced.
 * @returns Never — the declared `never` is what stops a caller from building this and then logging it
 * somewhere else instead of throwing it.
 */
export function rethrowRedacted(what: string, err: unknown): never {
    throw new Error(`${describeTeardownStage(what)} failed — ${redactTeardownDiagnostic(err)}`);
}

/**
 * One cell rendered so that two reads of the same stored value compare equal.
 *
 * The drivers do not agree on representation — a boolean column arrives as `true` from PostgreSQL and as
 * `1` from the MySQL family and sql.js — so a bare `toEqual` over raw rows would report a difference that
 * is the driver's rather than the data's. Both are folded onto the same rendering, and a `Date` onto its
 * epoch milliseconds, which is the precision a driver surfaces.
 *
 * ★ THIS RENDERING KEEPS THE VALUE, and is therefore for COMPARING ONLY — never for a message or a matcher
 * actual. {@link describeCellForDiagnostic} is the one that gets reported.
 */
export function canonicaliseCell(value: unknown): string {
    if (value === null || value === undefined) {
        return 'null';
    }
    if (value instanceof Date) {
        return `date:${value.getTime()}`;
    }
    if (Buffer.isBuffer(value)) {
        return `buffer:${value.toString('hex')}`;
    }
    if (typeof value === 'boolean') {
        return `number:${value ? 1 : 0}`;
    }
    if (typeof value === 'number') {
        return `number:${value}`;
    }
    return `string:${String(value)}`;
}

/**
 * Describes ONE cell for a diagnostic WITHOUT disclosing it: its kind, and for a sized value its size.
 *
 * ★ WHY A DESCRIPTION RATHER THAN THE VALUE. The rows these helpers compare are core rows, and on the
 * soft-delete path they are the `customer`, `user` and `session` rows of a real seeded buyer — so a cell
 * here can be an active authentication token, an email address, a name or a password hash. A failing
 * assertion prints its message into the run's log, and a continuous integration log is readable by
 * everyone who can see the build, so a diagnostic that reproduced the cell would publish the credential
 * the test merely had to put back. Naming the row and the column is what a reader actually needs in order
 * to find the write that moved it; the value is not.
 *
 * A number, a boolean and a null are rendered as themselves, because those are the identifiers and flags
 * a reader needs and none of them can carry a credential. A string, a buffer and a date are described by
 * shape alone — which still separates "the column moved" from "it did not", and a length change from a
 * same-length change, without saying what either value was. This is the same rule, for the same reason,
 * that `e2e/fixtures/query-capture.ts` applies to a bound statement parameter.
 */
export function describeCellForDiagnostic(value: unknown): string {
    if (value === null || value === undefined) {
        return 'null';
    }
    if (value instanceof Date) {
        return 'date';
    }
    if (Buffer.isBuffer(value)) {
        return `buffer(${String(value.length)})`;
    }
    if (typeof value === 'boolean' || typeof value === 'number' || typeof value === 'bigint') {
        return String(value);
    }
    if (typeof value === 'string') {
        return `string(${String(value.length)})`;
    }
    return typeof value;
}

/** What {@link describeRowDifferences} says when the rows match the capture in every cell. */
export const NO_ROW_DIFFERENCE = 'no cell differs';

/**
 * Names every cell that differs between a capture and the rows as they stand now — by ROW IDENTIFIER and
 * COLUMN NAME, and by the SHAPE of each side rather than by either value.
 *
 * ★ **FULL VALUES COMPARED, SHAPES REPORTED — and those are two separate things that are easy to conflate.**
 * The comparison runs over the complete canonicalised values, so nothing about the fidelity of "restored
 * cell for cell" is given up: every column of every captured row is compared, a captured row that has gone
 * is reported missing and a row that appeared is reported added. What is given up is only the reproduction
 * of the two values in the message. The alternative — handing the two row arrays to `toEqual` — is exactly
 * as strict and publishes every cell of every row on failure, through the matcher's own actual and expected.
 *
 * @param captured - The rows as they stood before the window under test.
 * @param now - The rows as they stand after it.
 * @returns {@link NO_ROW_DIFFERENCE} when every cell matches, or a value-free description of what moved.
 */
export function describeRowDifferences(
    captured: ReadonlyArray<Record<string, unknown>>,
    now: ReadonlyArray<Record<string, unknown>>,
): string {
    const nowById = new Map(now.map(row => [String(row.id), row]));
    const capturedIds = new Set(captured.map(row => String(row.id)));
    const differences: string[] = [];
    for (const row of captured) {
        const current = nowById.get(String(row.id));
        if (current === undefined) {
            differences.push(`row ${String(row.id)} is missing`);
            continue;
        }
        for (const column of Object.keys(row).sort()) {
            // FULL VALUES COMPARED, SHAPES REPORTED.
            if (canonicaliseCell(row[column]) !== canonicaliseCell(current[column])) {
                differences.push(
                    `row ${String(row.id)}.${column} moved ` +
                        `(${describeCellForDiagnostic(row[column])} -> ` +
                        `${describeCellForDiagnostic(current[column])})`,
                );
            }
        }
    }
    for (const row of now) {
        if (!capturedIds.has(String(row.id))) {
            differences.push(`row ${String(row.id)} was added`);
        }
    }
    return differences.length === 0 ? NO_ROW_DIFFERENCE : differences.join('; ');
}
