/*
 * The reorder list service — provenance, and the one property that makes it correct.
 *
 * WHAT THIS FILE IS. It holds *every* read and write for `reorder_list` and `reorder_list_line`, which is a
 * deliberate structural choice rather than an accident of layering: the ownership rule below then has
 * exactly one implementation, so no second code path can disagree with it.
 *
 * THE ONE PROPERTY THAT MAKES IT CORRECT. `@Allow(Permission.Owner)` on the resolvers is NOT the access
 * control — the ownership-and-channel predicate in this file is. `Permission.Owner` is declared
 * `assignable: false, internal: true` (the `Owner` PermissionDefinition inside `DEFAULT_PERMISSIONS`,
 * `packages/core/src/common/constants.ts` L27-L32), so no session ever holds it; the guard merely marks the
 * request context `authorizedAsOwnerOnly` and then admits the request. The platform states the consequence
 * in its own source: a resolver using that permission *must* include owner-enforcing logic, or the effect is
 * the same as public access. Identifiers are sequential under the default id strategy, so the predicate —
 * and not an unguessable id — is what protects one buyer's data from another's.
 *
 * THREE SHAPES IN HERE LOOK LIKE STYLE AND ARE NOT. Each is load-bearing and each is easy to "tidy" into a
 * defect:
 *
 * 1. Ownership conjuncts are composed into the SAME `WHERE` clause as the row lookup, never applied to an
 *    already-loaded row. `findOne({ where: { id } })` followed by an in-memory check reads the row it was
 *    supposed to refuse — a row in process memory can reach a log line, an error message or a timing
 *    difference — and it passes every response-shaped assertion while doing so. The instrumented contract
 *    this satisfies is: exactly one statement against the addressed table, its predicate carrying the acting
 *    customer and the active channel alongside the row's own identifier, and exactly zero rows returned.
 * 2. Counters and quantities are changed by conditional statements whose affected-row count is read as the
 *    authority, never by read-compute-save. Read-compute-save cannot distinguish "applied" from "matched
 *    nothing", and on a counter it silently loses one of two concurrent writes.
 * 3. The deterministic sort tie-break is APPENDED to a caller-supplied sort rather than substituted for it.
 *    The mechanism is the platform's own `Object.assign({}, options.sort, extendedOptions.orderBy)`
 *    (`packages/core/src/service/helpers/list-query-builder/list-query-builder.ts` L309), so keys handed
 *    through `extendedOptions.orderBy` land last — which is literally what "appended" means here. Nothing
 *    else in the builder can append.
 *
 * WHAT IS DELIBERATELY ABSENT, so that each absence reads as a ruling rather than as an omission. There is
 * no scheduled task, no event class, no job-queue handler and no configurable strategy; no retention,
 * anonymisation or purge behaviour of any kind, the customer-data-lifecycle pass belonging to a later batch,
 * with the consequence stated plainly that a *soft*-deleted customer's list rows persist; no fifth error
 * result, because a malformed quantity is a bad request rather than a business outcome; no idempotency key,
 * claim column or request fingerprint, the add operation's delivery guarantee being at-least-once and the
 * absolute-set adjust operation being the remedy; no custom field on any core entity; no monetary value and
 * no stock state; and no service-level, latency, throughput, conversion or revenue figure anywhere,
 * including in these comments.
 *
 * WHY THE FOUR ERROR RESULTS BELOW EXTEND NOTHING. The platform's `TranslateErrorResultInterceptor` rewrites
 * an error result's `message` by looking up `errorResult.<message>` in the i18n catalogue, but it does so
 * only for instances of core's own generated `ErrorResult` base classes
 * (`packages/core/src/api/middleware/translate-error-result-interceptor.ts`), and the Shop-side base is not
 * exported from the `@vendure/core` package root at all. These four classes therefore extend neither base
 * and carry a finished English sentence, which passes through untouched. Carrying a message *key* here would
 * be the defect: this plugin's translation bundle registers exactly four keys and none of them describes an
 * error result, so the lookup would miss and the caller would read raw key text.
 *
 * The `@since 3.8.0` tags below are a derivation and are flagged as one. The contribution guide requires new
 * public API to carry a `@since` tag naming what will be the next minor version, and its own literal example
 * names a different version. This checkout declares 3.7.0, so the next minor derives to 3.8.0 — computed
 * from that declared version plus the guide's rule, and never a quotation from the guide, which does not
 * state the value. The authoritative tickets record the same derivation.
 */

import { Inject, Injectable } from '@nestjs/common';
import { DeletionResponse, DeletionResult } from '@vendure/common/lib/generated-types';
import { PaginatedList } from '@vendure/common/lib/shared-types';
import {
    Customer,
    ForbiddenError,
    I18nError,
    ID,
    InternalServerError,
    ListQueryBuilder,
    ListQueryOptions,
    Logger,
    ProductVariantService,
    RequestContext,
    RequestContextCacheService,
    TransactionalConnection,
    UserInputError,
    VendureEntity,
} from '@vendure/core';
import { randomUUID } from 'crypto';
import { EntityMetadata, In, Not, SelectQueryBuilder } from 'typeorm';

import { loggerCtx, REORDER_PLUGIN_OPTIONS } from '../constants';
import { ReorderListLine } from '../entities/reorder-list-line.entity';
import { ReorderList } from '../entities/reorder-list.entity';
import { ResolvedReorderPluginOptions } from '../types';

import { canonicaliseReorderListName } from './reorder-list-name';

/**
 * How one named database object is identified in a driver failure, so that a violation of *that* object can
 * be recognised without widening to "any unique violation".
 *
 * It carries the columns as well as the name because the four supported engines do not agree on what they
 * put in the message. MySQL, MariaDB and PostgreSQL all name the object — `Duplicate entry '…' for key
 * 'UQ_…'` and `duplicate key value violates unique constraint "UQ_…"` respectively — while the SQLite family
 * names the **columns** instead: `UNIQUE constraint failed: reorder_list.customerId,
 * reorder_list.channelId, reorder_list.nameKey`. A match on the name alone therefore fails on the engine the
 * project's default end-to-end job actually runs, turning a promised conflict result into an internal error
 * there and nowhere else. Matching the exact qualified column list as the alternative keeps the test
 * object-specific rather than error-class-specific: it is still one named object being recognised, spelled
 * the way that engine spells it.
 */
interface ReorderListConstraintDescriptor {
    /** The exact name the entity declaration and the additive migration give the object. */
    name: string;
    /** The table the object is declared on. */
    table: string;
    /** The object's columns, which is how the SQLite family reports it. */
    columns: string[];
}

/**
 * The ONE database object this service translates into a buyer-visible outcome.
 *
 * The match is narrow by requirement rather than by caution. `reorder_list_line` carries its own uniqueness
 * constraint, `UQ_reorder_list_line_list_variant`, and mapping "any unique-violation code" would report a
 * duplicate *line* as a duplicate *name* — a wrong answer that reads like a right one. The two objects are
 * separate, are named separately and carry different columns, so neither descriptor can match the other's
 * failure under either spelling.
 */
const NAME_CONFLICT_CONSTRAINT_DESCRIPTOR: ReorderListConstraintDescriptor = {
    name: 'UQ_reorder_list_customer_channel_name_key',
    table: 'reorder_list',
    columns: ['customerId', 'channelId', 'nameKey'],
};

/**
 * The per-variant uniqueness object on `reorder_list_line`, recognised so that a losing concurrent insert can
 * be RETRIED rather than reported.
 *
 * It is not translated into a buyer-visible error and it never reaches the caller: a duplicate line means a
 * competing request created the very row this one was creating, and the contract's answer to that is an
 * accumulation onto the winner's row. Recognising the object is what lets the loser tell that state apart
 * from a genuine failure, and it is described here — separately from the name-conflict descriptor, with its
 * own name, table and columns — so that neither object's failure can ever be mistaken for the other's under
 * either the named or the column-list spelling.
 */
const LINE_DEDUPLICATION_CONSTRAINT_DESCRIPTOR: ReorderListConstraintDescriptor = {
    name: 'UQ_reorder_list_line_list_variant',
    table: 'reorder_list_line',
    columns: ['reorderListId', 'productVariantId'],
};

/**
 * How many whole transactions one add is allowed to take before the failure is reported rather than retried.
 *
 * A retry here is not a hopeful re-run of something that failed: each one is entered knowing that a competing
 * request has *committed* the line this call was creating, so the next attempt reads that committed row and
 * accumulates onto it — a path that cannot itself hit the same duplicate. Two attempts are therefore enough
 * for any single competitor, and the third exists so that a pathological interleaving (the winner's row
 * removed again before the loser's retry reads it) still converges instead of failing. The bound is small and
 * explicit because an unbounded loop against a database is a way to turn a defect into an outage: once it is
 * exhausted the failure is sanitised and reported like any other.
 */
const MAX_ADD_RECONCILIATION_ATTEMPTS = 3;

/**
 * The SQLite family's own wording for a uniqueness violation, required alongside the qualified column list so
 * that the column form of the match in {@link ReorderListService.violatesConstraint} cannot be satisfied by a
 * message that merely happens to mention those columns — a check-constraint failure or a not-null failure on
 * the same table names columns too, and neither is a uniqueness violation.
 */
const SQLITE_UNIQUE_VIOLATION_TEXT = 'unique constraint failed';

/**
 * The plugin-owned message keys this service raises, spelled exactly as the translation bundle registers
 * them. An unregistered key surfaces to the caller as the key text itself, so these three strings and the
 * bundle's own contents must agree; declaring them once here is what keeps that agreement checkable.
 *
 * There is deliberately no fourth key for a fifth failure mode: the bundle registers four keys in total, one
 * of which belongs to name canonicalisation and is raised by that module rather than by this one.
 */
const QUANTITY_MUST_BE_POSITIVE_KEY = 'error.reorder-list-line-quantity-must-be-positive';
const QUANTITY_ABOVE_MAXIMUM_KEY = 'error.reorder-list-line-quantity-above-maximum';
const VARIANT_NOT_FOUND_KEY = 'error.reorder-list-variant-not-found';

/**
 * The interpolation variable names the two interpolating messages carry. A mismatch here is not a compile
 * error and would surface only as an unsubstituted token in a message a buyer reads, which is why the names
 * are declared rather than written inline at each call site.
 */
const MAX_VARIABLE = 'max';
const ID_VARIABLE = 'id';

/**
 * The database engines against which a pessimistic row lock is both available and necessary, matching the
 * platform's own engine test in its shipped scheduler strategy
 * (`packages/core/src/plugin/default-scheduler-plugin/default-scheduler-strategy.ts` L278-L279).
 *
 * The SQLite family is absent for a reason that is a property of the driver rather than an optimism: the
 * in-process WebAssembly engine the test harness ships serves a single connection, so two transactions there
 * cannot interleave and a count-and-insert inside one transaction is sufficient on its own. Asking that
 * driver for a lock raises rather than degrades, so the branch is required and is not a micro-optimisation.
 *
 * Exported so the unit spec's lock-order replay reads the SAME list rather than a copy of it: the model has
 * to agree with the implementation about which engines have an order to impose, and a second literal would
 * be one more place to keep in step. It is not part of the package's published surface, this module being
 * absent from the root barrel.
 *
 * `readonly` because export plus mutability is a defect however narrow the audience: an importer that pushed
 * or spliced would change which engines this plugin locks on, process-wide, for every request. Nothing
 * mutates it — every reader calls `includes` — so the type states what the code already does.
 */
export const ENGINES_SUPPORTING_PESSIMISTIC_LOCKING: readonly string[] = ['postgres', 'mysql', 'mariadb'];

/**
 * The engines on which a transaction that will write a LINE must hold the parent list row exclusively rather
 * than shared, because two such transactions holding it shared deadlock at the line row.
 *
 * **This is a measured engine difference, not a preference.** A transaction writing only a line row needs the
 * parent lock solely to impose the parent-before-child order, so the shared mode is the natural choice: two of
 * them stay mutually compatible and continue to meet at the line row, which is where the atomic increment's
 * guard lives and where the contract requires the race to be observable. On PostgreSQL that is exactly what
 * happens. On the MySQL family it is not, and the difference was measured through the shipped resolvers rather
 * than reasoned about:
 *
 * Two adds accumulate onto one line and both hold the parent shared; the line is removed beneath both; both
 * increments then address a delete-marked record, and each transaction's follow-up current read of that record
 * (on the add path {@link ReorderListService.findLineForVariant}, which must take a lock to read current under
 * REPEATABLE READ) waits on the other's record lock from its own scan. InnoDB detects the cycle and answers
 * `Deadlock found when trying to get lock` — captured on both MariaDB 11.5 and MySQL 8, on the first attempt,
 * at the increment statement.
 *
 * **Its consequence is a failure a buyer sees, which is why prevention is the fix rather than recovery.** An
 * InnoDB deadlock rolls back the WHOLE transaction, destroying every savepoint in it — and how that surfaces
 * depends on the transaction mode of the resolver that called in, which differs across the six mutations:
 *
 * - Five of them (`createReorderList`, `updateReorderList`, `deleteReorderList`, `adjustReorderListLine`,
 *   `removeReorderListLine`) take `@Transaction()`'s default `'auto'` mode, so this service's own
 *   `withTransaction` is a nested savepoint [packages/core/src/connection/transaction-wrapper.ts]. There the
 *   platform issues `ROLLBACK TO SAVEPOINT` for a scope the engine has already discarded, receives
 *   `SAVEPOINT typeorm_1 does not exist`, and that error REPLACES the deadlock on the way out — fatal to
 *   recovery, because `ER_LOCK_DEADLOCK` is retriable by the platform's own wrapper and the savepoint error
 *   is not. The masking happens inside `packages/core` and cannot be corrected from here.
 * - `addItemToReorderList` — the one path that can form the cycle above — declares `@Transaction('manual')`,
 *   so each of its bounded attempts opens a real transaction at DEPTH ZERO and no savepoint exists to be
 *   masked; a deadlock there would surface as itself. The measurement above was taken through the resolvers
 *   as they then stood, in auto mode, where it was unrecoverable; manual mode removes the masking but not the
 *   deadlock, and a deadlock reaching a buyer is still a failure this feature has no reason to accept.
 *
 * Either way the cycle must not be formed in the first place, which is what the exclusive parent lock on the
 * MySQL family achieves.
 *
 * Holding the parent exclusively costs the interleaving on these two engines — two accumulations against one
 * list serialise at the parent instead of meeting at the line — and that cost is accepted deliberately: the
 * atomic increment's guard is still evidenced on PostgreSQL by the same barrier-released pair, and on every
 * engine by the sequential pair, whereas an unclassified failure reaching a buyer is not recoverable at all.
 * Nothing upgrades under either mode: the exclusive lock is taken at admission, before any line statement.
 *
 * Exported for the same reason {@link ENGINES_SUPPORTING_PESSIMISTIC_LOCKING} is, and `readonly` for the same
 * reason: the unit spec's lock-order replay has to read the SAME list rather than a copy of it, and an
 * importer must not be able to mutate the locking model of a running process. The e2e fixture publishes its
 * own `EXCLUSIVE_PARENT_FOR_LINE_WRITE_ENGINES` over the same two engines, an `e2e/` module being unreachable
 * from `src/`.
 */
export const ENGINES_REQUIRING_EXCLUSIVE_PARENT_FOR_LINE_WRITES: readonly string[] = ['mysql', 'mariadb'];

/*
 * The alias, column names and bound parameters the nested-lines read gives its per-parent ranking subquery.
 * Written as a section header rather than as a doc comment because it describes the five declarations that
 * follow rather than any one of them, and each of those carries its own.
 *
 * They are declared here, once, because each appears in more than one place in a raw SQL fragment — the
 * subquery that produces the rank and the predicate that filters on it — and a fragment that disagreed with
 * itself about a name would fail at the engine rather than at compile time. The names are prefixed so that
 * they cannot collide with a column of either plugin table or with a parameter the platform's own builder
 * generates.
 */

/**
 * The alias the ranking query is given as a derived table, which is what allows its rank — a window
 * function, and so unfilterable where it is computed — to be filtered one level out.
 */
const LINE_WINDOW_ALIAS = 'reorder_line_window';

/** The projected line identifier that derived table returns, and the value the outer `IN` predicate reads. */
const LINE_WINDOW_ID_COLUMN = 'reorder_line_window_id';

/** The projected per-parent row number the window predicate compares against the resolved page bounds. */
const LINE_WINDOW_RANK_COLUMN = 'reorder_line_window_rank';

/** The bound parameter carrying the resolved `skip`, the exclusive lower bound of the rank predicate. */
const LINE_WINDOW_SKIP_PARAM = 'reorderLineWindowSkip';

/** The bound parameter carrying `skip + take`, the inclusive upper bound of the rank predicate. */
const LINE_WINDOW_UPPER_PARAM = 'reorderLineWindowUpper';

/*
 * The column names the nested-lines read gives its per-parent grouped count, declared here for the same
 * reason as the window names above: each is written in both the grouped subquery that produces it and the
 * projection that reads it back.
 */

/** The projected parent list identifier the grouped count is keyed by. */
const LINE_TOTALS_PARENT_COLUMN = 'reorder_line_totals_parent_id';

/** The projected count of lines belonging to that parent, read back as each page's `totalItems`. */
const LINE_TOTALS_COUNT_COLUMN = 'reorder_line_totals_count';

/**
 * The alias the owner-scope `EXISTS` sub-query gives the parent list table.
 *
 * It is deliberately unlike any alias the query builder generates from an entity name, so that the fragment
 * cannot shadow the alias of the statement it is embedded in on any engine.
 */
const OWNED_LIST_SUBQUERY_ALIAS = 'owned_list_scope';

/**
 * The prefix of the request-scoped key under which a **successfully resolved** owner scope is remembered for
 * the remainder of one request.
 *
 * It names this service, following the platform's own convention of spelling a request-cache key after the
 * consumer of the cached value (`packages/core/src/api/resolvers/entity/payment-entity.resolver.ts` L28), and
 * the full key appends the active channel — see {@link ReorderListService.ownerScopeCacheKey}.
 */
const OWNER_SCOPE_CACHE_KEY_PREFIX = 'ReorderListService.ownerScope';

/**
 * The generic, driver-free message a database failure this service cannot classify is re-raised with.
 *
 * A driver message can carry the schema, the column list, a SQL fragment and sometimes the conflicting
 * values, and a buyer-facing response is not a place to put any of them. It is deliberately identical for
 * every operation and every failure class, because a message that varied by cause would be a channel for
 * exactly the detail it exists to withhold.
 */
const UNCLASSIFIED_FAILURE_MESSAGE = 'The reorder list request could not be completed';

/**
 * The complete set of internal-error messages this module authors.
 *
 * An `INTERNAL_SERVER_ERROR` arriving at the sanitiser is forwarded only if its message is one of these. The
 * distinction is not pedantry: this service calls into platform collaborators, and an internal error raised
 * inside one of them was written for a boundary that is not this one — it can name a table, a column, a
 * configuration key or a strategy class. Forwarding it unchanged would publish that wording to the caller and
 * log it, which is exactly what the surrounding sanitisation exists to prevent, so an internal error this
 * module did not write is reported as this module's own generic failure instead.
 *
 * There is exactly one member, and that is the point rather than an accident of the current code: this module
 * authors one internal failure, the unclassified database one. Every other refusal it raises is a caller-level
 * outcome — a `ForbiddenError` for a session that is not this feature's buyer, a `UserInputError` for a
 * malformed name or quantity, or one of the four published error results.
 */
const OWN_INTERNAL_MESSAGES: ReadonlySet<string> = new Set([UNCLASSIFIED_FAILURE_MESSAGE]);

/**
 * The platform error code an internal failure carries, matched rather than imported because the platform
 * exports the code as a string on the error instance and not as an enum member reachable from its package
 * root.
 */
const INTERNAL_SERVER_ERROR_CODE = 'INTERNAL_SERVER_ERROR';

/**
 * Replaces an error's captured frame list with a fixed, information-free line, and returns the same instance.
 *
 * **This closes the last leg of the disclosure boundary, and the leg is not this file's own logging.** The
 * platform's `ExceptionLoggerFilter` (`packages/core/src/api/middleware/exception-logger.filter.ts`) is the
 * final sink for every error a resolver raises, and it logs `exception.stack` — as the trace argument of a
 * `Logger.error` call for any error whose log level is `Error`, and unconditionally as a `Logger.debug` line
 * for every `I18nError` that carries a stack at all. A V8 stack is a list of absolute source paths from the
 * running build together with the internal frames that led to the throw, so an error this service sanitises
 * perfectly and then throws with its frames intact still deposits build paths and internal call structure in
 * the application log. Sanitising the message and leaving the frames would be a boundary that looks closed
 * from inside this file and is open one layer out.
 *
 * The replacement keeps the shape a reader and a log formatter expect — `Name: message` on one line, which is
 * exactly what a real stack's first line is — so nothing downstream has to cope with an absent or malformed
 * value, and the two pieces of information it carries are the error's own class and its already-sanitised
 * message. It is applied to every error this module raises or forwards, rather than only to the generic
 * internal one, so that no single throw site has to be remembered as the exception.
 *
 * What is deliberately NOT removed is the error's code or its interpolation variables: a caller branches on
 * the code and a buyer reads the interpolated message, and neither carries anything about the running build.
 */
function withoutStackFrames<T extends Error>(error: T): T {
    error.stack = `${error.name}: ${error.message}`;
    return error;
}

/**
 * The fixed set of operation codes a sanitised failure is logged under.
 *
 * They are a closed union of literals rather than free text at each call site, which is what makes the log
 * line's content *decidable*: an operator can grep for one of exactly ten values, and no future edit can
 * interpolate a caught error's own words into the position an operation code occupies. That second property
 * is the point — this is the only identifying information a sanitised log line carries about what failed,
 * and it has to be information this file chose rather than information the driver supplied.
 */
type ReorderListOperation =
    | 'getReorderLists'
    | 'getReorderList'
    | 'getLinesForLists'
    | 'reconcileLineCount'
    | 'createReorderList'
    | 'updateReorderList'
    | 'deleteReorderList'
    | 'addItemToReorderList'
    | 'adjustReorderListLine'
    | 'removeReorderListLine';

/**
 * The fixed classifications a sanitised failure is logged as.
 *
 * Each is a string this file owns. Nothing is copied out of the caught value — not its message, not its
 * class name, not the failing statement and not its parameters — because a driver failure carries the SQL
 * it was executing, the schema and column names it touched, sometimes the conflicting values themselves,
 * and on some drivers a filesystem path; an application log is a place all of that outlives the request and
 * is read by people and tools that were never entitled to it. What an operator gets instead is the shape of
 * the failure, which is enough to tell a database outage from a defect in this file, plus a correlation id
 * that distinguishes one occurrence from the next.
 */
type ReorderListFailureClass = 'a database query failure' | 'an unexpected error' | 'a non-error value';

/**
 * Whether two identifiers denote the same row.
 *
 * They are compared as strings because the configured `EntityIdStrategy` decides whether an id is a number or a
 * string, and the two forms of the same identifier reach this module from different places: one loaded from a
 * column, one resolved from a session, one parsed out of a request argument. A strict comparison would answer
 * `false` for `1` against `'1'`, and the same coercion is already why every map in this file is keyed on
 * `String(id)`.
 */
function sameId(left: ID, right: ID): boolean {
    return String(left) === String(right);
}

/**
 * Describes the *shape* of an unclassified failure, using only strings this module owns.
 *
 * The database-failure branch is decided structurally rather than by class name: TypeORM's `QueryFailedError`
 * carries the statement it was running on a `query` property, so the presence of that property identifies the
 * failure class without reading its contents. Nothing is copied out of the value — the result is one of the
 * three literals of {@link ReorderListFailureClass} — which is what allows a log line to say "a database query
 * failure" without saying which statement, which table, which constraint or which values.
 *
 * It is a module function rather than a method because the api layer needs the same classification for the
 * failures it catches at its own boundary, and a second implementation of it there could drift into copying
 * the driver's words.
 */
function classifyReorderListFailure(err: unknown): ReorderListFailureClass {
    if (err != null && typeof err === 'object' && typeof (err as { query?: unknown }).query === 'string') {
        return 'a database query failure';
    }
    return err instanceof Error ? 'an unexpected error' : 'a non-error value';
}

/**
 * @description
 * Logs a failure this plugin could not classify for its caller, and returns the one generic internal error the
 * plugin exposes for it. The caller throws what is returned.
 *
 * **It exists so that the api layer closes its boundary the same way this service closes its own.** A resolver
 * has failure paths a service cannot reach on its behalf — a payload whose type no union member matches, a
 * collaborator service that raised while a field was being resolved — and each of them ends in an error that
 * leaves the plugin. Constructing that error at the throw site is how a plugin ends up with several
 * almost-identical internal errors, one of which interpolates the value it could not handle into a message a
 * caller reads, and none of which strips the frame list the platform's exception filter goes on to log. This
 * helper is the single construction site, so there is one message, one log shape and one sanitising step.
 *
 * **What reaches the log, and what deliberately does not.** The log line carries the caller's fixed diagnostic,
 * a fixed classification of the cause's shape where a cause was supplied, and a fresh correlation id. It
 * carries no part of the cause — not `message`, not `stack`, not a statement, not its parameters, not a
 * constraint name — for the reason set out on {@link classifyReorderListFailure} and on
 * {@link ReorderListService.rethrowSanitisedFailure}. The returned error carries no frame list either; see
 * {@link withoutStackFrames}.
 *
 * @param diagnostic - A description of what failed, composed **only** of fixed text and values this plugin
 * itself chose. Interpolating a caught error's message, a driver string or any caller-supplied text into it
 * would reopen at this call site exactly the disclosure the helper closes.
 * @param cause - The caught value, where there was one. It is classified and then discarded; it is never
 * logged and never returned.
 * @returns The generic internal error to throw. It is returned rather than thrown so a call site can write
 * `throw reportReorderListInternalFailure(…)` and keep its own reachability analysis correct.
 *
 * @since 3.8.0
 */
export function reportReorderListInternalFailure(diagnostic: string, cause?: unknown): InternalServerError {
    const correlationId = randomUUID();
    const classification = cause === undefined ? '' : ` with ${classifyReorderListFailure(cause)}`;
    Logger.error(`${diagnostic}${classification} (correlation id ${correlationId})`, loggerCtx);
    return withoutStackFrames(new InternalServerError(UNCLASSIFIED_FAILURE_MESSAGE));
}

/**
 * An internal signal, never a reported error: one add attempt discovered that a concurrent request had already
 * created the line for the variant it was about to insert.
 *
 * It exists because that state is reached in two different ways and both need the same response. The database
 * can refuse the insert on `UQ_reorder_list_line_list_variant`, or the capacity claim that runs before the
 * insert can see the duplicate first — and in the second case there is no driver failure to recognise, so
 * something has to be thrown for the retry to key on. Throwing rather than returning is essential rather than
 * stylistic: the attempt has already claimed a line's worth of the list's counter, and only leaving the
 * transaction lets the platform's wrapper roll that claim back before the next attempt runs. Returning a
 * status would commit the claim and permanently overstate the list's size.
 *
 * It is module-private and is always consumed by
 * {@link ReorderListService.addItemToReorderList}'s retry loop. Should the retry budget ever be exhausted it
 * falls through to the same sanitiser every other unclassified failure does, so it can no more reach a caller
 * than a driver error can.
 */
class ConcurrentLineInsertDetected extends Error {
    constructor() {
        super('A concurrent request created the reorder list line this request was creating');
    }
}

