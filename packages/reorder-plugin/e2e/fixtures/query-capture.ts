/**
 * The canonical query-capture instrument for the reorder plugin's end-to-end suite.
 *
 * This module is the *only* mechanism this feature counts SQL statements with. It is a deliverable
 * in its own right rather than a convenience helper, and five of the six sibling suites import it
 * from this exact path.
 *
 * ---------------------------------------------------------------------------------------------
 * ATTRIBUTION
 * ---------------------------------------------------------------------------------------------
 * `review_rules` was called for the entire rules document and returned exactly
 * `No user rules provided.` — so **no user-specified rule governs this file and no rule forced it
 * into scope**. There is no rule to cite here and none has been invented. The absence of rules is
 * not licence to lower the bar: this module is held to enterprise-standard best practice instead.
 *
 * Every constraint this module honours is therefore either
 *  - prompt-derived: the Agent Action Plan, §0.2.4.2 (New Test Files), §0.5.1.8 (Group 8),
 *    §0.5.2.5 ("Proving the Implementation"), §0.6.1.2 and §0.7.6 (Statement-Count Discipline); or
 *  - ticket-derived: `tickets/EPIC-001-reorder-and-replenishment.md` §11.6.1 (The Canonical Test
 *    Lifecycle And Isolation Contract), §11.6.2 (The Canonical Query-Capture Harness) and §11.6.3
 *    (Which Engines Evidence A Race), `tickets/EPIC-001/FEATURE-001-01-named-reorder-lists.md`
 *    §2.6.1.1 (How A "Reads Nothing" Claim Is Actually Evidenced), and the statement-count clauses
 *    of all four `STORY-001-01-0x` files.
 *
 * ---------------------------------------------------------------------------------------------
 * WHAT THIS IS, AND THE TWO MECHANISMS IT DELIBERATELY IS NOT
 * ---------------------------------------------------------------------------------------------
 * IT IS a TypeORM `Logger` object supplied on `dbConnectionOptions`, whose statement hook appends
 * each statement *and its parameters* to an array the test owns. TypeORM's logging contract is
 * what makes the result exact rather than approximate: the hook receives every statement the data
 * source executes, including the ones a query builder and a lazy relation issue.
 *
 * IT IS NOT the boolean `logging` flag. `dbConnectionOptions` is TypeORM's own options object
 * (`packages/core/src/config/vendure-config.ts:L1296`) and the platform states plainly that SQL
 * query logging is controlled there, separately from the Vendure logger
 * (`packages/core/src/config/vendure-config.ts:L1358-L1360`). Set to `true` that flag *prints*; it
 * returns nothing a test can assert on, and a specification cannot count what it cannot capture.
 *
 * IT IS NOT a spy on `TransactionalConnection.getRepository`. That counts repository *handles
 * taken*, not statements issued — one handle serves many statements, a query builder issues
 * statements without taking a second handle, and an eagerly loaded relation issues a statement no
 * plugin code asked for. That overload is additionally `@deprecated since 1.7.0` in favour of
 * `rawConnection.getRepository()` (`packages/core/src/connection/transactional-connection.ts:L97`,
 * the implementation signature at `:L136`).
 *
 * ---------------------------------------------------------------------------------------------
 * FIRST-PARTY PROOF THAT THE MANDATED INSTRUMENT ACTUALLY RECEIVES THE STATEMENTS
 * ---------------------------------------------------------------------------------------------
 * `ConnectionModule.forRoot()` builds the TypeORM module from `{ ...dbConnectionOptions, logger }`
 * (`packages/core/src/connection/connection.module.ts:L43-L47`) where the logger comes from
 * `getTypeOrmLogger()` (`:L65-L71`):
 *
 *     static getTypeOrmLogger(dbConnectionOptions: DataSourceOptions) {
 *         if (!dbConnectionOptions.logger) { return new TypeOrmLogger(dbConnectionOptions.logging); }
 *         else { return dbConnectionOptions.logger; }
 *     }
 *
 * A caller-supplied `logger` is therefore passed straight through, replacing core's `TypeOrmLogger`.
 * Three consequences follow, and all three are evidence rather than inference:
 *
 *  1. The instrument is guaranteed to receive the statements. TypeORM's query runners call
 *     `logger.logQuery(...)` unconditionally before executing — see
 *     `node_modules/typeorm/driver/sqljs/SqljsQueryRunner.js:L70` — leaving it to the logger, not
 *     the driver, to decide what to do with the call.
 *  2. Once this logger is installed, `dbConnectionOptions.logging` becomes **inert**, because core's
 *     `TypeOrmLogger` is never constructed. That independently confirms the boolean flag is the
 *     wrong instrument.
 *  3. Because core's `TypeOrmLogger` is displaced, its error, warning, schema and migration
 *     diagnostics no longer reach the Vendure logger. That is why this class *records*
 *     `logQueryError`, `logSchemaBuild`, `logMigration` and `log` and exposes a `format()` dump
 *     rather than silently discarding them.
 *
 * ---------------------------------------------------------------------------------------------
 * WHY THIS EXPORTS A CLASS AND MUST NEVER BECOME AN OBJECT LITERAL
 * ---------------------------------------------------------------------------------------------
 * A suite installs the instrument by merging it into a `VendureConfig`, and `mergeConfig` treats a
 * class instance and an object literal completely differently:
 *
 *  - `isClassInstance(item)` is `isObject(item) && item.constructor && item.constructor.name !==
 *    'Object'` (`packages/common/src/shared-utils.ts:L26-L30`).
 *  - `mergeConfig` recurses into an object-valued source property when it is *not* a class instance,
 *    and assigns it **by reference** through `safeAssign` when it is
 *    (`packages/core/src/config/merge-config.ts:L48-L59`).
 *  - `simpleDeepClone`, applied to `mergeConfig`'s target at depth 0, returns its input unchanged
 *    when the input is a class instance (`packages/common/src/simple-deep-clone.ts:L23-L25`).
 *
 * A `new QueryCaptureLogger()` therefore survives both paths with its **identity intact**, so
 * `capture.reset()` in `beforeEach` provably affects the very object TypeORM holds. A plain object
 * literal such as `{ logQuery() {} }` has `constructor.name === 'Object'`, so it is deep-merged onto
 * a fresh `{}`: identity is lost, `reset()` silently stops working, and the failure is intermittent
 * and baffling. Do not "simplify" this class into a literal.
 *
 * For the same reason `reset()` truncates its arrays in place and never reassigns them, so a suite
 * that captured a reference to `capture.statements` keeps seeing the live array.
 *
 * ---------------------------------------------------------------------------------------------
 * WHAT THIS INSTRUMENT CANNOT DO
 * ---------------------------------------------------------------------------------------------
 * TypeORM's `Logger` hooks receive `(query, parameters, queryRunner)` and **never receive the result
 * set**. The "and exactly zero rows returned" half of the FEATURE-001-01 §2.6.1.1 contract is
 * therefore *not capturable here*: that half is asserted from the operation's own response (the
 * exact `null`, the exact empty page) or from a separate verification read. This module evidences
 * which statements were issued, in what order, against which tables, with what predicate and what
 * parameters. It does not evidence what they returned.
 *
 * ---------------------------------------------------------------------------------------------
 * ENGINE POSTURE — THE INVERSE OF THE SIBLING BARRIER MODULE
 * ---------------------------------------------------------------------------------------------
 * Epic §11.6.2 rules that "a statement count is asserted on one engine and the behaviour it
 * evidences is asserted on all four", and fixes the counted form to the sql.js job because it is
 * deterministic there while statement text and even statement count differ legitimately between
 * drivers. FEATURE-001-01 §2.6.1.1 restates it: the counted form runs on `e2e-sqljs` and the
 * behavioural form on all four engine jobs.
 *
 * This is the **opposite** of `./concurrency-barrier.ts`, whose forced interleavings run on MariaDB,
 * MySQL and PostgreSQL and are *excluded* from sql.js, because sql.js is the in-process WebAssembly
 * initializer and two transactions there cannot be held past a barrier and released together
 * (epic §11.6.3). Do not transplant one rule onto the other. Use `isStatementCountEngine()` below
 * to gate an exact-equality count; never make a behavioural assertion engine-conditional.
 *
 * ---------------------------------------------------------------------------------------------
 * THE THREE OBSERVATION BOUNDARIES — NAMED SO NO SUITE CONFLATES THEM
 * ---------------------------------------------------------------------------------------------
 * AAP §0.7.6 distinguishes three, and only the first one takes an exact number:
 *
 *  1. **Plugin-statement count** — statements issued against the plugin's own tables. This is the
 *     only boundary at which an exact number is asserted, and it is asserted as an *equality*:
 *     epic §11.6.2 says "Never 'at least one', and never 'no more than'".
 *  2. **Service-call count** — the method is spied and its *calls* are asserted, never its
 *     statements. That boundary does not use this module at all.
 *  3. **Whole-request statement count** — no exact number is ever asserted, only *non-growth*
 *     across two input sizes (a page of 3 against a page of 6), which is what demonstrates that
 *     `lines`, `lineCount` and `viewerAccess` are resolved once per page rather than per entry.
 *
 * Two further ticket constraints belong with them. A claim of **zero** statements against a table is
 * only ever made about a path that was refused *before* it reached that table. And a count is
 * meaningful only under epic §11.6.1's isolation contract: one server per specification, per-test
 * fixtures, and `reset()` in `beforeEach`.
 *
 * ---------------------------------------------------------------------------------------------
 * IMPLEMENTATION NOTES
 * ---------------------------------------------------------------------------------------------
 * This module imports only `typeorm` (types alone), adds no dependency, imports nothing from
 * `@vendure/core`, `@vendure/testing` or `vitest`, and deliberately never calls `testConfig()` —
 * that helper derives its port from the *calling file's* position in its own directory listing, so
 * calling it from `e2e/fixtures/` would index against this directory and can collide two suites on
 * one port (`e2e-common/test-config.ts:L37-L77`). Each spec file therefore builds its own config
 * from its own top-level `testConfig()` call and merges the fragment this module returns.
 *
 * The `@since` tag this feature requires on new public API is deliberately absent: that obligation
 * covers the plugin's published surface under `packages/reorder-plugin/src/`, and this is a test
 * fixture rather than published API.
 */