/**
 * Signals that the line this attempt had resolved was removed by a concurrent request before its increment
 * landed, so the add must be retried as an insert.
 *
 * It exists as a signal rather than a fall-through inside the same transaction because of the lock the
 * accumulation branch has by then acquired on a LINE row: the insert branch's capacity claim writes the PARENT,
 * and a transaction holding a child while it asks for the parent is the one ordering this plugin's rule forbids —
 * the half of a cycle whose other half is any concurrent removal, which holds the parent and waits for a child.
 * A fresh attempt sees no line, holds nothing, and reaches the insert branch cleanly.
 */
class ConcurrentLineRemovalDetected extends Error {
    constructor() {
        super('A concurrent request removed the reorder list line this request was incrementing');
    }
}

/**
 * @description
 * Input to {@link ReorderListService.createReorderList}, mirroring the published
 * `CreateReorderListInput` field for field.
 *
 * @docsCategory core plugins/ReorderPlugin
 * @docsPage ReorderListService
 * @since 3.8.0
 */
export interface CreateReorderListInput {
    /**
     * @description
     * The buyer-supplied list name. Canonicalised — trimmed, internal whitespace runs collapsed — before it
     * is stored, and refused as malformed input on four grounds: an empty canonical form; a canonical form
     * longer than the fixed bound; a refused character (a C0 control other than the three consumed as
     * whitespace, DELETE or a C1 control, U+200B, or U+FEFF); or a normalised `nameKey` longer than the same
     * bound. It is never truncated and never silently altered.
     *
     * @since 3.8.0
     */
    name: string;
}

/**
 * @description
 * Input to {@link ReorderListService.updateReorderList}, mirroring the published
 * `UpdateReorderListInput` field for field. The operation renames a list and touches nothing else: no line
 * row is read and none is written.
 *
 * @docsCategory core plugins/ReorderPlugin
 * @docsPage ReorderListService
 * @since 3.8.0
 */
export interface UpdateReorderListInput {
    /**
     * @description
     * The identifier of the list to rename. Addressed together with the acting customer and the active
     * channel, so an identifier the caller does not own resolves to `ReorderListNotFoundError` rather than
     * to another buyer's row.
     *
     * @since 3.8.0
     */
    id: ID;

    /**
     * @description
     * The new name, subject to the identical canonicalisation and the identical uniqueness rule that governs
     * creation — so a rename can return `ReorderListNameConflictError`, and a blank rename is refused as
     * malformed input rather than stored.
     *
     * @since 3.8.0
     */
    name: string;
}

/**
 * @description
 * Input to {@link ReorderListService.addItemToReorderList}, mirroring the published
 * `AddItemToReorderListInput` field for field.
 *
 * **It declares exactly three fields, and the absence of a fourth is a ruling rather than an omission.**
 * There is no idempotency key and no request fingerprint, because a replay guarantee needs a durable
 * claim-and-response record and this plugin owns no row in which one could be kept. A published argument
 * with no store behind it would advertise a guarantee that cannot be kept, which is worse than making no
 * guarantee at all. The delivery guarantee is therefore at-least-once, stated plainly: two deliveries of one
 * add accumulate, and {@link ReorderListService.adjustReorderListLine} — which sets an absolute quantity
 * rather than adding to one — is the deterministic remedy.
 *
 * @docsCategory core plugins/ReorderPlugin
 * @docsPage ReorderListService
 * @since 3.8.0
 */
export interface AddItemToReorderListInput {
    /**
     * @description
     * The identifier of the list to add to.
     *
     * @since 3.8.0
     */
    reorderListId: ID;

    /**
     * @description
     * The identifier of the variant to add. Resolved in the active channel; an identifier that does not
     * resolve there is refused as malformed input.
     *
     * @since 3.8.0
     */
    productVariantId: ID;

    /**
     * @description
     * The quantity to add. A positive integer, and it is an *increment* on this operation: where the variant
     * is already on the list the value is added to the existing line's quantity, and the configured maximum
     * is applied to the resulting total rather than to this increment.
     *
     * @since 3.8.0
     */
    quantity: number;
}

/**
 * @description
 * Input to {@link ReorderListService.adjustReorderListLine}, mirroring the published
 * `AdjustReorderListLineInput` field for field.
 *
 * @docsCategory core plugins/ReorderPlugin
 * @docsPage ReorderListService
 * @since 3.8.0
 */
export interface AdjustReorderListLineInput {
    /**
     * @description
     * The identifier of the list the line belongs to. Resolved under the ownership predicate first, which is
     * what distinguishes `ReorderListNotFoundError` from `ReorderListLineNotFoundError`.
     *
     * @since 3.8.0
     */
    reorderListId: ID;

    /**
     * @description
     * The identifier of the line to adjust.
     *
     * @since 3.8.0
     */
    lineId: ID;

    /**
     * @description
     * The quantity to set. An ABSOLUTE value rather than an increment, which is what makes this operation
     * idempotent by construction: repeating the call any number of times leaves the same stored value.
     *
     * @since 3.8.0
     */
    quantity: number;
}

/**
 * @description
 * Input to {@link ReorderListService.removeReorderListLine}, mirroring the published
 * `RemoveReorderListLineInput` field for field.
 *
 * @docsCategory core plugins/ReorderPlugin
 * @docsPage ReorderListService
 * @since 3.8.0
 */
export interface RemoveReorderListLineInput {
    /**
     * @description
     * The identifier of the list the line belongs to.
     *
     * @since 3.8.0
     */
    reorderListId: ID;

    /**
     * @description
     * The identifier of the line to remove. A second remove of the same line is refused with
     * `ReorderListLineNotFoundError` rather than reported as a success.
     *
     * @since 3.8.0
     */
    lineId: ID;
}

/**
 * @description
 * Whether the caller reached a list by owning it or through a grant, mirroring the published
 * `ReorderListAccess` enum. `SHARED` is declared because the published enum declares it and a non-null field
 * references it; nothing in this plugin returns it yet, sharing arriving with a later feature.
 *
 * @docsCategory core plugins/ReorderPlugin
 * @docsPage ReorderListService
 * @since 3.8.0
 */
export type ReorderListAccess = 'OWNED' | 'SHARED';

/**
 * @description
 * A capability a grant may confer on a shared list, mirroring the published `ReorderListCapability` enum.
 * Declared because the published enum declares it; the collection that carries it is always empty here.
 *
 * @docsCategory core plugins/ReorderPlugin
 * @docsPage ReorderListService
 * @since 3.8.0
 */
export type ReorderListCapability = 'READ' | 'APPLY_TO_ORDER';

/**
 * @description
 * The per-requester provenance of a returned list, mirroring the published `ReorderListViewerAccess` object
 * type. It is nested under an object type rather than sitting as bare scalars on the list type precisely
 * because it is per-requester: a value that varies by caller may not enter the generated sort and filter
 * inputs, which are built from the row type's own scalar fields.
 *
 * @docsCategory core plugins/ReorderPlugin
 * @docsPage ReorderListService
 * @since 3.8.0
 */
export interface ReorderListViewerAccess {
    /**
     * @description
     * How the caller reached this list.
     *
     * @since 3.8.0
     */
    access: ReorderListAccess;

    /**
     * @description
     * The capabilities a grant conferred. Non-empty only where {@link ReorderListViewerAccess.access} is
     * `SHARED`, so always empty while no share row can exist.
     *
     * @since 3.8.0
     */
    grantedCapabilities: ReorderListCapability[];
}

/**
 * @description
 * One parent's page of lines, as {@link ReorderListService.getLinesForLists} returns it: the published
 * `PaginatedList` shape plus one member that is **not** published and exists solely to keep the stored line
 * counter honest.
 *
 * **Why the two totals are separate members rather than one number.** `totalItems` is the parent's
 * collection **under the caller's filter**, which is what the published field has to report — a caller who
 * filters to the lines of one variant must be told how many lines match, not how many the list holds. The
 * stored `reorder_list.lineCount` is the **unfiltered** count of the parent's lines, so the two are
 * different quantities whenever a filter is in force, and using the first where the second is required is
 * not an approximation but a corruption: it would write a filtered number into the counter that the atomic
 * line bound is enforced against, letting a caller who filters to nothing reset a full list's counter and
 * then exceed `maxLinesPerList` without limit.
 *
 * {@link ReorderListLinePage.authoritativeTotalItems} therefore carries the unfiltered count **and is
 * present only when it really is unfiltered**. It is the one number
 * {@link ReorderListService.reconcileLineCount} may be given, and because the filtered value lives under a
 * different name, a caller cannot pass the wrong one by accident.
 *
 * @docsCategory core plugins/ReorderPlugin
 * @docsPage ReorderListService
 * @since 3.8.0
 */
export interface ReorderListLinePage extends PaginatedList<ReorderListLine> {
    /**
     * @description
     * The parent's **unfiltered** line total — the same quantity the stored `lineCount` column records —
     * or `undefined` where this request cannot establish it because the caller narrowed the collection with
     * a `filter` or a `filterOperator`.
     *
     * `undefined` means "no counter repair may be attempted for this parent on this request", which is the
     * same position a collection read is always in: the stored column is reported exactly as it stands. It
     * never means zero.
     *
     * @since 3.8.0
     */
    readonly authoritativeTotalItems?: number;
}

/**
 * @description
 * Returned when a reorder list addressed by id is absent, owned by another customer, in another channel, or
 * not shared with the caller.
 *
 * **One result for all four cases, deliberately.** Under the platform's default id strategy identifiers are
 * sequential and therefore guessable, so distinguishing "no such list" from "not yours" would confirm the
 * existence of another buyer's row to anyone who counts. Reporting one indistinguishable outcome for every
 * inaccessible case discloses nothing.
 *
 * This result belongs to *mutations* only. A single-list read answers `null` for every inaccessible case
 * instead, because a caller who asked to write needs a reason and a caller who asked to read does not.
 *
 * @docsCategory core plugins/ReorderPlugin
 * @docsPage ReorderListService
 * @since 3.8.0
 */
export class ReorderListNotFoundError {
    /**
     * @description
     * The GraphQL type name. Required rather than decorative: the union type resolvers discriminate on it,
     * and the platform's own error-result predicate treats a value without it as not an error result at all.
     *
     * @since 3.8.0
     */
    readonly __typename = 'ReorderListNotFoundError';

    /**
     * @description
     * The stable, machine-readable code, being the upper-snake form of the type name — the convention every
     * shipped error result follows, and the member this declaration contributes to the published `ErrorCode`
     * enum.
     *
     * @since 3.8.0
     */
    readonly errorCode = 'REORDER_LIST_NOT_FOUND_ERROR';

    /**
     * @description
     * A finished English sentence rather than a message key, and carrying no driver text, no SQL fragment and
     * no constraint name.
     *
     * @since 3.8.0
     */
    readonly message = 'The requested reorder list could not be found';
}

/**
 * @description
 * Returned when the canonical form of a supplied list name is already held by this customer in this channel.
 *
 * **Two layers can produce it and they are indistinguishable to a caller.** The create and update paths each
 * perform an **advisory** scoped pre-check over `(customerId, channelId, nameKey)`, which answers an ordinary
 * duplicate before a row is written, and each catches the violation of the named database constraint over the
 * same three columns once the platform has unwound the transaction. The constraint is the **authority**,
 * because a read followed by a write loses the race whenever two concurrent requests both read before either
 * writes, and a constraint does not. Both layers return this same result carrying the same caller-derived
 * `conflictingNameKey`, so nothing observable depends on which one answered.
 *
 * @docsCategory core plugins/ReorderPlugin
 * @docsPage ReorderListService
 * @since 3.8.0
 */
export class ReorderListNameConflictError {
    /**
     * @description
     * The GraphQL type name, discriminating this member of the two unions that carry it.
     *
     * @since 3.8.0
     */
    readonly __typename = 'ReorderListNameConflictError';

    /**
     * @description
     * The stable, machine-readable code.
     *
     * @since 3.8.0
     */
    readonly errorCode = 'REORDER_LIST_NAME_CONFLICT_ERROR';

    /**
     * @description
     * A finished English sentence, carrying no driver text, no SQL fragment and no constraint name — the
     * constraint's name is an implementation detail of the schema and is never reported to a caller.
     *
     * @since 3.8.0
     */
    readonly message = 'A reorder list with this name already exists';

    /**
     * @description
     * The canonical `nameKey` that collided.
     *
     * It echoes the caller's own input and discloses no other row: it is computed from the name the caller
     * submitted, so a client can explain precisely what collided without this field ever revealing anything
     * about the list that already holds it.
     *
     * @since 3.8.0
     */
    readonly conflictingNameKey: string;

    constructor(conflictingNameKey: string) {
        this.conflictingNameKey = conflictingNameKey;
    }
}

/**
 * @description
 * Returned when a write would take a customer over their maximum number of lists, or a list over its maximum
 * number of lines.
 *
 * Neither bound is enforced by a count-then-insert check, because that loses the race: two concurrent
 * requests both read a count below the maximum and both insert. The list bound is enforced by counting and
 * inserting inside one transaction under a row lock on the owning customer, and the line bound by a single
 * conditional counter update whose affected-row count decides — so no interleaving admits an extra row.
 *
 * @docsCategory core plugins/ReorderPlugin
 * @docsPage ReorderListService
 * @since 3.8.0
 */
export class ReorderListLimitError {
    /**
     * @description
     * The GraphQL type name, discriminating this member of the two unions that carry it.
     *
     * @since 3.8.0
     */
    readonly __typename = 'ReorderListLimitError';

    /**
     * @description
     * The stable, machine-readable code.
     *
     * @since 3.8.0
     */
    readonly errorCode = 'REORDER_LIST_LIMIT_ERROR';

    /**
     * @description
     * A finished English sentence. It states the kind of bound rather than its value, because the value is
     * carried as data in {@link ReorderListLimitError.maxItems} where a client can act on it without parsing
     * prose.
     *
     * @since 3.8.0
     */
    readonly message = 'This reorder list operation would exceed the configured maximum';

    /**
     * @description
     * The breached maximum, in the same shape the platform's own order-level limit error carries its own — so
     * a client can state the actual bound in a message rather than guessing at it.
     *
     * @since 3.8.0
     */
    readonly maxItems: number;

    constructor(maxItems: number) {
        this.maxItems = maxItems;
    }
}

/**
 * @description
 * Returned when a line addressed by id is absent from the addressed list.
 *
 * Reaching this result means the *list* resolved under the ownership predicate and the line did not exist
 * within it. That two-step is exactly what distinguishes it from {@link ReorderListNotFoundError}, and it is
 * also how a second remove of the same line is refused rather than reported as a success.
 *
 * @docsCategory core plugins/ReorderPlugin
 * @docsPage ReorderListService
 * @since 3.8.0
 */
export class ReorderListLineNotFoundError {
    /**
     * @description
     * The GraphQL type name, discriminating this member of the two unions that carry it.
     *
     * @since 3.8.0
     */
    readonly __typename = 'ReorderListLineNotFoundError';

    /**
     * @description
     * The stable, machine-readable code.
     *
     * @since 3.8.0
     */
    readonly errorCode = 'REORDER_LIST_LINE_NOT_FOUND_ERROR';

    /**
     * @description
     * A finished English sentence, carrying no driver text and no SQL fragment.
     *
     * @since 3.8.0
     */
    readonly message = 'The requested reorder list line could not be found';
}

/**
 * @description
 * Result of {@link ReorderListService.createReorderList}.
 *
 * Per-operation membership is exact. A client can code against this union knowing that creation cannot
 * produce a line-level or not-found outcome, which "any of the four error results" would never have told it.
 *
 * @docsCategory core plugins/ReorderPlugin
 * @docsPage ReorderListService
 * @since 3.8.0
 */
export type CreateReorderListResult = ReorderList | ReorderListNameConflictError | ReorderListLimitError;

/**
 * @description
 * Result of {@link ReorderListService.updateReorderList}. It carries the name conflict because a rename
 * writes a name, and the not-found result because it addresses an existing row.
 *
 * @docsCategory core plugins/ReorderPlugin
 * @docsPage ReorderListService
 * @since 3.8.0
 */
export type UpdateReorderListResult = ReorderList | ReorderListNotFoundError | ReorderListNameConflictError;

/**
 * @description
 * Result of {@link ReorderListService.deleteReorderList}.
 *
 * The success member is the platform's existing `DeletionResponse`, reused verbatim rather than replaced by a
 * plugin-owned deletion payload — its `result` and nullable `message` are exactly what a deletion has to
 * report.
 *
 * @docsCategory core plugins/ReorderPlugin
 * @docsPage ReorderListService
 * @since 3.8.0
 */
export type DeleteReorderListResult = DeletionResponse | ReorderListNotFoundError;

/**
 * @description
 * Result of {@link ReorderListService.addItemToReorderList}. It carries the limit result because an add can
 * breach the line bound, and deliberately carries no line-level not-found result: an add either accumulates
 * onto an existing line or creates one, so there is no line it can fail to find.
 *
 * @docsCategory core plugins/ReorderPlugin
 * @docsPage ReorderListService
 * @since 3.8.0
 */
export type AddItemToReorderListResult = ReorderList | ReorderListNotFoundError | ReorderListLimitError;

/**
 * @description
 * Result of {@link ReorderListService.adjustReorderListLine}. It carries no limit result, because changing a
 * quantity on a line that already exists cannot breach a line-count bound.
 *
 * @docsCategory core plugins/ReorderPlugin
 * @docsPage ReorderListService
 * @since 3.8.0
 */
export type AdjustReorderListLineResult =
    | ReorderList
    | ReorderListNotFoundError
    | ReorderListLineNotFoundError;

/**
 * @description
 * Result of {@link ReorderListService.removeReorderListLine}.
 *
 * @docsCategory core plugins/ReorderPlugin
 * @docsPage ReorderListService
 * @since 3.8.0
 */
export type RemoveReorderListLineResult =
    | ReorderList
    | ReorderListNotFoundError
    | ReorderListLineNotFoundError;

/**
 * The customer-and-channel scope every operation in this service is evaluated against.
 *
 * It is resolved once per operation from the authenticated session and the request's active channel, and it
 * is never assembled from a caller-supplied argument — which is what makes "the caller cannot nominate a
 * different owner" a structural property rather than a validation rule.
 */
interface ReorderListOwnerScope {
    customerId: ID;
    channelId: ID;
    /**
     * The authenticated user the other two were resolved under.
     *
     * It is carried but **never** used as a query predicate — no plugin table holds a user id, and the row
     * scope is the customer and the channel. What it exists for is provenance: it says *whose session*
     * established this scope, so a scope recorded against a returned row can be checked against the session
     * asking about that row later. Without it, "an active user exists" is all a later check could establish,
     * and two different buyers in one channel are indistinguishable to it. See
     * {@link ReorderListService.ownerScopeForRecordedRow}.
     */
    activeUserId: ID;
}

/**
 * The owner scope each returned list row was actually resolved under, recorded against the row object itself.
 *
 * **It is the evidence `viewerAccess` derives its answer from, and it exists because the alternative is an
 * assertion.** `viewerAccess` must cost zero database statements, so it cannot re-establish ownership by
 * reading anything; and it must nevertheless *derive* the answer from the entry and the session rather than
 * return a constant that happens to be right because some earlier code is expected to have filtered the row.
 * Recording the scope at the moment the predicate was applied gives the derivation something real to compare
 * against — the row's own `customerId` and `channelId`, and the request's own channel and session — at no cost
 * beyond a map insertion.
 *
 * **A `WeakMap` keyed on the row rather than a request-scoped cache keyed on an id.** The key is the exact
 * object a read returned, so the evidence cannot transfer to a different row that happens to share an
 * identifier, and it cannot outlive the object: an entry disappears when the row does, so nothing accumulates
 * across requests and nothing has to be cleared. A cache keyed on the request context would additionally be
 * unreliable here, because a field resolver does not always receive the same `RequestContext` instance the root
 * resolver did.
 */
const RESOLVED_OWNER_SCOPES = new WeakMap<ReorderList, ReorderListOwnerScope>();

/**
 * The window a nested page of lines resolves to, after the platform's builder has validated the caller's
 * request — refusing a `take` above the Shop maximum, and bounding a negative one up to zero.
 *
 * Held as a value because the window has to be taken *off* the built query — a statement serving every parent
 * on a page must not carry one parent's `LIMIT` — and then applied per parent inside the ranking predicate
 * that cuts each parent's own window in the database.
 */
interface ResolvedLinesWindow {
    take: number;
    skip: number;
}

/**
 * The ordering keys appended to a collection read's sort. Both members are optional because what gets
 * appended depends on what the caller already asked for: everything when they asked for nothing, the
 * identifier alone when they sorted by something else, and nothing at all when they already sorted by the
 * identifier.
 */
type AppendedReorderListOrder = { createdAt?: 'DESC'; id?: 'DESC' };

/** The line-collection counterpart of {@link AppendedReorderListOrder}, ascending rather than descending. */
type AppendedReorderListLineOrder = { createdAt?: 'ASC'; id?: 'ASC' };

/**
 * @description
 * Holds every read and write for the `reorder_list` and `reorder_list_line` tables: the two Shop reads — one
 * paginated collection of lists, and one single-list read whose nested `lines` field is itself paginated —
 * the six Shop mutations, and the three support members the entity field resolvers call.
 *
 * **The ownership-and-channel predicate in this class is the access control for all eight operations.** The
 * `@Allow(Permission.Owner)` decorator on the resolvers is not: that permission is declared unassignable and
 * internal, so no session holds it and the guard merely marks the request context and admits it. Every
 * operation below therefore resolves the acting customer from the authenticated session, composes that
 * customer and the request's active channel into the same `WHERE` clause as the row it addresses, and treats
 * the resulting row count as the authority on what happened.
 *
 * The two conventions the platform's shipped saved-list plugin establishes are followed exactly, and they
 * differ from each other on purpose. A **read** whose guard *refuses* returns an empty page or `null`, never
 * an error, which is what makes a single-list read non-enumerable — and it is the refusal alone that is
 * normalised that way: a read whose guard fails for any other reason reports the failure rather than
 * answering "you have nothing", because an empty page a caller cannot distinguish from the truth is worse
 * than an error they can act on. A **write** whose guard fails lets
 * `ForbiddenError` propagate, so the caller observes one top-level error entry carrying the code `FORBIDDEN`
 * with the operation's own field null.
 *
 * @example
 * ```ts
 * \@Resolver()
 * export class ReorderListShopResolver {
 *     constructor(private reorderListService: ReorderListService) {}
 *
 *     \@Query()
 *     \@Allow(Permission.Owner)
 *     activeCustomerReorderLists(
 *         \@Ctx() ctx: RequestContext,
 *         \@Args() args: { options?: ListQueryOptions<ReorderList> | null; includeShared?: boolean | null },
 *     ): Promise<PaginatedList<ReorderList>> {
 *         return this.reorderListService.getReorderLists(ctx, args.options, args.includeShared);
 *     }
 * }
 * ```
 *
 * @docsCategory core plugins/ReorderPlugin
 * @docsPage ReorderListService
 * @docsWeight 0
 * @since 3.8.0
 */
@Injectable()
export class ReorderListService {
    constructor(
        private connection: TransactionalConnection,
        private productVariantService: ProductVariantService,
        private listQueryBuilder: ListQueryBuilder,
        private requestContextCache: RequestContextCacheService,
        @Inject(REORDER_PLUGIN_OPTIONS) private options: ResolvedReorderPluginOptions,
    ) {}

    /*
     * THE FIVE BOUNDS BELOW READ THE INJECTED OPTIONS DIRECTLY, AND NONE OF THEM RESTATES A DEFAULT.
     *
     * The provider supplies {@link ResolvedReorderPluginOptions}: every key present, validated in
     * `ReorderPlugin.init()` and re-asserted at application bootstrap — never per request — and frozen. A
     * fallback here would be a second executable copy of a number the
     * plugin already declares — unreachable through `ReorderPlugin.init()`, and therefore untested and free
     * to drift away from the value the server is actually running on. The named accessors remain, because
     * each one records WHERE its bound bites, which is the fact a reader of a call site needs.
     */

    /**
     * The maximum number of lists one customer may hold in one channel. Read only by
     * {@link ReorderListService.createReorderList}.
     */
    private get maxListsPerCustomer(): number {
        return this.options.maxListsPerCustomer;
    }

    /**
     * The maximum number of lines one list may hold. Read only by
     * {@link ReorderListService.addItemToReorderList} — the adjust path deliberately never consults it,
     * because changing a quantity on an existing line adds no line and so cannot breach a line-count bound.
     */
    private get maxLinesPerList(): number {
        return this.options.maxLinesPerList;
    }

    /**
     * The maximum quantity one line may carry. Applied by both quantity-bearing operations to the RESULTING
     * quantity rather than to the increment.
     */
    private get maxQuantityPerLine(): number {
        return this.options.maxQuantityPerLine;
    }

    /**
     * The page size the collection read falls back to where a caller supplies no `take`. It is stricter than
     * the platform's own substitution of the Shop list-query limit, which is what keeps an omitted page size
     * returning a bounded page rather than every row.
     */
    private get defaultReorderListsPageSize(): number {
        return this.options.defaultReorderListsPageSize;
    }

    /**
     * The page size a nested page of lines falls back to where a caller supplies no `take`, stricter than the
     * platform's substitution for the same reason.
     */
    private get defaultReorderListLinesPageSize(): number {
        return this.options.defaultReorderListLinesPageSize;
    }

    /**
     * Whether the configured engine both supports and requires a pessimistic row lock.
     *
     * Read once per create rather than cached, because the connection's options are the authority and reading
     * them costs nothing; caching would only introduce a second place for the answer to live.
     */
    private get supportsPessimisticLocking(): boolean {
        return ENGINES_SUPPORTING_PESSIMISTIC_LOCKING.includes(this.connection.rawConnection.options.type);
    }

    /**
     * The mode in which a transaction that will write only a LINE holds the parent list row.
     *
     * Shared where two such transactions can share it safely, exclusive where measurement shows they cannot.
     * See {@link ENGINES_REQUIRING_EXCLUSIVE_PARENT_FOR_LINE_WRITES} for the measured deadlock this answers and
     * for what the exclusive mode costs. Read from the connection on each call for the same reason
     * {@link ReorderListService.supportsPessimisticLocking} is: the options are the authority.
     */
    private get parentLockModeForLineWrite(): 'pessimistic_read' | 'pessimistic_write' {
        return ENGINES_REQUIRING_EXCLUSIVE_PARENT_FOR_LINE_WRITES.includes(
            this.connection.rawConnection.options.type,
        )
            ? 'pessimistic_write'
            : 'pessimistic_read';
    }

    // The ownership-and-channel predicate. This is the access control for all eight operations.

    /**
     * Resolves the customer-and-channel scope every operation is evaluated against, and refuses a request
     * carrying no active user.
     *
     * This is the third conjunct of the predicate — "the session carries an active user at all" — and it is
     * evaluated first because the other two are meaningless without it. It is deliberately the platform's own
     * `ForbiddenError`, which takes neither a message nor variables: it is hard-wired to the `error.forbidden`
     * key and the code `FORBIDDEN`. `FORBIDDEN` rather than `UNAUTHORIZED` is the correct code here and the
     * distinction is the platform's own — an unauthorized error is raised where credentials do not *match*,
     * whereas an absent session on a permission-gated operation is reported as forbidden.
     *
     * Callers differ in how they treat the throw, and the difference is the read/write convention rather than
     * inconsistency: a read catches it and answers with an empty page or `null`, a write lets it propagate.
     *
     * **The `customer` lookup below is outside the counted boundary, and that is not an oversight to
     * "optimise" away.** The statement-count contract this service is held to filters captured statements to
     * `reorder_list` and `reorder_list_line` *by table name*, precisely so that an unrelated session, channel
     * or customer statement can neither inflate nor mask the number.
     *
     * **The lookup is narrowed twice over, and the second narrowing is the one that is easy to miss.**
     * `select` restricts the columns of the `customer` row to its identifier, but it does nothing about
     * relations the core entity declares *eager* — and `Customer.user` is one, so the default behaviour is
     * to join and hydrate the whole `User` row, and its own eager relations with it, for a lookup whose
     * entire output is one identifier. `loadEagerRelations: false` is what declines that. The result is that
     * no customer or user field beyond the identifier reaches process memory, which is a data-minimisation
     * choice on top of a correctness one: personal data that is never loaded cannot reach a log line, an
     * error message or a serialised context.
     */
    private async getOwnerScope(
        ctx: RequestContext,
        operation: ReorderListOperation,
    ): Promise<ReorderListOwnerScope> {
        this.requireActiveUser(ctx);
        // A scope this request has already resolved is reused rather than looked up again. One request
        // legitimately asks more than once — a collection read selecting the nested `lines` field resolves the
        // page and then the batched lines, and each asks independently so that neither is safe only by virtue
        // of its caller — and the answer cannot change within a request: it is derived from the session's user
        // and the context's channel, both fixed for the life of a `RequestContext`. See
        // {@link ReorderListService.cachedOwnerScope} for why only a SUCCESS is remembered and why the key
        // carries the channel.
        const cached = this.cachedOwnerScope(ctx);
        if (cached) {
            return cached;
        }
        let customer: Customer | null;
        try {
            customer = await this.connection.getRepository(ctx, Customer).findOne({
                where: { user: { id: ctx.activeUserId } },
                select: { id: true },
                // The second narrowing, and the one that is easy to miss. `select` restricts the columns of
                // the `customer` row to its identifier, but it says nothing about relations the core entity
                // declares *eager* — and `Customer.user` is one, so the default behaviour is to join and
                // hydrate the whole `User` row, and its own eager relations with it, for a lookup whose
                // entire output is one identifier. This declines that. The relation is still joined for the
                // predicate above: declining eager loading declines the hydration of the joined row's
                // columns, not the ability to filter on it. The result is that no customer or user field
                // beyond the identifier reaches process memory, which is data minimisation on top of
                // correctness — personal data that is never loaded cannot reach a log line, an error
                // message or a serialised context.
                loadEagerRelations: false,
            });
        } catch (err: unknown) {
            // The lookup is a database read like any other, so its failure is sanitised like any other and
            // is attributed to the operation that asked for it. Without this the one statement every
            // operation issues before its own would be the one statement outside the disclosure boundary.
            return this.rethrowSanitisedFailure(err, operation);
        }
        if (!customer) {
            // AN AUTHENTICATED USER WITH NO CUSTOMER ROW IS A GUARD FAILURE, NOT A BROKEN INVARIANT, AND
            // THE DIFFERENCE IS OBSERVABLE. It is a NORMAL platform state rather than upstream corruption:
            // the Shop API's own `login` applies no restriction on which `User` may authenticate
            // (`packages/core/src/service/services/auth.service.ts`), so an administrator's session — or one
            // from a custom `AuthenticationStrategy` that creates no customer — reaches here with
            // `activeUserId` set and no customer row. The platform answers exactly this case by returning
            // nothing (`packages/core/src/api/resolvers/shop/shop-customer.resolver.ts` answers `undefined`
            // for `activeCustomer`), and classifying it as internal instead would answer all eight
            // operations with a 500 for a session that is simply not a buyer.
            //
            // So it is the same refusal as an absent session, raised through the same error class, which is
            // what makes the read/write convention apply to it without a second branch anywhere: a read
            // catches `ForbiddenError` and answers the empty page or `null` (AAP section 0.5.2.3), and a
            // write lets it propagate as one top-level `FORBIDDEN` entry. Nothing about the session is
            // echoed — the platform's `ForbiddenError` takes neither a message nor variables.
            throw withoutStackFrames(new ForbiddenError());
        }
        return this.rememberOwnerScope(ctx, {
            customerId: customer.id,
            channelId: ctx.channelId,
            // `requireActiveUser` above has already refused an absent session, so this is non-null here.
            activeUserId: ctx.activeUserId as ID,
        });
    }

    /**
     * The scope this request has already resolved, or `undefined` where it has not resolved one.
     *
     * **Only a resolved scope is ever stored, and that asymmetry is the point.** A refusal — no active user,
     * an authenticated user with no customer row, a failed lookup — is never remembered, so nothing here can
     * turn a transient failure into a request-long one, and no path can read a cached "denied" and skip the
     * check that would have decided. The cache is therefore an optimisation over a decision already made in
     * this request's favour and never a decision of its own.
     *
     * **The key carries the channel because the value does.** The platform's request cache is a `WeakMap` keyed
     * on the {@link RequestContext} instance, and a context is copied — for a transaction, or with
     * `ctx.copy()` — rather than mutated, so a differently-scoped context is already a different cache entry.
     * Naming the channel in the key makes that independent of the copying convention rather than reliant on
     * it: a scope resolved for one channel can never answer for another even if the same context instance were
     * somehow reused across two.
     *
     * A transaction context is a fresh instance and so starts with an empty cache, which is correct rather
     * than wasteful: each transaction resolves its own scope, and on the create path that resolution is
     * deliberately a *locking* read whose position as the transaction's first statement is load-bearing.
     */
    private cachedOwnerScope(ctx: RequestContext): ReorderListOwnerScope | undefined {
        return this.requestContextCache.get<ReorderListOwnerScope>(ctx, this.ownerScopeCacheKey(ctx));
    }

    /**
     * Stores a successfully resolved scope for the remainder of this request and returns it, so the caller can
     * `return this.rememberOwnerScope(...)` and cannot resolve a scope it forgot to store.
     */
    private rememberOwnerScope(ctx: RequestContext, scope: ReorderListOwnerScope): ReorderListOwnerScope {
        this.requestContextCache.set(ctx, this.ownerScopeCacheKey(ctx), scope);
        return scope;
    }

    /**
     * The request-scoped cache key the resolved scope is held under, naming this service and the active
     * channel. The channel identifier is stringified because the configured `EntityIdStrategy` decides whether
     * it arrives as a number or a string, and one row must not produce two keys.
     */
    private ownerScopeCacheKey(ctx: RequestContext): string {
        return `${OWNER_SCOPE_CACHE_KEY_PREFIX}(${String(ctx.channelId)})`;
    }

    /**
     * Resolves the same scope as {@link ReorderListService.getOwnerScope}, but by a **locking** read on the
     * owning customer row — and it is the ordering rather than the lock that makes it a separate member.
     *
     * **Why the list bound needs this, and why taking the lock as a second statement is not enough.** The
     * bound is enforced by counting `reorder_list` rows and inserting inside one transaction, which is only
     * correct if the count observes a competing creator's committed row. On MariaDB and MySQL, whose default
     * isolation level is REPEATABLE READ, InnoDB builds a transaction's consistent-read view at its **first
     * consistent read** and every later plain `SELECT` in that transaction answers from that view. A locking
     * read is a *current* read and does not build the view, so the order that works is: take the lock first,
     * and let the count be the first consistent read — by which time the predecessor has committed and
     * released the lock, so the count sees its row.
     *
     * Resolving the scope with an ordinary `findOne` before the lock is what breaks that, and it breaks it
     * invisibly. Every mutation resolver carries `@Transaction()`, so the request's transaction is already
     * open when this service is entered; a plain customer lookup issued there builds the read view *before*
     * the lock is taken, and the later count then answers from a snapshot older than the predecessor's
     * commit. Two creators at the bound both count one below the maximum and both insert. Nothing about the
     * lock looks wrong in that code — it is acquired, it is held, it serialises the two transactions — and
     * the bound is still exceeded. So the scope resolution and the lock are the same statement here, and it
     * is the first statement the transaction issues.
     *
     * **The statement joins nothing at all, and that is what bounds WHICH rows the lock covers.** The acting
     * user is addressed through the `customer` table's own foreign-key column rather than through the `user`
     * relation, so the statement reads one table. That matters because the lock this method takes is the
     * unqualified form: `FOR UPDATE` with no `OF` clause locks a row of **every** table the statement reads, so
     * joining `customer.user` and filtering on `user.id` would lock the `User` row as well as the `Customer`
     * row — a row this feature never writes, shared with authentication and with every other feature that
     * touches a session, held for the whole of a list creation. The bound requires a lock on the owning
     * customer and nothing more, and one table in the statement is the portable way to say so:
     * `FOR UPDATE OF customer` would express it on PostgreSQL and is not accepted by the MySQL family in the
     * same form, whereas a single-table statement needs no dialect-specific clause and TypeORM's own
     * `pessimistic_write` emits exactly it on all three locking engines.
     *
     * Addressing the column also removes the reason a join would have to be written by hand. A find-options
     * relation condition (`where: { user: { id } }`) is realised as a LEFT join, and PostgreSQL refuses
     * `FOR UPDATE` on the nullable side of an outer join — so the *relation* cannot be filtered on at all
     * under a lock without spelling the join explicitly. The foreign-key column sidesteps both: no join to
     * write, no nullable side to refuse. The column name is read from the relation's own metadata rather than spelled as
     * a literal, because it is a join column the entity declares no property for, so a literal here would be
     * the one identifier in this file that could drift from the schema unnoticed.
     *
     * Only the id column is selected, so no customer field beyond the identifier reaches process memory — and
     * with the join gone, no `User` field can either. On the SQLite family the lock is skipped, which is
     * required rather than an optimisation: that driver serves a single connection, so two transactions cannot
     * interleave, and asking it for a lock raises rather than degrades.
     *
     * **This resolver deliberately does not consult the request-scoped scope cache, and must never be made
     * to.** It is not here for the customer identifier — the plain resolver produces the same one — it is here
     * for the *lock*, and for that lock being the transaction's first statement. Serving it from a cache would
     * return the right value while taking no lock at all, which is the one failure mode the list bound cannot
     * survive: the count would then be the transaction's first consistent read taken without the lock held, two
     * concurrent creators at the bound would both count one below the maximum, and both would insert. It does
     * not populate the cache either, so the two resolvers stay independent and neither can silently start
     * answering for the other.
     */
    private async getLockedOwnerScope(
        ctx: RequestContext,
        operation: ReorderListOperation,
    ): Promise<ReorderListOwnerScope> {
        this.requireActiveUser(ctx);
        let customer: Customer | null;
        try {
            const alias = 'customer';
            const queryBuilder = this.connection
                .getRepository(ctx, Customer)
                .createQueryBuilder(alias)
                .select([`${alias}.id`])
                .where(
                    `${this.escapeColumn(alias)}.${this.escapeColumn(this.customerUserJoinColumn())} = :userId`,
                    { userId: ctx.activeUserId },
                );
            if (this.supportsPessimisticLocking) {
                queryBuilder.setLock('pessimistic_write');
            }
            customer = await queryBuilder.getOne();
        } catch (err: unknown) {
            return this.rethrowSanitisedFailure(err, operation);
        }
        if (!customer) {
            // The same refusal, for the same reason, as the plain resolver's — see {@link
            // ReorderListService.getOwnerScope}. A session that is not a buyer is refused rather than
            // reported as an internal failure, and this is a write path, so it propagates as `FORBIDDEN`.
            throw withoutStackFrames(new ForbiddenError());
        }
        return {
            customerId: customer.id,
            channelId: ctx.channelId,
            // `requireActiveUser` above has already refused an absent session, so this is non-null here.
            activeUserId: ctx.activeUserId as ID,
        };
    }

    /**
     * Resolves one list under the full predicate, in EXACTLY ONE statement, or answers `null`.
     *
     * **The shape of this method is the whole point of it, and the rejected alternative is worth naming.**
     * The acting customer and the active channel are conjuncts of the *same* `WHERE` clause as the row's own
     * identifier, so a request for a row the caller may not have issues one statement that returns zero rows.
     * The shape this exists to reject is `findOne({ where: { id } })` followed by an in-memory comparison of
     * `row.customerId`: that shape issues a statement whose predicate carries the identifier alone and whose
     * result set is one row — the row it was supposed to refuse — and it satisfies every response-shaped
     * assertion while having loaded another buyer's data into process memory, where it can reach a log line,
     * an error message or a timing difference.
     *
     * Every list-addressing operation goes through here, and `null` is therefore the single normalised answer
     * to "absent", "another customer's", "another channel's" and "not shared with the caller" alike. The two
     * kinds of caller then diverge: a read returns that `null` unchanged, and a mutation converts it into
     * `ReorderListNotFoundError` because a caller who asked to write needs a reason.
     *
     * It is deliberately not `getEntityOrThrow`, which raises an entity-not-found error — a distinguishable
     * refusal that would confirm the existence of another buyer's row to anyone who counts, given that
     * identifiers are sequential under the default id strategy.
     */
    private findOwnedList(
        ctx: RequestContext,
        id: ID,
        scope: ReorderListOwnerScope,
    ): Promise<ReorderList | null> {
        // Declared without `async` deliberately: the body is one repository call, and the scope recording is a
        // continuation on its promise rather than a second awaited step.
        return this.connection
            .getRepository(ctx, ReorderList)
            .findOne({
                where: { id, customerId: scope.customerId, channelId: scope.channelId },
            })
            .then(list => this.recordOwnerScope(list, scope));
    }

    /**
     * Resolves one list under the full predicate exactly as {@link ReorderListService.findOwnedList} does, and
     * additionally takes a pessimistic write lock on the row where the engine supports one.
     *
     * **It exists for lock ORDER rather than for the lock itself.** A transaction that deletes a line and then
     * decrements its parent's counter touches the child before the parent, while a transaction that deletes a
     * list touches the parent and then — through the cascade — its children. Two transactions taking the same
     * two rows in opposite orders deadlock, and the engine resolves that by killing one of them, which a buyer
     * observes as an operation that failed for no reason they can see. Locking the parent first gives every
     * transaction in this service one order.
     *
     * The predicate is unchanged and still one statement: the acting customer and the active channel remain
     * conjuncts of the same `WHERE` clause as the identifier, so a row the caller may not have is still refused
     * by returning no rows rather than by loading and discarding it. A lock on a row that does not match locks
     * nothing.
     *
     * The lock is skipped on the in-process SQLite engine, which serves a single connection: two transactions
     * cannot interleave there, so there is no order to impose, and asking that driver for a lock raises rather
     * than degrades.
     *
     * **The rule this method exists to serve is stated over the transactions it binds, not over the operations**
     * (FEATURE-001-01 §5, the lock-ordering seam item): any transaction touching both the parent `reorder_list`
     * row and a child `reorder_list_line` row takes the parent **first**. What each operation writes decides
     * only the STRENGTH of the lock it needs, never whether it needs one: a transaction that writes the parent
     * takes it exclusively here, and one that writes only a child still LOCKS the parent — in share mode,
     * through {@link ReorderListService.findOwnedListForShare} — because its child statement carries a
     * correlated ownership sub-query and that sub-query is a current read on the MySQL family. The one
     * transaction that takes no separate lock is the add path's insert branch, whose conditional capacity claim
     * IS its first parent statement; `findOwnedListForShare` sets out all four cases.
     */
    private findOwnedListForUpdate(
        ctx: RequestContext,
        id: ID,
        scope: ReorderListOwnerScope,
    ): Promise<ReorderList | null> {
        return this.findOwnedListUnderLock(ctx, id, scope, 'pessimistic_write');
    }

    /**
     * Resolves one list under the full predicate exactly as {@link ReorderListService.findOwnedList} does, and
     * additionally takes a row lock on it where the engine supports one — **shared on PostgreSQL, exclusive on
     * the MySQL family**, as {@link ReorderListService.parentLockModeForLineWrite} decides and
     * {@link ENGINES_REQUIRING_EXCLUSIVE_PARENT_FOR_LINE_WRITES} explains. Everything below describes the
     * shared mode, which is the general case; on those two engines the same lock is taken exclusively, so the
     * ordering it establishes is identical and only the concurrency between two line writes on ONE list is
     * given up. The strength never changes within a transaction, so nothing upgrades under either mode.
     *
     * **It is the parent-first half of the lock order for a transaction that writes a child row and never the
     * parent.** `adjustReorderListLine` changes one line's quantity: it touches no counter and no other column
     * of `reorder_list`, so it needs the parent held only for as long as it takes to write the child — which is
     * what a shared lock provides. A concurrent adjustment of a different line on the same list also holds the
     * parent in share mode and neither waits for the other, so the ordering costs nothing in concurrency, while
     * `removeReorderListLine` and `deleteReorderList` — which take the same row exclusively as their own first
     * statement — now queue against it in the same direction rather than against it from the opposite one. That
     * inversion is what a deadlock is: on the MySQL family the correlated ownership `EXISTS` a child write
     * carries takes a shared lock on the parent row it reads, so an adjust that had already locked the child
     * would be waiting for the parent while a remove holding the parent waited for the child, and the engine
     * would resolve it by killing one of them — which a buyer sees as an operation that failed for no reason
     * they can act on.
     *
     * **The accumulation branch of the add path calls this too, and for the same reason an adjustment does.**
     * That branch writes only the child — an accumulation leaves `lineCount` untouched — but its increment
     * carries the ownership predicate as a correlated `EXISTS` over `reorder_list`, and on the MySQL family a
     * sub-query evaluated by a DML statement is a current read: the statement takes the child exclusively and
     * then the parent in share mode, so its own acquisition order is child then parent. Taking this lock first
     * puts the parent ahead of it. The insert branch does NOT call this and does not need to: it writes the
     * parent, and its capacity claim is a conditional counter update on that very row, so the claim IS its first
     * parent statement and the engine takes the row exclusively to evaluate it, which orders the parent write
     * ahead of the child insert by itself. Calling this there as well would take the row in share mode and then
     * ask for it exclusively — an upgrade, and two concurrent inserts holding one share lock each would deadlock
     * on it.
     *
     * The crossing between those two branches is what makes them safe together, and it is handled by ABANDONING
     * the attempt rather than by a lock. Where an accumulation's increment matches nothing because the line was
     * removed under it, the insert path is what the call needs — but the transaction holds a lock on a line row
     * by then, and taking the parent while a child is held is the one ordering this rule forbids. So the attempt
     * ends, every lock it took is released with it, and the bounded retry reaches the insert branch holding
     * nothing. Two alternatives are ruled out rather than untried. ONE exclusive lock ahead of both branches
     * cannot cycle either, but it serialises every add to a list — including adds of unrelated variants — and
     * closes the very windows the atomic increment and the conditional claim exist to defend. Retrying under a
     * locking read reintroduces the inversion by another route: a savepoint retry keeps both locks, so the
     * retry would ask for the parent exclusively while holding a shared lock on it and a lock on a child row.
     *
     * The predicate, the single-statement shape and the SQLite-family skip are all exactly as
     * {@link ReorderListService.findOwnedListForUpdate} describes them.
     */
    private findOwnedListForShare(
        ctx: RequestContext,
        id: ID,
        scope: ReorderListOwnerScope,
    ): Promise<ReorderList | null> {
        return this.findOwnedListUnderLock(ctx, id, scope, this.parentLockModeForLineWrite);
    }

    /**
     * The one implementation behind the two locking resolvers, parameterised by lock strength.
     *
     * Neither the predicate nor the statement count varies with the strength: it is the same single scoped
     * `SELECT` in both cases, and on an engine that cannot take a row lock it is the same statement
     * {@link ReorderListService.findOwnedList} issues — so a suite counting statements on the in-process SQLite
     * engine sees the same number whichever resolver a path chose, and the locking behaviour is the only thing
     * that differs.
     *
     * @param mode - `'pessimistic_write'` for a transaction that will also write the parent row,
     * `'pessimistic_read'` for one that will only write a child of it.
     */
    private findOwnedListUnderLock(
        ctx: RequestContext,
        id: ID,
        scope: ReorderListOwnerScope,
        mode: 'pessimistic_read' | 'pessimistic_write',
    ): Promise<ReorderList | null> {
        if (!this.supportsPessimisticLocking) {
            return this.findOwnedList(ctx, id, scope);
        }
        return this.connection
            .getRepository(ctx, ReorderList)
            .createQueryBuilder('reorderlist')
            .setLock(mode)
            .where('reorderlist.id = :id', { id })
            .andWhere('reorderlist.customerId = :customerId', { customerId: scope.customerId })
            .andWhere('reorderlist.channelId = :channelId', { channelId: scope.channelId })
            .getOne()
            .then(list => this.recordOwnerScope(list, scope));
    }

    /**
     * Records the scope a row was resolved under against the row itself, and returns the row unchanged so the
     * recording can sit inline on a read's own return path.
     *
     * **Every path that hands a `ReorderList` outwards goes through here**, which is what makes the evidence
     * `viewerAccess` reads exhaustive rather than best-effort: the two scoped single-row reads, the current read
     * used to classify a write miss, each item of the collection read's page, and the row `createReorderList`
     * saved. A path that skipped it would produce a row `viewerAccess` refuses to describe, which is a loud
     * failure rather than a silent misreport — but it is still a defect, so the list of call sites is stated
     * here and re-checked whenever a read is added. See {@link RESOLVED_OWNER_SCOPES}.
     */
    private recordOwnerScope<T extends ReorderList | null | undefined>(
        list: T,
        scope: ReorderListOwnerScope,
    ): T {
        if (list) {
            RESOLVED_OWNER_SCOPES.set(list, scope);
        }
        return list;
    }

    /**
     * Reads back the scope a row was resolved under and answers it only where it still describes THIS request,
     * refusing outright where it does not.
     *
     * **It is the inverse of {@link ReorderListService.recordOwnerScope}, and it is the single implementation of
     * that check.** Two members need it — `getViewerAccess`, which must *describe* a row's provenance, and
     * `reconcileLineCount`, which must *scope a write* by it — and both are reachable from the api layer with a
     * row the caller supplies. A second copy of the derivation would be a second thing to keep correct, and the
     * two disagreeing is exactly the shape in which one of them stops checking.
     *
     * **Six conjuncts, each ruling out a different way a row can arrive here unvouched for.** The scope must
     * have been recorded at all; the request must carry an authenticated session; the recorded customer and
     * channel must still match the row's own columns, so provenance cannot be attached to a row it does not
     * describe; the recorded channel must be the request's active channel; and **the recorded session must be
     * this request's session**.
     *
     * THE LAST CONJUNCT IS THE ONE THAT IS EASY TO LEAVE OUT, AND IT IS WHAT MAKES THE CHECK ABOUT *WHO IS
     * ASKING*. Without it the strongest statement available is "some user is authenticated and the row was read
     * in this channel" — which two different buyers in one channel both satisfy. A row read for buyer A, held
     * beyond its request by a cache or by an integration and then passed to a member here during buyer B's
     * authenticated request in the same channel, would pass every other conjunct: the row's columns agree with
     * the recorded scope because they describe A, and the channel agrees because both are in it. The write
     * would then be correctly scoped **to A** and issued **on B's call**. Comparing the recorded session to
     * the asking one closes that, and it is the only conjunct that can: the row itself carries no evidence of
     * who read it.
     *
     * It issues **no statement**: the answer is one map lookup and six comparisons over values that are already
     * in memory — the recorded scope, the row's own columns and the request context.
     *
     * @param ctx - The request the recorded scope must still describe.
     * @param list - The row whose provenance is being read back, and the key it was recorded against.
     * @param member - The member asking, named in the server-side diagnostic so a refusal says which path
     * received the unvouched-for row. It reaches the log only; the caller still sees the generic message.
     * @throws The generic internal failure — never a caller-shaped error — because reaching the refusal means a
     * row bypassed the ownership predicate, which no caller-reachable path produces.
     */
    private ownerScopeForRecordedRow(
        ctx: RequestContext,
        list: ReorderList,
        member: 'viewerAccess' | 'reconcileLineCount',
    ): ReorderListOwnerScope {
        const scope = RESOLVED_OWNER_SCOPES.get(list);
        const derivedFromThisRequest =
            scope !== undefined &&
            ctx.activeUserId != null &&
            sameId(scope.activeUserId, ctx.activeUserId) &&
            sameId(scope.customerId, list.customerId) &&
            sameId(scope.channelId, list.channelId) &&
            sameId(scope.channelId, ctx.channelId);
        if (!derivedFromThisRequest || scope === undefined) {
            throw reportReorderListInternalFailure(
                `A reorder list reached ${member} without owner provenance matching the request`,
            );
        }
        return scope;
    }

    // Reads. A failed guard answers with an empty page or null, never with an error.

    /**
     * @description
     * Returns a bounded, deterministically ordered page of the lists the authenticated customer owns in the
     * active channel.
     *
     * **A caller with no resolvable scope receives an empty page rather than an error**, which is the shipped
     * read convention: the guard's refusal is caught here and answered with `{ items: [], totalItems: 0 }`. It
     * costs zero statements against either plugin table, because the guard fails before any list statement is
     * built.
     *
     * **The scope is server-side and cannot be widened by a caller.** It is supplied through the builder's
     * `where` extension rather than merged into the caller's `filter`, so a filter arriving from the generated
     * options input is composed *with* the scope and can only narrow the result further.
     *
     * **Bounding is delegated to the platform, not reimplemented.** The page is resolved through
     * `ListQueryBuilder`, which REFUSES a requested page size above the configured Shop maximum outright —
     * with the platform's own input error and the platform's own message key — rather than reducing it to
     * fit; what it does bound is a negative `take`, which it raises to zero.
     * `ignoreQueryLimits` is left unset — the option's own documentation records that an unlimited public list
     * query can become a denial-of-service vector. What this method contributes is a *stricter* fallback than
     * the platform's own: where a caller supplies no page size the plugin's configured default applies
     * instead of the platform substituting its maximum.
     *
     * **This read deliberately does NOT repair a stale `lineCount`, and that is specified behaviour rather
     * than an oversight.** A page of lists does not page each list's lines, so it has no observed total to
     * compare the stored counter against; it reports the column as it stands. The single-list read is where
     * the disagreement becomes visible for free, and that is where the repair lives. A list whose counter has
     * drifted therefore reports the stale value in a collection read until it is read singly, and naming that
     * window is the point — an unstated self-healing behaviour is worse than a stated one.
     *
     * @param ctx - The request context, whose active channel and authenticated session are the scope.
     * @param options - The generator-supplied list options: `skip`, `take`, `sort` and `filter`. Explicit
     * `null` is admitted as well as absence, because a GraphQL argument a client sends as `null` arrives as
     * `null` and not as `undefined` — the two are distinct values in a variables map and only one of them is
     * what an omitted argument produces. Both mean the same thing here, which is "no page options supplied".
     * @param includeShared - Accepted at both values and, under this feature, answered identically, and
     * admitting explicit `null` for the same reason. See the note on
     * {@link ReorderListService.getReorderList}.
     *
     * @since 3.8.0
     */
    async getReorderLists(
        ctx: RequestContext,
        options?: ListQueryOptions<ReorderList> | null,
        includeShared: boolean | null = false,
    ): Promise<PaginatedList<ReorderList>> {
        let scope: ReorderListOwnerScope;
        try {
            scope = await this.getOwnerScope(ctx, 'getReorderLists');
        } catch (err: unknown) {
            // The read convention, and it is narrowed to the ONE error the convention is about. A refusal
            // is the expected path for an unauthenticated or non-customer caller and is answered with the
            // empty page at a cost of zero statements against either plugin table. Anything else — a
            // database outage, a broken schema, an unresolvable session invariant — is NOT normalised into
            // an empty page: reporting "you have no lists" for "the database is unreachable" is a wrong
            // answer that reads like a right one, and it is indistinguishable from the truthful empty page
            // by every assertion a client can make.
            if (err instanceof ForbiddenError) {
                return { items: [], totalItems: 0 };
            }
            return this.rethrowSanitisedFailure(err, 'getReorderLists');
        }
        try {
            // Reduced to the keys that actually order something BEFORE the builder sees it, and the appended
            // tie-break is derived from that same sanitised value so the two cannot disagree. See
            // {@link ReorderListService.effectiveSort}.
            const sort = this.effectiveSort<ReorderList>(options?.sort);
            return await this.listQueryBuilder
                .build(
                    ReorderList,
                    {
                        ...options,
                        sort,
                        // The plugin's stricter fallback. The platform substitutes its own Shop maximum for
                        // an absent page size, so merging the configured default here is the only place it
                        // can be applied without reimplementing the validation that follows it.
                        take: options?.take ?? this.defaultReorderListsPageSize,
                    },
                    {
                        ctx,
                        where: { customerId: scope.customerId, channelId: scope.channelId },
                        orderBy: this.appendedListOrder(sort),
                    },
                )
                .getManyAndCount()
                .then(([items, totalItems]) => ({
                    // Every item is recorded against the scope this page was read under, so a list reached
                    // through the collection can describe its own `viewerAccess` exactly as one reached through
                    // the single read can. See {@link RESOLVED_OWNER_SCOPES}.
                    items: items.map(item => this.recordOwnerScope(item, scope)),
                    totalItems,
                }));
        } catch (err: unknown) {
            // The whole statement-issuing body is inside the sanitiser, not just the parts that were
            // expected to fail. A caller-supplied sort or filter reaching the builder is caller-controlled
            // input arriving at a query, so its failure mode is a driver error carrying the fragment it
            // could not build — which is exactly the disclosure this wrapper exists to stop. The platform's
            // own over-limit refusal passes through untouched, being a classified input error.
            return this.rethrowSanitisedFailure(err, 'getReorderLists');
        }
    }