import { QueryRunner, Logger as TypeOrmLoggerInterface } from 'typeorm';

/**
 * The leading-keyword classification of a captured statement.
 *
 * `transaction` covers the transaction-control statements — `START TRANSACTION`, `BEGIN`,
 * `BEGIN TRANSACTION`, `COMMIT`, `ROLLBACK`, `SAVEPOINT`, `RELEASE SAVEPOINT` and
 * `SET TRANSACTION ...`. They are **captured rather than dropped**, because they are what lets a
 * suite prove that two writes happened inside the *same* transaction: both statements appear
 * between one `START TRANSACTION`/`BEGIN` and the following `COMMIT`, on the same `runnerId`, with
 * no intervening commit. They are excluded from every table-filtered result because they name no
 * table.
 *
 * `other` covers everything else: DDL, `PRAGMA ...`, `SET ...` and table-less probes such as
 * `SELECT VERSION()` (see {@link classifyStatement} for why a table-less `SELECT` is `other`).
 */
export type CapturedStatementKind = 'select' | 'insert' | 'update' | 'delete' | 'transaction' | 'other';

/**
 * One statement observed inside a capture window.
 */
export interface CapturedStatement {
    /** The statement text exactly as TypeORM issued it, with no normalisation applied. */
    query: string;
    /** The bound parameters, copied so a later driver mutation cannot rewrite history. Always an array, never undefined. */
    parameters: unknown[];
    /** Leading-keyword classification. See {@link CapturedStatementKind}. */
    kind: CapturedStatementKind;
    /**
     * The table tokens extracted from table *positions* only — after `FROM`, `INTO`, `UPDATE` and
     * every `JOIN` form — lower-cased and de-duplicated in first-seen order. Never a substring scan
     * of the statement text; see {@link extractStatementTables} for the two traps that makes
     * unavoidable.
     */
    tables: string[];
    /** Monotonic index within the current capture window, starting at 0 and contiguous. */
    sequence: number;
    /**
     * A stable identifier for the `QueryRunner` that issued the statement, so statements can be
     * grouped by connection and by transaction. `undefined` when TypeORM supplied no query runner.
     */
    runnerId: number | undefined;
    /**
     * `queryRunner.isTransactionActive` as observed at capture time, or `undefined` when no query
     * runner was supplied or the flag could not be read.
     */
    inTransaction: boolean | undefined;
    /**
     * Set only for a statement TypeORM reported through `logQueryError`. The error is attached to
     * the statement's existing record rather than producing a second one; see
     * {@link QueryCaptureLogger.logQueryError}.
     */
    error?: string;
}

/**
 * One message observed through TypeORM's general-purpose `log` hook.
 */
export interface CapturedLogMessage {
    /** The level TypeORM reported. */
    level: 'log' | 'info' | 'warn';
    /** The message, rendered to a string so a suite can assert on it without a type guard. */
    message: string;
}

/**
 * The `mergeConfig`-ready fragment returned by {@link queryCaptureConfig}.
 *
 * A fresh plain object wrapping the class instance. The instance itself is what must survive the
 * merge, and it does, because `mergeConfig` assigns a class instance by reference.
 */
export interface QueryCaptureConfigFragment {
    dbConnectionOptions: {
        logger: QueryCaptureLogger;
    };
}

/**
 * The identifier-quoting characters the four target engines emit. `dataSource.driver.escape()`
 * produces backticks on MySQL and MariaDB and double quotes on PostgreSQL and SQLite — the shipped
 * idiom that makes this engine-dependent is at
 * `packages/core/e2e/migrate-product-option-groups.e2e-spec.ts:L35`. Square brackets are included
 * so a bracket-quoted identifier degrades to the same token form.
 */