    /**
     * @description
     * Returns one list addressed by id, or `null`.
     *
     * **`null` is the single answer for every inaccessible case** — an id that matches no row, a row owned by
     * another customer, a row in another channel, a row not shared with the caller, and a request carrying no
     * authenticated session at all. Those answers are indistinguishable from one another by design: with
     * sequential identifiers, a distinguishable refusal would confirm the existence of another buyer's row to
     * anyone who counts. This method therefore returns a bare `null` on every one of those paths, with no
     * error, no warning and no extension attached to distinguish them.
     *
     * `ReorderListNotFoundError` is deliberately not reachable from here. It belongs to the four
     * list-addressing *mutations*, where a caller who asked to write needs a reason and where the return type
     * is a union that can carry one.
     *
     * The lookup is exactly one statement, scoped in its own `WHERE` clause. See
     * {@link ReorderListService.findOwnedList} for why the shape matters.
     *
     * @param ctx - The request context, whose active channel and authenticated session are the scope.
     * @param id - The list identifier. A value the configured id strategy cannot decode matches no row and
     * takes the same normalised `null` path as every other inaccessible case.
     * @param includeShared - Accepted at both values and answered identically under this feature, because no
     * share row can exist until list sharing ships: the set the non-default value asks for is empty by
     * construction rather than withheld. The non-default value is therefore **not refused** — refusing it
     * would mean the same call changed from an error to a success later, which is a behaviour change on an
     * unchanged signature. Nothing here reads, writes or knows about a share row. Explicit `null` is admitted
     * alongside absence, a GraphQL argument sent as `null` arriving as `null` rather than as `undefined`.
     *
     * @since 3.8.0
     */
    async getReorderList(
        ctx: RequestContext,
        id: ID,
        includeShared: boolean | null = false,
    ): Promise<ReorderList | null> {
        let scope: ReorderListOwnerScope;
        try {
            scope = await this.getOwnerScope(ctx, 'getReorderList');
        } catch (err: unknown) {
            // Same convention as the collection read, and narrowed the same way: a refusal becomes the
            // indistinguishable `null` at a cost of zero statements against either plugin table, while any
            // other failure is reported rather than disguised as "no such list". A caller cannot act on a
            // null they were given because the database was down, and an operator cannot see it at all.
            if (err instanceof ForbiddenError) {
                return null;
            }
            return this.rethrowSanitisedFailure(err, 'getReorderList');
        }
        try {
            return await this.findOwnedList(ctx, id, scope);
        } catch (err: unknown) {
            return this.rethrowSanitisedFailure(err, 'getReorderList');
        }
    }

    // Support members for the entity field resolvers. Each is resolved once per page, never once per entry.

    /**
     * @description
     * Returns one page of lines for each list on a page of lists, resolved by a fixed pair of statements over
     * the page's identifier set: one for the rows and one for the per-parent totals.
     *
     * **This method exists because the alternative satisfies every row-count criterion while being wrong.** A
     * page of a hundred lists whose `lines` field is resolved per entry issues a hundred and one statements:
     * pagination bounds the number of *rows* a request returns and says nothing about the number of
     * *statements* they cost. So the batch key is the page and never the entry, and the assertion that
     * matters is non-growth — a page of three lists and a page of six lists issue the same number of
     * statements against the plugin's tables.
     *
     * **What the two statements are, and why each parent's window is cut in the database.** The first reads
     * the rows: a single statement over the whole identifier set whose predicate embeds a ranking subquery —
     * `ROW_NUMBER() OVER (PARTITION BY reorderListId ORDER BY <the page's own order>)`, filtered one level out
     * to the half-open rank range the resolved window describes — so each parent contributes exactly its own
     * window rather than all of its lines. The second reads the totals: one grouped `COUNT(*)` keyed on
     * `reorderListId`, cloned from the same scoped query before the window predicate is added, which is what
     * gives each parent a `totalItems` describing its whole collection rather than the size of the page
     * returned. Two statements is what the contract permits and is deliberately not one: partitioning an
     * unwindowed union in process would load every line of every parent on the page — ten lists holding two
     * hundred lines each is two thousand rows to return twenty — and taking each `totalItems` from the size of
     * such a partition is only correct while the whole collection has been loaded, which is precisely the read
     * this shape refuses to issue.
     *
     * **Neither statement's count depends on the page size, which is the property that matters.** Both are
     * issued exactly once per parent page, whatever number of parents that page holds, so the statement count
     * against the plugin's tables is constant as the page grows — which is the non-growth assertion above,
     * stated as a pair rather than as a single statement. The rows read are bounded too: the window bounds
     * each parent's contribution, and the number of parents is bounded by the outer page.
     *
     * **The over-limit refusal is the platform's.** The builder is asked for the caller's window first, which
     * is what raises the platform's own input error — with the platform's own message key — when the
     * requested page size exceeds the configured Shop maximum, rather than quietly reducing it; the
     * resolved values are then read back off the built query and applied per parent. Building a query issues no statement, so this costs
     * nothing. The window is cleared from the query before either statement executes precisely because a
     * statement serving many parents must not carry one parent's `LIMIT`.
     *
     * Every identifier passed in appears in the returned map, with an empty page where that list has no lines,
     * so a caller never has to distinguish "no lines" from "not resolved".
     *
     * **Each page reports two totals, and only one of them may reach the stored counter.**
     * {@link PaginatedList.totalItems} is the parent's collection *under the caller's filter*, which is what
     * the published field reports. {@link ReorderListLinePage.authoritativeTotalItems} is the *unfiltered*
     * count — the quantity `reorder_list.lineCount` records — and is present only on a request that applied
     * no `filter` and no `filterOperator`, because only such a request establishes it. See
     * {@link ReorderListLinePage} for why conflating the two would corrupt the line bound.
     *
     * @param ctx - The request context, joined so the read runs inside any open transaction.
     * @param listIds - The identifiers of the lists on the page being resolved.
     * @param options - The generator-supplied options for the nested collection.
     *
     * @since 3.8.0
     */
    async getLinesForLists(
        ctx: RequestContext,
        listIds: ID[],
        options?: ListQueryOptions<ReorderListLine>,
    ): Promise<Map<ID, ReorderListLinePage>> {
        const pages = new Map<ID, ReorderListLinePage>();
        for (const listId of listIds) {
            // Seeded WITHOUT an authoritative total, deliberately. A page that exists only because its
            // identifier was asked about has observed nothing, and `authoritativeTotalItems` being absent
            // rather than zero is what stops a repair being driven from it. See {@link ReorderListLinePage}.
            pages.set(listId, { items: [], totalItems: 0 });
        }
        const parentIds = Array.from(pages.keys());
        if (parentIds.length === 0) {
            return pages;
        }

        let scope: ReorderListOwnerScope;
        try {
            scope = await this.getOwnerScope(ctx, 'getLinesForLists');
        } catch (err: unknown) {
            // The read convention again, narrowed the same way: a refusal leaves every requested identifier
            // holding its pre-seeded empty page and issues no statement against either plugin table, while
            // any other failure is reported. A page of lists whose lines silently came back empty because a
            // query failed would render as "these lists have no lines", which is a false statement about
            // the buyer's own data.
            if (err instanceof ForbiddenError) {
                return pages;
            }
            return this.rethrowSanitisedFailure(err, 'getLinesForLists');
        }

        try {
            return await this.readLinesForLists(ctx, parentIds, pages, scope, options);
        } catch (err: unknown) {
            return this.rethrowSanitisedFailure(err, 'getLinesForLists');
        }
    }

    /**
     * The statement-issuing half of {@link ReorderListService.getLinesForLists}, extracted so that the
     * public method's guard and its query body each sit inside exactly one sanitiser and neither can grow a
     * path that bypasses it.
     *
     * It receives the pre-seeded page map rather than building one, so every identifier the caller asked
     * about is present in the result whatever this method finds.
     */
    private async readLinesForLists(
        ctx: RequestContext,
        parentIds: ID[],
        pages: Map<ID, ReorderListLinePage>,
        scope: ReorderListOwnerScope,
        options?: ListQueryOptions<ReorderListLine>,
    ): Promise<Map<ID, ReorderListLinePage>> {
        const sort = this.effectiveSort<ReorderListLine>(options?.sort);
        const queryBuilder = this.listQueryBuilder.build(
            ReorderListLine,
            {
                ...options,
                sort,
                // The same stricter fallback as the collection read, applied to the nested collection.
                take: options?.take ?? this.defaultReorderListLinesPageSize,
            },
            {
                ctx,
                // The parent scope is carried in the SAME `WHERE` clause as the identifier set, expressed as a
                // condition on the parent relation. The identifiers reaching this method always come from a
                // page this service already resolved under the predicate, so this conjunct is defence in depth
                // — but it is defence that costs nothing: a relation condition is realised as a join inside
                // each of the two statements below rather than as a further statement, so the per-page count
                // is unchanged. It also makes the method safe in its own right rather than safe by virtue of
                // its caller, which matters for a member the api layer reaches directly.
                where: {
                    reorderListId: In(parentIds),
                    reorderList: { customerId: scope.customerId, channelId: scope.channelId },
                },
                orderBy: this.appendedLineOrder(sort),
            },
        );
        // Read the window the platform resolved — which is where an over-limit request has already been
        // refused — and then clear it, because the statements below serve every parent on the page and neither
        // may carry one parent's `LIMIT`.
        const window: ResolvedLinesWindow = {
            take: queryBuilder.expressionMap.take ?? this.defaultReorderListLinesPageSize,
            skip: queryBuilder.expressionMap.skip ?? 0,
        };
        queryBuilder.take(undefined).skip(undefined);

        // Cloned BEFORE the window predicate is added, so the totals count the collection rather than the page.
        // A clone carries the built query's joins, predicate, filter and parameters — the same names bound to
        // the same values — which is also why the ranking subquery below can be embedded in its own parent
        // without any possibility of a parameter-name collision.
        const totalsQueryBuilder = queryBuilder.clone();

        const lineIdColumn = this.qualifiedLineColumn(queryBuilder.alias, 'id');
        const parentIdColumn = this.qualifiedLineColumn(queryBuilder.alias, 'reorderListId');
        const rankingQueryBuilder = queryBuilder
            .clone()
            // The order belongs inside the window function rather than on the subquery, where it would be both
            // meaningless and, on some engines, discarded.
            .orderBy()
            .select(lineIdColumn, LINE_WINDOW_ID_COLUMN)
            .addSelect(
                `ROW_NUMBER() OVER (PARTITION BY ${parentIdColumn} ORDER BY ${this.windowOrderExpression(
                    queryBuilder,
                )})`,
                LINE_WINDOW_RANK_COLUMN,
            );

        const windowAlias = this.escapeColumn(LINE_WINDOW_ALIAS);
        const rankColumn = `${windowAlias}.${this.escapeColumn(LINE_WINDOW_RANK_COLUMN)}`;
        // The rank is a window function, so it cannot be filtered where it is computed — hence the ranking
        // query becomes a derived table and the rank is filtered one level out. `skip` and `take` are a
        // half-open range over one-based ranks: rank > skip and rank <= skip + take.
        //
        // Cutting each parent's window in the DATABASE rather than in memory is the whole point. Slicing a
        // union read that carried every line of every parent on the page would load a page of ten lists
        // holding two hundred lines each — two thousand rows — to return twenty, while a write transaction
        // holds its connection.
        const rankedLineIds =
            `SELECT ${this.escapeColumn(LINE_WINDOW_ID_COLUMN)} ` +
            `FROM (${rankingQueryBuilder.getQuery()}) ${windowAlias} ` +
            `WHERE ${rankColumn} > :${LINE_WINDOW_SKIP_PARAM} AND ${rankColumn} <= :${LINE_WINDOW_UPPER_PARAM}`;
        queryBuilder.andWhere(`${lineIdColumn} IN (${rankedLineIds})`, {
            [LINE_WINDOW_SKIP_PARAM]: window.skip,
            [LINE_WINDOW_UPPER_PARAM]: window.skip + window.take,
        });

        const rows = await queryBuilder.getMany();
        const totals = await totalsQueryBuilder
            .orderBy()
            .select(parentIdColumn, LINE_TOTALS_PARENT_COLUMN)
            .addSelect('COUNT(*)', LINE_TOTALS_COUNT_COLUMN)
            .groupBy(parentIdColumn)
            .getRawMany<Record<string, unknown>>();

        // Both maps are keyed on the stringified identifier because the configured id strategy decides whether
        // an id is a number or a string, and a map keyed on the raw value would miss across the two.
        const partitions = new Map<string, ReorderListLine[]>();
        for (const row of rows) {
            const key = String(row.reorderListId);
            const partition = partitions.get(key);
            if (partition) {
                partition.push(row);
            } else {
                partitions.set(key, [row]);
            }
        }
        const totalsByParent = new Map<string, number>();
        for (const total of totals) {
            // The engines disagree about whether a count comes back as a number or as a string, so it is
            // coerced once here rather than trusted to arrive as either.
            totalsByParent.set(
                String(total[LINE_TOTALS_PARENT_COLUMN]),
                Number(total[LINE_TOTALS_COUNT_COLUMN]),
            );
        }
        // Whether the grouped count this read just issued IS the parent's unfiltered line total. It is,
        // exactly when the caller narrowed nothing: the totals query carries this read's own scope — the
        // parent identifier set and the owning customer and channel — and nothing else, and that scope
        // selects the whole of each parent's collection rather than a part of it. A caller-supplied filter is
        // the one thing that makes the number a subset, so its presence is what withholds the total.
        const narrowedByCaller = this.hasEffectiveLineFilter(options);
        for (const listId of parentIds) {
            const key = String(listId);
            // The parent's whole collection under the caller's filter, which is deliberately NOT the size of
            // the window: a caller paging past the last line must still be told how many there are.
            const totalItems = totalsByParent.get(key) ?? 0;
            pages.set(listId, {
                items: partitions.get(key) ?? [],
                totalItems,
                // Published as the counter-repair authority ONLY on an unfiltered read. On a filtered one the
                // member is absent rather than optimistically equal to `totalItems`, because a filtered count
                // written into `reorder_list.lineCount` would replace the number the atomic line bound is
                // enforced against with a number the caller chose — see {@link ReorderListLinePage}.
                ...(narrowedByCaller ? {} : { authoritativeTotalItems: totalItems }),
            });
        }
        return pages;
    }

    /**
     * Whether the caller's nested-lines options narrow the collection, and therefore whether the grouped
     * count this read issues describes a *part* of each parent's lines rather than all of them.
     *
     * **It is deliberately generous about what counts as narrowing.** Any own key on `filter`, whatever its
     * value, and any `filterOperator` at all, are treated as a narrowing — even shapes the platform's own
     * filter parser would ignore, such as a key whose value is `undefined`. The two directions of a wrong
     * answer here are not symmetrical: reporting "not narrowed" for a read that was narrowed hands a
     * caller-chosen number to the counter repair, which is the defect this predicate exists to prevent,
     * while reporting "narrowed" for a read that was not merely declines a repair that had nothing to fix in
     * the overwhelming majority of requests and is the collection read's own standing behaviour.
     *
     * `filterOperator` is included on its own account rather than only alongside a filter: it selects how
     * several filter conditions combine, so a request that carries one has expressed an intention to filter,
     * and treating it as unfiltered would be reading past the caller's own statement of intent.
     *
     * **No other member of the options can narrow the grouped count, and each was checked.** `skip` and
     * `take` are read off the built query and cleared before the totals projection is taken, so the window
     * cannot reach it; `sort` orders rows and removes none; the server-side scope this method's caller adds —
     * the parent identifier set and the owning customer and channel — is part of what "this list's lines"
     * MEANS rather than a narrowing of it, since a line belongs to one list and that list to one customer in
     * one channel and the count is grouped per parent; and the line entity is not soft-deletable, so the
     * builder adds no deletion predicate of its own.
     */
    private hasEffectiveLineFilter(options?: ListQueryOptions<ReorderListLine>): boolean {
        if (!options) {
            return false;
        }
        if (options.filterOperator != null) {
            return true;
        }
        const filter = options.filter;
        if (filter == null || typeof filter !== 'object') {
            return false;
        }
        return Object.keys(filter).length > 0;
    }

    /**
     * Renders one of this line table's columns as a fully qualified, engine-escaped identifier, for use inside
     * a raw SQL fragment.
     *
     * The physical name is read from the entity's own metadata rather than assumed to equal the property name,
     * so a naming strategy that transformed it could not silently produce a fragment naming a column that does
     * not exist. Both halves are escaped, which additionally keeps the fragment away from the query builder's
     * `alias.property` substitution: an already-quoted identifier is not a property reference.
     */
    private qualifiedLineColumn(alias: string, propertyPath: string): string {
        const column = this.connection.rawConnection
            .getMetadata(ReorderListLine)
            .findColumnWithPropertyPath(propertyPath);
        if (!column) {
            // Unreachable for a property this file names literally, and reported rather than papered over
            // because the alternative is a raw fragment that fails at the engine with a driver message.
            throw withoutStackFrames(new InternalServerError(UNCLASSIFIED_FAILURE_MESSAGE));
        }
        return `${this.escapeColumn(alias)}.${this.escapeColumn(column.databaseName)}`;
    }

    /**
     * Renders the ordering the platform composed for a built lines query as the `ORDER BY` of a window
     * function, so that each parent's window is cut in exactly the order the page is returned in.
     *
     * Reading the order back off the built query rather than rebuilding it is what keeps the two identical:
     * the caller's own sort, the appended identifier tie-break and the platform's own translation of both are
     * already resolved there, and a second derivation could drift from it. Each key arrives as the query's
     * alias followed by a property path, which is translated to the same escaped physical form the rest of
     * these fragments use; a key that is already a SQL expression — which is how the platform represents a
     * calculated column — is passed through unchanged.
     */
    private windowOrderExpression(queryBuilder: SelectQueryBuilder<ReorderListLine>): string {
        const alias = queryBuilder.alias;
        const terms: string[] = [];
        for (const [key, value] of Object.entries(queryBuilder.expressionMap.orderBys)) {
            const direction = typeof value === 'string' ? value : value.order;
            const propertyPath = key.startsWith(`${alias}.`) ? key.slice(alias.length + 1) : undefined;
            const column = propertyPath
                ? this.connection.rawConnection
                      .getMetadata(ReorderListLine)
                      .findColumnWithPropertyPath(propertyPath)
                : undefined;
            const reference = column
                ? `${this.escapeColumn(alias)}.${this.escapeColumn(column.databaseName)}`
                : key;
            terms.push(`${reference} ${direction === 'DESC' ? 'DESC' : 'ASC'}`);
        }
        // The declared default is a total order, and this service always appends the identifier tie-break, so
        // the list is never empty in practice. The fallback exists so that a future change which stopped
        // appending would produce a deterministic window rather than an engine-defined one.
        return terms.length
            ? terms.join(', ')
            : `${this.qualifiedLineColumn(alias, 'createdAt')} ASC, ${this.qualifiedLineColumn(alias, 'id')} ASC`;
    }

    /**
     * @description
     * Repairs a stored line counter that disagrees with the line total actually observed, by a single
     * compare-and-set statement — and issues nothing at all when the two agree.
     *
     * **Called from the single-list read only.** That request already knows the observed total for the list it
     * returned, so the disagreement is visible for free there; a page of lists has no observed total to
     * compare against and therefore does not repair. Nothing else in this service calls it.
     *
     * **The total passed in must be the UNFILTERED count of the list's lines, and there is exactly one number
     * that qualifies:** {@link ReorderListLinePage.authoritativeTotalItems}, which
     * {@link ReorderListService.getLinesForLists} publishes only on a request that narrowed nothing. The
     * published `totalItems` of the same page is **not** that number — it counts the lines matching the
     * caller's own filter — and writing it here would replace the counter the atomic line bound is enforced
     * against with a value the caller selected: filter a full list down to nothing, and the counter it is
     * measured against becomes zero. The guard below cannot detect that substitution, because a filtered
     * count is a perfectly ordinary non-negative integer, which is why the distinction is carried by the
     * type of the value rather than by a check on it.
     *
     * **Why a counter can drift at all, and why the answer is "almost never".** Every plugin write path
     * maintains the counter inside the same transaction as the row change. The one path no plugin code sees is
     * a *hard* deletion of a `product_variant` row, which cascades line rows away underneath the plugin
     * without the counter being told. The platform's own variant deletion is a *soft* delete that flags the
     * row and leaves every line in place, so this drift is unreachable through any shipped operation and is
     * reachable only by a direct database deletion or by a future platform change. It is not therefore
     * ignored.
     *
     * **Why compare-and-set rather than a plain assignment.** The statement's `WHERE` names the stale value it
     * expects to find, so it is idempotent and two concurrent repairs cannot fight: whichever runs second
     * finds the guard value already changed and affects no row. A `lineCount` that a competing writer moved in
     * the meantime is therefore left alone rather than clobbered with a total observed before that write.
     *
     * **The statement carries the ownership predicate, exactly as every other statement this service issues
     * against a plugin table does.** Its `WHERE` names four things: the row, the stale counter it expects to
     * find, the acting customer and the active channel. The last two are not redundant with the read that
     * produced the row. This member is `public` because the api layer calls it, so the caller's provenance is
     * an argument rather than an invariant of this file, and a predicate naming the identifier alone would
     * write to whichever row bore that identifier — identifiers are sequential under the default id strategy,
     * so "whichever row" is a neighbouring buyer's list. Keeping the pair on the statement means the write is
     * scoped by the database rather than by the caller having been careful, which is the same rule
     * [FEATURE-001-01:§2.6.1.1] applies to all eight operations.
     *
     * **And the scope is taken from the row's recorded provenance, never from the request alone.** The row
     * arrives carrying the scope it was actually read under ({@link RESOLVED_OWNER_SCOPES}), and that
     * recording — not `ctx` — is what the predicate is built from, after being checked against the row's own
     * `customerId` and `channelId` and against the request's active channel and session. A row with no
     * provenance, or with provenance that disagrees, is refused: nothing is written, no statement is issued,
     * and the generic internal failure is raised. That is the same fail-closed derivation
     * {@link ReorderListService.getViewerAccess} performs, for the same reason — reaching it means a list
     * arrived here without passing the predicate, which is a defect in this service rather than anything a
     * caller did, and answering it by writing anyway is the one response that cannot be justified.
     *
     * **What keeps the written value non-negative, and why it is not the check constraint.**
     * `CHK_reorder_list_line_count_non_negative` is real defence in depth on PostgreSQL and the SQLite family
     * and is simply *absent* on MySQL and MariaDB, because TypeORM skips check constraints silently for that
     * family — the same limitation {@link ReorderList.lineCount} records on the column itself. So the
     * constraint cannot be what makes the invariant hold, and two things that are portable are. The first is
     * provenance: the total this method is given is, on the flow the single-list read composes, the grouped
     * `COUNT(*)` this service reads over `reorder_list_line`, which no engine can answer with a negative or
     * fractional number. The second is the guard below, which refuses a value that is not a non-negative safe
     * integer outright: nothing is written, no statement is issued, and the stored counter is reported
     * instead, so a defective caller cannot put in the column a value that only two of the four engines would
     * have rejected.
     *
     * @param ctx - The request context whose active channel and authenticated session the row's recorded
     * scope is checked against, so provenance from one request cannot scope another's write.
     * @param list - The list whose counter is being reconciled. The **row object** rather than its identifier,
     * because the object is what carries the scope the row was read under, and that scope is what the
     * statement's ownership conjuncts are built from.
     * @param storedLineCount - The counter value that arrived with the row, and the guard the update compares.
     * @param observedTotal - The line total this request actually observed. A value that is not a non-negative
     * safe integer is a defect in the caller, and is refused rather than written.
     * @returns The value the caller should report, which is the stored column in every case the column can be
     * established: the stored value when the two agreed or when the observed total was refused; the observed
     * total once this method has written it; and, where the compare-and-set lost its race, the column as it
     * now stands, read back under the same ownership conjuncts. The observed total is reported on the lost
     * race in exactly one case — the row no longer exists within this scope, so there is no stored value to
     * report and the observed total is the only answer consistent with the page being returned.
     * @throws The generic internal failure when the row carries no owner provenance, or provenance that
     * disagrees with the request — no statement is issued on that path. Also when the compare-and-set lost its
     * race and the row is still there but its stored counter is not a non-negative safe integer: there is
     * then a stored value and it is not a count, so no authoritative number exists to report and the observed
     * total is deliberately not substituted for one.
     *
     * @since 3.8.0
     */
    async reconcileLineCount(
        ctx: RequestContext,
        list: ReorderList,
        storedLineCount: number,
        observedTotal: number,
    ): Promise<number> {
        // THE SCOPE THE WRITE WILL BE MADE UNDER, derived from the row's own recorded provenance and refused
        // rather than assumed. See this member's JSDoc, and `getViewerAccess` for the same derivation.
        //
        // It is derived FIRST, before the two values are even compared, so that "this member does not act on a
        // row it cannot vouch for" holds without qualification rather than only on the branch that happens to
        // write. It costs no statement — a map lookup and comparisons over already-loaded values — so the
        // zero-statement property of the agreeing path is untouched.
        const scope = this.ownerScopeForRecordedRow(ctx, list, 'reconcileLineCount');
        const listId = list.id;
        if (storedLineCount === observedTotal) {
            // The overwhelmingly common path: zero statements.
            return storedLineCount;
        }
        if (!Number.isSafeInteger(observedTotal) || observedTotal < 0) {
            // The portable half of the column's non-negative invariant, since the check constraint that would
            // otherwise refuse this value does not exist on MySQL or MariaDB. A total the column may not hold
            // is a defect in this service rather than anything the request did, so it is logged as one — the
            // list identifier and the offending number are the only values named, and neither describes the
            // caller — and the stored value is reported unchanged, which is the counter as it actually stands.
            // Nothing is written and no statement is issued. It is not raised, because a read that has already
            // produced the buyer's page must not be turned into a failure by a counter it only meant to
            // reconcile.
            Logger.error(
                `Refused a lineCount repair on reorder list ${String(listId)} because the observed total ` +
                    `${String(observedTotal)} is not a non-negative integer`,
                loggerCtx,
            );
            return storedLineCount;
        }
        let result;
        try {
            result = await this.connection
                .getRepository(ctx, ReorderList)
                .createQueryBuilder('reorderlist')
                .update()
                .set({ lineCount: observedTotal })
                .where('id = :id', { id: listId })
                .andWhere('lineCount = :storedLineCount', { storedLineCount })
                // THE OWNERSHIP CONJUNCTS, ON THE STATEMENT THAT WRITES. Bound under names of their own so a
                // reader — and the assertion that checks this shape — follows the predicate to the value rather
                // than finding the value in the parameter bag and inferring the predicate.
                .andWhere('customerId = :ownerCustomerId', { ownerCustomerId: scope.customerId })
                .andWhere('channelId = :ownerChannelId', { ownerChannelId: scope.channelId })
                .execute();
        } catch (err: unknown) {
            return this.rethrowSanitisedFailure(err, 'reconcileLineCount');
        }
        if (!result.affected) {
            // THE GUARDED ROW DID NOT MATCH, SO THIS REQUEST'S OBSERVED TOTAL IS NO LONGER THE COLUMN'S
            // VALUE — AND THE COLUMN IS THE AUTHORITY. Either a competing writer moved the counter between
            // the read and this statement, or the row is no longer reachable under this owner scope at all: a
            // list deleted in the same window matches neither guard. Nothing is retried, because whatever
            // now stands in the row was put there by something with a better claim than a repair.
            //
            // What is NOT done is report `observedTotal` anyway. A repair that lost its race has established
            // exactly one thing — that it does not know the counter — and answering with the total it counted
            // before the competing write would publish a number that is neither the stored column nor the
            // value the winner committed. So the column is read back, once, under the same three ownership
            // conjuncts the update carried, and that is what the caller reports. Two outcomes follow from
            // that read: the row is gone from this scope, in which case there is no stored value and the
            // observed total is the only answer left; or the row is there, in which case its value is
            // reported — and if that value is not a count at all, the request fails rather than substituting
            // one, because a stored value that exists and is unusable is an invariant failure and not a
            // missing number.
            Logger.debug(
                `Skipped a lineCount repair on reorder list ${String(listId)} because the guarded row no ` +
                    `longer matched — its stored value changed concurrently, or the row is no longer within ` +
                    `the owner scope it was read under`,
                loggerCtx,
            );
            let current: ReorderList | null;
            try {
                current = await this.connection.getRepository(ctx, ReorderList).findOne({
                    where: {
                        id: listId,
                        customerId: scope.customerId,
                        channelId: scope.channelId,
                    },
                    select: { id: true, lineCount: true },
                    loadEagerRelations: false,
                });
            } catch (err: unknown) {
                return this.rethrowSanitisedFailure(err, 'reconcileLineCount');
            }
            if (current === null) {
                // The row is gone, or has left this scope, so there is no stored value to report at all. The
                // total this request observed is then the only answer it has, and it is the one consistent
                // with the page it is about to return.
                return observedTotal;
            }
            const currentStored = Number(current.lineCount);
            if (!Number.isSafeInteger(currentStored) || currentStored < 0) {
                // THE ROW IS THERE AND ITS COUNTER IS NOT A COUNT. Reporting `observedTotal` here would be
                // the one thing this whole branch exists to avoid: answering with a number that is not the
                // stored column while the stored column still exists, and doing it silently. The value is
                // also not something this plugin can have produced — every write goes through a guarded
                // increment, a guarded decrement or this compare-and-set, and
                // `CHK_reorder_list_line_count_non_negative` refuses a negative on every engine that carries
                // it. It is reachable on MySQL and MariaDB, where TypeORM 0.3.x discards that constraint
                // (conflict C-E), after a direct write by something other than this plugin. So it is an
                // invariant failure about shared data rather than a value to be worked around: the request
                // fails with this module's own sanitised internal error, and the diagnostic reaches the log.
                // A repair is deliberately NOT attempted from it — this method's guard is the value it read
                // before the race, which is exactly the value that has been disproved.
                throw reportReorderListInternalFailure(
                    'A reorder list row within the owner scope carries a stored lineCount that is not a ' +
                        'non-negative safe integer, so no authoritative value could be reported for it',
                );
            }
            return currentStored;
        }
        return observedTotal;
    }

    /**
     * @description
     * Returns the per-requester provenance of a list, at a cost of zero statements.
     *
     * **The answer is derived from evidence, not asserted.** Under this feature `OWNED` with no granted
     * capability is the only reachable value — every list this service hands back has passed the ownership
     * predicate, and no share row can exist until list sharing ships — but "the only reachable value" is a
     * property of the code paths that lead here, and a member that simply returned the constant would be
     * correct only for as long as that stayed true, with nothing to notice if it stopped. So the value is
     * derived from three things the request already established: the scope the row was actually read under
     * (recorded against the row at that moment — see {@link RESOLVED_OWNER_SCOPES}), the row's own
     * `customerId` and `channelId`, and the request's own active channel and session.
     *
     * **It still issues no statement, which is the point of deriving it this way.** The comparison reads a map
     * entry and a handful of already-loaded values; nothing is queried. A per-entry access check that issued a
     * statement would make the request's statement count grow with the page size while every published bound
     * stayed satisfied, which is the shape this whole family of members exists to avoid.
     *
     * **A row it cannot vouch for is refused rather than described.** The published enum offers `OWNED` and
     * `SHARED`, and neither is an honest answer for a row whose provenance is missing or disagrees with the
     * request — `SHARED` would claim a grant that cannot exist, and `OWNED` would be the assertion this method
     * exists not to make. Reaching that branch means a list arrived here without passing the predicate, which is
     * a defect in this service rather than anything a caller did, so it is logged as one and answered with the
     * generic internal failure. No caller-reachable path produces it: the branch is a guard on an invariant, not
     * a case in the contract.
     *
     * Sharing will make the answer conditional in a later feature. It is deliberately not anticipated here: no
     * share table is read, no grant field is declared, and nothing about the shape of a grant is assumed.
     *
     * @param ctx - The request context whose active channel and authenticated session the recorded scope is
     * checked against, so that provenance from one request cannot describe another.
     * @param list - The list being described, and the object the recorded scope is keyed on.
     *
     * @since 3.8.0
     */
    getViewerAccess(ctx: RequestContext, list: ReorderList): ReorderListViewerAccess {
        // The derivation itself lives in one place, because the counter repair needs the identical check to
        // scope its write. See {@link ReorderListService.ownerScopeForRecordedRow}.
        this.ownerScopeForRecordedRow(ctx, list, 'viewerAccess');
        return { access: 'OWNED', grantedCapabilities: [] };
    }

    // Deterministic ordering. The identifier tie-break is APPENDED to a caller's sort, never substituted.

    /**
     * Builds the ordering the collection read hands to the builder as its `orderBy` extension, which is the
     * one channel through which keys can be *appended*: the builder merges `options.sort` first and the
     * extension second, so extension keys land last.
     *
     * A total order matters because a partial one makes every count assertion a coincidence. Two lists created
     * inside the same clock tick carry equal timestamps — which one seeded fixture or two inserts in a single
     * transaction produce routinely — and an order equal on every column it names leaves the engine free to
     * return those rows in either order on either request. Across two offset pages that means a row can be
     * returned twice or not at all. The row identifier is the only column that is always unique, so appending
     * it makes the order total.
     */
    private appendedListOrder(sort: ListQueryOptions<ReorderList>['sort']): AppendedReorderListOrder {
        if (!this.hasEffectiveSort(sort)) {
            // No caller sort: the whole declared default, newest first, tie-broken by identifier.
            return { createdAt: 'DESC', id: 'DESC' };
        }
        if (sort?.id != null) {
            // The caller already sorts by the identifier, so their order is total already. Appending here
            // would OVERWRITE their chosen direction rather than extend it, and overwriting is substitution —
            // which is the one thing this method exists not to do.
            return {};
        }
        return { id: 'DESC' };
    }

    /**
     * The line-collection counterpart of {@link ReorderListService.appendedListOrder}, ascending so that a
     * list's lines read in the order they were added, and tie-broken by identifier for the same reason.
     */
    private appendedLineOrder(sort: ListQueryOptions<ReorderListLine>['sort']): AppendedReorderListLineOrder {
        if (!this.hasEffectiveSort(sort)) {
            return { createdAt: 'ASC', id: 'ASC' };
        }
        if (sort?.id != null) {
            return {};
        }
        return { id: 'ASC' };
    }

    /**
     * Whether a caller's sort parameter actually orders anything.
     *
     * The generated sort input is nullable in every position, so a caller can legitimately send an object all
     * of whose directions are null — which orders nothing and must be treated as "no sort supplied", so that
     * the full default order applies rather than the tie-break alone.
     */
    private hasEffectiveSort(sort: { [key: string]: unknown } | null | undefined): boolean {
        return sort != null && Object.values(sort).some(direction => direction != null);
    }

    /**
     * Reduces a caller's sort parameter to the keys that actually order something, as a NEW object, and
     * answers `undefined` where nothing is left.
     *
     * **Both halves below follow from one property of the generated input: every position in it is nullable.
     * A null direction must therefore be removed both to keep the `ORDER BY` valid and to keep an appended
     * identifier tie-break in final position.**
     *
     * The first half is validity. A direction of `null` is not "no direction" to the platform's sort parser —
     * it copies every entry it is given straight into the ORM's order map, so a `null` direction becomes a
     * literal `ORDER BY <column> null` and the statement fails at the engine. A caller can send such an object
     * legitimately, most obviously a generated client that fills every field of the sort input, so it is
     * removed here rather than trusted to be absent.
     *
     * The second half is *position*, and it is the subtler one. The builder merges the two sorts with
     * `Object.assign`, which overwrites an existing key's value while leaving that key where it already was.
     * So a caller sort of `{ id: null, createdAt: 'ASC' }` merged with an appended `{ id: 'DESC' }` would order
     * by the identifier FIRST and the caller's own key second — the identifier promoted from tie-break to
     * primary sort, which is a substitution wearing the shape of an append. Dropping the null-directioned key
     * here removes it from the merge entirely, so the appended key lands last, which is what "appended" means.
     *
     * The caller's own object is never mutated: the sort travels on to the builder as a fresh object, so an
     * argument the api layer may reuse is left exactly as it arrived.
     */
    private effectiveSort<T extends VendureEntity>(
        sort: ListQueryOptions<T>['sort'],
    ): ListQueryOptions<T>['sort'] {
        if (sort == null) {
            return undefined;
        }
        const ordering = Object.entries(sort as Record<string, unknown>).filter(
            ([, direction]) => direction != null,
        );
        return ordering.length ? (Object.fromEntries(ordering) as ListQueryOptions<T>['sort']) : undefined;
    }

    // Writes over the list itself. A failed guard propagates, so an unauthenticated write is FORBIDDEN.

    /**
     * @description
     * Creates an empty named list for the authenticated customer in the active channel.
     *
     * **Ownership is derived, never nominated.** The stored row's customer comes from the authenticated
     * session and its channel from the request's active channel, and this operation exposes no argument that
     * could name a different owner — so "a caller cannot create a list for somebody else" is a structural
     * property rather than a validation rule.
     *
     * **The name is canonicalised in exactly one place.** The display value stored is the submitted string
     * with its whitespace canonicalised and nothing else altered — not escaped, not stripped, not
     * entity-encoded — so a name carrying markup-significant characters round-trips byte for byte. A name
     * whose canonical form cannot be stored is refused as malformed input by that same helper, which throws;
     * nothing is ever truncated.
     *
     * **The list bound is enforced by counting and inserting inside one transaction, under a row lock on the
     * owning customer where the engine supports one** — so a second concurrent creator waits and then counts
     * the first one's row, rather than both reading a count below the maximum and both inserting. **The lock
     * is taken by the transaction's first statement, which is also the one that resolves the owning
     * customer**, because a plain read issued before it would fix this transaction's consistent-read snapshot
     * on MariaDB and MySQL and the later count would then answer from a moment before the predecessor
     * committed — a lock that is genuinely held and a bound that is still exceeded. See
     * {@link ReorderListService.getLockedOwnerScope}.
     *
     * **Name uniqueness is decided in two layers, and the order of authority between them is fixed.** The
     * service performs an **advisory** scoped pre-check over `(customerId, channelId, nameKey)` **and** catches
     * the insert failure, which is what the contract requires of it. The pre-check is advisory in the strict
     * sense: it answers an ordinary duplicate before a row is written, and it decides nothing a concurrent
     * request could invalidate — two simultaneous creates may both read before either writes, so a pre-check
     * cannot be the authority. The authority is `UQ_reorder_list_customer_channel_name_key`, matched by that
     * one constraint name and no other, and its violation is what becomes `ReorderListNameConflictError`. Both
     * paths return the identical result carrying the identical `conflictingNameKey`, so a caller cannot tell
     * which layer answered — and neither can a test, which is why the race is proved at the database rather
     * than here. Comparison is case-insensitive and accent-preserving in both layers because both compare the
     * canonical `nameKey` the pipeline produced: a name differing from a stored one only by case, surrounding
     * whitespace or Unicode composition collides, while "Café" and "Cafe" do not. A list is created with a line
     * count of exactly zero.
     *
     * @param ctx - The request context, whose active channel and authenticated session become the row's scope.
     * @param input - The submitted name.
     * @throws A `ForbiddenError` when the request carries no authenticated session, and a `UserInputError`
     * when the submitted name cannot be stored. Neither is a member of the returned union: they are request
     * failures rather than business outcomes.
     *
     * @since 3.8.0
     */
    async createReorderList(
        ctx: RequestContext,
        input: CreateReorderListInput,
    ): Promise<CreateReorderListResult> {
        // The session guard is evaluated here, before any statement and before any transaction, so that an
        // unauthenticated write surfaces the propagated FORBIDDEN error without opening one. It costs no
        // database read: it is the third conjunct of the predicate and reads the session alone.
        this.requireActiveUser(ctx);
        // Canonicalisation and its four rejections live in one place, so no second code path can disagree
        // about what a stored name is. This throws for a name that cannot be stored, again before any
        // statement, so a refused name never takes a lock.
        const { name, nameKey } = canonicaliseReorderListName(input.name);

        try {
            return await this.connection.withTransaction(ctx, async transactionCtx => {
                // THE FIRST DATABASE STATEMENT OF THIS TRANSACTION, AND IT IS A LOCKING READ. Resolving the
                // owning customer and locking that row are one statement, so that no consistent read
                // precedes the lock and the bound count below is therefore the read that fixes this
                // transaction's snapshot — after the lock is held, and so after any competing creator has
                // committed. The name pre-check that follows it reads under that same snapshot. See
                // getLockedOwnerScope for why a plain lookup before the lock defeats the bound on MariaDB
                // and MySQL while leaving the lock itself looking perfectly correct.
                const scope = await this.getLockedOwnerScope(transactionCtx, 'createReorderList');
                const listRepository = this.connection.getRepository(transactionCtx, ReorderList);

                const heldLists = await listRepository.count({
                    where: { customerId: scope.customerId, channelId: scope.channelId },
                });
                if (heldLists >= this.maxListsPerCustomer) {
                    // At the maximum as well as over it: holding exactly the maximum means there is no room
                    // for one more. Nothing has been written at this point.
                    return new ReorderListLimitError(this.maxListsPerCustomer);
                }

                // THE ADVISORY HALF OF THE UNIQUENESS RULE. One scoped count over the canonical key, carrying
                // the same owner conjuncts as every other statement addressing a list, so it can only see rows
                // this caller owns in this channel. It answers an ordinary duplicate before a row is written —
                // which is what the contract asks the service to do — and it is deliberately NOT the
                // authority: two concurrent creates can both reach here before either inserts, so this read
                // cannot decide the race and does not claim to. The constraint below decides that, and both
                // layers produce the identical result from the identical canonical key, so nothing observable
                // depends on which one answered.
                const conflicting = await listRepository.count({
                    where: { customerId: scope.customerId, channelId: scope.channelId, nameKey },
                });
                if (conflicting > 0) {
                    // Nothing has been written at this point, so the transaction closes having changed
                    // nothing. It is RETURNED rather than raised because a duplicate name is a business
                    // outcome — a raised value here would reach the caller as a request failure instead of as
                    // this union member.
                    return new ReorderListNameConflictError(nameKey);
                }

                // Deliberately NOT wrapped in a try/catch of its own. See the catch below: a constraint
                // violation has to leave this callback for the transaction to be unwound before it is
                // translated.
                const created = await listRepository.save(
                    new ReorderList({
                        customerId: scope.customerId,
                        channelId: scope.channelId,
                        name,
                        nameKey,
                        // Exactly zero, and stated explicitly rather than left to the column default, because
                        // a freshly created list reporting a count of zero is part of the published contract.
                        lineCount: 0,
                    }),
                );
                // The saved row is returned directly rather than re-read, so this is the one write path where
                // the scope has to be recorded here instead of by a read. See {@link RESOLVED_OWNER_SCOPES}.
                return this.recordOwnerScope(created, scope);
            });
        } catch (err: unknown) {
            // WHERE A DUPLICATE NAME IS FINALLY DECIDED, AND THE TRANSLATION IS OUTSIDE THE TRANSACTION ON
            // PURPOSE.
            //
            // This is the race path, and it is the authority. The advisory count above answers the ordinary
            // duplicate, but it cannot answer a duplicate created between its own read and this insert — two
            // concurrent creates both pass it — so `UQ_reorder_list_customer_channel_name_key` is what makes
            // exactly one of them fail, and this catch is what turns that failure into the same result the
            // pre-check would have returned.
            //
            // The violation has to ESCAPE the callback rather than be caught inside it and turned into a
            // union member there, and that is a correctness requirement on PostgreSQL rather than a matter
            // of tidiness. The platform
            // runs this callback through a wrapper that COMMITs whatever the callback returns
            // (`packages/core/src/connection/transaction-wrapper.ts`), and because every mutation resolver
            // carries `@Transaction()`, that wrapper is nested: it opens a SAVEPOINT rather than a
            // transaction and its commit is therefore `RELEASE SAVEPOINT`. PostgreSQL puts a subtransaction
            // whose statement failed into an aborted state in which the only legal moves are `ROLLBACK TO
            // SAVEPOINT` and ending the transaction — so the `RELEASE` raises, and the buyer receives an
            // internal error in place of the conflict result the contract promises.
            //
            // Letting the violation escape hands the wrapper an error instead, so it issues `ROLLBACK TO
            // SAVEPOINT` (or `ROLLBACK` when this is the outermost transaction), leaving a usable
            // transaction and nothing written. Only then is the error inspected, and only the one named
            // constraint is translated; every other database failure is re-raised sanitised.
            return this.translateNameConflict(err, nameKey, 'createReorderList');
        }
    }

    /**
     * @description
     * Renames an existing list, and changes nothing else about it.
     *
     * **A caller who may not have this row is refused by one scoped read, before any statement that could
     * write.** The transaction's first statement resolves the addressed row under the full three-conjunct
     * predicate — the identifier together with the acting customer and the active channel — and a caller for
     * whom that matches nothing receives the normalised `ReorderListNotFoundError` having issued exactly one
     * scoped `SELECT` that returned no rows and **no `INSERT`, `UPDATE` or `DELETE` at all**. That is the
     * published evidence contract for a refused write, and it is a statement-shaped requirement rather than a
     * response-shaped one: a refusal reached by issuing the `UPDATE` first and asking afterwards produces the
     * identical payload while having issued DML on behalf of a caller who was not entitled to any.
     *
     * **Admission does not move the authority off the write.** The rename is still issued as a **single
     * conditional statement** carrying the same three conjuncts, and its affected-row count is still what says
     * whether it applied — because the row can be deleted, or leave this caller's scope, between the read that
     * admitted it and the write that changes it. The read decides who may ask; the write decides what happened.
     *
     * **Zero is one case short of meaning "no such row", and the shortfall is a driver property.** A
     * connection reporting *changed* rather than *matched* rows reports zero for a row the predicate matched
     * whose columns already held the values being written, so a rename to the name a list already carries can
     * arrive on the same path as an unknown identifier. The connection this repository opens is not one of
     * those — mysql2 negotiates `FOUND_ROWS` by default, so that case reports one — but a deployment can opt
     * out with `flags: '-FOUND_ROWS'`, and a driver reporting no affected count at all lands here always. One
     * scoped current read on that path tells the two apart: a list already carrying the requested name is
     * reported as the success it is, making the operation idempotent under every driver, and everything else is
     * reported as `ReorderListNotFoundError` — the same normalised outcome an unknown, foreign or other-channel
     * identifier produces. See {@link ReorderListService.classifyListRenameMiss}.
     *
     * **No line row is read and none is written.** A rename touches the two name columns and the inherited
     * update timestamp, so a list's line count and every one of its lines are returned unchanged.
     *
     * The new name is subject to the identical canonicalisation and the identical uniqueness rule that governs
     * creation, so this operation can return `ReorderListNameConflictError` — and a blank new name is refused
     * as malformed input rather than stored.
     *
     * **The uniqueness re-check runs in two layers here exactly as it does on the create path, and its
     * position in the sequence is what keeps it from disclosing anything.** The advisory scoped count over
     * `(customerId, channelId, nameKey)` is a question about *other* rows, so asking it before the addressed
     * row has been admitted would invert the order the two results have to be decided in: a caller renaming a
     * list they do not own — or one that does not exist — to a name they *do* already hold would be told the
     * name conflicts, which both confirms that the identifier they guessed was worth asking about and replaces
     * the one normalised `ReorderListNotFoundError` every inaccessible case is supposed to produce. It
     * therefore runs **after** admission and **excludes the addressed row itself**, so a rename that only
     * changes a list's display casing is not reported as colliding with itself. The final authority remains
     * `UQ_reorder_list_customer_channel_name_key`, caught outside the transaction callback, which is what
     * decides a name created concurrently between this pre-check and the write.
     *
     * @param ctx - The request context.
     * @param input - The list identifier and the new name.
     * @throws A `ForbiddenError` when the request carries no authenticated session, and a `UserInputError`
     * when the new name cannot be stored.
     *
     * @since 3.8.0
     */
    async updateReorderList(
        ctx: RequestContext,
        input: UpdateReorderListInput,
    ): Promise<UpdateReorderListResult> {
        const scope = await this.getOwnerScope(ctx, 'updateReorderList');
        const { name, nameKey } = canonicaliseReorderListName(input.name);

        try {
            return await this.connection.withTransaction(ctx, async transactionCtx => {
                // THE FIRST STATEMENT OF THIS TRANSACTION, AND IT IS A READ. One scoped `SELECT` carrying the
                // identifier together with the acting customer and the active channel, so a caller who may not
                // have this row is refused here — one statement, zero rows, and no DML issued on their behalf.
                // It is a locking read where the engine supports one, which both keeps this transaction's
                // parent-before-child lock order identical to every other write in this service and makes the
                // pre-check below and the write that follows it decide against the same row state.
                const admitted = await this.findOwnedListForUpdate(transactionCtx, input.id, scope);
                if (!admitted) {
                    // Indistinguishable for an unknown identifier, another customer's list and another
                    // channel's list. Nothing has been read but this row's absence, and nothing written.
                    return new ReorderListNotFoundError();
                }

                // The advisory half of the uniqueness rule, positioned AFTER admission so that a caller who
                // may not have this row can never be told about a name they hold. The addressed row is
                // excluded, so renaming a list to a value differing from its own only in display casing —
                // which leaves the canonical key identical — is not reported as colliding with itself.
                const conflicting = await this.connection.getRepository(transactionCtx, ReorderList).count({
                    where: {
                        customerId: scope.customerId,
                        channelId: scope.channelId,
                        nameKey,
                        id: Not(admitted.id),
                    },
                });
                if (conflicting > 0) {
                    // The same result the named constraint produces, carrying the same canonical key, so the
                    // two layers are indistinguishable to a caller. Nothing has been written.
                    return new ReorderListNameConflictError(nameKey);
                }

                const result = await this.connection
                    .getRepository(transactionCtx, ReorderList)
                    .createQueryBuilder('reorderlist')
                    .update()
                    .set({ name, nameKey })
                    .where('id = :id', { id: input.id })
                    .andWhere('customerId = :customerId', { customerId: scope.customerId })
                    .andWhere('channelId = :channelId', { channelId: scope.channelId })
                    .execute();

                if (result.affected !== 1) {
                    // NOT immediately a not-found: an affected count of zero does not distinguish "no such
                    // row for this caller" from "the row already held exactly this name", and on a driver
                    // reporting CHANGED rows rather than MATCHED rows the second case is the one that
                    // arrives here. See {@link ReorderListService.classifyListRenameMiss}.
                    return await this.classifyListRenameMiss(transactionCtx, input.id, scope, name, nameKey);
                }
                return await this.reloadOwnedList(transactionCtx, input.id, scope);
            });
        } catch (err: unknown) {
            // Same rollback-first translation as the create path, for the same PostgreSQL-savepoint reason.
            // It is reached only when the write above was refused by the named constraint, which the advisory
            // count cannot pre-empt: a competing request may have taken the name between that read and this
            // write. And it is reachable only for a row this caller owns, because a row they do not own is
            // refused by the admission read before either statement is issued.
            return this.translateNameConflict(err, nameKey, 'updateReorderList');
        }
    }

    /**
     * @description
     * Deletes a list together with its lines.
     *
     * **A caller who may not have this row is refused before any statement that could write.** The
     * transaction's first statement resolves the addressed row under the full three-conjunct predicate, so a
     * refused delete issues exactly one scoped `SELECT` returning no rows and **no `DELETE` at all** — the
     * published evidence contract for a refused write, which a delete issued first and asked about afterwards
     * would fail while returning the identical payload. A **repeat delete** is refused on that same read,
     * because the row it addressed is already gone.
     *
     * The delete itself remains a **single conditional statement** whose predicate names the row identifier
     * together with the acting customer and the active channel, with the affected-row count as the authority.
     * One means the list was deleted; zero means the row left this caller's scope between the read that
     * admitted it and this statement, and is reported as the same normalised not-found.
     *
     * **The lines go with it through the declared cascade on the line table's parent reference, in the same
     * statement.** Nothing here loops over lines, and nothing deletes them individually: the delete is issued
     * against the parent row and the engine removes the children, so no line row is ever observable without
     * its parent.
     *
     * The success payload is the platform's own `DeletionResponse`, reused verbatim rather than replaced by a
     * plugin-owned deletion type. Its `message` field is nullable and is deliberately omitted — a successful
     * deletion has nothing to add to the result it already reports. The type name is set explicitly so that
     * the union this value belongs to is discriminated on the same field as its error member.
     *
     * @param ctx - The request context.
     * @param id - The identifier of the list to delete.
     * @throws A `ForbiddenError` when the request carries no authenticated session.
     *
     * @since 3.8.0
     */
    async deleteReorderList(ctx: RequestContext, id: ID): Promise<DeleteReorderListResult> {
        const scope = await this.getOwnerScope(ctx, 'deleteReorderList');

        try {
            return await this.connection.withTransaction(ctx, async transactionCtx => {
                // The scoped admission read, and the transaction's first statement. It carries the same three
                // conjuncts as the delete below, takes the parent row's write lock where the engine has one —
                // the same parent-before-child order every write in this service uses — and refuses a caller
                // who may not have this row with one statement, zero rows and nothing written.
                const admitted = await this.findOwnedListForUpdate(transactionCtx, id, scope);
                if (!admitted) {
                    return new ReorderListNotFoundError();
                }

                const result = await this.connection
                    .getRepository(transactionCtx, ReorderList)
                    .createQueryBuilder('reorderlist')
                    .delete()
                    .where('id = :id', { id })
                    .andWhere('customerId = :customerId', { customerId: scope.customerId })
                    .andWhere('channelId = :channelId', { channelId: scope.channelId })
                    .execute();

                if (result.affected !== 1) {
                    // The row was admitted and is now gone: a concurrent request deleted it, or it left this
                    // caller's scope, between the two statements. Reported as the same normalised not-found.
                    return new ReorderListNotFoundError();
                }
                // No counter maintenance is needed or possible: the counter lived on the row that has just
                // been removed, and the lines went with it through the cascade.
                return { __typename: 'DeletionResponse', result: DeletionResult.DELETED };
            });
        } catch (err: unknown) {
            // No constraint on this path is a buyer outcome — a delete cannot collide with a unique index —
            // so every failure here is unclassified and is reported without driver detail.
            return this.rethrowSanitisedFailure(err, 'deleteReorderList');
        }
    }