const IDENTIFIER_QUOTE_CHARACTERS = /["`[\]]/g;

/**
 * The patterns whose match is immediately followed by a table reference.
 *
 * The first covers DML and DDL in one keyword class. Every `JOIN` form — `INNER JOIN`, `LEFT JOIN`,
 * `LEFT OUTER JOIN`, `RIGHT JOIN`, `FULL OUTER JOIN`, `CROSS JOIN`, `NATURAL JOIN` — is covered by
 * matching the `JOIN` keyword itself, because the table always follows `JOIN`. `STRAIGHT_JOIN` is
 * *not* matched, and must not be, because the word boundary falls before `STRAIGHT`. `TABLE` covers
 * `CREATE TABLE`, `CREATE TABLE IF NOT EXISTS`, `ALTER TABLE`, `DROP TABLE`, `DROP TABLE IF EXISTS`
 * and `TRUNCATE TABLE`; `REFERENCES` covers the foreign-key clause of an `ALTER TABLE`. Both matter
 * because the migration suite inspects the statements issued while applying and reverting.
 *
 * The second and third are targeted rather than general on purpose. Index DDL puts its table after
 * `ON`, and SQLite's table-rebuild strategy puts its table after `RENAME TO`; matching a bare `ON`
 * would instead pull identifiers out of every `JOIN ... ON a = b` and `ON DELETE CASCADE` clause, so
 * the `ON` here is anchored to an index statement and the `TO` to a rename.
 *
 * Every pattern is scanned globally rather than first-match-only: `ListQueryBuilder`'s paginated
 * reads emit sub-selects and several joins, and the read suite's per-page non-growth assertion
 * depends on all of them being seen.
 */
const TABLE_POSITION_PATTERNS: Array<{ readonly source: string; readonly isBareUpdate: boolean }> = [
    { source: '\\b(from|into|update|join|table|references)\\b', isBareUpdate: true },
    { source: '\\b(?:create|drop)\\s+(?:unique\\s+)?index\\b[^;]*?\\bon\\b', isBareUpdate: false },
    { source: '\\brename\\s+to\\b', isBareUpdate: false },
];

/**
 * Words that may sit between a table-introducing keyword and the table itself:
 * `CREATE TABLE IF NOT EXISTS "x"`, `DROP TABLE IF EXISTS "x"` and PostgreSQL's `FROM ONLY "t"`.
 * None of them is a table name in this schema, so reading past them is unambiguous.
 */
const SKIPPABLE_PRE_TABLE_WORDS = ['if', 'not', 'exists', 'only'];

/**
 * Words which, when they immediately precede `UPDATE`, mean that `UPDATE` is not introducing a
 * table: `SELECT ... FOR UPDATE`, `... ON UPDATE CASCADE`, MySQL's
 * `INSERT ... ON DUPLICATE KEY UPDATE col = ...` and PostgreSQL's
 * `INSERT ... ON CONFLICT DO UPDATE SET col = ...`.
 */
const NON_TABLE_UPDATE_PREDECESSORS = ['for', 'on', 'key', 'do'];

/**
 * SQL syntax words that can occupy a table position in an unusual or malformed scan and are
 * certainly not tables in this schema.
 *
 * This list is deliberately short, and it deliberately does **not** contain `order`. `order` is a
 * real Vendure table that the mutate suite filters on, and dropping it here would let
 * `writesFor('order').length === 0` pass while a statement really had touched it — the exact silent
 * false pass this instrument exists to prevent. `ORDER BY` never reaches this list anyway, because
 * extraction is positional: `BY` is not one of {@link TABLE_INTRODUCING_KEYWORDS}, so the `order` of
 * an `ORDER BY` clause is never even considered as a candidate.
 */
const NON_TABLE_IDENTIFIERS = [
    'action',
    'and',
    'as',
    'cascade',
    'default',
    'dual',
    'locked',
    'no',
    'not',
    'nowait',
    'null',
    'of',
    'on',
    'or',
    'outfile',
    'restrict',
    'select',
    'set',
    'share',
    'skip',
    'values',
    'where',
];

/**
 * The clause keywords that end a `WHERE` portion. Truncating at these is what stops a column named
 * only in the sort or in a `RETURNING` list from counting as a predicate conjunct.
 */
const WHERE_TERMINATORS =
    /\b(group\s+by|order\s+by|having|limit|offset|returning|window|union|intersect|except|fetch\s+(?:first|next)|for\s+(?:update|share))\b/i;

/**
 * The character budget applied to the statement text in {@link QueryCaptureLogger.format}. It is a
 * control value for a diagnostic dump and expresses no claim about the statement it truncates.
 */
const DEFAULT_FORMATTED_QUERY_LENGTH = 240;

function isWhitespace(character: string | undefined): boolean {
    return (
        character === ' ' ||
        character === '\t' ||
        character === '\n' ||
        character === '\r' ||
        character === '\f'
    );
}

function isIdentifierStart(character: string | undefined): boolean {
    return character !== undefined && /[A-Za-z_]/.test(character);
}

function isIdentifierCharacter(character: string | undefined): boolean {
    return character !== undefined && /[A-Za-z0-9_$]/.test(character);
}

/**
 * Replaces every identifier-quoting character with a space, so one code path handles all four
 * engines. Replacing rather than deleting matters: it keeps `"reorder_list"("createdAt"` from
 * collapsing into a single token.
 */
function stripIdentifierQuotes(query: string): string {
    return query.replace(IDENTIFIER_QUOTE_CHARACTERS, ' ');
}

/**
 * Removes leading whitespace, leading SQL comments (`-- line` and block comments) and any leading
 * `(` so that classification looks at the statement's real first keyword.
 */
function stripLeadingNoise(query: string): string {
    let text = query;
    for (;;) {
        const trimmed = text.replace(/^\s+/, '');
        if (trimmed.indexOf('--') === 0) {
            const lineEnd = trimmed.indexOf('\n');
            text = lineEnd === -1 ? '' : trimmed.slice(lineEnd + 1);
            continue;
        }
        if (trimmed.indexOf('/*') === 0) {
            const blockEnd = trimmed.indexOf('*/');
            text = blockEnd === -1 ? '' : trimmed.slice(blockEnd + 2);
            continue;
        }
        if (trimmed.charAt(0) === '(') {
            text = trimmed.slice(1);
            continue;
        }
        return trimmed;
    }
}

/**
 * Returns the identifier word immediately before `index`, lower-cased, or `undefined` when there is
 * none. Used only to decide whether an `UPDATE` occurrence introduces a table.
 */
function precedingWord(text: string, index: number): string | undefined {
    let end = index;
    while (end > 0 && isWhitespace(text.charAt(end - 1))) {
        end--;
    }
    let start = end;
    while (start > 0 && isIdentifierCharacter(text.charAt(start - 1))) {
        start--;
    }
    if (start === end) {
        return undefined;
    }
    return text.slice(start, end).toLowerCase();
}

/**
 * Reads the table identifier that follows a table-introducing keyword.
 *
 * Returns `undefined` — meaning "this occurrence introduces no table" — when the next non-space
 * character is `(`, which is how a sub-select (`FROM (SELECT ...)`) and an `INSERT INTO t(cols)`
 * column list are skipped. `(` is treated as a delimiter rather than requiring a preceding space,
 * because TypeORM emits `INSERT INTO "reorder_list"("createdAt", ...)` with none.
 *
 * A schema-qualified reference resolves to its last segment, so `FROM public.reorder_list` and
 * `FROM mydb.public.reorder_list` both yield `reorder_list`. A trailing alias is ignored, because
 * reading stops at the first identifier: `FROM reorder_list ReorderList` yields `reorder_list`. A
 * word from {@link SKIPPABLE_PRE_TABLE_WORDS} is read past, so `TABLE IF NOT EXISTS "x"` yields `x`.
 */
function readTableIdentifier(text: string, fromIndex: number): string | undefined {
    const length = text.length;
    let index = fromIndex;
    let value: string | undefined;
    let start = index;
    for (;;) {
        while (index < length && isWhitespace(text.charAt(index))) {
            index++;
        }
        if (index >= length || text.charAt(index) === '(' || !isIdentifierStart(text.charAt(index))) {
            return undefined;
        }
        start = index;
        while (index < length && isIdentifierCharacter(text.charAt(index))) {
            index++;
        }
        value = text.slice(start, index);
        if (SKIPPABLE_PRE_TABLE_WORDS.indexOf(value.toLowerCase()) === -1) {
            break;
        }
    }
    for (;;) {
        let lookahead = index;
        while (lookahead < length && isWhitespace(text.charAt(lookahead))) {
            lookahead++;
        }
        if (text.charAt(lookahead) !== '.') {
            return value;
        }
        lookahead++;
        while (lookahead < length && isWhitespace(text.charAt(lookahead))) {
            lookahead++;
        }
        if (!isIdentifierStart(text.charAt(lookahead))) {
            return value;
        }
        start = lookahead;
        while (lookahead < length && isIdentifierCharacter(text.charAt(lookahead))) {
            lookahead++;
        }
        value = text.slice(start, lookahead);
        index = lookahead;
    }
}

/**
 * @description
 * Extracts the tables a statement references, from table **positions** only.
 *
 * Positional extraction is not a refinement, it is the whole point, because a substring scan
 * produces false alarms in two ways that would break every suite:
 *
 * **Trap 1 — sibling-prefix collision.** A substring test for `reorder_list` also matches
 * `reorder_list_line`, and `product_variant` also matches `product_variant_translation`,
 * `product_variant_price` and `product_variant_asset`. Every count in every suite would be
 * inflated. Matching here is token-exact: the extracted tokens are compared for case-insensitive
 * *equality*, never with `indexOf` against the raw statement.
 *
 * **Trap 2 — `ORDER BY` against the `order` table.** `order` and `order_line` are tables the mutate
 * suite filters on, and `order` is a reserved word so it is always quoted as a table — but every
 * sorted read contains `ORDER BY`, and the read suite sorts on both of its reads. A naive token scan
 * for `order` would match the sort clause and fail constantly. Positional extraction never looks at
 * `ORDER BY`, because `BY` introduces no table.
 *
 * The scan strips identifier quotes, walks *every* occurrence of the patterns in
 * {@link TABLE_POSITION_PATTERNS}, skips an `UPDATE` that is part of `FOR UPDATE`, `ON UPDATE`,
 * `ON DUPLICATE KEY UPDATE` or `ON CONFLICT DO UPDATE`, skips an occurrence followed by `(`, reads
 * past `IF NOT EXISTS` / `IF EXISTS` / `ONLY`, ignores a trailing alias, resolves a schema-qualified
 * name to its last segment, drops the small set of SQL syntax words in
 * {@link NON_TABLE_IDENTIFIERS}, and returns the surviving tokens lower-cased and de-duplicated in
 * first-seen order.
 *
 * DDL is covered as well as DML, because the migration suite inspects the statements issued while a
 * migration is applied and reverted. `CREATE TABLE`, `CREATE TABLE IF NOT EXISTS`, `ALTER TABLE`,
 * `DROP TABLE`, `DROP TABLE IF EXISTS`, `TRUNCATE TABLE`, a foreign key's `REFERENCES`,
 * `CREATE [UNIQUE] INDEX ... ON <table>`, `DROP INDEX ... ON <table>` and SQLite's table-rebuild
 * `RENAME TO <table>` all attribute their table.
 *
 * The function is total: any input, including a malformed or empty statement, yields an array rather
 * than an exception.
 *
 * **Accepted limitation, stated rather than papered over:** this is a positional scan and not a SQL
 * grammar, so a table name appearing inside a string literal could in principle be extracted, and a
 * column named in `EXTRACT(field FROM col)` or `SUBSTRING(col FROM 1)` is extracted as though it
 * were a table. Neither can occur for the tables these suites filter on, and both are harmless to a
 * name-filtered assertion, but a future filter on an arbitrary name should know it.
 *
 * @example
 * ```ts
 * extractStatementTables('SELECT "ReorderList"."id" FROM "reorder_list" "ReorderList" ORDER BY "ReorderList"."createdAt" DESC');
 * // ['reorder_list']   — note that 'order' is absent
 *
 * extractStatementTables('INSERT INTO "reorder_list"("createdAt", "name") VALUES ($1, $2)');
 * // ['reorder_list']
 * ```
 */
export function extractStatementTables(query: string): string[] {
    if (typeof query !== 'string' || query.length === 0) {
        return [];
    }
    const tables: string[] = [];
    try {
        const text = stripIdentifierQuotes(query);
        for (const pattern of TABLE_POSITION_PATTERNS) {
            const scanner = new RegExp(pattern.source, 'gi');
            let match = scanner.exec(text);
            while (match !== null) {
                const keyword = (match[1] ?? '').toLowerCase();
                const shouldConsider =
                    !pattern.isBareUpdate ||
                    keyword !== 'update' ||
                    NON_TABLE_UPDATE_PREDECESSORS.indexOf(precedingWord(text, match.index) ?? '') === -1;
                if (shouldConsider) {
                    const identifier = readTableIdentifier(text, match.index + match[0].length);
                    if (identifier !== undefined) {
                        const normalised = identifier.toLowerCase();
                        if (
                            NON_TABLE_IDENTIFIERS.indexOf(normalised) === -1 &&
                            tables.indexOf(normalised) === -1
                        ) {
                            tables.push(normalised);
                        }
                    }
                }
                if (scanner.lastIndex === match.index) {
                    scanner.lastIndex = match.index + 1;
                }
                match = scanner.exec(text);
            }
        }
    } catch {
        // A parse problem must never become a query failure or a test failure in the code under
        // test, so the statement is reported as referencing no table rather than throwing. The
        // statement itself is still captured, and `format()` still shows its text.
        return [];
    }
    return tables;
}

/**
 * @description
 * Classifies a statement on its first keyword, after leading whitespace, leading SQL comments and a
 * leading `(` have been discarded.
 *
 * `WITH ... SELECT` classifies as `select`. Every transaction-control statement classifies as
 * `transaction` and is captured rather than dropped, because transaction boundaries are what prove
 * that two writes shared one transaction.
 *
 * `REPLACE INTO` is folded into `insert` deliberately: it writes rows, so leaving it as `other`
 * would let a "zero writes" assertion pass while rows had been written. TypeORM's MySQL driver
 * emits `INSERT ... ON DUPLICATE KEY UPDATE` rather than `REPLACE INTO`, so this is a safeguard
 * rather than an observed path.
 *
 * DDL — `CREATE`, `ALTER`, `DROP`, `TRUNCATE` — classifies as `other`, because it is not row-level
 * DML. It still attributes its table (see {@link extractStatementTables}), so it is visible through
 * {@link QueryCaptureLogger.forTables} while being excluded from
 * {@link QueryCaptureLogger.writesFor}. A suite counting writes therefore counts writes, and a suite
 * inspecting a migration still sees the schema statements.
 *
 * **One rule is worth stating explicitly:** a statement whose leading keyword is `SELECT` (or
 * `WITH ... SELECT`) but from which no table can be extracted classifies as `other`, not `select`.
 * That is what keeps a driver probe such as `SELECT VERSION()`, `SELECT 1` or `SELECT DATABASE()`
 * from looking like a table read in a `kind`-filtered assertion. Such a probe could never enter a
 * table-filtered result anyway, since it names no table.
 *
 * The function is total: any input, including a malformed or empty statement, yields a kind rather
 * than an exception.
 *
 * @example
 * ```ts
 * classifyStatement('UPDATE "reorder_list" SET "lineCount" = "lineCount" + 1 WHERE "id" = $1'); // 'update'
 * classifyStatement('START TRANSACTION');                                                      // 'transaction'
 * classifyStatement('SAVEPOINT typeorm_1');                                                    // 'transaction'
 * classifyStatement('SELECT VERSION()');                                                       // 'other'
 * classifyStatement('   ');                                                                    // 'other'
 * ```
 */
export function classifyStatement(query: string): CapturedStatementKind {
    if (typeof query !== 'string' || query.length === 0) {
        return 'other';
    }
    try {
        const leading = stripLeadingNoise(stripIdentifierQuotes(query));
        const words = /^([A-Za-z_][A-Za-z0-9_]*)(?:\s+([A-Za-z_][A-Za-z0-9_]*))?/.exec(leading);
        if (words === null) {
            return 'other';
        }
        const first = words[1].toUpperCase();
        const second = (words[2] ?? '').toUpperCase();
        switch (first) {
            case 'SELECT':
                return extractStatementTables(query).length === 0 ? 'other' : 'select';
            case 'WITH':
                if (/\bselect\b/i.test(leading)) {
                    return extractStatementTables(query).length === 0 ? 'other' : 'select';
                }
                return 'other';
            case 'INSERT':
            case 'REPLACE':
                return 'insert';
            case 'UPDATE':
                return 'update';
            case 'DELETE':
                return 'delete';
            case 'BEGIN':
            case 'COMMIT':
            case 'ROLLBACK':
            case 'SAVEPOINT':
                return 'transaction';
            case 'START':
            case 'SET':
            case 'RELEASE':
                return second === 'TRANSACTION' || second === 'SAVEPOINT' ? 'transaction' : 'other';
            default:
                return 'other';
        }
    } catch {
        // Classification degrades to `other` rather than throwing, for the same reason
        // `extractStatementTables` degrades to an empty list.
        return 'other';
    }
}

/**
 * @description
 * The pure single-statement predicate: does this statement reference this table, token-exactly?
 *
 * Built on {@link extractStatementTables}, so it inherits both trap fixes. In particular
 * `statementReferencesTable(<a reorder_list_line statement>, 'reorder_list')` is `false`, and
 * `statementReferencesTable(<a product_variant_translation statement>, 'product_variant')` is
 * `false`.
 *
 * The function is total and never throws.
 *
 * @example
 * ```ts
 * statementReferencesTable('DELETE FROM "reorder_list_line" WHERE "reorderListId" = ?', 'reorder_list_line'); // true
 * statementReferencesTable('DELETE FROM "reorder_list_line" WHERE "reorderListId" = ?', 'reorder_list');      // false
 * ```
 */
export function statementReferencesTable(query: string, tableName: string): boolean {
    if (typeof tableName !== 'string' || tableName.length === 0) {
        return false;
    }
    return extractStatementTables(query).indexOf(tableName.toLowerCase()) !== -1;
}

function escapeForRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function resolveStatementText(statement: CapturedStatement | string): string {
    return typeof statement === 'string' ? statement : statement.query;
}

/**
 * Returns the quote-stripped `WHERE` portion of a statement — from the first `WHERE` keyword up to
 * the first clause keyword that ends a `WHERE` — or `undefined` when the statement has no `WHERE`.
 *
 * The truncation is what stops a column or a value that appears only in an `ORDER BY`, a `LIMIT` or a
 * `RETURNING` list from being read as part of the predicate.
 */
function extractWherePortion(query: string): string | undefined {
    const text = stripIdentifierQuotes(query);
    const whereMatch = /\bwhere\b/i.exec(text);
    if (whereMatch === null) {
        return undefined;
    }
    const portion = text.slice(whereMatch.index + whereMatch[0].length);
    const terminator = WHERE_TERMINATORS.exec(portion);
    return terminator === null ? portion : portion.slice(0, terminator.index);
}

/**
 * True when `token` occurs in `text` as a standalone literal rather than as part of a longer
 * identifier or number. Written without a lookbehind so it stays portable, and with `.` and `$`
 * treated as part of a token so `1` does not match inside `1.5`, `list_1` or `$12`.
 */
function containsStandaloneToken(text: string, token: string): boolean {
    if (token.length === 0) {
        return false;
    }
    return new RegExp(`(^|[^\\w.$])${escapeForRegExp(token)}($|[^\\w.$])`).test(text);
}

/**
 * @description
 * True when the statement's `WHERE` portion names **every** one of the given columns, quote-agnostically.
 *
 * The published contract for a scoped read or a conditional write is that the `WHERE` carries the
 * acting customer and the active channel **as conjuncts beside the row's own identifier**
 * (FEATURE-001-01 §2.6.1.1), so a suite checks `['id', 'customerId', 'channelId']`. What this
 * distinguishes is exactly the shape the rule exists to reject — fetch by id, inspect the row,
 * discard it — whose predicate carries the id alone.
 *
 * Three details make it an assertion rather than a guess:
 *
 *  - The portion examined runs from the first `WHERE` keyword up to the first clause keyword that
 *    ends a `WHERE` (`GROUP BY`, `ORDER BY`, `HAVING`, `LIMIT`, `OFFSET`, `RETURNING`, `WINDOW`,
 *    `UNION`, `INTERSECT`, `EXCEPT`, `FETCH FIRST`/`FETCH NEXT`, `FOR UPDATE`/`FOR SHARE`). Without
 *    that truncation a column named only in the sort would count as a predicate conjunct.
 *  - Matching is on word boundaries, so `id` cannot match inside `customerId`, `channelId` or
 *    `reorderListId`, and `list_id` cannot match `id`.
 *  - A statement with no `WHERE` at all returns `false`, and an **empty** column list returns
 *    `false` rather than vacuously `true`, because an assertion that names no column asserts nothing.
 *
 * The function is total and never throws. It accepts either a {@link CapturedStatement} or a raw
 * statement string.
 *
 * @example
 * ```ts
 * const [scoped] = capture.selectsFor('reorder_list');
 * expect(whereMentionsColumns(scoped, ['id', 'customerId', 'channelId'])).toBe(true);
 * ```
 */
export function whereMentionsColumns(statement: CapturedStatement | string, columnNames: string[]): boolean {
    if (!Array.isArray(columnNames) || columnNames.length === 0) {
        return false;
    }
    try {
        const portion = extractWherePortion(resolveStatementText(statement));
        if (portion === undefined) {
            return false;
        }
        for (const columnName of columnNames) {
            if (typeof columnName !== 'string' || columnName.length === 0) {
                return false;
            }
            if (!new RegExp(`\\b${escapeForRegExp(columnName)}\\b`, 'i').test(portion)) {
                return false;
            }
        }
        return true;
    } catch {
        // A malformed statement is reported as not carrying the columns rather than throwing, so a
        // parse problem can never be mistaken for a satisfied predicate.
        return false;
    }
}

/**
 * @description
 * True when the statement carries the given value — either as one of its bound parameters, or as an
 * inline literal in its predicate.
 *
 * **Why the comparison is loose (`String(p) === String(value)`) rather than strict.** PostgreSQL
 * renders placeholders as `$1` while MySQL, MariaDB and SQLite render them as `?`, so the values
 * normally live in `parameters` and not in the statement text — and the harness's
 * `TestingEntityIdStrategy` presents identifiers externally as `T_1` while the bound parameter
 * carries the decoded identifier, which arrives as a number on one driver and a string on another.
 * **The caller is responsible for passing the decoded value**, not the external `T_n` form.
 *
 * **★ Why an inline literal must also be checked, and why that is not belt-and-braces.** The SQLite
 * family does not bind a numeric value at all: `AbstractSqliteDriver.escapeQueryWithParameters`
 * returns `String(value)` for a `number`, writing it straight into the SQL text and leaving
 * `parameters` empty (`node_modules/typeorm/driver/sqlite-abstract/AbstractSqliteDriver.js:L309`, the
 * `typeof value === "number"` branch). Strings, booleans and dates are still bound; only numbers are
 * inlined. MySQL, MariaDB and PostgreSQL bind everything.
 *
 * That matters more than it first appears, because **sql.js is the one engine on which an exact
 * statement count is asserted** and the platform's default identifier strategy produces numeric
 * identifiers — so on precisely the counted engine, a list identifier appears as a literal in the
 * statement text and nowhere in `parameters`. A parameters-only helper would return `false` there and
 * silently fail the FEATURE-001-01 §2.6.1.1 predicate assertion it exists to support. This was
 * observed against a real sql.js data source, not inferred.
 *
 * The inline search is confined to the statement's `WHERE` portion (see
 * {@link whereMentionsColumns} for how that portion is delimited), so a delta in a `SET` clause or a
 * page size in a `LIMIT` cannot be mistaken for a predicate value. Where the statement has no
 * `WHERE`, the whole statement is searched, which is what makes an `INSERT ... VALUES` inspectable. A
 * token must occur standalone: `1` does not match inside `1.5`, `21`, `list_1` or `$12`.
 *
 * Like the parameters comparison, the inline check reports only that the value is *carried* — not
 * which column carries it. Pair it with {@link whereMentionsColumns} when the claim is about scope.
 *
 * `null` and `undefined` are compared strictly against the bound parameters only, so a `null`
 * parameter is not matched by the string `'null'`. The helper is intended for scalar identifiers,
 * quantities and flags; an object argument would stringify to `[object Object]` and match nothing
 * useful.
 *
 * The function is total and never throws. It accepts either a {@link CapturedStatement} or a raw
 * parameters array — passing a bare array skips the inline check, there being no statement text.
 *
 * @example
 * ```ts
 * const [conditional] = capture.writesFor('reorder_list');
 * // True on all four engines: bound on MySQL/MariaDB/PostgreSQL, inline on sql.js.
 * expect(statementCarriesParameterValue(conditional, decodedListId)).toBe(true);
 * expect(whereMentionsColumns(conditional, ['id', 'customerId', 'channelId'])).toBe(true);
 * ```
 */
export function statementCarriesParameterValue(
    statement: CapturedStatement | readonly unknown[],
    value: unknown,
): boolean {
    try {
        const isRawArray = Array.isArray(statement);
        const parameters: readonly unknown[] = isRawArray
            ? (statement as readonly unknown[])
            : (statement as CapturedStatement).parameters;
        if (value === null || value === undefined) {
            if (!Array.isArray(parameters)) {
                return false;
            }
            for (const parameter of parameters) {
                if (parameter === value) {
                    return true;
                }
            }
            return false;
        }
        const target = String(value);
        if (Array.isArray(parameters)) {
            for (const parameter of parameters) {
                if (parameter !== null && parameter !== undefined && String(parameter) === target) {
                    return true;
                }
            }
        }
        if (isRawArray) {
            return false;
        }
        // The SQLite family inlines a numeric value into the statement text instead of binding it,
        // so the predicate must be searched too. See this function's documentation for the driver
        // line and for why it decides the counted assertions.
        const text = (statement as CapturedStatement).query;
        if (typeof text !== 'string' || text.length === 0) {
            return false;
        }
        const portion = extractWherePortion(text);
        return containsStandaloneToken(portion === undefined ? stripIdentifierQuotes(text) : portion, target);
    } catch {
        // A parameter whose `toString` throws is reported as not matching rather than propagating.
        return false;
    }
}

/**
 * Renders a value to a string without ever throwing. Circular structures fall back to a plain
 * `String()` rendering, mirroring the `stringifyParams` idiom in
 * `packages/core/src/config/logger/typeorm-logger.ts:L88-L95`.
 */
function safeStringify(value: unknown): string {
    try {
        const rendered = JSON.stringify(value);
        return rendered === undefined ? String(value) : rendered;
    } catch {
        // Most probably a circular structure. Fall back to the default rendering rather than
        // letting a diagnostic helper fail.
        try {
            return String(value);
        } catch {
            return '[unstringifiable]';
        }
    }
}

/**
 * Reads `queryRunner.isTransactionActive` defensively, returning `undefined` when no runner was
 * supplied or the flag cannot be read.
 */
function resolveTransactionState(queryRunner: QueryRunner | undefined): boolean | undefined {
    if (queryRunner === undefined || queryRunner === null) {
        return undefined;
    }
    try {
        return queryRunner.isTransactionActive === true;
    } catch {
        // A driver whose accessor throws must not turn a captured statement into a test failure.
        return undefined;
    }
}

function normaliseTableNames(tableNames: readonly string[]): string[] {
    const normalised: string[] = [];
    for (const tableName of tableNames) {
        if (typeof tableName === 'string' && tableName.length > 0) {
            const lowered = tableName.toLowerCase();
            if (normalised.indexOf(lowered) === -1) {
                normalised.push(lowered);
            }
        }
    }
    return normalised;
}

const WRITE_KINDS: CapturedStatementKind[] = ['insert', 'update', 'delete'];

/**
 * @description
 * The canonical query-capture instrument: a TypeORM `Logger` that records every statement the data
 * source executes inside an explicitly opened window, so a specification can assert an **exact**
 * statement count, the order of the statements, the shape of their predicates and their bound
 * parameters.
 *
 * Install it by merging {@link queryCaptureConfig} — or the equivalent literal — into the config the
 * spec file built from its own top-level `testConfig()` call. It must be a **class instance** and
 * never an object literal; the module header explains why, and `reset()` silently stops working if
 * that is ignored.
 *
 * Four properties make the captured array an assertion rather than an anecdote (epic §11.6.2):
 *
 *  1. **Reset per test** — `reset()` is called from `beforeEach`, so a count is scoped to one test
 *     and never to a file.
 *  2. **Bounded by the request, not by the test** — capture is `enabled` immediately before the
 *     operation under test and `disabled` immediately after it returns, which {@link capture} does
 *     for you including on the throwing path. `enabled` therefore defaults to **`false`**: otherwise
 *     the bootstrap's `synchronize: true` schema build and every fixture write would land in the
 *     array. Fixture writes, authentication and cleanup must fall outside every count.
 *  3. **Filtered by table, with the filter named in the assertion** — {@link forTables},
 *     {@link selectsFor} and {@link writesFor} take the table names the claim is about, so an
 *     unrelated session or channel statement can neither inflate nor mask the number. Each requires
 *     at least one table name *at compile time*, because a table-filtered assertion that names no
 *     table would return an empty list and pass silently.
 *  4. **Asserted as equality, with the predicate's shape asserted alongside it** — use
 *     `toBe(1)`/`toBe(0)` with {@link whereMentionsColumns}. Epic §11.6.2 is explicit: "Never 'at
 *     least one', and never 'no more than'."
 *
 * The instrument records what was *issued*; it cannot record what was *returned* (see the module
 * header). And an exact count is asserted on the sql.js job only — gate it with
 * {@link isStatementCountEngine} — while the behaviour it evidences is asserted on all four engine
 * jobs.
 *
 * @example
 * ```ts
 * // e2e spec usage
 * import { createTestEnvironment } from '\@vendure/testing';
 * import { mergeConfig } from '\@vendure/core';
 * import { testConfig } from '../../../e2e-common/test-config';
 * import { QueryCaptureLogger, isStatementCountEngine, whereMentionsColumns } from './fixtures/query-capture';
 *
 * const capture = new QueryCaptureLogger();
 *
 * const { server, shopClient } = createTestEnvironment(
 *     mergeConfig(testConfig(), {
 *         plugins: [ReorderPlugin.init({ ... })],
 *         dbConnectionOptions: { logger: capture },
 *     }),
 * );
 *
 * beforeEach(() => {
 *     // Rule 1: the window is scoped to one test.
 *     capture.reset();
 * });
 *
 * // Rule 4 is an equality, and rule 3 names the table it counts against. The counted form of the
 * // claim is gated to sql.js by rule from epic 11.6.2; the behavioural half below it is not.
 * it.skipIf(!isStatementCountEngine())('reads the addressed table exactly once, scoped', async () => {
 *     const { activeCustomerReorderList: result } = await capture.capture(() =>
 *         shopClient.query(GET_REORDER_LIST, { id: otherCustomersListId }),
 *     );
 *
 *     expect(result).toBeNull();                                        // the response half
 *     expect(capture.selectsFor('reorder_list').length).toBe(1);        // exactly one, never "at least one"
 *     expect(capture.writesFor('reorder_list').length).toBe(0);         // the second, separate half
 *     const [scoped] = capture.selectsFor('reorder_list');
 *     expect(whereMentionsColumns(scoped, ['id', 'customerId', 'channelId'])).toBe(true);
 * });
 * ```
 *
 * @example
 * ```ts
 * // Proving that two writes shared one transaction, using `runnerId` and the captured
 * // transaction-control statements.
 * await capture.capture(() => shopClient.query(REMOVE_REORDER_LIST_LINE, { id: lineId }));
 *
 * const ordered = capture.statements;
 * const begin = ordered.findIndex(s => s.kind === 'transaction' && /^\s*(begin|start)/i.test(s.query));
 * const commit = ordered.findIndex(s => s.kind === 'transaction' && /^\s*commit/i.test(s.query));
 * const decrement = ordered.findIndex(s => s.kind === 'update' && s.tables.indexOf('reorder_list') !== -1);
 * const removal = ordered.findIndex(s => s.kind === 'delete' && s.tables.indexOf('reorder_list_line') !== -1);
 *
 * expect(begin).toBeLessThan(removal);
 * expect(removal).toBeLessThan(commit);
 * expect(decrement).toBeGreaterThan(begin);
 * expect(decrement).toBeLessThan(commit);
 * expect(ordered[decrement].runnerId).toBe(ordered[removal].runnerId);
 * ```
 *
 * @example
 * ```ts
 * // Non-growth across two input sizes — the whole-request boundary, which never asserts an exact
 * // number. Embed `format()` so a failure is readable.
 * capture.reset();
 * await capture.capture(() => shopClient.query(GET_REORDER_LISTS, { options: { take: 3 } }));
 * const forThree = capture.forTables('reorder_list', 'reorder_list_line').length;
 *
 * capture.reset();
 * await capture.capture(() => shopClient.query(GET_REORDER_LISTS, { options: { take: 6 } }));
 * const forSix = capture.forTables('reorder_list', 'reorder_list_line').length;
 *
 * expect(forSix).toBe(forThree);
 * ```
 */
export class QueryCaptureLogger implements TypeOrmLoggerInterface {
    private readonly capturedStatements: CapturedStatement[] = [];
    private readonly capturedSchemaMessages: string[] = [];
    private readonly capturedMigrationMessages: string[] = [];
    private readonly capturedLogMessages: CapturedLogMessage[] = [];
    private readonly capturedSlowQueryNotices: string[] = [];

    /**
     * A stable identifier per `QueryRunner`. A `WeakMap` is used deliberately: the runner is not
     * retained, so installing this logger for the lifetime of a server introduces no leak. Runner
     * identifiers are *not* reset by {@link reset}, so grouping stays meaningful across windows
     * within one server.
     */
    private readonly runnerIds = new WeakMap<QueryRunner, number>();

    private captureEnabled = false;
    private nextSequence = 0;
    private nextRunnerId = 1;

    /**
     * @description
     * Every statement captured in the current window, in issue order, including the
     * transaction-control statements. The array instance is stable across {@link reset}, which
     * truncates it in place, so a reference taken once stays live.
     */
    get statements(): readonly CapturedStatement[] {
        return this.capturedStatements;
    }

    /**
     * @description
     * Messages TypeORM reported through `logSchemaBuild` while capture was enabled. Populated
     * because installing this logger displaces core's `TypeOrmLogger`, so these diagnostics would
     * otherwise be lost entirely.
     */
    get schemaMessages(): readonly string[] {
        return this.capturedSchemaMessages;
    }

    /**
     * @description
     * Messages TypeORM reported through `logMigration` while capture was enabled — the surface the
     * migration suite inspects while applying and reverting.
     */
    get migrationMessages(): readonly string[] {
        return this.capturedMigrationMessages;
    }

    /**
     * @description
     * Messages TypeORM reported through its general-purpose `log` hook while capture was enabled.
     */
    get logMessages(): readonly CapturedLogMessage[] {
        return this.capturedLogMessages;
    }

    /**
     * @description
     * The text of every statement TypeORM reported through `logQuerySlow` while capture was enabled.
     *
     * The reported duration is deliberately **not** retained anywhere in this module: it records
     * which statements were issued and makes no claim about how long any of them took. TypeORM only
     * calls that hook when `maxQueryExecutionTime` is configured, which the shared test
     * configuration does not set.
     */
    get slowQueryNotices(): readonly string[] {
        return this.capturedSlowQueryNotices;
    }

    /**
     * @description
     * Whether the capture window is currently open. `false` on a fresh instance, by design.
     */
    get enabled(): boolean {
        return this.captureEnabled;
    }

    /**
     * @description
     * Opens the capture window. Prefer {@link capture}, which closes it again even when the
     * operation throws.
     */
    enable(): void {
        this.captureEnabled = true;
    }

    /**
     * @description
     * Closes the capture window. Statements issued while it is closed are not recorded at all.
     */
    disable(): void {
        this.captureEnabled = false;
    }

    /**
     * @description
     * Empties every captured collection and restarts `sequence` at 0. Call it from `beforeEach`, per
     * epic §11.6.1, so a count is scoped to one test rather than to a file.
     *
     * The arrays are truncated **in place** and never reassigned, so a suite holding a reference to
     * {@link statements} keeps seeing the live array. The enabled/disabled state and the runner
     * identifier registry are deliberately left alone: resetting is about the captured data, and a
     * runner keeps its identifier for as long as the server lives.
     */
    reset(): void {
        this.capturedStatements.length = 0;
        this.capturedSchemaMessages.length = 0;
        this.capturedMigrationMessages.length = 0;
        this.capturedLogMessages.length = 0;
        this.capturedSlowQueryNotices.length = 0;
        this.nextSequence = 0;
    }

    /**
     * @description
     * An alias for {@link reset}, for a suite that reads more naturally with it.
     */
    clear(): void {
        this.reset();
    }

    /**
     * @description
     * Runs `fn` with the capture window open and closes it in a `finally`, so a throwing or
     * rejecting operation still ends the window and the rejection still propagates unchanged.
     *
     * This is the mechanism behind epic §11.6.2's second rule — capture is bounded by the request
     * rather than by the test — so fixture writes, authentication and cleanup stay outside every
     * count.
     *
     * It does **not** reset first: call {@link reset} in `beforeEach`, and again between two windows
     * in one test if each window needs its own number. If the window was already open when this is
     * called, it is left open afterwards, so a nested call cannot close an enclosing window.
     *
     * @example
     * ```ts
     * capture.reset();
     * const result = await capture.capture(() => shopClient.query(CREATE_REORDER_LIST, { input }));
     * expect(capture.writesFor('reorder_list').length).toBe(1);
     * ```
     */
    async capture<T>(fn: () => Promise<T>): Promise<T> {
        const wasEnabled = this.captureEnabled;
        this.enable();
        try {
            return await fn();
        } finally {
            if (!wasEnabled) {
                this.disable();
            }
        }
    }

    /**
     * @description
     * Every captured statement that references at least one of the named tables, token-exactly and
     * case-insensitively, in issue order.
     *
     * Transaction-control statements are excluded, because they name no table; they remain in
     * {@link statements} for ordering proofs. DDL is *not* excluded — a `CREATE TABLE reorder_list`
     * is returned here — so the migration suite can inspect it.
     *
     * At least one table name is required by the signature, so `forTables()` is a compile error
     * rather than an empty result that would satisfy a "zero statements" assertion by accident.
     *
     * @example
     * ```ts
     * expect(capture.forTables('stock_level').length).toBe(0);
     * expect(capture.forTables('reorder_list', 'reorder_list_line').length).toBe(expectedForThreeLists);
     * ```
     */
    forTables(...tableNames: [string, ...string[]]): CapturedStatement[] {
        const wanted = normaliseTableNames(tableNames);
        if (wanted.length === 0) {
            return [];
        }
        return this.capturedStatements.filter(entry => {
            if (entry.kind === 'transaction') {
                return false;
            }
            for (const tableName of wanted) {
                if (entry.tables.indexOf(tableName) !== -1) {
                    return true;
                }
            }
            return false;
        });
    }

    /**
     * @description
     * The `SELECT` statements among {@link forTables}. The refused-write contract of
     * FEATURE-001-01 §2.6.1.1 is two separately stated halves — "exactly one scoped `SELECT` ... and
     * no `INSERT`, `UPDATE` or `DELETE` at all" — so this and {@link writesFor} exist as separate
     * methods and are asserted independently.
     */
    selectsFor(...tableNames: [string, ...string[]]): CapturedStatement[] {
        return this.forTables(...tableNames).filter(entry => entry.kind === 'select');
    }

    /**
     * @description
     * The row-level write statements among {@link forTables} — `insert`, `update` and `delete`. This
     * is how "and none was an `INSERT`, `UPDATE` or `DELETE`" is asserted by name.
     */
    writesFor(...tableNames: [string, ...string[]]): CapturedStatement[] {
        return this.forTables(...tableNames).filter(entry => WRITE_KINDS.indexOf(entry.kind) !== -1);
    }

    /**
     * @description
     * `forTables(...).length`, for readability at an assertion site.
     *
     * It exists for equality assertions only. Epic §11.6.2 requires an exact number: "Never 'at
     * least one', and never 'no more than'." A greater-than or a truthiness check on this value is
     * not an acceptable substitute for an equality.
     */
    count(...tableNames: [string, ...string[]]): number {
        return this.forTables(...tableNames).length;
    }

    /**
     * @description
     * A compact, deterministic, multi-line dump of everything captured — one line per statement,
     * carrying its sequence, kind, runner identifier, transaction state, extracted tables, the
     * statement text truncated to a character budget, and its parameters.
     *
     * It **builds a string and never prints**; a suite embeds it in a failure message. Parameters are
     * rendered through a stringifier that falls back rather than throwing on a circular structure,
     * mirroring `packages/core/src/config/logger/typeorm-logger.ts:L88-L95`.
     *
     * @param maxQueryLength A character budget for the statement text. A control value for the dump,
     * not a claim about any statement.
     *
     * @example
     * ```ts
     * expect(capture.selectsFor('reorder_list').length, capture.format()).toBe(1);
     * ```
     */
    format(maxQueryLength = DEFAULT_FORMATTED_QUERY_LENGTH): string {
        const budget =
            typeof maxQueryLength === 'number' && maxQueryLength > 0
                ? maxQueryLength
                : DEFAULT_FORMATTED_QUERY_LENGTH;
        const lines: string[] = [
            `QueryCaptureLogger: ${this.capturedStatements.length} statement(s), capture ${
                this.captureEnabled ? 'enabled' : 'disabled'
            }, engine ${resolveConfiguredEngine()}`,
        ];
        for (const entry of this.capturedStatements) {
            const text = entry.query.length > budget ? `${entry.query.slice(0, budget)}...` : entry.query;
            const parts = [
                `#${entry.sequence}`,
                entry.kind,
                `runner=${String(entry.runnerId)}`,
                `tx=${String(entry.inTransaction)}`,
                `tables=[${entry.tables.join(', ')}]`,
            ];
            if (entry.error !== undefined) {
                parts.push(`error=${entry.error}`);
            }
            lines.push(`${parts.join(' ')} :: ${text} :: params=${safeStringify(entry.parameters)}`);
        }
        if (this.capturedSlowQueryNotices.length > 0) {
            lines.push(`slow-query notices: ${String(this.capturedSlowQueryNotices.length)}`);
        }
        for (const message of this.capturedSchemaMessages) {
            lines.push(`schema: ${message}`);
        }
        for (const message of this.capturedMigrationMessages) {
            lines.push(`migration: ${message}`);
        }
        for (const message of this.capturedLogMessages) {
            lines.push(`log(${message.level}): ${message.message}`);
        }
        return lines.join('\n');
    }

    /**
     * @description
     * TypeORM's per-statement hook. Called unconditionally by every query runner *before* the
     * statement executes — see `node_modules/typeorm/driver/sqljs/SqljsQueryRunner.js:L70` — which is
     * precisely why this instrument is exact rather than approximate.
     */
    logQuery(query: string, parameters?: any[], queryRunner?: QueryRunner): void {
        this.recordStatement(query, parameters, queryRunner, undefined);
    }

    /**
     * @description
     * TypeORM's failed-statement hook.
     *
     * The error is **attached to the statement's existing record** rather than producing a second
     * one, and this is load-bearing rather than tidiness: TypeORM calls `logQuery` before executing
     * and then calls this hook for the *same* statement when it fails, so appending here would
     * record a failed statement twice and break every equality assertion. The deliberate
     * `UQ_reorder_list_customer_channel_name_key` violation the create suite provokes is exactly
     * such a statement.
     *
     * The record chosen is the most recent captured statement with the same text that does not
     * already carry an error and was issued on the same query runner, which is correct even when the
     * same statement text is issued twice in one window. A record is appended only when no such
     * statement exists — the case where the window opened between the two hooks — so nothing is ever
     * silently dropped.
     *
     * Recording rather than discarding matters for a second reason: installing this logger displaces
     * core's `TypeOrmLogger`, so this is the only place the diagnostic survives.
     */
    logQueryError(error: string | Error, query: string, parameters?: any[], queryRunner?: QueryRunner): void {
        if (!this.captureEnabled) {
            return;
        }
        // TypeORM's interface types this argument `string | Error`, and both arrive in practice. A
        // string is used verbatim: passing it through the JSON stringifier would wrap it in quotes
        // and defeat a substring assertion on a constraint name.
        const errorText =
            typeof error === 'string' ? error : error instanceof Error ? error.message : safeStringify(error);
        const existing = this.findCapturedStatement(query, queryRunner, true);
        if (existing !== undefined) {
            existing.error = errorText;
            return;
        }
        this.recordStatement(query, parameters, queryRunner, errorText);
    }

    /**
     * @description
     * TypeORM's slow-statement hook, called *in addition* to `logQuery` and only when
     * `maxQueryExecutionTime` is configured (`node_modules/typeorm/driver/sqljs/SqljsQueryRunner.js:L85-L87`),
     * which the shared test configuration does not set.
     *
     * The statement text is noted in {@link slowQueryNotices} and the statement itself is appended
     * only when it is not already captured, for the same double-count reason as
     * {@link logQueryError}. The `time` argument is deliberately unused and never stored: this module
     * evidences which statements were issued and makes no claim about how long any of them took, so
     * no timing assertion can be derived from it.
     */
    logQuerySlow(time: number, query: string, parameters?: any[], queryRunner?: QueryRunner): void {
        if (!this.captureEnabled) {
            return;
        }
        this.capturedSlowQueryNotices.push(typeof query === 'string' ? query : safeStringify(query));
        if (this.findCapturedStatement(query, queryRunner, false) === undefined) {
            this.recordStatement(query, parameters, queryRunner, undefined);
        }
    }

    /**
     * @description
     * TypeORM's schema-build hook. Recorded into {@link schemaMessages} rather than discarded,
     * because core's `TypeOrmLogger` is displaced by this one and would otherwise have surfaced it.
     */
    logSchemaBuild(message: string, queryRunner?: QueryRunner): void {
        if (!this.captureEnabled) {
            return;
        }
        this.capturedSchemaMessages.push(typeof message === 'string' ? message : safeStringify(message));
    }

    /**
     * @description
     * TypeORM's migration hook. Recorded into {@link migrationMessages}, which is what the migration
     * suite inspects while applying and reverting.
     */
    logMigration(message: string, queryRunner?: QueryRunner): void {
        if (!this.captureEnabled) {
            return;
        }
        this.capturedMigrationMessages.push(typeof message === 'string' ? message : safeStringify(message));
    }

    /**
     * @description
     * TypeORM's general-purpose log hook. Recorded into {@link logMessages} with the message
     * rendered to a string, so a suite can assert on it without a type guard.
     */
    log(level: 'log' | 'info' | 'warn', message: any, queryRunner?: QueryRunner): void {
        if (!this.captureEnabled) {
            return;
        }
        this.capturedLogMessages.push({
            level,
            message: typeof message === 'string' ? message : safeStringify(message),
        });
    }

    /**
     * Appends one statement record. Every hook funnels through here, so the `enabled` gate and the
     * "never throw" guarantee are implemented once.
     */
    private recordStatement(
        query: string,
        parameters: any[] | undefined,
        queryRunner: QueryRunner | undefined,
        error: string | undefined,
    ): void {
        if (!this.captureEnabled) {
            return;
        }
        const entry = this.buildEntry(query, parameters, queryRunner, this.nextSequence);
        this.nextSequence = entry.sequence + 1;
        if (error !== undefined) {
            entry.error = error;
        }
        this.capturedStatements.push(entry);
    }

    /**
     * Builds one record, degrading rather than throwing. A throw inside a TypeORM logger hook
     * surfaces to the caller as a mysterious query failure, so a parse problem must never become a
     * failure in the code under test; the statement is still recorded, classified conservatively as
     * `other` with no table attributed.
     */
    private buildEntry(
        query: string,
        parameters: any[] | undefined,
        queryRunner: QueryRunner | undefined,
        sequence: number,
    ): CapturedStatement {
        try {
            const text = typeof query === 'string' ? query : safeStringify(query);
            return {
                query: text,
                parameters: Array.isArray(parameters) ? parameters.slice() : [],
                kind: classifyStatement(text),
                tables: extractStatementTables(text),
                sequence,
                runnerId: this.resolveRunnerId(queryRunner),
                inTransaction: resolveTransactionState(queryRunner),
            };
        } catch {
            return {
                query: typeof query === 'string' ? query : '',
                parameters: [],
                kind: 'other',
                tables: [],
                sequence,
                runnerId: undefined,
                inTransaction: undefined,
            };
        }
    }

    /**
     * Finds the most recent captured statement with the same text, optionally requiring that it does
     * not already carry an error, and requiring a matching runner identifier when both are known.
     * The scan runs backwards, because the statement a second hook is reporting on is the latest
     * matching one.
     */
    private findCapturedStatement(
        query: string,
        queryRunner: QueryRunner | undefined,
        requireNoExistingError: boolean,
    ): CapturedStatement | undefined {
        if (typeof query !== 'string') {
            return undefined;
        }
        const runnerId = queryRunner === undefined ? undefined : this.runnerIds.get(queryRunner);
        for (let index = this.capturedStatements.length - 1; index >= 0; index--) {
            const candidate = this.capturedStatements[index];
            if (candidate.query !== query) {
                continue;
            }
            if (requireNoExistingError && candidate.error !== undefined) {
                continue;
            }
            if (
                runnerId !== undefined &&
                candidate.runnerId !== undefined &&
                candidate.runnerId !== runnerId
            ) {
                continue;
            }
            return candidate;
        }
        return undefined;
    }

    /**
     * Assigns and remembers a stable identifier for a query runner. Nothing is retained beyond the
     * runner's own lifetime, because the registry is a `WeakMap`.
     */
    private resolveRunnerId(queryRunner: QueryRunner | undefined): number | undefined {
        if (queryRunner === undefined || queryRunner === null) {
            return undefined;
        }
        const existing = this.runnerIds.get(queryRunner);
        if (existing !== undefined) {
            return existing;
        }
        const assigned = this.nextRunnerId;
        this.nextRunnerId = assigned + 1;
        this.runnerIds.set(queryRunner, assigned);
        return assigned;
    }
}

/**
 * @description
 * The engine identifiers on which an **exact** statement count may be asserted.
 *
 * These are the SQLite-family identifiers, of which `sqljs` is the one the repository's e2e
 * configuration actually selects (`e2e-common/test-config.ts:L106`); `sqlite` and
 * `better-sqlite3` are included so a locally configured native SQLite run is treated the same way
 * rather than silently skipping.
 *
 * Note the direction of this gate carefully. It restricts a **counted** assertion. A behavioural
 * assertion — the response, the persisted rows, the refusal — runs on all four engine jobs and must
 * never be gated on it. This is the inverse of the sibling `./concurrency-barrier.ts`, whose forced
 * interleavings are *excluded* from sql.js.
 */
export const STATEMENT_COUNT_ENGINES: readonly string[] = ['sqljs', 'sqlite', 'better-sqlite3'];

/**
 * @description
 * Why an exact statement count is asserted on one engine and the behaviour it evidences on all four.
 * Suitable for use as a skip reason at an assertion site.
 */
export const STATEMENT_COUNT_ENGINE_REASON =
    'Statement text and even statement count differ legitimately between drivers, so epic ' +
    '11.6.2 fixes the counted form of a claim to the sql.js job, where it is deterministic, and ' +
    'requires the behaviour that count evidences to be asserted on all four engine jobs.';

/**
 * @description
 * The database engine the e2e run is configured for, resolved exactly as
 * `e2e-common/test-config.ts`'s own `getDbConfig()` resolves it: `process.env.DB || 'sqljs'`.
 *
 * Mirroring that expression character-for-character is what makes this evaluable at *collection*
 * time, before any server exists — which is what makes `it.skipIf(!isStatementCountEngine())(...)`
 * usable, following the shipped idiom at `packages/core/e2e/order-promotion.e2e-spec.ts:L1811-L1813`.
 *
 * @example
 * ```ts
 * resolveConfiguredEngine(); // 'sqljs' when DB is unset, otherwise the value of DB
 * ```
 */
export function resolveConfiguredEngine(): string {
    return process.env.DB || 'sqljs';
}

/**
 * @description
 * Whether an exact statement count may be asserted on the given engine, defaulting to the engine the
 * run is configured for.
 *
 * Pass nothing to gate at collection time. Pass an explicit engine string — typically
 * `dataSource.options.type`, available once a server has booted — to gate against what the running
 * data source actually is.
 *
 * This module never refuses to work on another engine: capture, filtering and predicate inspection
 * are available everywhere. Only *counted equality* is gated.
 *
 * @example
 * ```ts
 * // Counted form: sql.js only, with the reason stated at the site.
 * it.skipIf(!isStatementCountEngine())(STATEMENT_COUNT_ENGINE_REASON, async () => {
 *     await capture.capture(() => shopClient.query(ADD_ITEM_TO_REORDER_LIST, { input }));
 *     expect(capture.count('stock_level')).toBe(0);
 * });
 *
 * // Behavioural form: all four engine jobs, never gated.
 * it('does not allocate stock when a line is added', async () => {
 *     const { addItemToReorderList } = await shopClient.query(ADD_ITEM_TO_REORDER_LIST, { input });
 *     expect(addItemToReorderList.lines[0].quantity).toBe(6);
 * });
 * ```
 */
export function isStatementCountEngine(engine?: string): boolean {
    const resolved = (typeof engine === 'string' && engine.length > 0 ? engine : resolveConfiguredEngine())
        .toLowerCase()
        .trim();
    return STATEMENT_COUNT_ENGINES.indexOf(resolved) !== -1;
}

/**
 * @description
 * A `mergeConfig`-ready fragment installing the instrument on `dbConnectionOptions.logger`.
 *
 * It returns a **fresh plain object wrapping the class instance** and reads no configuration of its
 * own. In particular it does not call `testConfig()`: that helper derives its port from the calling
 * file's index within its own directory listing, so a call made from `e2e/fixtures/` would index
 * against this directory and can collide two suites on one port
 * (`e2e-common/test-config.ts:L37-L77`). Each spec file builds its own config from its own top-level
 * `testConfig()` call and merges this fragment into it.
 *
 * Either shipped merge shape preserves the instance identity, because in both cases the value at
 * `logger` is a class instance and `mergeConfig` assigns a class instance by reference
 * (`packages/core/src/config/merge-config.ts:L52-L56`).
 *
 * **No type assertion is required, and this was verified rather than assumed.** `PartialVendureConfig`
 * is a deep-partial mapped type (`packages/core/src/config/vendure-config.ts:L1415-L1427`) which maps
 * *every* property, including the function-typed members of TypeORM's `Logger`, so it is reasonable
 * to expect it to reject one. It does not: the mapping of a function type is an object type whose
 * members are all optional, which a function value satisfies structurally. Both shapes below were
 * type-checked against the real `DeepPartialSimple` and TypeORM's real `DataSourceOptions` with the
 * workspace-pinned compiler, alongside a negative control (`logger: 42`) confirming the check has
 * teeth. If a future change to that mapped type does start rejecting it, narrow the assertion to this
 * one property and never to the whole config.
 *
 * @example
 * ```ts
 * // Shape 1: partial merge into `dbConnectionOptions`, without repeating the `type` discriminant.
 * // The shipped precedent is `packages/core/e2e/custom-field-relations.e2e-spec.ts:L97-L103`.
 * const capture = new QueryCaptureLogger();
 *
 * const { server, shopClient } = createTestEnvironment(
 *     mergeConfig(testConfig(), {
 *         plugins: [ReorderPlugin.init({ ... })],
 *         ...queryCaptureConfig(capture),
 *     }),
 * );
 * ```
 *
 * @example
 * ```ts
 * // Shape 2: spread of the resolved options, per `packages/cli/e2e/migrate-command.e2e-spec.ts:L245-L249`.
 * // Use this when it reads better to keep the discriminated union's own `type` in view.
 * const baseConfig = testConfig();
 * const capture = new QueryCaptureLogger();
 *
 * const { server, shopClient } = createTestEnvironment(
 *     mergeConfig(baseConfig, {
 *         plugins: [ReorderPlugin.init({ ... })],
 *         dbConnectionOptions: {
 *             ...baseConfig.dbConnectionOptions,
 *             // The instance, by reference and with no assertion. `mergeConfig` assigns a class
 *             // instance without cloning it, so `capture.reset()` reaches the very object TypeORM
 *             // holds.
 *             logger: capture,
 *         },
 *     }),
 * );
 * ```
 */
export function queryCaptureConfig(capture: QueryCaptureLogger): QueryCaptureConfigFragment {
    return {
        dbConnectionOptions: {
            logger: capture,
        },
    };
}