    /**
     * @description
     * Adds a variant to a list at an integer quantity, or accumulates onto the line that variant already has.
     *
     * **The order of the three steps is fixed, and it is what makes the duplicate-at-capacity case
     * deterministic:**
     *
     * 1. the existing line for this list-and-variant pair is resolved;
     * 2. the **resulting** quantity is validated — not the increment;
     * 3. only then is the line bound consulted, and only when a new line will actually be inserted.
     *
     * The consequence to preserve is that adding a variant **already on** a list that is at its line maximum
     * *succeeds* by accumulating: it creates no line, so it breaches no line-count bound. Consulting the bound
     * first would refuse a write that adds nothing to the collection the bound protects.
     *
     * **Accumulation is one atomic statement and never a read followed by a save.** The quantity is
     * incremented in the database, addressed by the line's own identifier, and the affected-row count is read.
     * The shipped saved-list precedent reads, computes and saves, which is safe for a boolean membership set
     * and unsafe for a counter: two concurrent two-unit adds would both read six, both compute twelve and both
     * store twelve, so the buyer asked for eighteen and holds twelve. The stored line count does not change on
     * this path, because no line was added.
     *
     * **On the insert path the counter claim is the first write of the transaction**, and the line is inserted
     * only if that claim succeeded — so a single statement decides whether there is room and no interleaving
     * admits an extra line.
     *
     * **No availability is read.** A saved list records intent rather than availability: no stock level is
     * consulted, nothing is allocated and nothing is reserved, so a variant whose saleable quantity is below
     * the requested one is added exactly as any other is. The variant is resolved for existence in the active
     * channel and for nothing else.
     *
     * **There is no idempotency key, and the delivery guarantee is stated rather than implied.** An atomic
     * increment makes concurrent adds correct, but it cannot distinguish a client that retried a timed-out
     * request from a buyer who genuinely pressed add twice — and a replay guarantee needs a durable
     * claim-and-response record, which this plugin owns no row for. Delivery is therefore **at-least-once**:
     * two deliveries of one add accumulate, and {@link ReorderListService.adjustReorderListLine} is the
     * deterministic remedy because it sets an absolute quantity rather than adding to one.
     *
     * @param ctx - The request context.
     * @param input - The list, the variant, and the quantity to add.
     * @throws A `ForbiddenError` when the request carries no authenticated session, and a `UserInputError`
     * when the variant cannot be resolved in the active channel or the resulting quantity is out of bounds.
     *
     * @since 3.8.0
     */
    async addItemToReorderList(
        ctx: RequestContext,
        input: AddItemToReorderListInput,
    ): Promise<AddItemToReorderListResult> {
        const scope = await this.getOwnerScope(ctx, 'addItemToReorderList');

        // Bounded retries, and each retry is a WHOLE FRESH TRANSACTION rather than a second attempt inside a
        // failed one. Three states require one. Two are a concurrent request having created the very line this
        // call was about to create — the line-level uniqueness constraint refusing the insert, and the capacity
        // claim discovering the duplicate before it inserts — and in both the contract's answer is an
        // accumulation onto the winner's row rather than an error, so the loser redoes the operation with the
        // row now visible. The third is its mirror: a concurrent request REMOVED the line this attempt had
        // resolved, so the operation must be redone as an insert — which this attempt cannot do, because it
        // already holds a lock on a LINE row and the insert path's first parent statement would then be a
        // parent lock taken while a child one is held. A fresh attempt holds neither.
        //
        // THE FRESHNESS IS THE RESOLVER'S DOING, NOT THIS LOOP'S, and it is a property this loop cannot
        // establish for itself. `withTransaction` INHERITS an already-open transaction from the context, and
        // TypeORM opens a nested one as a savepoint (`SAVEPOINT typeorm_N` once `transactionDepth` is above
        // zero; every driver family here declares `transactionSupport = 'nested'`). Rolling back to a savepoint
        // is NOT equivalent to rolling back a transaction: on InnoDB the row locks taken after the savepoint are
        // retained, and the enclosing transaction's REPEATABLE READ snapshot outlives it — so a savepoint retry
        // would inherit both the locks it needed released and the stale view of the row it is retrying because
        // of. `addItemToReorderList`'s resolver therefore declares `@Transaction('manual')`, under which nothing
        // is open when this loop starts and each `withTransaction` below opens a real transaction at depth zero.
        // Every attempt consequently begins holding nothing and seeing the latest committed state, which is what
        // makes the plain reads inside each attempt correct and what keeps each attempt's locking as narrow as
        // it is.
        for (let attempt = 0; ; attempt++) {
            try {
                return await this.connection.withTransaction(ctx, transactionCtx =>
                    this.addItemWithinTransaction(transactionCtx, input, scope),
                );
            } catch (err: unknown) {
                const reconcilable =
                    err instanceof ConcurrentLineInsertDetected ||
                    err instanceof ConcurrentLineRemovalDetected ||
                    this.violatesConstraint(err, LINE_DEDUPLICATION_CONSTRAINT_DESCRIPTOR);
                if (reconcilable && attempt + 1 < MAX_ADD_RECONCILIATION_ATTEMPTS) {
                    // The transaction has already been rolled back by the platform's wrapper before this line
                    // runs, which is what makes a fresh attempt possible at all: the capacity claim this attempt
                    // may have taken is undone with it, every lock it held is released, and the next attempt
                    // takes its own snapshot. Translating or retrying INSIDE the callback could do none of the
                    // three.
                    continue;
                }
                return this.rethrowSanitisedFailure(err, 'addItemToReorderList');
            }
        }
    }

    /**
     * One attempt at {@link ReorderListService.addItemToReorderList}, inside one transaction.
     *
     * The three mandated steps run in their fixed order — resolve the existing line, validate the RESULTING
     * quantity, and only then consult the line bound — and each of the three concurrent states the capacity
     * claim can report is resolved explicitly rather than collapsed into whichever outcome is nearest.
     *
     * **The lock order is satisfied per branch, and which lock each branch takes follows from what it writes.**
     * FEATURE-001-01 §5's lock-ordering item fixes one rule for the whole plugin — a transaction touching both
     * the parent row and a child row takes the parent first — and the two branches here touch different rows:
     *
     *   - an ACCUMULATION writes one line's quantity and NO column of `reorder_list`, but it still LOCKS the
     *     parent, and the distinction between writing and locking is the whole of the point. Its increment
     *     carries the ownership predicate as a correlated `EXISTS` over the parent table, and on the MySQL
     *     family a sub-query evaluated by a DML statement is a CURRENT read — so that one statement takes the
     *     child exclusively and then the parent in share mode, child first. The branch therefore takes the
     *     shared parent lock itself, first, which puts it on the same side of the rule as every other line
     *     write. SHARED because no parent column is written: two concurrent accumulations of one list both hold
     *     it and neither waits, so they still contend on the atomic increment rather than on the lock, and the
     *     lock is never upgraded. The correlated predicate remains in the statement as well, and is what scopes
     *     the write on an engine where no lock was available.
     *   - an INSERT writes the parent's counter and then the child, so its conditional capacity claim is its
     *     first parent statement and no separate lock is taken. Two concurrent inserters contend on that one
     *     statement, and the loser's own insert then meets the per-variant unique object.
     *
     * The branch is decided by a NON-LOCKING read of the line, which joins no wait-for graph and so cannot
     * invert anything by preceding a lock. It is correct on every engine because each attempt runs in its own
     * fresh transaction and therefore its own snapshot — see the retry loop in
     * {@link ReorderListService.addItemToReorderList} for why the resolver, and not this method, owns that.
     * The variant is resolved before either branch takes or writes anything on the parent, which is the same
     * ticket item's other sentence: "no transaction holds the parent row across a call it does not control".
     *
     * **The one crossing between the branches goes through a fresh transaction, not through a fall-through.**
     * Where the increment matches nothing because a concurrent request removed the line, the insert path is what
     * this call needs — but by then this attempt holds a lock on a LINE row (the increment's own, and the
     * current read that established the state), and the insert path's capacity claim would take the parent while
     * that is held. That is the one ordering the rule forbids, so the attempt is abandoned instead and the
     * bounded retry reaches the insert branch in a transaction holding nothing.
     */
    private async addItemWithinTransaction(
        ctx: RequestContext,
        input: AddItemToReorderListInput,
        scope: ReorderListOwnerScope,
    ): Promise<AddItemToReorderListResult> {
        const list = await this.findOwnedList(ctx, input.reorderListId, scope);
        if (!list) {
            // Indistinguishable for an unknown identifier, another customer's list and another channel's
            // list, and nothing has been written.
            return new ReorderListNotFoundError();
        }

        // Existence in the active channel, and nothing else. This is the only collaborator call this
        // operation makes: no saleable-stock read, no display-stock read and no available-stock read.
        //
        // The empty relation list is load-bearing rather than decorative. Omitting the argument does not
        // mean "no relations": the collaborator substitutes a default set of three — the product, the
        // variant's featured asset and the product's featured asset — so a request whose only question is
        // "does this variant resolve in this channel?" would load a catalogue object graph while a write
        // transaction holds its connection. Passing the empty list declines all three.
        //
        // What remains is not free, and is stated rather than implied: the collaborator always joins the
        // variant's tax category, the variant's own prices and translations are declared eager on the core
        // entity, and it applies channel price and tax to the row before returning it. That residual cost
        // is the price of asking the platform rather than reading the table directly, which is the trade
        // the architecture requires — a channel-scoped existence check with a narrower cost is not part of
        // the collaborator's published surface.
        const variant = await this.productVariantService.findOne(ctx, input.productVariantId, []);
        if (!variant) {
            throw withoutStackFrames(
                new UserInputError(VARIANT_NOT_FOUND_KEY, {
                    [ID_VARIABLE]: String(input.productVariantId),
                }),
            );
        }

        // Step one: resolve the existing line, scoped to this list so a line of another list cannot be
        // reached even by a variant they share.
        //
        // THIS READ TAKES NO LOCK, WHICH IS WHY IT MAY PRECEDE ONE. Which branch the add takes is decided
        // before anything is locked: an accumulation goes on to take the parent in share mode and then write the
        // child, and an insert's first parent statement is its conditional capacity claim, which takes the row
        // exclusively. A non-locking read joins no wait-for graph, so deciding the branch first cannot invert
        // the ordering rule — and it is what makes the two orderings expressible at all. It also has to stay
        // non-locking for the insert branch's sake: a share lock taken here would be upgraded by that branch's
        // claim, and two concurrent inserts each holding one would deadlock on the upgrade.
        //
        // A PLAIN READ IS ALSO ENOUGH ON EVERY ENGINE, and that is a consequence of the transaction boundary
        // rather than of this statement. Each attempt runs in a transaction of its own, so its snapshot is taken
        // here and reflects everything committed before it; there is no earlier attempt whose view this one could
        // inherit. A LOCKING read here would be needed only if a retry ran as a savepoint inside the resolver's
        // transaction, keeping its original REPEATABLE READ snapshot — and it would then be the defect, putting
        // a lock on a LINE row ahead of the insert branch's parent statement and inverting the one ordering the
        // plugin fixes.
        //
        // ONE exclusive parent lock here for both branches is the other rejected shape. It orders the locks
        // correctly and costs far too much for it: every add to a list would serialise behind every other,
        // including adds of unrelated variants and accumulations onto an existing line, and the serialisation
        // would hide the very defects the atomic statements below exist to prevent — a read-compute-save
        // increment and a count-then-insert capacity check both pass a race whose contention window a preceding
        // lock has closed.
        const existingLine = await this.findLineForVariant(ctx, list.id, input.productVariantId, false);

        // Step two: validate, and BOTH checks are needed rather than one being a superset of the other.
        // The increment must itself be a positive integer, or a caller could subtract by adding — and an
        // increment of zero onto a line already holding six would leave a resulting quantity that passes.
        // The resulting quantity must then be within the maximum, because the bound applies to what the
        // line would hold and not to what was asked for: an add of six onto a line already holding six is
        // refused at a maximum of ten even though the increment alone is legal.
        this.validateQuantity(input.quantity);

        // THE STORED BASE IS CLASSIFIED BEFORE ANY TOTAL IS COMPUTED FROM IT, and the order is the whole
        // point. The resulting-quantity check below is arithmetic over `existingLine.quantity`, so a base the
        // column may not hold poisons its verdict: a stored `-5` plus a perfectly legal increment of `2` is
        // `-3`, which that check refuses as a malformed request and reports to the buyer as
        // `UserInputError`. The buyer did not write that row and can do nothing about it, and the report
        // names the one party that is not at fault while the actual data defect goes unlogged — visible to
        // nobody, because a user input error is the least investigated outcome this service produces.
        // Classifying here catches EVERY non-positive base, where the statement-level floor further down
        // only catches the ones whose sum happens to come out positive.
        //
        // This does not make that floor or its `'line-invalid'` classification redundant. This is a read, so
        // the row can still be corrupted between here and the statement; the floor is what refuses to write
        // in that window, and its classifier is what reports it. Two guards, one race apart.
        if (existingLine && existingLine.quantity <= 0) {
            throw reportReorderListInternalFailure(
                `Declined to accumulate onto reorder list line ${String(existingLine.id)} because its ` +
                    'stored quantity is not positive',
            );
        }

        this.validateQuantity((existingLine?.quantity ?? 0) + input.quantity);

        if (existingLine) {
            // THE PARENT FIRST, IN SHARE MODE, BECAUSE THIS BRANCH DOES TOUCH THE PARENT ROW — inside its own
            // child statement, which is what makes the dependency easy to miss.
            //
            // The increment below carries its ownership predicate as a correlated `EXISTS` over `reorder_list`,
            // because a line row stores neither a customer nor a channel and the affected-row count has to be
            // the authority. On the MySQL family a sub-query evaluated by a DML statement is a CURRENT read, so
            // that `EXISTS` takes a shared lock on the parent row — and it takes it AFTER the engine has taken
            // the child row exclusively to update it. The acquisition order of the statement is therefore child
            // then parent, whatever its author intended, and `removeReorderListLine` and `deleteReorderList`
            // take the same two rows parent then child. That is an inversion, and an inversion is what a
            // deadlock is: the engine resolves it by killing one of the two, which a buyer sees as an operation
            // that failed for no reason they can act on. Reasoning that this branch "writes only the child, so
            // the ordering rule does not reach it" is true of what it WRITES and false of what it LOCKS, and the
            // rule is about locks.
            //
            // SHARED rather than exclusive, because this transaction writes no column of `reorder_list`: an
            // accumulation changes one line's quantity and leaves `lineCount` untouched. Two concurrent
            // accumulations of the same list both hold it in share mode and neither waits for the other, so the
            // ordering costs nothing between them and the atomic increment remains the statement a concurrent
            // pair actually contends on — which is what keeps a read-compute-save implementation of it failing
            // the concurrent-add evidence rather than being shielded from it. Nothing on this branch ever asks
            // for the parent exclusively, so the share lock is never upgraded and cannot cycle with a second
            // accumulation either.
            //
            // ONLY WHERE AN ENGINE CAN ORDER TWO TRANSACTIONS AT ALL. The in-process SQLite engine serves a
            // single connection, so there is no interleaving to order, its correlated read takes no lock, and
            // asking that driver for one raises rather than degrades. Skipping the statement there also leaves
            // this path's counted statements unchanged on the one engine those counts are asserted on.
            if (this.supportsPessimisticLocking) {
                const admitted = await this.findOwnedListForShare(ctx, list.id, scope);
                if (!admitted) {
                    // The list left the caller's scope between the admission read and this lock. Refused with
                    // the same indistinguishable answer, and with nothing written — the increment is not
                    // attempted at all, so there is no affected count to classify.
                    return new ReorderListNotFoundError();
                }
            }
            const accumulation = await this.accumulateLineQuantity(
                ctx,
                existingLine.id,
                list.id,
                input.productVariantId,
                input.quantity,
                scope,
            );
            if (accumulation === 'accumulated') {
                // The line's identifier is unchanged, no second row was created, and the list's stored line
                // count is untouched because no line was added.
                return this.reloadOwnedList(ctx, list.id, scope);
            }
            if (accumulation === 'above-maximum') {
                // A concurrent add raised the stored quantity between this attempt's read and its increment,
                // so the total this attempt would leave behind breaches the configured maximum. That is the
                // same malformed-request outcome an over-maximum add reaches directly, and it is thrown for
                // the same reason: a quantity that cannot be stored is not a business outcome.
                throw withoutStackFrames(
                    new UserInputError(QUANTITY_ABOVE_MAXIMUM_KEY, {
                        [MAX_VARIABLE]: this.maxQuantityPerLine,
                    }),
                );
            }
            if (accumulation === 'line-invalid') {
                // The addressed line is present and owned, but its stored quantity is not positive — a state
                // `CHK_reorder_list_line_quantity_positive` would make unrepresentable, and which TypeORM does
                // not create on MySQL or MariaDB (conflict C-E). Something outside this service put it there,
                // so there is nothing the caller could have sent differently and nothing to normalise into a
                // domain outcome: `UserInputError` would blame the request for data it did not write, and
                // not-found would deny a row that is demonstrably present. It is reported as what it is, an
                // internal data defect, which is also the only answer that leaves the row untouched — the
                // increment already declined to compound it, and this path adds no repair of its own because
                // guessing the intended quantity is not something this service can do correctly.
                throw reportReorderListInternalFailure(
                    `Declined to accumulate onto reorder list line ${String(existingLine.id)} because its ` +
                        'stored quantity is not positive',
                );
            }
            if (accumulation === 'list-gone') {
                // The addressed line is still there, within the maximum and above the floor, so the only
                // conjunct left to have refused the increment is the ownership one: the list was deleted or
                // moved out of the caller's scope between this attempt resolving it and the increment.
                // Normalised to the same not-found every inaccessible case produces.
                return new ReorderListNotFoundError();
            }
            if (accumulation === 'line-replaced') {
                // A concurrent request removed the line this attempt had resolved and inserted a fresh one for
                // the same variant. That is the same state a losing insert reaches — a row for this variant now
                // exists and was not put there by this attempt — so it takes the same route: abandon this
                // attempt so the platform unwinds it, and retry with the replacement visible, which accumulates
                // onto it. Inserting instead would be refused by the per-variant constraint, and reporting it
                // would refuse a write the contract requires to succeed.
                throw new ConcurrentLineInsertDetected();
            }
            // 'line-gone': a concurrent request removed the line between the read and the increment. The list
            // itself still resolved under the predicate at the top of this attempt, so the truthful answer is
            // not "the list is gone" — it is that this variant is no longer on the list, which is precisely the
            // state the insert path below exists for.
            //
            // This attempt does NOT fall through to it, and the ordering rule is why. By
            // now it holds a lock on a LINE row — the increment examined one, and the current read that
            // established this state holds either the replacement's row or the gap the removed row left — while
            // the insert path's capacity claim would take the PARENT. A transaction holding a child and then
            // asking for the parent is the one ordering the plugin's rule forbids, and it is the half of a cycle
            // whose other half is any concurrent removal or deletion: those hold the parent and wait for a child.
            // Abandoning the attempt lets the platform unwind it, releasing every lock it took, and the caller's
            // bounded retry opens a fresh transaction which sees no line, holds nothing, and reaches the insert
            // branch with the capacity claim as its first parent statement.
            throw new ConcurrentLineRemovalDetected();
        }

        // Step three, and only now: claim room for a new line.
        //
        // THIS IS THE INSERT BRANCH'S FIRST PARENT STATEMENT AS WELL AS ITS FIRST WRITE, and taking no separate
        // pre-lock is what keeps the ordering rule satisfied without closing the window the race is about. The
        // claim is a conditional `UPDATE` of the parent row, so the engine takes that row exclusively to
        // evaluate it: the parent is written before the child is inserted, which is the rule, and two
        // concurrent inserters contend on this single statement rather than on a lock taken before either had
        // decided anything. A refusal leaves nothing to undo, because nothing has been written yet.
        const capacity = await this.claimLineCapacity(ctx, list.id, input.productVariantId, scope);
        switch (capacity) {
            case 'claimed':
                break;
            case 'list-gone':
                // The list was deleted (or moved out of scope) after this attempt resolved it. Reported as
                // the same normalised not-found every inaccessible case produces, rather than as a limit
                // breach it has nothing to do with.
                return new ReorderListNotFoundError();
            case 'duplicate-line':
                // A concurrent add created the line for this very variant. The contract's answer is an
                // accumulation onto it, so this attempt is abandoned and retried with the row visible.
                throw new ConcurrentLineInsertDetected();
            case 'counter-invalid':
                // The list is present and owned, holds no line for this variant, and its stored counter is
                // negative — a state `CHK_reorder_list_line_count_non_negative` would make unrepresentable,
                // and which TypeORM does not create on MySQL or MariaDB (conflict C-E). The claim declined to
                // build on it, and this attempt declines to guess past it: the insert below is not reached, so
                // no line is created against a capacity that was never established. It is reported as an
                // internal data defect rather than as `ReorderListLimitError`, because a limit error would
                // state a maximum this list has not been shown to have reached and would hide the defect
                // behind an outcome an operator would read as ordinary.
                throw reportReorderListInternalFailure(
                    `Declined to claim line capacity on reorder list ${String(list.id)} because its stored ` +
                        'line count is negative',
                );
            case 'full':
                return new ReorderListLimitError(this.maxLinesPerList);
        }

        // A duplicate line for this list-and-variant pair can only arrive here when two concurrent adds both
        // found no existing line and both inserted. The loser's statement violates
        // `UQ_reorder_list_line_list_variant`, and that violation is deliberately NOT caught here: it leaves
        // this callback so the platform's wrapper unwinds the transaction — releasing the capacity claim above
        // with it — after which the caller's bounded retry recognises that one named constraint, resolves the
        // winner's row and accumulates onto it. Catching it here instead would leave an aborted subtransaction
        // on PostgreSQL, and absorbing it with an ignore form would also absorb the failures that are not
        // duplicates. It is never translated into a name conflict: the two constraints are separate, are named
        // separately and carry different columns.
        await this.insertLine(ctx, list.id, input.productVariantId, input.quantity);
        return this.reloadOwnedList(ctx, list.id, scope);
    }

    /**
     * @description
     * Sets the quantity on an existing line to an absolute value.
     *
     * **The value is set rather than added, and that is what makes this operation idempotent by
     * construction** — repeating the call any number of times leaves the same stored quantity. It is therefore
     * the deterministic remedy for the at-least-once delivery of
     * {@link ReorderListService.addItemToReorderList}: a client that cannot tell whether its add committed
     * reads the list back and sets the quantity it intends.
     *
     * **It deliberately does not consult the line bound and does not change the stored line count**, because
     * changing a quantity on a line that already exists adds no line and therefore cannot breach a line-count
     * bound. Measuring it against that bound would refuse a write that adds nothing.
     *
     * The quantity is validated **before any write is issued**, so a refused adjustment leaves the line at
     * exactly its prior value. It is not validated before any *statement*: the owner scope is resolved first,
     * by one `Customer` read, because who is asking has to be established before what they asked for is
     * judged — a caller with no session must be refused as forbidden rather than told their quantity was
     * malformed. That read touches neither plugin table and writes nothing. A quantity of zero is refused
     * rather than treated as a removal — removing the line is what expresses "none of this", and there is a
     * published operation for it.
     *
     * **A caller who may not have the addressed list is refused by one scoped read, before any statement that
     * could write.** The transaction's first statement against either plugin table resolves the parent list
     * under the full three-conjunct predicate, and a caller for whom that matches nothing receives the
     * normalised `ReorderListNotFoundError` having issued exactly one scoped `SELECT` that returned no rows and
     * **no `UPDATE` at all**. That is the published evidence contract for a refused write, and it is a
     * statement-shaped requirement rather than a response-shaped one: classifying a zero affected count after
     * the fact returns the identical payload while having issued DML for a caller entitled to none. It is also
     * what keeps the two not-found results honest — a caller who cannot reach the list learns nothing about
     * which of its lines exist.
     *
     * **Admission does not move the ownership predicate off the statement that writes.** The update's `WHERE`
     * still names the line, its parent list, and — through a correlated `EXISTS` over `reorder_list` — the
     * acting customer and the active channel, so the write remains a single conditional statement whose
     * affected-row count is the authority on what happened. That matters precisely because the two statements
     * are separate: the list can be deleted, or change hands, between the read that admitted it and the write,
     * and a write holding only identifiers would apply anyway.
     *
     * **A zero affected-row count on an admitted path is labelled rather than decided.** It means the line was
     * not changed, and minimal scoped reads then say which reason to report: a list that has since become
     * inaccessible gives `ReorderListNotFoundError`, and an accessible list with no such line gives
     * `ReorderListLineNotFoundError`. Those reads cannot admit a write, because the write has already been
     * refused.
     *
     * **One of the cases zero covers is a line that already holds the requested quantity, and it is reported
     * as a success.** A connection reporting *changed* rather than *matched* rows reports zero for a matched
     * row it wrote nothing to. That is not the default connection here, mysql2 negotiating `FOUND_ROWS`, but it
     * is what a deployment opting out with `flags: '-FOUND_ROWS'` gets and what any driver reporting no
     * affected count at all gets — and on those the idempotence this operation is published for would otherwise
     * fail on precisely its intended use, a client resolving an unconfirmed add by setting the value already
     * stored. See {@link ReorderListService.classifyLineQuantityMiss}.
     *
     * @param ctx - The request context.
     * @param input - The list, the line, and the absolute quantity to set.
     * @throws A `ForbiddenError` when the request carries no authenticated session, and a `UserInputError`
     * when the quantity is out of bounds.
     *
     * @since 3.8.0
     */
    async adjustReorderListLine(
        ctx: RequestContext,
        input: AdjustReorderListLineInput,
    ): Promise<AdjustReorderListLineResult> {
        const scope = await this.getOwnerScope(ctx, 'adjustReorderListLine');
        // Before any write, so a refused adjustment cannot have touched the line. The one statement that
        // precedes it is the owner-scope read above, which touches neither plugin table: who is asking has
        // to be established before what they asked for is judged.
        this.validateQuantity(input.quantity);

        try {
            return await this.connection.withTransaction(ctx, async transactionCtx => {
                // THE SCOPED ADMISSION READ, AND THE FIRST STATEMENT THIS TRANSACTION ISSUES AGAINST EITHER
                // PLUGIN TABLE. One `SELECT` over `reorder_list` whose `WHERE` carries the addressed list's
                // identifier together with the acting customer and the active channel, so a caller who may not
                // have this list is refused here: one statement, zero rows, and no `UPDATE` issued on their
                // behalf. Asking afterwards instead — reading the affected count and classifying it — returns
                // the identical payload while having issued DML for a caller entitled to none, which is the
                // one thing the published evidence contract for a refused write forbids outright.
                //
                // It is a SHARED locking read where the engine has one, and the strength is the whole of the
                // difference from the rename and delete paths. This transaction writes a child row and never
                // the parent, so it needs the parent held only until the child write lands — which share mode
                // gives it while leaving two concurrent adjustments of the same list free to proceed together.
                // What it buys is the lock ORDER: every transaction in this service that touches both rows now
                // takes the parent first, so an adjust can no longer hold the child while waiting for the
                // parent that a concurrent remove is holding while waiting for the child. See
                // {@link ReorderListService.findOwnedListForShare}.
                const admitted = await this.findOwnedListForShare(transactionCtx, input.reorderListId, scope);
                if (!admitted) {
                    // Indistinguishable for an unknown identifier, another customer's list and another
                    // channel's list, and deliberately NOT the line-level not-found: a caller who cannot
                    // reach the list must learn nothing about which of its lines exist.
                    return new ReorderListNotFoundError();
                }

                const result = await this.connection
                    .getRepository(transactionCtx, ReorderListLine)
                    .createQueryBuilder('reorderlistline')
                    .update()
                    // An absolute set, not an increment. No raw expression, so no escaping is needed here.
                    .set({ quantity: input.quantity })
                    .where('id = :lineId', { lineId: input.lineId })
                    .andWhere('reorderListId = :reorderListId', { reorderListId: input.reorderListId })
                    // The remaining two conjuncts of the ownership predicate, in this same statement.
                    .andWhere(this.ownedListExistsClause())
                    .setParameters({
                        ownerCustomerId: scope.customerId,
                        ownerChannelId: scope.channelId,
                    })
                    .execute();

                if (result.affected !== 1) {
                    // NOT immediately a not-found, for the same reason the rename path is not: a line
                    // already holding exactly the requested quantity is matched by this statement and
                    // changed by it in nothing, which a driver reporting CHANGED rows reports as zero.
                    // See {@link ReorderListService.classifyLineQuantityMiss}.
                    return await this.classifyLineQuantityMiss(
                        transactionCtx,
                        input.reorderListId,
                        input.lineId,
                        input.quantity,
                        scope,
                    );
                }
                // The stored line count is deliberately untouched: no line was added or removed.
                return await this.reloadOwnedList(transactionCtx, input.reorderListId, scope);
            });
        } catch (err: unknown) {
            return this.rethrowSanitisedFailure(err, 'adjustReorderListLine');
        }
    }

    /**
     * @description
     * Removes one line from a list.
     *
     * **A caller who may not have the addressed list is refused by the transaction's first statement**, a
     * scoped read of the parent under the full three-conjunct predicate. It returns no rows for an unknown,
     * foreign or other-channel list, so the refusal costs exactly one scoped `SELECT` and issues no `DELETE`
     * at all — the published evidence contract for a refused write — and it takes the parent's write lock
     * where the engine has one, which is what gives every transaction in this service one lock order.
     *
     * **The delete itself still carries the whole ownership predicate**: the line's own identifier, its parent
     * list's, and — through a correlated `EXISTS` over `reorder_list` — the acting customer and the active
     * channel. Its affected-row count is the authority: one means the line was removed, and zero means it was
     * not, which is also how a **second remove of the same line** is refused rather than reported as a
     * success. Addressing the line by its parent's identifier alone, on the strength of the read above, would
     * leave the delete unguarded against the list being deleted, or changing hands, in between.
     *
     * A zero count is then labelled by one minimal scoped read: no accessible list gives
     * `ReorderListNotFoundError`, an accessible list gives `ReorderListLineNotFoundError`. The read explains a
     * refusal that has already happened; it never authorises one.
     *
     * **The stored line count is decremented in the same transaction as the delete**, which is what keeps the
     * counter and the rows in agreement, and the decrement carries a floor guard so the column's non-negative
     * check constraint stays satisfiable even under a defect.
     *
     * @param ctx - The request context.
     * @param input - The list and the line to remove.
     * @throws A `ForbiddenError` when the request carries no authenticated session.
     *
     * @since 3.8.0
     */
    async removeReorderListLine(
        ctx: RequestContext,
        input: RemoveReorderListLineInput,
    ): Promise<RemoveReorderListLineResult> {
        const scope = await this.getOwnerScope(ctx, 'removeReorderListLine');

        try {
            return await this.connection.withTransaction(ctx, async transactionCtx => {
                // The parent BEFORE the child, and under a write lock where the engine has one. This is the
                // one transaction in the service that would otherwise take the two rows in the opposite order
                // to `deleteReorderList` — which takes the parent and then its children through the cascade —
                // and two transactions taking the same two rows in opposite orders deadlock rather than wait.
                // The predicate is the same three conjuncts, so an inaccessible list is still refused by
                // matching nothing rather than by being loaded and discarded, and its answer is the same
                // normalised not-found. See {@link ReorderListService.findOwnedListForUpdate}.
                const parent = await this.findOwnedListForUpdate(transactionCtx, input.reorderListId, scope);
                if (!parent) {
                    return new ReorderListNotFoundError();
                }
                const result = await this.connection
                    .getRepository(transactionCtx, ReorderListLine)
                    .createQueryBuilder('reorderlistline')
                    .delete()
                    .where('id = :lineId', { lineId: input.lineId })
                    .andWhere('reorderListId = :reorderListId', { reorderListId: input.reorderListId })
                    // The remaining two conjuncts of the ownership predicate, in this same statement.
                    .andWhere(this.ownedListExistsClause())
                    .setParameters({
                        ownerCustomerId: scope.customerId,
                        ownerChannelId: scope.channelId,
                    })
                    .execute();

                if (result.affected !== 1) {
                    return await this.classifyLineWriteMiss(transactionCtx, input.reorderListId, scope);
                }
                // Same transaction as the delete above, so the counter and the rows cannot be observed
                // disagreeing. The scope is handed on so the decrement carries the same owner conjuncts as
                // every other statement addressing this row, rather than trusting this call site for them.
                await this.releaseLineCapacity(transactionCtx, input.reorderListId, scope);
                return await this.reloadOwnedList(transactionCtx, input.reorderListId, scope);
            });
        } catch (err: unknown) {
            return this.rethrowSanitisedFailure(err, 'removeReorderListLine');
        }
    }

    // Write-side conventions, shared by all six mutations so that none of them can quietly differ.

    /**
     * Resolves one list under the full predicate by a **current** read, for the zero-affected path of a write.
     *
     * **This exists because {@link ReorderListService.findOwnedList} answers the wrong question after a write
     * has been refused.** A plain `SELECT` is a consistent read, and on MariaDB and MySQL — whose default
     * isolation level is REPEATABLE READ — every consistent read in a transaction answers from the read view
     * built at that transaction's *first* one. Every mutation resolver carries `@Transaction()`, and the owner
     * scope resolves through a customer `SELECT` before any of this service's own statements, so by the time a
     * conditional write is issued the read view is already older than any concurrent commit. The write itself
     * is a current operation and sees the truth, which is precisely why it can affect zero rows while a plain
     * re-read still returns the row it was refused for: a list deleted since the read view was built is gone
     * to the write and present to the read. Classifying the refusal from that stale answer reports the wrong
     * reason — a deleted list read back as still there is then blamed on the line bound instead.
     *
     * A shared rather than exclusive lock is requested, because the question is existence and nothing here
     * writes the row afterwards. On the SQLite family the lock is skipped and the plain read is already
     * current, that driver serving a single connection so no second transaction can have committed anything
     * this one has not seen.
     *
     * It is issued **only** on a zero-affected path, so a successful write never pays for it.
     */
    private async findOwnedListNow(
        ctx: RequestContext,
        id: ID,
        scope: ReorderListOwnerScope,
    ): Promise<ReorderList | null> {
        const queryBuilder = this.connection
            .getRepository(ctx, ReorderList)
            .createQueryBuilder('reorderlist')
            .where('reorderlist.id = :id', { id })
            .andWhere('reorderlist.customerId = :customerId', { customerId: scope.customerId })
            .andWhere('reorderlist.channelId = :channelId', { channelId: scope.channelId });
        if (this.supportsPessimisticLocking) {
            queryBuilder.setLock('pessimistic_read');
        }
        return queryBuilder.getOne().then(list => this.recordOwnerScope(list, scope));
    }

    /**
     * Says which of the two not-found results to report for a line write that affected no row.
     *
     * It is a *labelling* step and never a deciding one, and the distinction is what keeps it safe. The write
     * has already been refused by a single statement carrying the line, its parent and the caller's owner
     * scope, so nothing this read returns can admit a write that the statement declined. All it establishes is
     * which of the predicate's parts was unsatisfied, because the two are reported differently: an
     * inaccessible list is `ReorderListNotFoundError` — indistinguishable for an unknown identifier, another
     * customer's list and another channel's list, so no caller can probe for the existence of a list that is
     * not theirs — while an accessible list means the line itself was the part that was missing, which is
     * `ReorderListLineNotFoundError`.
     *
     * It is one statement, it is scoped by the same predicate as every other read here, and it runs only on
     * the zero-affected path, so a successful write never pays for it. It is a **current** read for the reason
     * {@link ReorderListService.findOwnedListNow} sets out: a plain read here would answer from a view older
     * than the concurrent delete that caused the refusal, and would then report the line as missing from a
     * list that is itself gone.
     */
    private async classifyLineWriteMiss(
        ctx: RequestContext,
        listId: ID,
        scope: ReorderListOwnerScope,
    ): Promise<ReorderListNotFoundError | ReorderListLineNotFoundError> {
        const list = await this.findOwnedListNow(ctx, listId, scope);
        return list ? new ReorderListLineNotFoundError() : new ReorderListNotFoundError();
    }

    /**
     * Says whether a rename that affected no row was refused or was simply a no-op, and reports accordingly.
     *
     * **Why an affected count of zero is not on its own a not-found.** The affected-row count is the authority
     * on whether a conditional write applied, and this service leans on that everywhere — but the count a
     * driver reports for an `UPDATE` is either *matched* rows or *changed* rows depending on how the connection
     * was opened, and the two differ by exactly one case: a row the predicate matched whose columns already
     * held the values being written.
     *
     * On the connection this repository actually opens, that case reports **one** rather than zero, so this
     * path is a robustness guarantee rather than the ordinary route. The MySQL-family connector is mysql2,
     * whose `getDefaultFlags()` includes `FOUND_ROWS`
     * (`node_modules/mysql2/lib/connection_config.js`), and `mergeFlags` applies every default unless a
     * configuration blacklists it with a leading `-`; TypeORM's `MysqlDriver` passes `flags: options.flags`
     * straight through and suppresses none of the connector's defaults
     * (`node_modules/typeorm/driver/mysql/MysqlDriver.js`). A deployment that opts out with
     * `flags: '-FOUND_ROWS'` gets matched-row reporting turned off and lands here on every no-op rename, and a
     * driver that reports no affected count at all (`undefined`) lands here on **every** rename.
     *
     * Both of those are worth handling rather than assuming away, because the failure they would otherwise
     * produce is a wrong answer rather than an error: treating zero as "no such list" tells a caller their list
     * does not exist while they are looking at it, and does so for the one request that was already in the
     * state they asked for. It also makes the operation non-idempotent for no reason — a client retrying a
     * rename it could not confirm would be told the list had gone.
     *
     * **How the two are told apart.** One scoped **current** read, on the zero path only, under exactly the
     * predicate the write carried. No row means there is genuinely no such list for this caller — unknown,
     * another customer's, or another channel's, all indistinguishable, which is what keeps a caller from
     * probing for a list that is not theirs. A row already carrying both the display name and the canonical key
     * that were being written means the write was a no-op and the requested state holds, so it is reported as
     * the success it is. The row that read returns is itself the post-write state, taken after the statement
     * and under the same predicate, so it is returned directly rather than read a third time.
     *
     * **A row that exists and carries a different name is an anomaly, and is not reported as a success.** The
     * read ran under the same three conjuncts as the write, so a matched row whose name differs means the write
     * both matched and failed to apply — which no engine does. It keeps the conservative not-found rather than
     * claiming a rename that demonstrably did not happen, and logs, because a silent wrong success is far worse
     * than a visible wrong refusal.
     */
    private async classifyListRenameMiss(
        ctx: RequestContext,
        id: ID,
        scope: ReorderListOwnerScope,
        name: string,
        nameKey: string,
    ): Promise<ReorderList | ReorderListNotFoundError> {
        const list = await this.findOwnedListNow(ctx, id, scope);
        if (!list) {
            return new ReorderListNotFoundError();
        }
        if (list.name === name && list.nameKey === nameKey) {
            return list;
        }
        Logger.warn(
            `A rename of reorder list ${String(
                id,
            )} affected no row although the list is accessible and carries a different name`,
            loggerCtx,
        );
        return new ReorderListNotFoundError();
    }

    /**
     * Says whether an absolute quantity set that affected no row was refused, or was already satisfied.
     *
     * This is {@link ReorderListService.classifyListRenameMiss}'s counterpart on the line, and it exists for
     * the identical driver reason and under the identical caveat: setting a line to the quantity it already
     * holds matches the row and changes nothing, which a connection reporting *changed* rather than *matched*
     * rows reports as zero affected. That is not the default connection here — mysql2 negotiates `FOUND_ROWS`
     * and the case reports one — so this path serves a deployment that opts out with `flags: '-FOUND_ROWS'`,
     * and any driver that reports no affected count at all. See
     * {@link ReorderListService.classifyListRenameMiss} for the citations.
     *
     * Handling it matters because the alternative is a wrong answer rather than an error: reporting
     * `ReorderListLineNotFoundError` would deny the existence of a line that is present and already in the
     * requested state — and would do so for precisely the request this operation exists to make safe, since
     * the absolute set is the published remedy for an add a client could not confirm, and a client resolving
     * that uncertainty will frequently set the value already stored.
     *
     * **The parent is classified first, and that order is not interchangeable.** The line row carries no
     * customer and no channel, so a read scoped only by its parent's identifier is not ownership-scoped; the
     * parent read establishes the scope, and it is also the read that distinguishes the two not-found results
     * exactly as {@link ReorderListService.classifyLineWriteMiss} does. Only once the list is known accessible
     * is the line read at all, and only a line whose stored quantity already equals the requested one is
     * reported as a success — with the list, which is this operation's published payload and was read after
     * the write under the full predicate.
     *
     * Both reads are on the zero path only, so a successful adjustment pays for neither. A line that exists
     * and holds a different quantity keeps the conservative `ReorderListLineNotFoundError` and logs, for the
     * same reason its rename counterpart does.
     */
    private async classifyLineQuantityMiss(
        ctx: RequestContext,
        listId: ID,
        lineId: ID,
        quantity: number,
        scope: ReorderListOwnerScope,
    ): Promise<ReorderList | ReorderListNotFoundError | ReorderListLineNotFoundError> {
        const list = await this.findOwnedListNow(ctx, listId, scope);
        if (!list) {
            return new ReorderListNotFoundError();
        }
        const line = await this.findLineById(ctx, listId, lineId);
        if (!line) {
            return new ReorderListLineNotFoundError();
        }
        if (line.quantity === quantity) {
            return list;
        }
        Logger.warn(
            `An absolute quantity set on reorder list line ${String(
                lineId,
            )} affected no row although the line is accessible and holds a different quantity`,
            loggerCtx,
        );
        return new ReorderListLineNotFoundError();
    }

    /**
     * Resolves one line of a list by its own identifier, by a **current** read, for a zero-affected path.
     *
     * The parent's identifier is a conjunct rather than an assumption, so a line identifier belonging to some
     * other list cannot be resolved through it even though the caller supplied both. Ownership itself is
     * carried by the parent read the sole caller performs first, for the reason
     * {@link ReorderListService.classifyLineQuantityMiss} sets out: a line row stores no customer and no
     * channel, so this statement could not carry the predicate even if it wanted to.
     *
     * It is current for the reason {@link ReorderListService.findOwnedListNow} sets out, and no relation is
     * joined for the reason {@link ReorderListService.findLineForVariant} sets out — PostgreSQL refuses a lock
     * on the nullable side of an outer join, so a relation condition would fail on one engine only.
     */
    private findLineById(ctx: RequestContext, listId: ID, lineId: ID): Promise<ReorderListLine | null> {
        const queryBuilder = this.connection
            .getRepository(ctx, ReorderListLine)
            .createQueryBuilder('reorderlistline')
            .where('reorderlistline.id = :lineId', { lineId })
            .andWhere('reorderlistline.reorderListId = :listId', { listId });
        if (this.supportsPessimisticLocking) {
            queryBuilder.setLock('pessimistic_read');
        }
        return queryBuilder.getOne();
    }

    /**
     * Escapes a column identifier for the configured engine, for use inside a raw `SET` expression.
     *
     * **This is not optional politeness and the failure it prevents appears on exactly one engine.** Both
     * columns this service increments are camel-cased, and an unquoted camel-cased identifier inside a raw SQL
     * fragment is folded to lower case by PostgreSQL, where it then matches no column and the statement fails
     * at run time. The SQLite family, by contrast, resolves it happily — so an unescaped fragment passes the
     * in-process engine's tests and fails one engine job. The platform's own services escape through the
     * driver for the same reason.
     */
    private escapeColumn(columnName: string): string {
        return this.connection.rawConnection.driver.escape(columnName);
    }

    /**
     * The correlated `EXISTS` fragment that carries the ownership predicate into a statement written against
     * `reorder_list_line`, whose own row holds no customer and no channel.
     *
     * **Why a sub-query, and why a preceding scoped read does not replace it.** Every write in this service is
     * required to be a single conditional statement whose `WHERE` carries the acting customer and the active
     * channel beside the row's identifier, with the affected-row count as the authority. A line row cannot
     * satisfy that on its own — it stores only its parent's identifier — so a write addressed by that
     * identifier alone would have delegated the whole ownership decision to an earlier statement. Between the
     * two, a list can be deleted or change hands, and a write holding only ids applies anyway. Folding the
     * parent's two columns into the same statement closes that window: the row is matched only while it still
     * belongs to a list this caller owns in this channel.
     *
     * The line-addressing paths **also** resolve the parent under the same three conjuncts before they write,
     * and the two mechanisms answer different questions rather than duplicating one. The read is the refusal
     * evidence a caller who may not have the list is owed — one scoped `SELECT` returning nothing, and no DML
     * issued on their behalf — while this fragment is what keeps the write itself the authority on what
     * happened. Removing either one loses a property the other does not supply.
     *
     * **Why a join is not used instead.** A join in an `UPDATE`/`DELETE` is spelled differently by each of the
     * four engines and is not expressible at all in the SQLite family's `UPDATE` syntax, whereas a correlated
     * `EXISTS` sub-query is standard and identical on all four.
     *
     * **Every identifier here is escaped explicitly, and that is a requirement rather than a precaution.** The
     * query builder rewrites bare property names it recognises in the finished statement, but it recognises
     * only the columns of the entity being written — it has no knowledge of an aliased second table this
     * fragment introduces, so `alias.column` tokens are left exactly as written. Unescaped camel-cased
     * identifiers are folded to lower case by PostgreSQL, where they then match no column; escaping through
     * the driver is what makes one fragment correct on every engine. The names themselves are read from the
     * entity metadata rather than written as literals, so the fragment cannot drift from the schema.
     *
     * **The table is rendered through {@link ReorderListService.qualifiedTableName}, not by escaping its bare
     * name.** On a connection configured with a schema or a database, the statement this fragment sits inside
     * has a QUALIFIED target, so a bare name here would consult a different table of the same name on the
     * connection's search path — and answer the ownership question from it. That helper explains what goes
     * wrong in full; the requirement here is only that this one identifier never be spelled unqualified.
     *
     * The outer reference to the line's own `reorderListId` is deliberately left unqualified. It is
     * unambiguous — `reorder_list` carries no column of that name, so the identifier can only resolve to the
     * statement's target table — and it avoids depending on how each engine's dialect renders (or omits) an
     * alias for that target.
     *
     * The two values are bound as the parameters `ownerCustomerId` and `ownerChannelId`, which the caller
     * supplies alongside its own; nothing is interpolated into the SQL.
     */
    private ownedListExistsClause(): string {
        const rawConnection = this.connection.rawConnection;
        const escape = (identifier: string) => rawConnection.driver.escape(identifier);
        const listMetadata = rawConnection.getMetadata(ReorderList);
        const lineMetadata = rawConnection.getMetadata(ReorderListLine);
        const alias = escape(OWNED_LIST_SUBQUERY_ALIAS);
        const listColumn = (propertyName: string) =>
            `${alias}.${escape(this.columnNameOf(listMetadata, propertyName))}`;
        const lineListIdColumn = escape(this.columnNameOf(lineMetadata, 'reorderListId'));
        return (
            `EXISTS (SELECT 1 FROM ${this.qualifiedTableName(listMetadata)} ${alias}` +
            ` WHERE ${listColumn('id')} = ${lineListIdColumn}` +
            ` AND ${listColumn('customerId')} = :ownerCustomerId` +
            ` AND ${listColumn('channelId')} = :ownerChannelId)`
        );
    }

    /**
     * One entity's relation, rendered the way the query builder renders the statement's own target table:
     * qualified by whatever schema or database the connection is configured with, and escaped part by part.
     *
     * **This is a correctness requirement under a configured schema and not a cosmetic one.** The statements
     * this fragment is appended to are built by the query builder, which renders their target table from
     * `metadata.tablePath` — so under `dbConnectionOptions.schema` the target is `"tenant"."reorder_list_line"`
     * while a sub-query naming `metadata.tableName` is the bare `"reorder_list"`. PostgreSQL then resolves
     * that bare name through `search_path`, which the driver does NOT set from the schema option, so it either
     * fails outright or — worse, and silently — correlates the ownership predicate against a same-named table
     * in ANOTHER schema. A tenant's write would then be judged by another tenant's rows.
     *
     * The split-and-escape is TypeORM's own rule, taken from `QueryBuilder.getTableName`
     * [node_modules/typeorm/query-builder/QueryBuilder.js:L362-L372] rather than reimplemented from a guess,
     * including its treatment of an EMPTY part: SQL Server produces `database..table` when a database is
     * configured without a schema, and an empty identifier must be passed through unescaped for that to
     * remain valid SQL.
     */
    private qualifiedTableName(metadata: EntityMetadata): string {
        const escape = (identifier: string) => this.connection.rawConnection.driver.escape(identifier);
        return metadata.tablePath
            .split('.')
            .map(part => (part === '' ? part : escape(part)))
            .join('.');
    }

    /**
     * The database column on `customer` holding the id of the `User` a buyer signs in as.
     *
     * It is read from the relation's own metadata rather than written as the literal `userId`, and the reason is
     * specific to this one column: `Customer` declares the relation as `@OneToOne(() => User) @JoinColumn()`
     * and declares **no property** for its foreign key, so there is no `customerId`-style field for
     * {@link ReorderListService.columnNameOf} to answer from. A literal would therefore be the one identifier in
     * this file able to drift from the schema in silence — and it is the identifier the create path's owner lock
     * is addressed by, so drifting would either lock the wrong row or lock nothing.
     *
     * A relation carrying anything other than exactly one join column is a schema this lookup cannot express,
     * so it is reported as the defect it would be rather than guessed at. The message names only this file's own
     * literals, so it discloses nothing about the caller or the database.
     */
    private customerUserJoinColumn(): string {
        const metadata = this.connection.rawConnection.getMetadata(Customer);
        const relation = metadata.findRelationWithPropertyPath('user');
        const joinColumns = relation?.joinColumns ?? [];
        if (joinColumns.length !== 1) {
            Logger.error(
                `Reorder plugin requires Customer.user to carry exactly one join column, found ` +
                    `${joinColumns.length}`,
                loggerCtx,
            );
            throw withoutStackFrames(new InternalServerError(UNCLASSIFIED_FAILURE_MESSAGE));
        }
        return joinColumns[0].databaseName;
    }

    /**
     * The mapped database column name for one entity property.
     *
     * Raw SQL fragments read their identifiers through here rather than spelling them as literals, so a
     * fragment cannot drift from the schema if a column is ever renamed in its entity declaration.
     *
     * An unmapped property name is a defect in this file rather than anything the request did, so it is logged
     * as one — the entity and property names are this file's own literals, so the line discloses nothing about
     * the caller or the database — and reported with the same generic message every unclassified failure
     * carries.
     */
    private columnNameOf(metadata: EntityMetadata, propertyName: string): string {
        const column = metadata.findColumnWithPropertyName(propertyName);
        if (!column) {
            Logger.error(
                `Reorder plugin entity ${metadata.name} declares no column for the property ${propertyName}`,
                loggerCtx,
            );
            throw withoutStackFrames(new InternalServerError(UNCLASSIFIED_FAILURE_MESSAGE));
        }
        return column.databaseName;
    }

    /**
     * Refuses a quantity that cannot be stored, before any write is issued.
     *
     * "Before any write" rather than "before any statement", stated precisely because the difference is
     * observable: each caller resolves its owner scope first — and the add path additionally resolves the list,
     * the variant and any existing line, because the bound applies to the RESULTING quantity and that cannot be
     * known without reading what the line already holds. All of those are reads. What this guard guarantees is
     * that no row is created, changed or removed on a path it refuses.
     *
     * **Both refusals are thrown rather than returned, and that is a contract rather than an implementation
     * choice.** A quantity outside its bounds is a malformed request and not a business outcome, so it reaches
     * the caller as a single top-level error entry carrying the code `USER_INPUT_ERROR` with the operation's
     * own field null — never as a member of a result union. This is precisely why this feature declares four
     * error results and not five.
     *
     * It is deliberately *not* the platform's negative-quantity error result: that type's own description is
     * about setting a negative quantity on an order line, the platform returns it for values below zero only,
     * it says nothing about zero, and it is about an order line rather than a list line. Reporting one
     * condition under another condition's name is worse than reporting it plainly.
     *
     * The maximum is applied to the value passed in, and callers pass the **resulting** quantity rather than an
     * increment — so an add of one onto a line already at the maximum is refused even though the increment
     * itself is one.
     *
     * @param resultingQuantity - The quantity the line would hold if the operation applied.
     */
    private validateQuantity(resultingQuantity: number): void {
        if (!Number.isInteger(resultingQuantity) || resultingQuantity <= 0) {
            // The registered message states the whole rule in one sentence and interpolates nothing, so no
            // variables are passed. A non-integer and a non-positive value are one condition to a caller:
            // the quantity is not a positive integer.
            throw withoutStackFrames(new UserInputError(QUANTITY_MUST_BE_POSITIVE_KEY));
        }
        if (resultingQuantity > this.maxQuantityPerLine) {
            throw withoutStackFrames(
                new UserInputError(QUANTITY_ABOVE_MAXIMUM_KEY, {
                    [MAX_VARIABLE]: this.maxQuantityPerLine,
                }),
            );
        }
    }

    /**
     * Refuses a request carrying no authenticated session, without issuing a statement.
     *
     * It is the third conjunct of the ownership predicate — "the session carries an active user at all" —
     * separated out so that a write can evaluate it before opening a transaction while the two row-level
     * conjuncts are still resolved by a single scoped statement afterwards. Both scope resolvers call it, so
     * the check itself has one implementation rather than three.
     *
     * `FORBIDDEN` rather than `UNAUTHORIZED` is the platform's own distinction: an unauthorized error is
     * raised where credentials do not *match*, whereas an absent session on a permission-gated operation is
     * reported as forbidden.
     */
    private requireActiveUser(ctx: RequestContext): void {
        if (!ctx.activeUserId) {
            throw withoutStackFrames(new ForbiddenError());
        }
    }

    /**
     * Resolves the line a list holds for one variant, optionally by a locking (current) read.
     *
     * The lookup is scoped to the parent list, which was itself resolved under the full predicate inside this
     * same transaction, so a line belonging to another list cannot be reached even through a variant the two
     * lists share.
     *
     * **No relation is joined, and that is a PostgreSQL requirement rather than an economy.** A relation
     * condition would be realised as a LEFT join, and PostgreSQL refuses `FOR UPDATE` on the nullable side of
     * an outer join — so the locking form would fail on one engine only. The parent scope is carried by the
     * parent's own identifier here and by the correlated `EXISTS` clause on every statement that writes.
     *
     * @param useCurrentRead - Whether to take a pessimistic write lock, which on MariaDB, MySQL and
     * PostgreSQL also makes the read a *current* one that sees the latest committed row rather than this
     * transaction's snapshot. Skipped on the SQLite family, which serves a single connection and raises rather
     * than degrades when asked for a lock.
     */
    private findLineForVariant(
        ctx: RequestContext,
        listId: ID,
        productVariantId: ID,
        useCurrentRead: boolean,
    ): Promise<ReorderListLine | null> {
        const queryBuilder = this.connection
            .getRepository(ctx, ReorderListLine)
            .createQueryBuilder('reorderlistline')
            .where('reorderlistline.reorderListId = :listId', { listId })
            .andWhere('reorderlistline.productVariantId = :productVariantId', { productVariantId });
        if (useCurrentRead && this.supportsPessimisticLocking) {
            queryBuilder.setLock('pessimistic_write');
        }
        return queryBuilder.getOne();
    }

    /**
     * Adds to an existing line's quantity by ONE conditional statement, and reports which of the three
     * possible states the affected-row count revealed.
     *
     * **The statement carries four conjuncts and each one is load-bearing.** The line's own identifier and its
     * parent list's identifier address the row. The correlated `EXISTS` over `reorder_list` carries the acting
     * customer and the active channel, so the ownership predicate is enforced by the *same* statement whose
     * affected-row count is the authority rather than by an earlier read. And `quantity <= :maxBeforeIncrement`
     * is the configured maximum applied atomically to the RESULTING value: the caller has already validated
     * the total it expects, but between that read and this statement a concurrent add can raise the stored
     * quantity, and without this conjunct both callers would validate against a stale total and the line would
     * end up above the maximum. With it, the loser affects no row and is refused.
     *
     * **The increment is expressed in SQL, never computed in TypeScript.** A read-compute-save loses one of
     * two concurrent adds: both read six, both compute twelve, both store twelve, and the buyer who asked for
     * eighteen holds twelve. `quantity = quantity + :delta` is evaluated by the engine against the row's
     * current value, so the second writer increments the first writer's result.
     *
     * @returns `'accumulated'` when the row was updated; `'line-replaced'` when the addressed line has gone and
     * a *different* row now holds this variant, which is a concurrent insert to reconcile onto rather than a
     * state to report; `'line-gone'` when no row holds this variant at all, so the caller should take the
     * insert path; `'above-maximum'` when the addressed line is still there and its current quantity plus this
     * increment would breach the configured maximum; `'line-invalid'` when the addressed line is still there
     * but its stored quantity already violates the column's positive invariant, so this statement declined to
     * compound it; `'list-gone'` when the addressed line is there, within the maximum and above the floor,
     * which leaves the ownership conjunct as the only thing the statement can have failed on.
     */
    private async accumulateLineQuantity(
        ctx: RequestContext,
        lineId: ID,
        listId: ID,
        productVariantId: ID,
        delta: number,
        scope: ReorderListOwnerScope,
    ): Promise<
        'accumulated' | 'line-replaced' | 'line-gone' | 'above-maximum' | 'line-invalid' | 'list-gone'
    > {
        const quantityColumn = this.escapeColumn('quantity');
        const result = await this.connection
            .getRepository(ctx, ReorderListLine)
            .createQueryBuilder('reorderlistline')
            .update()
            .set({ quantity: () => `${quantityColumn} + :delta` })
            .where('id = :lineId', { lineId })
            .andWhere('reorderListId = :listId', { listId })
            .andWhere(`${quantityColumn} <= :maxBeforeIncrement`)
            // THE STORED QUANTITY'S OWN FLOOR, for the same reason the ceiling beside it is here. This
            // statement adds to a number it does not read first, so a stored quantity that already violates
            // the column's positive invariant would be carried forward by the arithmetic rather than caught by
            // it: zero plus a legal increment stores a total the request never asked for, and a negative base
            // stores another negative. `CHK_reorder_list_line_quantity_positive` is what makes such a row
            // unrepresentable, and TypeORM does not create it on MySQL or MariaDB (conflict C-E), so on those
            // engines this predicate is the only thing standing between a corrupt row and a corrupt total
            // compounded on top of it. Refusing is classified below as `'line-invalid'` and is reported as an
            // internal failure, because a row the column may not hold is a defect in this service's data
            // rather than anything the request did — and compounding it would make this service the author of
            // the next invalid value.
            .andWhere(`${quantityColumn} > 0`)
            .andWhere(this.ownedListExistsClause())
            .setParameters({
                delta,
                maxBeforeIncrement: this.maxQuantityPerLine - delta,
                ownerCustomerId: scope.customerId,
                ownerChannelId: scope.channelId,
            })
            .execute();
        if (result.affected === 1) {
            return 'accumulated';
        }
        // Zero affected rows is ambiguous by construction — the row's existence, the maximum guard and the
        // ownership conjunct are all in the one predicate — so the state is re-established rather than
        // guessed. The re-read is a current read where the engine offers one, both because a snapshot older
        // than the competing commit would answer the question wrongly and because holding the row makes the
        // answer stable for the caller acting on it. It is addressed by the variant for the same reason the
        // caller's first read was: if the line has gone, the caller's next step is to insert one for that
        // variant.
        const current = await this.findLineForVariant(ctx, listId, productVariantId, true);
        if (!current) {
            return 'line-gone';
        }
        // IDENTITY BEFORE ARITHMETIC. A row for this variant exists, but "a row for this variant" and "the row
        // this statement addressed" are not the same thing: a concurrent request can remove the addressed line
        // and insert a fresh one for the same variant, and the per-variant uniqueness constraint then makes the
        // replacement the only row the lookup above can return. Every remaining answer here is a statement
        // about the ADDRESSED row, so reading its quantity off a different row would answer a question that was
        // not asked — and the two wrong answers it produces are both plausible: a replacement holding a small
        // quantity looks like "the list must have gone", and one holding a large quantity looks like a maximum
        // breach the caller never caused. A different identifier means a concurrent insert, which is the state
        // the reconciliation path already exists for, so it is named as that and nothing is inferred from it.
        if (String(current.id) !== String(lineId)) {
            return 'line-replaced';
        }
        // The addressed row is there, so exactly one of the three remaining conjuncts refused it, and the
        // stored quantity says which. The floor is tested FIRST, and the order is load-bearing rather than
        // stylistic: a non-positive stored quantity does not breach the ceiling either — a negative base plus
        // a legal increment stays well under the maximum — so asking the ceiling's question first would answer
        // `'list-gone'` and blame the ownership conjunct for a row that is present and owned, sending a data
        // defect back to the buyer as a missing list.
        if (current.quantity <= 0) {
            return 'line-invalid';
        }
        // The floor held, so a stored quantity that this increment would carry past the maximum is the guard,
        // and anything else leaves only the ownership conjunct.
        return current.quantity + delta > this.maxQuantityPerLine ? 'above-maximum' : 'list-gone';
    }

    /**
     * Inserts the line for a list-and-variant pair, letting the per-variant uniqueness constraint refuse a
     * duplicate.
     *
     * **It is an ordinary insert rather than an ignoring one, because the ignore form is unsafe on two of the
     * four engines.**
     * `orIgnore()` compiles to `ON CONFLICT DO NOTHING` on PostgreSQL and the SQLite family — narrow, and only
     * a conflict is absorbed — but on MySQL and MariaDB it compiles to `INSERT IGNORE`, which downgrades every
     * *ignorable* error of the statement to a warning: a foreign key that does not resolve, a value too long
     * for its column, a `NOT NULL` column left empty. Each of those would come back as "affected 0 rows",
     * indistinguishable from a duplicate, and would then be reported to the caller as a concurrent insert and
     * retried — a wrong diagnosis followed by a retry that cannot succeed. Narrowing that on the MySQL family
     * is not possible through the ignore form, because it takes no conflict target there.
     *
     * **So the duplicate is classified from the failure instead, by its constraint name.** A violation of
     * `UQ_reorder_list_line_list_variant` raised by this statement leaves this transaction callback and the
     * platform's wrapper unwinds it with a plain `ROLLBACK`: the only caller is the add path, whose resolver
     * declares `@Transaction('manual')`, so the attempt this statement belongs to is itself the outermost
     * transaction and there is no enclosing savepoint to roll back to. The bounded retry in
     * {@link ReorderListService.addItemToReorderList} recognises exactly that one named constraint and
     * accumulates onto the winner's row. The unwind is what makes this safe on PostgreSQL, whose aborted
     * subtransaction would otherwise refuse every later statement: nothing later is attempted inside the failed
     * transaction, and the retry runs in a fresh one. It also gives back the capacity claim this attempt took,
     * because a pair that already has a line adds no line. Every other database failure is not a duplicate and
     * is re-raised sanitised rather than retried, which is the behaviour `INSERT IGNORE` could not express.
     *
     * The statement is generated by the builder, so the value transformation, the date columns and the
     * identifier strategy are the ORM's rather than hand-written, and it is issued through the request's own
     * repository so it belongs to the open transaction. No affected-row count is read: an insert that returns
     * has inserted its row, and one that has not raises.
     */
    private async insertLine(
        ctx: RequestContext,
        listId: ID,
        productVariantId: ID,
        quantity: number,
    ): Promise<void> {
        await this.connection
            .getRepository(ctx, ReorderListLine)
            .createQueryBuilder()
            .insert()
            .values({ reorderListId: listId, productVariantId, quantity })
            .execute();
    }

    /**
     * Claims room for one more line on a list, by a single conditional counter update, and reports which state
     * the affected-row count revealed.
     *
     * **This statement IS the line bound.** It increments the counter only while it is still below the
     * configured maximum — and only for a list the acting customer owns in the active channel, so the
     * ownership predicate is enforced by the statement that writes rather than by an earlier read. Its
     * affected-row count is the verdict: one means the room was claimed and the line may now be inserted.
     * Because a single statement decides, no interleaving can admit an extra line, which is exactly the
     * assertion a count-then-insert check fails.
     *
     * **Zero affected rows is where a boolean return is inadequate, and the three states it conflates are not
     * interchangeable.** The list may be genuinely full; it may have been deleted (or moved out of the
     * caller's scope) since this transaction resolved it; or a concurrent add may have inserted a line for the
     * very variant this call is adding, in which case the contract's answer is an accumulation onto that row
     * and not a limit error at all. Reporting "full" for the second is a wrong reason, and for the third it
     * refuses a write the contract requires to succeed — a duplicate add to a list at its maximum accumulates,
     * because it creates no line. So the state is re-established with two scoped reads on the zero path only.
     *
     * It is issued as the **first write of the insert path**, so a refusal leaves nothing to undo.
     *
     * @returns `'claimed'`, `'list-gone'`, `'duplicate-line'`, `'counter-invalid'` when the list is present and
     * holds no line for this variant but its stored counter is negative, or `'full'`.
     */
    private async claimLineCapacity(
        ctx: RequestContext,
        listId: ID,
        productVariantId: ID,
        scope: ReorderListOwnerScope,
    ): Promise<'claimed' | 'list-gone' | 'duplicate-line' | 'counter-invalid' | 'full'> {
        const lineCount = this.escapeColumn('lineCount');
        const result = await this.connection
            .getRepository(ctx, ReorderList)
            .createQueryBuilder('reorderlist')
            .update()
            .set({ lineCount: () => `${lineCount} + 1` })
            .where('id = :listId', { listId })
            .andWhere('customerId = :customerId', { customerId: scope.customerId })
            .andWhere('channelId = :channelId', { channelId: scope.channelId })
            .andWhere('lineCount < :maxLinesPerList', { maxLinesPerList: this.maxLinesPerList })
            // THE COUNTER'S OWN FLOOR, as a predicate rather than an assumption. The bound above compares a
            // stored number, so it is exactly as trustworthy as that number: a counter that has drifted below
            // zero satisfies `< maxLinesPerList` however many lines the list really holds, and the claim would
            // then hand out the capacity the bound exists to withhold — once for every unit of drift, silently.
            // `CHK_reorder_list_line_count_non_negative` is what makes a negative counter unrepresentable, and
            // TypeORM does not create it on MySQL or MariaDB (conflict C-E), so on those engines this predicate
            // is the only place the floor can be asserted. It costs nothing when the counter is sound and fails
            // closed when it is not: the refusal is classified below and reaches the caller as the ordinary
            // limit outcome, never as a quietly widened bound. The decrement carries this guard's mirror; see
            // `releaseLineCapacity`.
            .andWhere('lineCount >= 0')
            .execute();
        if (result.affected === 1) {
            return 'claimed';
        }
        // The two reads below run on the zero path only, so the ordinary add pays for neither. BOTH are
        // current reads, and for the list that is the difference between a right and a wrong answer: a
        // consistent read would answer from a view predating the delete that caused this refusal, report the
        // list as present, find no duplicate, and blame the line bound for a list that no longer exists.
        const list = await this.findOwnedListNow(ctx, listId, scope);
        if (!list) {
            return 'list-gone';
        }
        // A duplicate is looked for BEFORE the counter is believed, because a duplicate add accumulates
        // regardless of how full the list is: the write it is about to make creates no line, so the bound the
        // counter guards is not the bound it should be measured against. A current read is used so a snapshot
        // taken before the competing insert committed cannot report the row as absent.
        const duplicate = await this.findLineForVariant(ctx, listId, productVariantId, true);
        if (duplicate) {
            return 'duplicate-line';
        }
        // Only now is the counter believed, and the first thing asked of it is whether it is a number this
        // column may hold. A negative counter is the one state that reaches here having satisfied every
        // conjunct except the floor, and it is NOT the same answer as `'full'`: a list whose counter has
        // drifted below zero is almost certainly not at its maximum, so reporting a limit would tell the buyer
        // their list is full when it is not, and would bury the defect behind a plausible domain outcome that
        // no operator would ever investigate. It is separated out so it can be reported as the data defect it
        // is, for the same reasons set out on the `'line-invalid'` branch of the accumulate path.
        if (list.lineCount < 0) {
            return 'counter-invalid';
        }
        return 'full';
    }

    /**
     * Releases one line's worth of counter, in the same transaction as the delete that removed the line.
     *
     * **It carries the whole ownership predicate in its own `WHERE`, and that is a rule about statements
     * rather than about this statement.** Every write this service issues names the acting customer and the
     * active channel beside the row's identifier, so that no statement depends on an earlier one having
     * checked. Reaching this method only from a delete that already matched under the full predicate would
     * make the decrement *provably* safe today and silently unscoped tomorrow: a second caller, a refactor
     * that moved the delete, or a retry that reused the identifier alone would each produce a counter write
     * addressed by nothing but an id. The scope costs two conjuncts on an index the table already carries.
     *
     * The floor guard in the predicate is what keeps the column's non-negative check constraint satisfiable
     * even under a defect: a decrement that would take the counter below zero affects no row instead of
     * writing a negative value. Since the caller only reaches this after a delete that affected exactly one
     * row, a zero affected-count here means the counter had already drifted, which is worth a log rather than
     * a failure — the rows are the truth and the single-list read repairs the counter.
     *
     * @param scope - The customer-and-channel scope this request resolved. It is passed in rather than
     * re-resolved, because re-resolving it would issue a second `Customer` read for a fact the caller already
     * established, and a scope resolved twice is a scope that can differ between the two writes.
     */
    private async releaseLineCapacity(
        ctx: RequestContext,
        listId: ID,
        scope: ReorderListOwnerScope,
    ): Promise<void> {
        const lineCount = this.escapeColumn('lineCount');
        const result = await this.connection
            .getRepository(ctx, ReorderList)
            .createQueryBuilder('reorderlist')
            .update()
            .set({ lineCount: () => `${lineCount} - 1` })
            .where('id = :listId', { listId })
            .andWhere('customerId = :customerId', { customerId: scope.customerId })
            .andWhere('channelId = :channelId', { channelId: scope.channelId })
            .andWhere('lineCount > 0')
            .execute();
        if (!result.affected) {
            // Reached when the guarded decrement matched no row. In this transaction the delete has already
            // matched under the same three conjuncts, so a lineCount of zero is the reachable cause and is
            // named as such; the scope conjuncts are stated too, because a claim about a statement should
            // account for every predicate the statement carries rather than only the interesting one. Either
            // way the rows are the truth and the single-list read repairs the counter, so this is a warning
            // rather than a failure of a removal that has already happened.
            Logger.warn(
                `Reorder list ${String(listId)} had a lineCount of zero while a line was being removed ` +
                    'from it, or is no longer resolvable for the acting customer in the active channel',
                loggerCtx,
            );
        }
    }

    /**
     * Re-reads a list through the same scoped predicate, for a mutation that has just changed it.
     *
     * Every mutation returning a list returns a freshly read row rather than the row it had in hand, so the
     * stored line counter and the update timestamp the caller receives are the post-write values rather than
     * the pre-write ones. The read goes through the ownership predicate again, so the row a caller receives is
     * one they own even in the impossible case that ownership changed mid-transaction.
     *
     * A row that has vanished between the write and this read is reported as not found rather than as an
     * internal error: from the caller's point of view a concurrent delete landing in that window is exactly
     * "the list is not there", which is the same normalised outcome every other inaccessible case produces.
     */
    private async reloadOwnedList(
        ctx: RequestContext,
        listId: ID,
        scope: ReorderListOwnerScope,
    ): Promise<ReorderList | ReorderListNotFoundError> {
        const list = await this.findOwnedList(ctx, listId, scope);
        return list ?? new ReorderListNotFoundError();
    }

    // Database-failure translation: narrow where it is a buyer outcome, sanitised everywhere else.

    /**
     * Translates a name-uniqueness violation into its buyer-visible result, and re-raises everything else.
     *
     * **The match is on ONE constraint name and nothing else, and the width of the match is the whole point.**
     * Mapping "any unique-violation error code" would look like a shortcut and behave like a defect: the line
     * table carries its own uniqueness constraint, so a duplicated line would be reported to the buyer as a
     * duplicated *list name* — a wrong answer that reads like a right one. The two constraints are separate,
     * are named separately, and only this one is a business outcome.
     *
     * The returned result carries the caller's **own** canonical key, computed from the name they submitted, so
     * a client can explain precisely what collided while the response discloses nothing about the row that
     * already holds it.
     *
     * Everything that is not this one constraint goes to
     * {@link ReorderListService.rethrowSanitisedFailure}, so a driver message never reaches a caller.
     *
     * **It is called from outside the transaction callback, never inside it**, so by the time it runs the
     * platform's transaction wrapper has already unwound the failed statement — a rollback on the outermost
     * transaction, or `ROLLBACK TO SAVEPOINT` on the nested one every `@Transaction()`-decorated resolver
     * produces. Translating before that unwind is what breaks on PostgreSQL, whose aborted subtransaction
     * refuses the `RELEASE SAVEPOINT` a normal return would trigger; the create and update paths each carry
     * the full reasoning at their own catch.
     *
     * @param err - The caught driver failure.
     * @param nameKey - The canonical key the caller's own submitted name produced.
     * @param operation - The operation code an unclassified failure is logged under.
     */
    private translateNameConflict(
        err: unknown,
        nameKey: string,
        operation: ReorderListOperation,
    ): ReorderListNameConflictError {
        if (this.violatesConstraint(err, NAME_CONFLICT_CONSTRAINT_DESCRIPTOR)) {
            return new ReorderListNameConflictError(nameKey);
        }
        return this.rethrowSanitisedFailure(err, operation);
    }

    /**
     * Re-raises a failure this service cannot classify, disclosing nothing about it to the caller and
     * nothing about it to the log either.
     *
     * **Every database-touching member of this service funnels its unclassified failures through here** — the
     * eight published operations, the two scope resolvers whose statements precede them, the batched line
     * read behind the `lines` field, and the counter reconciliation — which is what makes the disclosure
     * boundary a property of the class rather than a habit at each call site: there is exactly one place a
     * driver error can turn into a response, and exactly one place it can turn into a log line. The two name
     * writes reach it through {@link ReorderListService.translateNameConflict}, which forwards everything the
     * one named constraint does not explain.
     *
     * **An already-classified platform error keeps its code and its message, and loses only its frames.** The
     * test is `instanceof I18nError` — the platform's own base for every error that carries a code and a
     * translatable message — so `UserInputError`, `ForbiddenError` and the list builder's own over-limit
     * refusal all reach the caller under their own codes. Re-wrapping one would turn a deliberate
     * `USER_INPUT_ERROR` into an internal error silently, giving the caller the wrong code for the right
     * reason. Testing the base rather than listing subclasses is deliberate: the list would have to be
     * revisited every time a `try` widened.
     *
     * **The one exception to that pass-through is an internal error this module did not author.** An
     * `INTERNAL_SERVER_ERROR` is the one code whose message is written for operators rather than for callers,
     * and a collaborator's internal message can name a table, a column, a configuration key or a strategy
     * class. Only the internal message this module authors — see {@link OWN_INTERNAL_MESSAGES}, which has
     * exactly one member — is forwarded; any other is reported as this module's own generic failure and
     * logged like any unclassified one, so a platform internal is neither published to the caller nor copied
     * into the log.
     *
     * **What reaches the log, and what deliberately does not.** The log line carries three things this file
     * chose: the fixed operation code, a fixed classification of the failure's shape, and a fresh correlation
     * id that distinguishes one occurrence from the next. It carries **no** part of the caught value — not
     * `message`, not `stack`, not the failing statement, not its parameters, not a constraint name. A driver
     * failure's message routinely contains the SQL it was executing together with schema and column names,
     * often the conflicting values, and on some drivers a filesystem path; an application log outlives the
     * request and is read by people and tools that were never entitled to any of that, which is the whole of
     * CWE-532. An operator who needs statement-level detail turns on the platform's own TypeORM logging,
     * which is a deployment decision made deliberately and with the retention consequences understood —
     * rather than one this plugin makes for every deployment by copying driver text into its own log.
     *
     * **The error that leaves here carries no frame list either**, because this file's own log line is not the
     * last one written about it: the platform's exception filter logs `exception.stack` for every error a
     * resolver raises. See {@link withoutStackFrames} for why sanitising the message and keeping the frames
     * closes the boundary only as far as the edge of this file.
     *
     * **Nothing is swallowed.** The failure still terminates the operation, as an `InternalServerError` under
     * the platform's `INTERNAL_SERVER_ERROR` code carrying one generic sentence, identical for every
     * operation and every cause so that the message itself cannot become the channel this method closes.
     *
     * @param err - The caught failure.
     * @param operation - The fixed operation code the failure is logged under. Never returned to the caller.
     * @returns Never — the declared return type lets a caller write `return this.rethrowSanitisedFailure(…)`
     * and keeps reachability analysis correct at every call site.
     */
    private rethrowSanitisedFailure(err: unknown, operation: ReorderListOperation): never {
        if (err instanceof I18nError && this.isClassifiedForCaller(err)) {
            throw withoutStackFrames(err);
        }
        const correlationId = randomUUID();
        Logger.error(
            `The reorder list operation ${operation} failed with ${this.classifyFailure(err)} ` +
                `(correlation id ${correlationId})`,
            loggerCtx,
        );
        throw withoutStackFrames(new InternalServerError(UNCLASSIFIED_FAILURE_MESSAGE));
    }

    /**
     * Whether a platform error is one whose own code and message may be given to the caller.
     *
     * Every code other than `INTERNAL_SERVER_ERROR` describes a decision about the request — the input was
     * malformed, the session may not do this, the page size is above the configured limit — so its message is
     * written for whoever made the request and is forwarded. `INTERNAL_SERVER_ERROR` is the one code that
     * describes the server instead, and its message is therefore only safe to forward when this module wrote
     * it. That is a narrow, enumerated test rather than a judgement: the one message this module authors is
     * declared in {@link OWN_INTERNAL_MESSAGES}, and anything else — an internal error from a platform
     * collaborator this service calls into — is reported as this module's own generic failure.
     */
    private isClassifiedForCaller(err: I18nError): boolean {
        return err.code !== INTERNAL_SERVER_ERROR_CODE || OWN_INTERNAL_MESSAGES.has(err.message);
    }

    /**
     * Describes the *shape* of an unclassified failure, using only strings this file owns.
     *
     * The classification itself lives in the module function {@link classifyReorderListFailure}, because the
     * api layer needs the identical treatment for the failures it catches at its own boundary and a second
     * implementation there could drift into copying the driver's words. This member is the service-side name
     * for it, kept so that every sanitising path in the class reads the same way.
     */
    private classifyFailure(err: unknown): ReorderListFailureClass {
        return classifyReorderListFailure(err);
    }

    /**
     * Whether a caught driver failure is a violation of the one named database object described.
     *
     * **A textual, case-insensitive search is the portable test here, and that is a considered choice rather
     * than a lazy one.** Every supported engine reports the offending object differently — in the message
     * body, in a driver-specific field, quoted, bracketed, or with a table prefix — and on the MySQL family a
     * named `UNIQUE` constraint materialises as a named unique *index* rather than as a constraint object,
     * under the same name. There is consequently no single structured field that carries an identifier on all
     * four engines, so the search covers the message together with the driver-specific fields the common
     * drivers populate, and is case-insensitive because engines differ in how they case an identifier they
     * echo back.
     *
     * Two spellings are accepted and they identify the same one object, described in
     * {@link ReorderListConstraintDescriptor}: the object's **name**, which MySQL, MariaDB and PostgreSQL
     * report, and the object's **exact qualified column list** beside the SQLite family's own
     * `UNIQUE constraint failed` wording, which is all that family reports. The column form requires *every*
     * one of the object's columns to be present, so it cannot match a different object on the same table or
     * the same object on a different table.
     *
     * What is deliberately not tested is an error class or a vendor error code: `ER_DUP_ENTRY` and `23505`
     * identify "some unique violation", which is precisely the width this method exists not to have.
     */
    private violatesConstraint(err: unknown, constraint: ReorderListConstraintDescriptor): boolean {
        const texts = this.collectFailureTexts(err);
        if (texts.length === 0) {
            return false;
        }
        const name = constraint.name.toLowerCase();
        if (texts.some(text => text.includes(name))) {
            return true;
        }
        const qualifiedColumns = constraint.columns.map(column =>
            `${constraint.table}.${column}`.toLowerCase(),
        );
        return texts.some(
            text =>
                text.includes(SQLITE_UNIQUE_VIOLATION_TEXT) &&
                qualifiedColumns.every(column => text.includes(column)),
        );
    }

    /**
     * Collects the lower-cased text a driver failure carries, from the wrapper and from one level of the
     * driver error it wraps.
     *
     * One level of unwrapping is enough: TypeORM exposes the driver's own error on `driverError` and no
     * driver nests a second wrapper inside the first. The strings gathered here are read for a match and are
     * never logged or returned — {@link ReorderListService.rethrowSanitisedFailure} is the only thing that
     * writes about a failure, and it writes none of this.
     */
    private collectFailureTexts(err: unknown): string[] {
        if (err == null || typeof err !== 'object') {
            return [];
        }
        const candidate = err as {
            message?: unknown;
            detail?: unknown;
            constraint?: unknown;
            sqlMessage?: unknown;
            driverError?: unknown;
        };
        const driverError =
            candidate.driverError != null && typeof candidate.driverError === 'object'
                ? (candidate.driverError as {
                      message?: unknown;
                      detail?: unknown;
                      constraint?: unknown;
                      sqlMessage?: unknown;
                  })
                : {};
        return [
            candidate.message,
            candidate.detail,
            candidate.constraint,
            candidate.sqlMessage,
            driverError.message,
            driverError.detail,
            driverError.constraint,
            driverError.sqlMessage,
        ].reduce<string[]>((texts, value) => {
            if (typeof value === 'string' && value !== '') {
                texts.push(value.toLowerCase());
            }
            return texts;
        }, []);
    }
}
