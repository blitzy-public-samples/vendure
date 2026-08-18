/*
 * -------------------------------------------------------------------------------------------------------
 * Unit specification for the reorder list service — what it pins, and what it deliberately leaves to the
 * end-to-end suites.
 * -------------------------------------------------------------------------------------------------------
 * Attribution. No user-specified rules were provided for this project: the rules document was read and
 * returned exactly "No user rules provided.", and EPIC-001 reaches the same finding independently in its
 * own section 11.9. Nothing asserted below is, or derives from, a user-specified rule, and the absence of
 * a rules document has not been treated as licence to assert less. Every clause pinned here traces to
 * FEATURE-001-01 (sections 2.6.1.1, 2.6.2, 2.6.2.1, 2.6.3, 2.7 and 2.11), to an acceptance criterion of
 * STORY-001-01-01 through STORY-001-01-04, or to an EPIC-001 settled ruling (R2, R3, R13, R14, R17, R19),
 * and is attributed at the assertion that pins it.
 *
 * Where this file lives, and why. It sits beside the module it tests and carries the `.spec.ts` suffix,
 * which is this repository's stated convention for a unit test [CONTRIBUTING.md:L428]. The package's
 * Vitest configuration confines unit discovery to `src` and excludes `e2e` outright, and its
 * `unplugin-swc` transform sets `useDefineForClassFields: false` — which is load-bearing rather than
 * incidental here, because `ReorderListService` is `@Injectable()` and carries constructor-parameter
 * decorators that any other transform would mis-emit.
 *
 * WHAT THIS FILE PROVES. The branching logic the service applies around its statements: which statement
 * it composes, what it does with an affected-row count, which error it selects, and what it returns. That
 * is a different claim from "the database enforces this", and the difference is the whole reason both
 * kinds of test exist.
 *
 * The three shapes that would pass an outcome-only test while being wrong, and are therefore asserted
 * structurally here rather than through a return value:
 *
 * 1. THE COMPOSED PREDICATE. `findOne({ where: { id } })` followed by an in-memory ownership check
 *    returns exactly the same `null` a correct implementation returns, so a test that reads only the
 *    return value cannot fail when the behaviour is absent — FEATURE-001-01 section 2.6.1.1 says so in as
 *    many words. The assertions below therefore read the predicate the service handed to the double: the
 *    row's own identifier together with the acting customer and the active channel, in ONE statement,
 *    returning zero rows. The negative form is asserted too, because it is the actual defect: no refused
 *    path issues a statement whose predicate carries the identifier alone.
 *
 *    Two consequences of that are worth naming, because both were once asserted more loosely than the
 *    claim requires. A value is only evidence of a scope when the PREDICATE reaches it: a statement can
 *    carry a bound parameter it never references, so `scopeBoundBy` follows the placeholder the predicate
 *    names rather than reading the parameter bag. And a line row holds neither a customer nor a channel,
 *    so its writes carry the pair in a correlated `EXISTS` over the parent table — which `toContain('EXISTS')`
 *    says nothing about, since an uncorrelated or unscoped sub-query passes that test while reaching every
 *    buyer's rows. `ownershipSubqueryOf` parses the whole sub-query instead and each of its parts is
 *    asserted: the table, the correlation to the row being written, and the two comparisons resolved
 *    through their own placeholders.
 * 2. THE AFFECTED-ROW COUNT AS THE AUTHORITY. A read-then-write cannot distinguish "applied" from
 *    "matched nothing", and on a counter it silently loses one of two concurrent writes. Each of the four
 *    mutate and remove paths is therefore driven at an affected count of one and again at zero, and both
 *    branches are asserted — including the pair of errors that a conflated implementation would collapse
 *    into one.
 * 3. THE APPENDED TIE-BREAK. The platform merges `Object.assign({}, options.sort, extendedOptions.orderBy)`
 *    [packages/core/src/service/helpers/list-query-builder/list-query-builder.ts:L309], so a key handed
 *    through `extendedOptions.orderBy` lands LAST and nothing else in the builder can append. Asserting on
 *    the arguments handed to `build` is therefore asserting the real mechanism rather than a proxy for it.
 *
 * WHAT THIS FILE DOES NOT DO, stated so a later reader does not add it. It boots no server, opens no
 * database, loads no fixture and uses no `@vendure/testing` harness. Engine behaviour — the named
 * constraints refusing a write, the barrier-released races on MariaDB, MySQL and PostgreSQL, the
 * migration's up/down/up cycle, and the real statement counts of a live request — belongs to the
 * `e2e/*.e2e-spec.ts` suites, and sql.js is excluded from concurrency evidence entirely
 * [FEATURE-001-01:§2.11]. Nothing here asserts a service-level, latency, throughput, conversion or
 * revenue figure, and nothing here asserts a timing [FEATURE-001-01:§2.12].
 *
 * It also constructs the service DIRECTLY rather than through a NestJS testing module, following
 * [packages/core/src/telemetry/collectors/database.collector.spec.ts:L14-L32]. That is a constraint and
 * not a preference: the NestJS testing package is declared only by `packages/core`, this package's
 * manifest declares `@vendure/core` and `@vendure/common` and nothing else, and adding a dependency would
 * breach the invariant that no existing manifest and no lockfile entry changes. Two specs in core do use
 * that module, and both live in the package that declares it.
 *
 * WHY THE DOUBLES ARE AS DETAILED AS THEY ARE. Every claim above is a claim about a statement's shape, so
 * a double that merely returns a value cannot carry the assertion. The recorder below therefore captures
 * the operation, the conditions, the bound parameters, the `SET` expression, the projection, the grouping,
 * the joins, the locks taken and the transaction the statement was issued in, and journals every terminal
 * call — which is what lets one `expect` distinguish "scoped lookup returning nothing" from "unscoped
 * lookup returning a row that was then discarded".
 *
 * AND WHY TWO OF THEM FAIL CLOSED RATHER THAN ALWAYS ANSWERING. A double that returns its configured value
 * whatever it was asked lets the statement be wrong while the test stays green, so two of them require the
 * statement to be one that could really have produced the answer:
 *
 *  - THE OWNER LOOK-UP answers with the configured customer row only for a statement that projects the
 *    identifier alone, joins the user relation explicitly, names that user in its predicate and binds it to
 *    the acting session — the session read off the very context the repository was requested with, not a
 *    constant this file owns. Every ownership assertion in this file rests on the row that look-up returns,
 *    so an implementation resolving the owner from an argument, from a literal or from an unscoped read
 *    finds no row and fails loudly instead of writing under the wrong owner.
 *  - THE PER-PARENT TOTALS answer only a statement that is actually a grouped count: the parent column
 *    projected under an alias, `COUNT(*)` under a second, and a `GROUP BY` on the same expression it
 *    projected. Manufacturing perfect totals for a statement missing its grouping is how "the aggregate can
 *    be removed without failing a test" happens.
 *
 * THE RAW QUERY RUNNER IS MODELLED AT ITS REAL ARITY for the same reason — `query(sql, parameters,
 * useStructuredResult)`. Asked for a structured result it answers the platform's normalised shape, whose
 * `affected` is one portable number on every engine; asked without it, it answers what a driver natively
 * returns, which carries no `affected` at all. A double that always returned `{ affected }` would let the
 * flag be dropped and still report the insert as applied.
 * -------------------------------------------------------------------------------------------------------
 */

import { DeletionResponse, DeletionResult, LogicalOperator } from '@vendure/common/lib/generated-types';
import {
    Channel,
    Customer,
    ForbiddenError,
    ID,
    InternalServerError,
    ListQueryBuilder,
    ListQueryOptions,
    Logger,
    ProductVariant,
    ProductVariantService,
    RequestContext,
    RequestContextCacheService,
    TransactionalConnection,
    UserInputError,
} from '@vendure/core';
import { FindOperator } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loggerCtx } from '../constants';
import { ReorderListLine } from '../entities/reorder-list-line.entity';
import { ReorderList } from '../entities/reorder-list.entity';
import { ReorderPlugin } from '../reorder.plugin';
import { ResolvedReorderPluginOptions } from '../types';

import {
    ReorderListLimitError,
    ReorderListLineNotFoundError,
    ReorderListNameConflictError,
    ReorderListNotFoundError,
    ReorderListService,
} from './reorder-list.service';

// -------------------------------------------------------------------------------------------------------
// Identifiers. Sequential by design, because that is what the default id strategy produces and it is
// precisely why an ownership predicate rather than an unguessable id has to be the control
// [FEATURE-001-01:§2.7].
// -------------------------------------------------------------------------------------------------------

const USER_ID = 'T_10';
const CUSTOMER_ID = 'T_5';
const FOREIGN_CUSTOMER_ID = 'T_6';
const CHANNEL_ID = 'T_1';
const FOREIGN_CHANNEL_ID = 'T_2';
const LIST_ID = 'T_100';
const SECOND_LIST_ID = 'T_101';
const LINE_ID = 'T_200';
const OTHER_LINE_ID = 'T_201';
const VARIANT_ID = 'T_300';

/**
 * The two option values this run declares for the bounds under test, kept small so that a boundary can be
 * driven exactly rather than approached. The production defaults are 200 lines and 999 units; the values
 * here are the *configured* ones, and every bound assertion reads the configured number rather than a
 * literal, so a changed option cannot leave an assertion silently testing nothing
 * [FEATURE-001-01:§2.11].
 */
const MAX_LISTS_PER_CUSTOMER = 2;
const MAX_LINES_PER_LIST = 3;
const MAX_QUANTITY_PER_LINE = 10;
const DEFAULT_LISTS_PAGE_SIZE = 25;
const DEFAULT_LINES_PAGE_SIZE = 50;

/**
 * The platform's own Shop-side page cap, mirrored by the `build` double so that the delegation assertions
 * exercise the real refusal rather than a plugin-authored one
 * [packages/core/src/config/default-config.ts:L89].
 */
const SHOP_LIST_QUERY_LIMIT = 100;

/**
 * The exact message keys the service raises, spelled as the plugin's translation bundle registers them.
 * An unregistered key surfaces as the key text itself, so asserting the literal is asserting what a buyer
 * would read [FEATURE-001-01:§2.6].
 */
const QUANTITY_MUST_BE_POSITIVE_KEY = 'error.reorder-list-line-quantity-must-be-positive';
const QUANTITY_ABOVE_MAXIMUM_KEY = 'error.reorder-list-line-quantity-above-maximum';
const VARIANT_NOT_FOUND_KEY = 'error.reorder-list-variant-not-found';

/**
 * The two named database objects whose failures the service must tell apart, and the generic message every
 * unclassified failure is re-raised with. The generic message is asserted as an exact string rather than a
 * substring, because "contains no driver text" is only checkable against a message this file knows in full
 * [STORY-001-01-01:§DoD].
 */
const NAME_CONFLICT_CONSTRAINT = 'UQ_reorder_list_customer_channel_name_key';
const LINE_DEDUPLICATION_CONSTRAINT = 'UQ_reorder_list_line_list_variant';
const UNCLASSIFIED_FAILURE_MESSAGE = 'The reorder list request could not be completed';

/**
 * Values for the two members the entity mapping WITHDREW — a per-line request-deduplication key and its
 * request fingerprint.
 *
 * They exist so that "the add path never reads them" is asserted against a request that actually supplies
 * them. Passing only the three legal fields and describing the fourth in a comment proves nothing: an
 * implementation that consumed or persisted an undeclared member only when one was present would pass, because
 * none ever was. The values are distinctive strings so a single search of the journal can establish that
 * neither reached a statement, a parameter or an inserted value [FEATURE-001-01:§2.11].
 */
const WITHDRAWN_IDEMPOTENCY_SENTINEL = 'withdrawn-add-claim-key-4f2c81';
const WITHDRAWN_FINGERPRINT_SENTINEL = 'withdrawn-add-claim-print-9b73ad';

/**
 * The identifier-escaping marker the `driver.escape` double wraps every identifier in.
 *
 * It is deliberately not a real quoting character. A raw fragment that hard-codes `"lineCount"` instead of
 * asking the driver to quote it passes on sql.js and fails only on PostgreSQL, so the marker converts a
 * one-engine production defect into a unit assertion that runs in milliseconds.
 */
const ESCAPE_PREFIX = '<<';
const ESCAPE_SUFFIX = '>>';

function escaped(identifier: string): string {
    return `${ESCAPE_PREFIX}${identifier}${ESCAPE_SUFFIX}`;
}

/**
 * The property names each plugin entity declares, used by the metadata double to answer the column
 * look-ups the raw fragments perform. Declared as data rather than derived from TypeORM metadata, because
 * building real metadata would require a connection and this file has none by design.
 */
const REORDER_LIST_COLUMNS = [
    'id',
    'createdAt',
    'updatedAt',
    'customerId',
    'channelId',
    'name',
    'nameKey',
    'lineCount',
];
const REORDER_LIST_LINE_COLUMNS = [
    'id',
    'createdAt',
    'updatedAt',
    'reorderListId',
    'productVariantId',
    'quantity',
];

const REORDER_LIST_TABLE = 'reorder_list';
const REORDER_LIST_LINE_TABLE = 'reorder_list_line';

// -------------------------------------------------------------------------------------------------------
// The statement journal. This is the instrument every structural assertion in this file reads.
// -------------------------------------------------------------------------------------------------------

/** Which table a statement was addressed to. `Unknown` exists so that an unexpected repository request is
 * recorded rather than silently served, which is what makes "no other repository is requested" checkable
 * [FEATURE-001-01:§2.11]. */
type ProbedEntity = 'Customer' | 'ReorderList' | 'ReorderListLine' | 'Unknown';

/** The four statement kinds the service composes. `select` covers every read; the other three are the
 * write half that a refused caller must produce none of [FEATURE-001-01:§2.6.1.1]. */
type StatementOperation = 'select' | 'update' | 'delete' | 'insert';

/**
 * One statement, captured at the moment its terminal method was called.
 *
 * The fields are a snapshot rather than a live reference to the builder, because the service reuses and
 * clones builders — a live reference would let a later mutation rewrite history and an assertion would then
 * describe the wrong statement.
 */
interface JournalledStatement {
    entity: ProbedEntity;
    operation: StatementOperation;
    /** Which builder or repository method actually issued it, so a read cannot be mistaken for a write. */
    terminal: string;
    /** Zero outside a transaction; otherwise the ordinal of the transaction that was open at the time. */
    transaction: number;
    /** The string conditions in composition order, which together are the statement's `WHERE` clause. */
    conditions: string[];
    /** Every bound parameter, merged across `where`, `andWhere` and `setParameters`. */
    parameters: Record<string, unknown>;
    /** Lock modes requested before the statement was issued. */
    locks: string[];
    /**
     * The projection, in composition order — each entry the expression the statement selected and the alias
     * it selected it under.
     *
     * Recorded because a projection is part of a statement's meaning and not a detail of its formatting. Two
     * of this file's claims are unassertable without it: that the locked owner look-up reads the customer's
     * IDENTIFIER and nothing else, so no personal field reaches process memory; and that the per-parent
     * totals are a grouped `COUNT(*)` over the parent column rather than a count of something else that
     * happens to return the same number for the fixture in hand.
     */
    selections: Array<{ expression: unknown; alias?: string }>;
    /** The `GROUP BY` expressions, which is what makes a per-parent aggregate distinguishable from a total. */
    groupings: unknown[];
    /**
     * The join arguments in composition order, exactly as they were passed.
     *
     * The locked owner look-up joins `Customer.user` explicitly rather than through a find-options relation
     * condition, because PostgreSQL refuses `FOR UPDATE` on the nullable side of an outer join and TypeORM
     * realises a relation condition as a LEFT join. That is a correctness property of one engine, so the join
     * form is recorded and asserted rather than assumed.
     */
    joins: unknown[];
    /** The `SET` clause of an `UPDATE`, with function-valued entries left unresolved for inspection. */
    updateSet?: Record<string, unknown>;
    /** The values of an `INSERT`. */
    insertValues?: Record<string, unknown>;
    /** The find-options object of a repository call or of a `ListQueryBuilder` server-side scope. */
    findOptions?: Record<string, unknown>;
}

/** One `ListQueryBuilder.build` invocation, captured whole so that the options and the extended options
 * can be asserted separately — which matters because the tie-break lives in exactly one of them. */
interface JournalledBuild {
    entity: ProbedEntity;
    options: Record<string, unknown>;
    extendedOptions: Record<string, unknown>;
    probe: QueryBuilderProbe;
}

/**
 * The two shapes TypeORM's own `orderBys` map takes: a bare direction, and an object carrying the direction
 * alongside a nulls-ordering. Both are reproduced because the service reads the map directly when it builds
 * the per-parent ranking expression, and a reader that handled only one form would fail on the other.
 */
type ProbedOrderBy = Record<string, string | { order: string; nulls?: string }>;

/**
 * Resolves or rejects the way a real query builder does.
 *
 * A TypeORM terminal returns a promise and reports a driver failure by REJECTING it, never by throwing
 * synchronously. Reproducing that is not pedantry: a synchronous throw would escape a `try` the service
 * placed around an `await`, so a double that threw would exercise a control flow the production code never
 * meets and a failure-path assertion would be describing the harness.
 */
function settled<T>(produce: () => T): Promise<T> {
    try {
        return Promise.resolve(produce());
    } catch (err: unknown) {
        return Promise.reject(err);
    }
}

function tableFor(entity: ProbedEntity): string {
    if (entity === 'ReorderList') {
        return REORDER_LIST_TABLE;
    }
    if (entity === 'ReorderListLine') {
        return REORDER_LIST_LINE_TABLE;
    }
    return entity.toLowerCase();
}

/**
 * A chainable stand-in for TypeORM's `SelectQueryBuilder` that records instead of executing.
 *
 * Two of its behaviours are faithful reproductions rather than conveniences, and the tests depend on both:
 * `orderBy()` with no argument CLEARS the accumulated ordering exactly as TypeORM's does, which is what the
 * service relies on when it re-projects a cloned builder; and `clone()` returns an independent copy, so a
 * projection applied to a clone cannot reach back into the original.
 */
class QueryBuilderProbe {
    readonly conditions: string[] = [];
    readonly parameters: Record<string, unknown> = {};
    readonly locks: string[] = [];
    readonly selections: Array<{ expression: unknown; alias?: string }> = [];
    readonly groupings: unknown[] = [];
    readonly joins: unknown[] = [];
    operation: StatementOperation = 'select';
    updateSet?: Record<string, unknown>;
    insertValues?: Record<string, unknown>;
    conflictIgnored = false;
    findOptions?: Record<string, unknown>;
    expressionMap: { take?: number; skip?: number; orderBys: ProbedOrderBy } = { orderBys: {} };

    constructor(
        private readonly harness: ServiceHarness,
        readonly entity: ProbedEntity,
        readonly alias: string,
        readonly transaction: number,
        /**
         * The active user of the `RequestContext` the repository that produced this builder was requested
         * with, or `undefined` for a builder the harness produced without one.
         *
         * It is the anchor the owner look-up is judged against. A double that answered with the configured
         * customer row whatever the statement asked for would let an implementation bind a constant, bind
         * another session's identifier, or drop the predicate altogether — and every ownership assertion in
         * this file rests on the row that look-up returns. Recording the identifier the service was GIVEN,
         * rather than the one the test expects, is what makes the check independent of the assertion.
         */
        readonly requestedByUserId?: unknown,
    ) {}

    select(expression?: unknown, alias?: string): this {
        if (expression === undefined) {
            return this;
        }
        this.selections.length = 0;
        this.selections.push({ expression, alias });
        return this;
    }

    addSelect(expression: unknown, alias?: string): this {
        this.selections.push({ expression, alias });
        return this;
    }

    innerJoin(...args: unknown[]): this {
        this.joins.push(args);
        return this;
    }

    leftJoin(...args: unknown[]): this {
        this.joins.push(args);
        return this;
    }

    where(condition: unknown, parameters?: Record<string, unknown>): this {
        this.conditions.length = 0;
        return this.andWhere(condition, parameters);
    }

    andWhere(condition: unknown, parameters?: Record<string, unknown>): this {
        if (typeof condition === 'string') {
            this.conditions.push(condition);
        } else {
            this.findOptions = { ...(this.findOptions ?? {}), where: condition };
        }
        return this.setParameters(parameters ?? {});
    }

    setParameters(parameters: Record<string, unknown>): this {
        Object.assign(this.parameters, parameters);
        return this;
    }

    setLock(mode: string): this {
        this.locks.push(mode);
        return this;
    }

    orderBy(sort?: unknown, order?: unknown): this {
        if (sort === undefined) {
            this.expressionMap.orderBys = {};
            return this;
        }
        if (typeof sort === 'string') {
            this.expressionMap.orderBys[sort] = typeof order === 'string' ? order : 'ASC';
            return this;
        }
        this.expressionMap.orderBys = { ...(sort as ProbedOrderBy) };
        return this;
    }

    groupBy(grouping?: unknown): this {
        this.groupings.push(grouping);
        return this;
    }

    take(count?: number): this {
        this.expressionMap.take = count;
        return this;
    }

    skip(count?: number): this {
        this.expressionMap.skip = count;
        return this;
    }

    update(): this {
        this.operation = 'update';
        return this;
    }

    delete(): this {
        this.operation = 'delete';
        return this;
    }

    insert(): this {
        this.operation = 'insert';
        return this;
    }

    set(values: Record<string, unknown>): this {
        this.updateSet = values;
        return this;
    }

    values(values: Record<string, unknown>): this {
        this.insertValues = values;
        return this;
    }

    orIgnore(): this {
        this.conflictIgnored = true;
        return this;
    }

    clone(): QueryBuilderProbe {
        const copy = this.harness.createProbe(
            this.entity,
            this.alias,
            this.transaction,
            this.requestedByUserId,
        );
        copy.conditions.push(...this.conditions);
        Object.assign(copy.parameters, this.parameters);
        copy.locks.push(...this.locks);
        copy.selections.push(...this.selections);
        copy.groupings.push(...this.groupings);
        copy.joins.push(...this.joins);
        copy.operation = this.operation;
        copy.updateSet = this.updateSet;
        copy.insertValues = this.insertValues;
        copy.conflictIgnored = this.conflictIgnored;
        copy.findOptions = this.findOptions ? { ...this.findOptions } : undefined;
        copy.expressionMap = {
            take: this.expressionMap.take,
            skip: this.expressionMap.skip,
            orderBys: { ...this.expressionMap.orderBys },
        };
        return copy;
    }

    /**
     * Renders a statement without issuing it, exactly as TypeORM's own `getQuery()` does. It is
     * deliberately NOT journalled: a rendered sub-query that is embedded in another statement is not itself
     * a statement, and counting it would inflate every per-page number this file asserts
     * [FEATURE-001-01:§2.6.3].
     *
     * An `INSERT` renders as an `INSERT`, and that is not cosmetic. The insert path renders its statement
     * here and then hands the text to a query runner, so a builder that rendered a `SELECT` for it would put
     * a read into the journal where a write belongs — and "the statement issued through the runner was the
     * generated insert" would be unassertable.
     */
    getQuery(): string {
        if (this.operation === 'insert') {
            const columns = Object.keys(this.insertValues ?? {});
            const placeholders = columns.map((_, index) => `$${String(index + 1)}`);
            const ignore = this.conflictIgnored ? ' ON CONFLICT DO NOTHING' : '';
            return (
                `INSERT INTO ${tableFor(this.entity)}(${columns.join(', ')})` +
                ` VALUES (${placeholders.join(', ')})${ignore}`
            );
        }
        const projection = this.selections.length
            ? this.selections
                  .map(entry => `${String(entry.expression)}${entry.alias ? ` AS ${entry.alias}` : ''}`)
                  .join(', ')
            : `${this.alias}.*`;
        const predicate = this.conditions.length ? ` WHERE ${this.conditions.join(' AND ')}` : '';
        return `SELECT ${projection} FROM ${tableFor(this.entity)} ${this.alias}${predicate}`;
    }

    /**
     * The rendered statement together with the positional parameters it binds, as TypeORM's own
     * `getQueryAndParameters()` returns them.
     *
     * An `INSERT` binds its VALUES rather than its predicate — it has no predicate — so the array is the
     * inserted values in column order. Returning the (empty) predicate parameters for it instead would make
     * the insert path's parameter array unassertable, and a service that generated the statement but bound
     * the wrong values would pass.
     */
    getQueryAndParameters(): [string, unknown[]] {
        const values =
            this.operation === 'insert'
                ? Object.values(this.insertValues ?? {})
                : Object.values(this.parameters);
        return [this.getQuery(), values];
    }

    getOne(): Promise<unknown> {
        this.record('getOne');
        return settled(() => this.harness.resolveGetOne(this));
    }

    getMany(): Promise<unknown[]> {
        this.record('getMany');
        return settled(() => this.harness.resolveGetMany(this));
    }

    getRawMany(): Promise<Array<Record<string, unknown>>> {
        this.record('getRawMany');
        return settled(() => this.harness.resolveGetRawMany(this));
    }

    getManyAndCount(): Promise<[unknown[], number]> {
        this.record('getManyAndCount');
        return settled(() => this.harness.resolveGetManyAndCount(this));
    }

    getCount(): Promise<number> {
        this.record('getCount');
        return settled(() => this.harness.resolveGetManyAndCount(this)[1]);
    }

    execute(): Promise<{ affected: number }> {
        this.record('execute');
        return settled(() => ({ affected: this.harness.resolveAffected(this) }));
    }

    private record(terminal: string): void {
        this.harness.journal.push({
            entity: this.entity,
            operation: this.operation,
            terminal,
            transaction: this.transaction,
            conditions: [...this.conditions],
            parameters: { ...this.parameters },
            locks: [...this.locks],
            selections: this.selections.map(entry => ({ ...entry })),
            groupings: [...this.groupings],
            joins: [...this.joins],
            updateSet: this.updateSet ? { ...this.updateSet } : undefined,
            insertValues: this.insertValues ? { ...this.insertValues } : undefined,
            findOptions: this.findOptions ? { ...this.findOptions } : undefined,
        });
    }
}

// -------------------------------------------------------------------------------------------------------
// The plan. Every double reads its answers from here, so a test states the database state it is asserting
// against as data rather than by re-wiring the harness.
// -------------------------------------------------------------------------------------------------------

interface HarnessPlan {
    /** What `rawConnection.options.type` reports, which is the only input to the locking branch. */
    engine: string;
    customerRow: Customer | null;
    /** Where set, every owner look-up fails with this value — the one statement every operation issues
     * before its own, and therefore the one that must also be inside the disclosure boundary. */
    customerFailure?: unknown;
    /** The properties the metadata double will resolve, so a missing column can be driven deliberately. */
    listColumns: string[];
    lineColumns: string[];
    /** A repository `findOne` against `reorder_list`, answered from the predicate it was handed. */
    listFindOne: (options: Record<string, unknown>) => ReorderList | null;
    /** A builder `getOne` against `reorder_list`. */
    listGetOne: (probe: QueryBuilderProbe) => ReorderList | null;
    listPage: (probe: QueryBuilderProbe) => [ReorderList[], number];
    heldListCount: number;
    listAffected: (probe: QueryBuilderProbe) => number;
    lineGetOne: (probe: QueryBuilderProbe) => ReorderListLine | null;
    lineAffected: (probe: QueryBuilderProbe) => number;
    linePage: (probe: QueryBuilderProbe) => ReorderListLine[];
    /** Per-parent totals, keyed by parent identifier, answered through the grouped-count projection. */
    lineTotals: Record<string, number>;
    /**
     * Where set, the line insert FAILS with this value rather than inserting — which is how a losing insert
     * is driven now that the statement is an ordinary insert rather than an ignoring one. A duplicate is a
     * raised violation of the named line-uniqueness object, so the double raises one.
     */
    lineInsertFailure?: unknown;
    variant: ProductVariant | undefined;
    saveList: (entity: ReorderList) => ReorderList;
    /** An optional last step applied to every built query, used to express an ordering map the platform
     * legitimately produces but this harness would not otherwise construct. */
    decorateBuiltQuery?: (probe: QueryBuilderProbe) => void;
}

/**
 * The whole collaborator surface of `ReorderListService`, doubled.
 *
 * It is one class rather than a bag of `vi.fn()`s because the doubles have to agree with one another: a
 * repository handed a transaction-scoped context must tag its statements with that transaction, a cloned
 * builder must register itself so that per-page statement counts stay honest, and the metadata double must
 * answer for whichever entity the raw fragment asked about. Wiring that per test is how a suite ends up
 * asserting the harness rather than the subject.
 */
class ServiceHarness {
    readonly journal: JournalledStatement[] = [];
    readonly builds: JournalledBuild[] = [];
    readonly probes: QueryBuilderProbe[] = [];
    readonly repositoryRequests: string[] = [];
    readonly metadataRequests: string[] = [];
    readonly escapedIdentifiers: string[] = [];
    transactionsOpened = 0;

    readonly plan: HarnessPlan = {
        engine: 'postgres',
        customerRow: new Customer({ id: CUSTOMER_ID }),
        listColumns: [...REORDER_LIST_COLUMNS],
        lineColumns: [...REORDER_LIST_LINE_COLUMNS],
        listFindOne: () => ownedList(),
        listGetOne: () => ownedList(),
        listPage: () => [[ownedList()], 1],
        heldListCount: 0,
        listAffected: () => 1,
        lineGetOne: () => null,
        lineAffected: () => 1,
        linePage: () => [],
        lineTotals: {},
        variant: { id: VARIANT_ID } as ProductVariant,
        saveList: entity => {
            entity.id = LIST_ID;
            return entity;
        },
    };

    readonly productVariantService = {
        findOne: vi.fn(() => settled(() => this.plan.variant)),
        /** Present so that "no availability is read" can be asserted at exactly zero calls. A discarded
         * read is still a read, and a zero-call assertion is the only form of that claim a test can fail
         * [STORY-001-01-02:AC-5]. */
        getSaleableStockLevel: vi.fn(() => Promise.resolve(0)),
        getDisplayStockLevel: vi.fn(() => ''),
    };

    readonly listQueryBuilder = {
        build: vi.fn(
            (
                entity: unknown,
                options: Record<string, unknown> = {},
                extendedOptions: Record<string, unknown> = {},
            ) => this.buildListQuery(entity, options, extendedOptions),
        ),
    };

    readonly connection: TransactionalConnection;

    private readonly transactionIds = new WeakMap<object, number>();

    constructor() {
        const connection = {
            getRepository: vi.fn((ctx: unknown, entity: unknown) => this.repositoryFor(ctx, entity)),
            withTransaction: vi.fn(
                (ctx: RequestContext, work: (transactionCtx: RequestContext) => Promise<unknown>) =>
                    this.runInTransaction(ctx, work),
            ),
        };
        // Declared as a getter rather than a fixed value, so a test that changes the configured engine after
        // the service was constructed is reflected the next time the service reads it.
        Object.defineProperty(connection, 'rawConnection', {
            enumerable: true,
            get: () => this.rawConnection(),
        });
        this.connection = connection as unknown as TransactionalConnection;
    }

    createProbe(
        entity: ProbedEntity,
        alias: string,
        transaction: number,
        requestedByUserId?: unknown,
    ): QueryBuilderProbe {
        const probe = new QueryBuilderProbe(this, entity, alias, transaction, requestedByUserId);
        this.probes.push(probe);
        return probe;
    }

    resolveGetOne(probe: QueryBuilderProbe): unknown {
        if (probe.entity === 'Customer') {
            return this.resolveLockedCustomerLookup(probe);
        }
        if (probe.entity === 'ReorderList') {
            return this.plan.listGetOne(probe);
        }
        if (probe.entity === 'ReorderListLine') {
            return this.plan.lineGetOne(probe);
        }
        return null;
    }

    resolveGetMany(probe: QueryBuilderProbe): unknown[] {
        return probe.entity === 'ReorderListLine' ? this.plan.linePage(probe) : [];
    }

    /**
     * Answers the grouped-count projection — but ONLY for a statement that is actually a grouped count.
     *
     * Two rules make this a measurement rather than a fabrication, and both were absent when the aliases were
     * defaulted and the shape unread:
     *
     *  - **The shape is required before any total is produced.** The statement must project the parent column
     *    under an alias, project `COUNT(*)` under a second alias, and group by the same expression it
     *    projected as the parent. A statement missing the grouping, counting something else, or grouping by a
     *    different expression is answered with NO rows, which surfaces as a per-parent total of zero and fails
     *    the assertions that read the total. Manufacturing perfect totals for a statement that could not have
     *    produced them is exactly how "removing the `GROUP BY` still passes" happens
     *    [FEATURE-001-01:§2.6.3].
     *  - **The aliases are read back with no fallback.** They are module-private to the service, so a test
     *    duplicating them would keep passing after a rename while the production read silently returned
     *    zeroes; and a defaulted alias would answer a statement that selected no alias at all, which the
     *    service could not then read the value from.
     */
    resolveGetRawMany(probe: QueryBuilderProbe): Array<Record<string, unknown>> {
        const [parentProjection, countProjection, ...extra] = probe.selections;
        const parentExpression = parentProjection?.expression;
        const parentAlias = parentProjection?.alias;
        const countAlias = countProjection?.alias;
        const groupsByParent = probe.groupings.length === 1 && probe.groupings[0] === parentExpression;
        const countsRows =
            typeof countProjection?.expression === 'string' &&
            countProjection.expression.replace(/\s+/g, '').toUpperCase() === 'COUNT(*)';
        const aliased =
            typeof parentAlias === 'string' &&
            parentAlias.length > 0 &&
            typeof countAlias === 'string' &&
            countAlias.length > 0 &&
            parentAlias !== countAlias;
        if (extra.length > 0 || !aliased || !countsRows || !groupsByParent) {
            return [];
        }
        return Object.entries(this.plan.lineTotals).map(([parentId, total]) => ({
            [parentAlias]: parentId,
            [countAlias]: total,
        }));
    }

    resolveGetManyAndCount(probe: QueryBuilderProbe): [unknown[], number] {
        return probe.entity === 'ReorderList' ? this.plan.listPage(probe) : [[], 0];
    }

    resolveAffected(probe: QueryBuilderProbe): number {
        if (probe.entity === 'ReorderList') {
            return this.plan.listAffected(probe);
        }
        if (probe.entity === 'ReorderListLine') {
            if (probe.operation === 'insert') {
                // An insert either inserts its row or raises. There is no affected-row count to read and no
                // ignore form to absorb a conflict, so a duplicate arrives here as a driver failure carrying
                // the named line-uniqueness object [FEATURE-001-01:§2.11].
                if (this.plan.lineInsertFailure !== undefined) {
                    throw this.plan.lineInsertFailure;
                }
                return 1;
            }
            return this.plan.lineAffected(probe);
        }
        return 0;
    }

    transactionOf(ctx: unknown): number {
        return typeof ctx === 'object' && ctx !== null ? (this.transactionIds.get(ctx) ?? 0) : 0;
    }

    /**
     * The active user of a request context, read through the platform's own accessor so that a
     * transaction-scoped child context — a prototype-linked object rather than a copy — reports the same
     * session as its parent.
     */
    activeUserIdOf(ctx: unknown): unknown {
        return typeof ctx === 'object' && ctx !== null ? (ctx as RequestContext).activeUserId : undefined;
    }

    /**
     * Answers the LOCKING owner look-up the create path performs, and answers it only for a statement that
     * could actually have resolved the acting customer.
     *
     * Four properties are required, and each one exists because dropping it is a live defect that no
     * response-shaped assertion could see:
     *
     *  - **The projection is the identifier alone.** `Customer` carries personal data and an eagerly declared
     *    `user` relation, so a look-up whose entire output is one id must say so; a widened projection loads
     *    fields that can then reach a log line or a serialised context [FEATURE-001-01:§2.7].
     *  - **The join is the explicit inner join to `user`.** A find-options relation condition is realised as a
     *    LEFT join and PostgreSQL refuses `FOR UPDATE` on its nullable side, so the locking form would fail on
     *    exactly one engine — a one-engine failure this unit file can catch in milliseconds.
     *  - **The predicate names the user.** Without it the statement selects an arbitrary customer row, and
     *    every ownership assertion downstream would be scoped to a stranger.
     *  - **The bound value is the ACTING session's user.** Compared against the identifier the repository was
     *    requested with rather than against a constant this file owns, so an implementation that bound a
     *    literal, bound another session's id, or resolved the owner from an argument is refused here.
     *
     * A statement failing any of them is answered with no row, which the service reports as an internal
     * failure — loud, and attributable to the look-up rather than to the operation that followed it.
     */
    private resolveLockedCustomerLookup(probe: QueryBuilderProbe): Customer | null {
        if (this.plan.customerFailure !== undefined) {
            throw this.plan.customerFailure;
        }
        const projectsIdentifierOnly =
            probe.selections.length === 1 &&
            Array.isArray(probe.selections[0].expression) &&
            (probe.selections[0].expression as unknown[]).length === 1 &&
            (probe.selections[0].expression as unknown[])[0] === `${probe.alias}.id`;
        const joinsUserRelation = probe.joins.some(
            join =>
                Array.isArray(join) &&
                join.length >= 2 &&
                join[0] === `${probe.alias}.user` &&
                join[1] === 'user',
        );
        const namesTheUser = probe.conditions.some(
            condition => condition.replace(/\s+/g, '') === 'user.id=:userId',
        );
        if (!projectsIdentifierOnly || !joinsUserRelation || !namesTheUser) {
            return null;
        }
        return this.answerForBoundUser(probe.parameters.userId, probe.requestedByUserId);
    }

    /**
     * Answers the NON-locking owner look-up every other operation performs.
     *
     * The predicate is a find-options object rather than a string here, so the identity check reads the
     * object — but the rule is the same one {@link ServiceHarness.resolveLockedCustomerLookup} applies, and
     * for the same reason: a double that answered with the configured row whatever it was asked would let the
     * acting customer be resolved from anything at all, and every ownership assertion in this file is built
     * on the row it returns.
     */
    private resolveCustomerFindOne(
        options: Record<string, unknown>,
        requestedByUserId: unknown,
    ): Customer | null {
        if (this.plan.customerFailure !== undefined) {
            throw this.plan.customerFailure;
        }
        const where = (options.where ?? {}) as Record<string, unknown>;
        const user = (where.user ?? {}) as Record<string, unknown>;
        return this.answerForBoundUser(user.id, requestedByUserId);
    }

    /**
     * The configured customer row where the look-up bound the acting session's user, and `null` otherwise.
     *
     * The comparison is on the stringified values because the configured id strategy decides whether an
     * identifier is a number or a string, and an absent binding is refused rather than read as "any user".
     */
    private answerForBoundUser(boundUserId: unknown, requestedByUserId: unknown): Customer | null {
        if (boundUserId === undefined || boundUserId === null) {
            return null;
        }
        if (requestedByUserId === undefined || String(boundUserId) !== String(requestedByUserId)) {
            return null;
        }
        return this.plan.customerRow;
    }

    private runInTransaction(
        ctx: RequestContext,
        work: (transactionCtx: RequestContext) => Promise<unknown>,
    ): Promise<unknown> {
        this.transactionsOpened += 1;
        // A prototype-linked child rather than a copy, so every getter on RequestContext keeps working
        // while the child remains a distinct object this harness can tag. That tag is what turns "in the
        // same transaction as the delete" into an assertion rather than a hope [FEATURE-001-01:§2.11].
        const transactionCtx = Object.create(ctx) as RequestContext;
        this.transactionIds.set(transactionCtx, this.transactionsOpened);
        return work(transactionCtx);
    }

    private rawConnection(): unknown {
        // Rebuilt on every access, which is what keeps `options.type` current without a captured alias.
        return {
            options: { type: this.plan.engine },
            driver: {
                escape: (identifier: string) => {
                    this.escapedIdentifiers.push(identifier);
                    return escaped(identifier);
                },
            },
            getMetadata: (entity: unknown) => this.metadataFor(entity),
        };
    }

    private metadataFor(entity: unknown): unknown {
        const name = this.entityNameOf(entity);
        this.metadataRequests.push(name);
        const columns =
            name === 'ReorderList'
                ? this.plan.listColumns
                : name === 'ReorderListLine'
                  ? this.plan.lineColumns
                  : [];
        const column = (property: string) =>
            columns.includes(property) ? { databaseName: property, propertyName: property } : undefined;
        return {
            name,
            tableName: tableFor(name),
            findColumnWithPropertyName: column,
            findColumnWithPropertyPath: column,
        };
    }

    private repositoryFor(ctx: unknown, entity: unknown): unknown {
        const name = this.entityNameOf(entity);
        this.repositoryRequests.push(name);
        const transaction = this.transactionOf(ctx);
        // The acting session, read off the very context the repository was requested with. Every statement
        // this repository produces is judged against it rather than against a value this file chose, which is
        // what stops a double from certifying a look-up that resolved the owner from somewhere else.
        const requestedByUserId = this.activeUserIdOf(ctx);
        return {
            findOne: vi.fn((options: Record<string, unknown> = {}) =>
                settled<Customer | ReorderList | null>(() => {
                    this.journal.push({
                        entity: name,
                        operation: 'select',
                        terminal: 'findOne',
                        transaction,
                        conditions: [],
                        parameters: {},
                        locks: [],
                        selections: [],
                        groupings: [],
                        joins: [],
                        findOptions: options,
                    });
                    if (name === 'Customer') {
                        return this.resolveCustomerFindOne(options, requestedByUserId);
                    }
                    return name === 'ReorderList' ? this.plan.listFindOne(options) : null;
                }),
            ),
            count: vi.fn((options: Record<string, unknown> = {}) =>
                settled(() => {
                    this.journal.push({
                        entity: name,
                        operation: 'select',
                        terminal: 'count',
                        transaction,
                        conditions: [],
                        parameters: {},
                        locks: [],
                        selections: [],
                        groupings: [],
                        joins: [],
                        findOptions: options,
                    });
                    if (name !== 'ReorderList') {
                        return 0;
                    }
                    // One count exists on the whole service — the list bound's. There is deliberately no
                    // `nameKey` branch here, because a name pre-check is exactly what the create path must not
                    // issue: the named unique object decides every duplicate [FEATURE-001-01:§2.11].
                    return this.plan.heldListCount;
                }),
            ),
            save: vi.fn((row: ReorderList) =>
                settled(() => {
                    this.journal.push({
                        entity: name,
                        operation: 'insert',
                        terminal: 'save',
                        transaction,
                        conditions: [],
                        parameters: {},
                        locks: [],
                        selections: [],
                        groupings: [],
                        joins: [],
                        insertValues: { ...row } as Record<string, unknown>,
                    });
                    return this.plan.saveList(row);
                }),
            ),
            createQueryBuilder: vi.fn((alias?: string) =>
                this.createProbe(name, alias ?? name.toLowerCase(), transaction, requestedByUserId),
            ),
        };
    }

    private buildListQuery(
        entity: unknown,
        options: Record<string, unknown>,
        extendedOptions: Record<string, unknown>,
    ): QueryBuilderProbe {
        const name = this.entityNameOf(entity);
        const ctx = extendedOptions.ctx;
        const probe = this.createProbe(
            name,
            name.toLowerCase(),
            this.transactionOf(ctx),
            this.activeUserIdOf(ctx),
        );
        this.builds.push({ entity: name, options, extendedOptions, probe });

        // Faithful to the platform's own `parseTakeSkipParams`: an over-limit `take` is refused by the
        // BUILDER, with the platform's key and the platform's limit, and an omitted `take` is substituted
        // rather than left unset [packages/core/src/service/helpers/list-query-builder/list-query-builder.ts:L637-L649].
        const requestedTake = options.take;
        const ignoreQueryLimits = extendedOptions.ignoreQueryLimits === true;
        const limit = ignoreQueryLimits ? Number.MAX_SAFE_INTEGER : SHOP_LIST_QUERY_LIMIT;
        if (typeof requestedTake === 'number' && requestedTake > limit) {
            throw new UserInputError('error.list-query-limit-exceeded', { limit });
        }
        probe.expressionMap.take =
            typeof requestedTake === 'number' ? Math.min(Math.max(requestedTake, 0), limit) : limit;
        probe.expressionMap.skip = typeof options.skip === 'number' ? Math.max(options.skip, 0) : 0;

        // The one mechanism by which a tie-break can be appended, reproduced exactly: the extended options'
        // `orderBy` is merged LAST, so its keys land after the caller's and an already-named key keeps the
        // caller's direction [list-query-builder.ts:L309].
        const sortParams = Object.assign({}, options.sort, extendedOptions.orderBy) as Record<string, string>;
        for (const [key, direction] of Object.entries(sortParams)) {
            probe.expressionMap.orderBys[`${probe.alias}.${key}`] = direction;
        }
        if (extendedOptions.where !== undefined) {
            probe.findOptions = { where: extendedOptions.where };
        }
        this.plan.decorateBuiltQuery?.(probe);
        return probe;
    }

    private entityNameOf(entity: unknown): ProbedEntity {
        if (entity === Customer) {
            return 'Customer';
        }
        if (entity === ReorderList) {
            return 'ReorderList';
        }
        if (entity === ReorderListLine) {
            return 'ReorderListLine';
        }
        return 'Unknown';
    }
}

// -------------------------------------------------------------------------------------------------------
// Row fixtures and request contexts.
// -------------------------------------------------------------------------------------------------------

function ownedList(overrides: Partial<ReorderList> = {}): ReorderList {
    return new ReorderList({
        id: LIST_ID,
        customerId: CUSTOMER_ID,
        channelId: CHANNEL_ID,
        name: 'Weekly kitchen restock',
        nameKey: 'weekly kitchen restock',
        lineCount: 0,
        ...overrides,
    });
}

function ownedLine(overrides: Partial<ReorderListLine> = {}): ReorderListLine {
    return new ReorderListLine({
        id: LINE_ID,
        reorderListId: LIST_ID,
        productVariantId: VARIANT_ID,
        quantity: 1,
        ...overrides,
    });
}

/**
 * A repository answer that behaves like a one-row table: the row is returned only where the predicate the
 * service composed actually matches it.
 *
 * This is what makes the ownership assertions mean something. A double that returned the row regardless of
 * the predicate would let an unscoped lookup pass, and a double that returned null regardless would let a
 * missing predicate pass; matching on the predicate the service supplied is the only shape under which the
 * conjuncts have to be present for the right answer to come back [FEATURE-001-01:§2.6.1.1].
 */
function rowMatchingPredicate<T extends object>(row: T): (options: Record<string, unknown>) => T | null {
    return options => {
        const where = (options.where ?? {}) as Record<string, unknown>;
        const matches = Object.entries(where).every(
            ([key, value]) => String((row as Record<string, unknown>)[key]) === String(value),
        );
        return matches ? row : null;
    };
}

function createCtx(overrides: { userId?: ID; channelId?: ID; anonymous?: boolean } = {}): RequestContext {
    const channelId = overrides.channelId ?? CHANNEL_ID;
    const userId = overrides.userId ?? USER_ID;
    return new RequestContext({
        apiType: 'shop',
        channel: new Channel({ id: channelId, code: `channel-${String(channelId)}` }),
        session: overrides.anonymous ? undefined : ({ user: { id: userId } } as any),
        isAuthorized: true,
        // The gate marks the context and then admits the request, because no session can hold
        // `Permission.Owner` — it is declared `assignable: false, internal: true`
        // [packages/core/src/common/constants.ts:L27-L32]. The service predicate is the whole control.
        authorizedAsOwnerOnly: true,
    });
}

// -------------------------------------------------------------------------------------------------------
// Journal queries. Each is named for the claim it supports, so an assertion reads as the clause it pins.
// -------------------------------------------------------------------------------------------------------

function statementsAgainst(harness: ServiceHarness, entity: ProbedEntity): JournalledStatement[] {
    return harness.journal.filter(statement => statement.entity === entity);
}

function pluginStatements(harness: ServiceHarness): JournalledStatement[] {
    return harness.journal.filter(
        statement => statement.entity === 'ReorderList' || statement.entity === 'ReorderListLine',
    );
}

function writeStatements(harness: ServiceHarness): JournalledStatement[] {
    return harness.journal.filter(statement => statement.operation !== 'select');
}

function statementsOfKind(
    harness: ServiceHarness,
    entity: ProbedEntity,
    operation: StatementOperation,
): JournalledStatement[] {
    return statementsAgainst(harness, entity).filter(statement => statement.operation === operation);
}

function conditionTextOf(statement: JournalledStatement): string {
    return statement.conditions.join(' AND ');
}

function whereKeysOf(statement: JournalledStatement): string[] {
    return Object.keys((statement.findOptions?.where ?? {}) as Record<string, unknown>);
}

/**
 * A single comparison of one of the statement's string conditions, parsed rather than searched for.
 *
 * `column` is the compared column with any alias qualifier and any identifier escaping removed; `qualifier`
 * is the alias it was written under, or `undefined` for a bare column; `operand` is the other side exactly as
 * written.
 */
interface ParsedComparison {
    column: string;
    qualifier?: string;
    operand: string;
}

/** Removes the marker the `driver.escape` double wraps identifiers in, leaving the bare name. */
function unescapeIdentifier(token: string): string {
    const match = new RegExp(`^${ESCAPE_PREFIX}(.+)${ESCAPE_SUFFIX}$`).exec(token.trim());
    return match === null ? token.trim() : match[1];
}

/**
 * Parses one `column = operand` condition, accepting the alias-qualified and identifier-escaped spellings the
 * service legitimately produces and rejecting anything more complex.
 *
 * EQUALITY ONLY, and rejecting the complex forms is the point. A scope is a statement that the predicate
 * cannot be satisfied without, so an inequality — a `lineCount < :max` bound, a `quantity <= :max` guard — is
 * a constraint on a column rather than a scope, and a fragment carrying a sub-query, a function call or a
 * second comparison is not a simple comparison at all. Reading either as though it were is how a predicate
 * that constrains nothing gets read as a scope. The whole condition must match, so nothing is recognised from
 * a fragment of one.
 */
function parseComparison(condition: string): ParsedComparison | undefined {
    const escapedToken = `${ESCAPE_PREFIX}[A-Za-z_][A-Za-z0-9_]*${ESCAPE_SUFFIX}`;
    const bareToken = '[A-Za-z_][A-Za-z0-9_]*';
    const token = `(?:${escapedToken}|${bareToken})`;
    const operand = `(?::${bareToken}|${token}|-?\\d+(?:\\.\\d+)?)`;
    const pattern = new RegExp(`^\\s*(?:(${token})\\s*\\.\\s*)?(${token})\\s*=\\s*(${operand})\\s*$`);
    const match = pattern.exec(condition);
    if (match === null) {
        return undefined;
    }
    return {
        column: unescapeIdentifier(match[2]),
        qualifier: match[1] === undefined ? undefined : unescapeIdentifier(match[1]),
        operand: match[3].trim(),
    };
}

/**
 * Resolves a comparison's operand to the value the statement actually compares against: a `:name`
 * placeholder to the parameter of that name, a numeric literal to itself, and anything else — an escaped
 * identifier, so a column-to-column correlation — to `undefined`.
 *
 * Resolving THROUGH the parameter reference is the whole point of this helper. A value read straight out of
 * the parameter bag proves only that the statement carried it somewhere; a value reached by following the
 * placeholder the predicate names proves that this column is compared against that value.
 */
function resolveOperandValue(operand: string, parameters: Record<string, unknown>): unknown {
    if (operand.startsWith(':')) {
        return parameters[operand.slice(1)];
    }
    if (/^-?\d+(\.\d+)?$/.test(operand)) {
        return operand;
    }
    return undefined;
}

/**
 * The value a statement's predicate compares one column against, or `undefined` where the predicate does not
 * compare that column at all.
 *
 * Only the statement's own top-level conditions are read: a conjunct of an `EXISTS` sub-query belongs to the
 * sub-query's relation rather than to this statement's, and treating one as this statement's own is exactly
 * the confusion {@link ownershipSubqueryOf} exists to resolve properly.
 */
function predicateValueFor(statement: JournalledStatement, column: string): unknown {
    for (const condition of statement.conditions) {
        const comparison = parseComparison(condition);
        if (comparison === undefined || comparison.column !== column) {
            continue;
        }
        const value = resolveOperandValue(comparison.operand, statement.parameters);
        if (value !== undefined) {
            return value;
        }
    }
    return undefined;
}

/**
 * The values a statement's PREDICATE compares the acting customer and the active channel against, or
 * `undefined` for either where the predicate does not compare it.
 *
 * It reads every spelling the service legitimately uses and resolves each one through the predicate itself: a
 * find-options `where` object (where the object IS the predicate), its nested `reorderList` scope, a string
 * condition naming a placeholder, and the correlated `EXISTS` sub-query that carries the pair for a statement
 * written against the line table.
 *
 * ★ What it deliberately no longer does is read `parameters.customerId` directly. A statement can carry a
 * bound parameter it never references — `setParameters` binds whatever it is given, and TypeORM does not
 * require every bound name to appear in the SQL — so a value found in the parameter bag is evidence that the
 * value was PRESENT and no evidence at all that the predicate USES it. Deleting the ownership conjuncts while
 * leaving the parameters in place is precisely the shape that would leave a bag-reading assertion green with
 * every buyer's rows reachable, so the value here is reached only by following a reference the predicate makes
 * [FEATURE-001-01:§2.6.1.1].
 */
function scopeBoundBy(statement: JournalledStatement): { customer: unknown; channel: unknown } {
    const where = (statement.findOptions?.where ?? {}) as Record<string, unknown>;
    const nested = (where.reorderList ?? {}) as Record<string, unknown>;
    const subquery = ownershipSubqueryOf(statement);
    return {
        customer:
            where.customerId ??
            nested.customerId ??
            predicateValueFor(statement, 'customerId') ??
            subquery?.customer,
        channel:
            where.channelId ??
            nested.channelId ??
            predicateValueFor(statement, 'channelId') ??
            subquery?.channel,
    };
}

/** The ownership predicate a statement carries through a correlated `EXISTS` sub-query, once parsed. */
interface OwnershipSubquery {
    /** The table the sub-query reads, which must be the list table for the predicate to mean anything. */
    table: string;
    /** The sub-query column the correlation compares — the parent list's own identifier. */
    correlatedColumn: string;
    /** The outer column the correlation compares it to — the line row's reference to its parent. */
    correlatedTo: string;
    /** The value the sub-query compares its customer column against, resolved through the placeholder. */
    customer: unknown;
    /** The value the sub-query compares its channel column against, resolved through the placeholder. */
    channel: unknown;
}

/**
 * Parses the correlated `EXISTS` sub-query a statement against `reorder_list_line` carries its ownership
 * predicate in, or `undefined` where the statement carries no such sub-query in a readable form.
 *
 * ★ WHY THIS EXISTS AND WHY A SUBSTRING TEST IS NOT A SUBSTITUTE. A line row stores neither a customer nor a
 * channel, so the only way a line write can be scoped inside the one statement whose affected-row count is
 * the authority is a sub-query over the parent table [FEATURE-001-01:§2.11]. Asserting that the condition
 * text `toContain('EXISTS')` says nothing about what that sub-query does: `EXISTS (SELECT 1 FROM reorder_list)`
 * is satisfied by ANY list in the table, `EXISTS (SELECT 1 FROM reorder_list ol WHERE ol.customerId = :x)`
 * is satisfied by any of the caller's lists rather than by the addressed one, and a correlation written
 * against the wrong outer column reaches another list's lines. All three pass a substring test and all three
 * are a tenant-isolation defect, so the whole sub-query is parsed and each of its parts asserted:
 *
 *  - the table it reads;
 *  - the correlation, which is what ties it to the row being written rather than to the table at large;
 *  - the customer and channel columns, each resolved THROUGH the placeholder the sub-query names, so a
 *    swapped binding cannot pass.
 *
 * It is deliberately strict and fails closed. Exactly one `EXISTS` conjunct is expected, it must be the whole
 * of its condition, every one of its own conjuncts must be qualified by the alias its `FROM` introduced, and
 * there must be exactly three of them — the correlation and the two scope comparisons. Anything else returns
 * `undefined` rather than a partial reading, because a sub-query this parser cannot read in full is one whose
 * effect it cannot vouch for.
 */
function ownershipSubqueryOf(statement: JournalledStatement): OwnershipSubquery | undefined {
    const existsConditions = statement.conditions.filter(condition => /^\s*EXISTS\s*\(/i.test(condition));
    if (existsConditions.length !== 1) {
        return undefined;
    }
    const body = /^\s*EXISTS\s*\(([\s\S]*)\)\s*$/i.exec(existsConditions[0]);
    if (body === null || body[1].includes('(') || body[1].includes(')')) {
        return undefined;
    }
    const relation = /^\s*SELECT\s+1\s+FROM\s+(\S+)\s+(\S+)\s+WHERE\s+([\s\S]+)$/i.exec(body[1]);
    if (relation === null) {
        return undefined;
    }
    const table = unescapeIdentifier(relation[1]);
    const alias = unescapeIdentifier(relation[2]);
    const conjuncts = relation[3].split(/\s+AND\s+/i);
    if (conjuncts.length !== 3) {
        return undefined;
    }
    const comparisons = new Map<string, ParsedComparison>();
    for (const conjunct of conjuncts) {
        const comparison = parseComparison(conjunct);
        // Every conjunct must belong to the relation the sub-query introduced. An unqualified or
        // differently qualified one is a comparison about some other relation, which is how a self-join or a
        // stray outer reference would be mistaken for the scope.
        if (comparison === undefined || comparison.qualifier !== alias) {
            return undefined;
        }
        comparisons.set(comparison.column, comparison);
    }
    const correlation = comparisons.get('id');
    const customer = comparisons.get('customerId');
    const channel = comparisons.get('channelId');
    if (correlation === undefined || customer === undefined || channel === undefined) {
        return undefined;
    }
    // The correlation's other side must be an ESCAPED outer column reference. Two things are being required
    // there and both matter. A sub-query whose `id` is compared to a bound parameter is not correlated to the
    // row being written at all — it is satisfied by whichever list that parameter names, so a line of any list
    // the caller owns becomes reachable. And an outer reference written without going through the driver's
    // escape is folded to lower case by PostgreSQL, where it then matches no column: a fragment that passes on
    // the in-process engine and fails one engine job.
    const correlatedTo = unescapeIdentifier(correlation.operand);
    if (correlation.operand.startsWith(':') || correlatedTo === correlation.operand) {
        return undefined;
    }
    return {
        table,
        correlatedColumn: correlation.column,
        correlatedTo,
        customer: resolveOperandValue(customer.operand, statement.parameters),
        channel: resolveOperandValue(channel.operand, statement.parameters),
    };
}

/**
 * The complete ownership sub-query a line write must carry, expressed once so that all three line-writing
 * paths assert the same thing and none can quietly differ.
 */
function ownedLineScope(correlatedTo: string): OwnershipSubquery {
    return {
        table: REORDER_LIST_TABLE,
        correlatedColumn: 'id',
        correlatedTo,
        customer: CUSTOMER_ID,
        channel: CHANNEL_ID,
    };
}

function addressesARow(statement: JournalledStatement): boolean {
    const where = (statement.findOptions?.where ?? {}) as Record<string, unknown>;
    if (where.id !== undefined) {
        return true;
    }
    const { id, lineId, listId } = statement.parameters;
    return id !== undefined || lineId !== undefined || listId !== undefined;
}

/**
 * Row look-ups against a plugin table whose predicate carries neither the acting customer nor the active
 * channel — which is exactly the "fetch by id, inspect the row, discard it" shape the instrumented contract
 * exists to reject [FEATURE-001-01:§2.6.1.1].
 *
 * It is applied to refused paths, where the entry look-up is the only statement the operation reaches, so
 * an unscoped look-up there cannot be anything but the forbidden shape. It is deliberately not applied to a
 * successful path, where later statements are legitimately addressed by an identifier the entry look-up has
 * already scoped — asserting it there would be asserting something the contract does not say.
 */
function unscopedRowLookups(harness: ServiceHarness): JournalledStatement[] {
    return pluginStatements(harness).filter(statement => {
        if (statement.operation !== 'select' || !addressesARow(statement)) {
            return false;
        }
        const scope = scopeBoundBy(statement);
        return scope.customer === undefined || scope.channel === undefined;
    });
}

/**
 * The part of a statement the three counter recognisers below need.
 *
 * It is deliberately narrower than {@link JournalledStatement} so that the same recogniser can be applied
 * both to a journalled statement AFTER the fact and to a builder as it is about to be issued — which is what
 * lets a test answer one statement's affected count differently from another's within a single operation.
 */
type CounterStatementShape = Pick<JournalledStatement, 'entity' | 'operation' | 'conditions'> & {
    updateSet?: Record<string, unknown>;
};

/** The conditional counter update that claims a line's worth of capacity, recognised by its bound. */
function isLineCountClaim(statement: CounterStatementShape): boolean {
    return (
        statement.entity === 'ReorderList' &&
        statement.operation === 'update' &&
        statement.conditions.some(condition => condition.includes('lineCount <'))
    );
}

/** The guarded decrement that returns a line's worth of capacity. */
function isLineCountRelease(statement: CounterStatementShape): boolean {
    return (
        statement.entity === 'ReorderList' &&
        statement.operation === 'update' &&
        statement.conditions.some(condition => condition.includes('lineCount >'))
    );
}

/** The compare-and-set repair, recognised by its guard on the stale value. */
function isLineCountRepair(statement: CounterStatementShape): boolean {
    return (
        statement.entity === 'ReorderList' &&
        statement.operation === 'update' &&
        statement.conditions.some(condition => condition.includes('lineCount = :storedLineCount'))
    );
}

/**
 * Resolves one entry of an `UPDATE`'s `SET` clause to the text it will contribute.
 *
 * A function-valued entry is TypeORM's way of writing a raw expression, so resolving it is how an increment
 * is told apart from an absolute assignment — the distinction between a correct accumulation and a lost
 * update [FEATURE-001-01:§2.11].
 */
function setExpressionOf(statement: CounterStatementShape, column: string): string {
    const value = statement.updateSet?.[column];
    return typeof value === 'function' ? String((value as () => unknown)()) : String(value);
}

/**
 * A driver failure shaped the way a real one arrives: a message, and optionally the extra fields the four
 * supported engines attach. `query` is what the service's classifier reads to tell a database failure from a
 * defect, and `driverError` is where MySQL and MariaDB put the wording a name match has to survive.
 */
function driverFailure(message: string, extras: Record<string, unknown> = {}): Error {
    return Object.assign(new Error(message), extras);
}

/**
 * The failure a losing line insert really produces: a violation of the named per-variant uniqueness object.
 *
 * It is spelled as a driver failure rather than as a bare error because that is what the retry has to
 * recognise — the classification is a match on that one constraint name, so a test that threw anything else
 * would prove the retry fires on any failure at all, which is precisely the width the ignore form had
 * [FEATURE-001-01:§2.11].
 */
function duplicateLineViolation(): Error {
    return driverFailure(
        `duplicate key value violates unique constraint "${LINE_DEDUPLICATION_CONSTRAINT}"`,
        { query: 'INSERT INTO "reorder_list_line" ...' },
    );
}

/** Every `INSERT` builder the service composed, which is where insert values are observable. */
function insertProbes(harness: ServiceHarness): QueryBuilderProbe[] {
    return harness.probes.filter(probe => probe.operation === 'insert');
}

/**
 * A plan answer that changes between calls, repeating its final value thereafter.
 *
 * Concurrency is not simulated here — that belongs to the barrier-released end-to-end proofs. What this
 * expresses is the state a *second* read legitimately observes after a competing request committed, which is
 * the only way the service's reconciliation branches are reachable at all [FEATURE-001-01:§2.11].
 */
function answeringInSequence<T>(...values: T[]): () => T {
    let index = 0;
    return () => {
        const value = values[Math.min(index, values.length - 1)];
        index += 1;
        return value;
    };
}

/**
 * Empties every recorder so that a second invocation inside one test can be measured on its own.
 *
 * This is what the non-growth rule needs: the claim is that a page of six parents costs the same number of
 * statements as a page of three, and comparing two absolute counts is only possible if the second is counted
 * from zero [FEATURE-001-01:§2.6.3].
 */
function resetRecorders(harness: ServiceHarness): void {
    harness.journal.length = 0;
    harness.builds.length = 0;
    harness.probes.length = 0;
    harness.escapedIdentifiers.length = 0;
    harness.metadataRequests.length = 0;
    harness.repositoryRequests.length = 0;
}

async function captureRejection(work: () => Promise<unknown>): Promise<unknown> {
    try {
        await work();
    } catch (err: unknown) {
        return err;
    }
    return undefined;
}

/**
 * The synchronous counterpart of {@link captureRejection}, for the one member that refuses synchronously.
 *
 * `getViewerAccess` returns a value rather than a promise, precisely because it issues no statement — so its
 * refusal path throws where every other refusal here rejects, and asserting on it needs a synchronous capture
 * rather than `rejects`.
 */
function captureThrow(work: () => unknown): unknown {
    try {
        work();
    } catch (err: unknown) {
        return err;
    }
    return undefined;
}

describe('ReorderListService', () => {
    let harness: ServiceHarness;
    let service: ReorderListService;
    let options: ResolvedReorderPluginOptions;
    let requestContextCache: RequestContextCacheService;
    let ctx: RequestContext;
    let loggedErrors: Array<{ message: string; context?: string }>;
    let loggedWarnings: string[];
    let loggedDebug: string[];

    beforeEach(() => {
        harness = new ServiceHarness();
        options = {
            maxListsPerCustomer: MAX_LISTS_PER_CUSTOMER,
            maxLinesPerList: MAX_LINES_PER_LIST,
            maxQuantityPerLine: MAX_QUANTITY_PER_LINE,
            defaultReorderListsPageSize: DEFAULT_LISTS_PAGE_SIZE,
            defaultReorderListLinesPageSize: DEFAULT_LINES_PAGE_SIZE,
        };
        requestContextCache = new RequestContextCacheService();
        service = new ReorderListService(
            harness.connection,
            harness.productVariantService as unknown as ProductVariantService,
            harness.listQueryBuilder as unknown as ListQueryBuilder,
            requestContextCache,
            options,
        );
        ctx = createCtx();
        loggedErrors = [];
        loggedWarnings = [];
        loggedDebug = [];
        // The service logs the failure it refuses to disclose, so the log is where "the original error is
        // not swallowed" is actually observable [STORY-001-01-01:§DoD].
        vi.spyOn(Logger, 'error').mockImplementation((message: string, context?: string) => {
            loggedErrors.push({ message, context });
        });
        vi.spyOn(Logger, 'warn').mockImplementation((message: string) => {
            loggedWarnings.push(message);
        });
        vi.spyOn(Logger, 'debug').mockImplementation((message: string) => {
            loggedDebug.push(message);
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    // ---------------------------------------------------------------------------------------------------
    // The predicate. Highest-value group in the file, because it is the whole of the access control.
    // ---------------------------------------------------------------------------------------------------

    describe('the ownership-and-channel predicate, which is the whole of the access control', () => {
        it('composes the row identifier, the acting customer and the active channel into one predicate', async () => {
            await service.getReorderList(ctx, LIST_ID);

            const lookups = pluginStatements(harness);
            expect(lookups).toHaveLength(1);
            expect(whereKeysOf(lookups[0])).toEqual(
                expect.arrayContaining(['id', 'customerId', 'channelId']),
            );
            const where = lookups[0].findOptions?.where as Record<string, unknown>;
            expect(where.id).toBe(LIST_ID);
            expect(where.customerId).toBe(CUSTOMER_ID);
            expect(where.channelId).toBe(CHANNEL_ID);
        });

        it('resolves the acting customer from the session rather than from any argument', async () => {
            await service.getReorderList(ctx, LIST_ID);

            const customerLookups = statementsAgainst(harness, 'Customer');
            expect(customerLookups).toHaveLength(1);
            expect(customerLookups[0].findOptions?.where).toEqual({ user: { id: USER_ID } });
        });

        it('returns exactly null for an identifier matching no row, having issued one scoped statement', async () => {
            harness.plan.listFindOne = () => null;

            const result = await service.getReorderList(ctx, LIST_ID);

            expect(result).toBeNull();
            expect(pluginStatements(harness)).toHaveLength(1);
            expect(unscopedRowLookups(harness)).toEqual([]);
            expect(writeStatements(harness)).toEqual([]);
        });

        it('returns exactly null for a list owned by another customer, and reads no row', async () => {
            harness.plan.listFindOne = rowMatchingPredicate(ownedList({ customerId: FOREIGN_CUSTOMER_ID }));

            const result = await service.getReorderList(ctx, LIST_ID);

            expect(result).toBeNull();
            const lookups = pluginStatements(harness);
            expect(lookups).toHaveLength(1);
            expect(scopeBoundBy(lookups[0])).toEqual({ customer: CUSTOMER_ID, channel: CHANNEL_ID });
            expect(unscopedRowLookups(harness)).toEqual([]);
        });

        it('returns exactly null for a list held in another channel', async () => {
            harness.plan.listFindOne = rowMatchingPredicate(ownedList({ channelId: FOREIGN_CHANNEL_ID }));

            const result = await service.getReorderList(ctx, LIST_ID);

            expect(result).toBeNull();
            expect(pluginStatements(harness)).toHaveLength(1);
            expect(unscopedRowLookups(harness)).toEqual([]);
        });

        it('reads the active channel from the request context, so a second token addresses a second scope', async () => {
            harness.plan.listFindOne = rowMatchingPredicate(ownedList());

            const foreignChannelResult = await service.getReorderList(
                createCtx({ channelId: FOREIGN_CHANNEL_ID }),
                LIST_ID,
            );

            expect(foreignChannelResult).toBeNull();
            expect(scopeBoundBy(pluginStatements(harness)[0]).channel).toBe(FOREIGN_CHANNEL_ID);
        });

        it('returns exactly null, with no statement of any kind, when the session carries no active user', async () => {
            const result = await service.getReorderList(createCtx({ anonymous: true }), LIST_ID);

            expect(result).toBeNull();
            expect(harness.journal).toEqual([]);
            expect(harness.repositoryRequests).toEqual([]);
        });

        it('returns four indistinguishable nulls across absent, foreign-customer, foreign-channel and anonymous reads', async () => {
            harness.plan.listFindOne = () => null;
            const absent = await service.getReorderList(ctx, LIST_ID);

            harness.plan.listFindOne = rowMatchingPredicate(ownedList({ customerId: FOREIGN_CUSTOMER_ID }));
            const foreignCustomer = await service.getReorderList(ctx, LIST_ID);

            harness.plan.listFindOne = rowMatchingPredicate(ownedList({ channelId: FOREIGN_CHANNEL_ID }));
            const foreignChannel = await service.getReorderList(ctx, LIST_ID);

            const anonymous = await service.getReorderList(createCtx({ anonymous: true }), LIST_ID);

            // Asserted equal to one another rather than merely each asserted null: the requirement is that
            // the four answers are indistinguishable, and `undefined` or a warning-carrying object would
            // satisfy "falsy" while distinguishing them [FEATURE-001-01:§2.6].
            expect([absent, foreignCustomer, foreignChannel, anonymous]).toEqual([null, null, null, null]);
            expect(new Set([absent, foreignCustomer, foreignChannel, anonymous]).size).toBe(1);
        });

        it('never answers either read with ReorderListNotFoundError, which lives only in mutation unions', async () => {
            harness.plan.listFindOne = () => null;
            harness.plan.listPage = () => [[], 0];

            const single = await service.getReorderList(ctx, LIST_ID);
            const collection = await service.getReorderLists(ctx);

            expect(single).not.toBeInstanceOf(ReorderListNotFoundError);
            expect(collection.items).toEqual([]);
            expect(collection.items.some(item => item instanceof ReorderListNotFoundError)).toBe(false);
        });

        it('answers a collection read with an empty page rather than an error when the guard fails', async () => {
            const result = await service.getReorderLists(createCtx({ anonymous: true }));

            expect(result).toEqual({ items: [], totalItems: 0 });
            expect(harness.listQueryBuilder.build).not.toHaveBeenCalled();
            expect(harness.journal).toEqual([]);
        });

        it('answers a nested-lines read with an empty page per requested parent when the guard fails', async () => {
            const result = await service.getLinesForLists(createCtx({ anonymous: true }), [
                LIST_ID,
                SECOND_LIST_ID,
            ]);

            expect(result.get(LIST_ID)).toEqual({ items: [], totalItems: 0 });
            expect(result.get(SECOND_LIST_ID)).toEqual({ items: [], totalItems: 0 });
            expect(harness.listQueryBuilder.build).not.toHaveBeenCalled();
        });

        it('scopes the collection read through the server-side extended options rather than the caller', async () => {
            await service.getReorderLists(ctx);

            expect(harness.builds).toHaveLength(1);
            expect(harness.builds[0].extendedOptions.where).toEqual({
                customerId: CUSTOMER_ID,
                channelId: CHANNEL_ID,
            });
        });

        it('reports an authenticated user with no customer row as an internal failure, not a refusal', async () => {
            harness.plan.customerRow = null;

            const failure = await captureRejection(() => service.getReorderList(ctx, LIST_ID));

            expect(failure).toBeInstanceOf(InternalServerError);
            expect(failure).not.toBeInstanceOf(ForbiddenError);
            expect((failure as InternalServerError).message).toBe(
                'The authenticated user has no associated Customer',
            );
        });

        it('succeeds for an ordinary customer session that holds no plugin-registered permission', async () => {
            const created = await service.createReorderList(ctx, { name: 'Weekly kitchen restock' });
            const read = await service.getReorderList(ctx, LIST_ID);

            expect(created).toBeInstanceOf(ReorderList);
            expect(read).toBeInstanceOf(ReorderList);
        });
    });

    describe('the write guard, which lets ForbiddenError propagate', () => {
        const mutations: Array<{
            name: string;
            invoke: (subject: ReorderListService, anonymous: RequestContext) => Promise<unknown>;
        }> = [
            {
                name: 'createReorderList',
                invoke: (subject, anonymous) => subject.createReorderList(anonymous, { name: 'Pantry' }),
            },
            {
                name: 'updateReorderList',
                invoke: (subject, anonymous) =>
                    subject.updateReorderList(anonymous, { id: LIST_ID, name: 'Pantry' }),
            },
            {
                name: 'deleteReorderList',
                invoke: (subject, anonymous) => subject.deleteReorderList(anonymous, LIST_ID),
            },
            {
                name: 'addItemToReorderList',
                invoke: (subject, anonymous) =>
                    subject.addItemToReorderList(anonymous, {
                        reorderListId: LIST_ID,
                        productVariantId: VARIANT_ID,
                        quantity: 1,
                    }),
            },
            {
                name: 'adjustReorderListLine',
                invoke: (subject, anonymous) =>
                    subject.adjustReorderListLine(anonymous, {
                        reorderListId: LIST_ID,
                        lineId: LINE_ID,
                        quantity: 2,
                    }),
            },
            {
                name: 'removeReorderListLine',
                invoke: (subject, anonymous) =>
                    subject.removeReorderListLine(anonymous, {
                        reorderListId: LIST_ID,
                        lineId: LINE_ID,
                    }),
            },
        ];

        for (const mutation of mutations) {
            it(`propagates ForbiddenError from ${mutation.name} and writes nothing at all`, async () => {
                const anonymous = createCtx({ anonymous: true });

                const failure = await captureRejection(() => mutation.invoke(service, anonymous));

                expect(failure).toBeInstanceOf(ForbiddenError);
                // FORBIDDEN and never UNAUTHORIZED: the two are different codes with different meanings and
                // a client branches on them [EPIC-001:R17], [STORY-001-01-02:AC-4].
                expect((failure as ForbiddenError).code).toBe('FORBIDDEN');
                expect((failure as ForbiddenError).message).toBe('error.forbidden');
                expect(writeStatements(harness)).toEqual([]);
                expect(harness.journal).toEqual([]);
                expect(harness.transactionsOpened).toBe(0);
            });
        }

        it('returns no result object for a refused write, because a refusal is not a business outcome', async () => {
            const anonymous = createCtx({ anonymous: true });

            const failure = await captureRejection(() => service.deleteReorderList(anonymous, LIST_ID));

            expect(failure).not.toBeInstanceOf(ReorderListNotFoundError);
            expect(failure).not.toBeInstanceOf(ReorderListLineNotFoundError);
        });
    });

    // ---------------------------------------------------------------------------------------------------
    // Affected-row branching. One means applied, zero means the row was not there; a read-then-write with
    // no affected-row check cannot tell the two apart [FEATURE-001-01:§2.11].
    // ---------------------------------------------------------------------------------------------------

    describe('updateReorderList, whose affected-row count decides the outcome', () => {
        it('returns the renamed list when the conditional statement reports one affected row', async () => {
            harness.plan.listAffected = () => 1;
            harness.plan.listFindOne = () => ownedList({ name: 'Pantry top-up', nameKey: 'pantry top-up' });

            const result = await service.updateReorderList(ctx, { id: LIST_ID, name: 'Pantry top-up' });

            expect(result).toBeInstanceOf(ReorderList);
            expect((result as ReorderList).name).toBe('Pantry top-up');
        });

        it('returns ReorderListNotFoundError when no affected row is reported and the accessible row carries a different name', async () => {
            harness.plan.listAffected = () => 0;

            const result = await service.updateReorderList(ctx, { id: LIST_ID, name: 'Pantry top-up' });

            expect(result).toBeInstanceOf(ReorderListNotFoundError);
            expect((result as ReorderListNotFoundError).errorCode).toBe('REORDER_LIST_NOT_FOUND_ERROR');
            // Nothing was RELOADED — the reload the success path performs never runs. What does run is a
            // single classification read, and it is the whole of the zero-affected path: the count alone
            // cannot distinguish "no such row for this caller" from "the row already held this name", so it
            // is not allowed to decide on its own. The row the harness answers with is named
            // 'Weekly kitchen restock' while this call renames to 'Pantry top-up', so the requested state
            // does NOT hold and the conservative not-found stands.
            const selects = statementsOfKind(harness, 'ReorderList', 'select');
            expect(selects).toHaveLength(1);
            // And it is scoped, not a bare lookup by identifier: the classification read carries the same
            // three conjuncts as the write it is classifying, so it cannot report on a row the caller could
            // not have written.
            expect(conditionTextOf(selects[0])).toContain('reorderlist.id = :id');
            expect(conditionTextOf(selects[0])).toContain('reorderlist.customerId = :customerId');
            expect(conditionTextOf(selects[0])).toContain('reorderlist.channelId = :channelId');
            expect(scopeBoundBy(selects[0])).toEqual({ customer: CUSTOMER_ID, channel: CHANNEL_ID });
        });

        it('returns the list rather than a not-found when no affected row is reported because the row already carries the requested name', async () => {
            // THE DRIVER CASE THIS COVERS, STATED PRECISELY. The affected-row count a driver reports for an
            // `UPDATE` is either MATCHED rows or CHANGED rows depending on how the connection was opened, and
            // the two differ on exactly one case: a matched row whose columns already held the values being
            // written. On the connection this repository actually opens that case reports ONE, not zero —
            // mysql2's `getDefaultFlags()` includes `FOUND_ROWS` and its `mergeFlags` applies every default
            // unless a configuration blacklists it with a leading `-`, and TypeORM's `MysqlDriver` passes
            // `flags` through without suppressing connector defaults. So the zero this test drives is NOT the
            // default path: it is what a deployment opting out with `flags: '-FOUND_ROWS'` gets, and what any
            // driver reporting no affected count at all gets. It is asserted because the failure it would
            // otherwise cause is a wrong answer rather than an error — reporting `ReorderListNotFoundError`
            // would tell a buyer their list does not exist while they are looking at it, and would make the
            // operation non-idempotent: a client retrying a rename it could not confirm would be told the list
            // had gone. The mock is the only way to reach that branch, since the default connector cannot
            // produce it.
            harness.plan.listAffected = () => 0;
            harness.plan.listGetOne = () => ownedList({ name: 'Pantry top-up', nameKey: 'pantry top-up' });

            const result = await service.updateReorderList(ctx, { id: LIST_ID, name: 'Pantry top-up' });

            expect(result).not.toBeInstanceOf(ReorderListNotFoundError);
            expect((result as ReorderList).name).toBe('Pantry top-up');
            expect((result as ReorderList).nameKey).toBe('pantry top-up');
            // One read, not two: the classification read is itself taken after the write and under the full
            // predicate, so it IS the post-write state and there is nothing for a reload to add.
            expect(statementsOfKind(harness, 'ReorderList', 'select')).toHaveLength(1);
            // And no second write was attempted to force the value that was already there.
            expect(statementsOfKind(harness, 'ReorderList', 'update')).toHaveLength(1);
        });

        it('treats the canonicalised form as the comparison, so a rename differing only in whitespace is the same no-op', async () => {
            // The comparison is against the values that were actually written — the display name and the
            // canonical key produced by the pipeline — and not against the raw argument. A submission padded
            // and internally spaced canonicalises to exactly the stored pair, so it is the same no-op.
            harness.plan.listAffected = () => 0;
            harness.plan.listGetOne = () => ownedList({ name: 'Pantry top-up', nameKey: 'pantry top-up' });

            const result = await service.updateReorderList(ctx, {
                id: LIST_ID,
                name: '   Pantry    top-up   ',
            });

            expect(result).not.toBeInstanceOf(ReorderListNotFoundError);
            expect((result as ReorderList).name).toBe('Pantry top-up');
        });

        it('refuses to call a display-only rename a no-op, because the display value is part of what is written', async () => {
            // A rename from 'pantry top-up' to 'Pantry Top-Up' leaves the canonical key identical and the
            // display value different, and the statement writes both columns. Comparing only the key would
            // report success for a change that had not been applied, so both are compared and this stays the
            // conservative not-found.
            harness.plan.listAffected = () => 0;
            harness.plan.listGetOne = () => ownedList({ name: 'pantry top-up', nameKey: 'pantry top-up' });

            const result = await service.updateReorderList(ctx, { id: LIST_ID, name: 'Pantry Top-Up' });

            expect(result).toBeInstanceOf(ReorderListNotFoundError);
        });

        it('returns ReorderListNotFoundError when no affected row is reported and no accessible row exists', async () => {
            // The other half of the zero path, and the one that must stay indistinguishable: an unknown
            // identifier, another customer's list and another channel's list all resolve to nothing here and
            // all produce the one normalised not-found, so no caller can probe for a list that is not theirs.
            harness.plan.listAffected = () => 0;
            harness.plan.listGetOne = () => null;

            const result = await service.updateReorderList(ctx, { id: LIST_ID, name: 'Pantry top-up' });

            expect(result).toBeInstanceOf(ReorderListNotFoundError);
            expect(statementsOfKind(harness, 'ReorderList', 'select')).toHaveLength(1);
        });

        it('addresses the rename by the row identifier together with the acting customer and channel', async () => {
            await service.updateReorderList(ctx, { id: LIST_ID, name: 'Pantry top-up' });

            const updates = statementsOfKind(harness, 'ReorderList', 'update');
            expect(updates).toHaveLength(1);
            expect(conditionTextOf(updates[0])).toContain('id = :id');
            expect(conditionTextOf(updates[0])).toContain('customerId = :customerId');
            expect(conditionTextOf(updates[0])).toContain('channelId = :channelId');
            expect(scopeBoundBy(updates[0])).toEqual({ customer: CUSTOMER_ID, channel: CHANNEL_ID });
        });

        it('writes the display name and the canonical key and nothing else, reading no line row', async () => {
            await service.updateReorderList(ctx, { id: LIST_ID, name: '  Pantry   top-up  ' });

            const updates = statementsOfKind(harness, 'ReorderList', 'update');
            expect(Object.keys(updates[0].updateSet ?? {}).sort()).toEqual(['name', 'nameKey']);
            expect(updates[0].updateSet?.name).toBe('Pantry top-up');
            expect(updates[0].updateSet?.nameKey).toBe('pantry top-up');
            expect(statementsAgainst(harness, 'ReorderListLine')).toEqual([]);
        });
    });

    describe('deleteReorderList, which reuses the platform deletion payload', () => {
        it('returns the platform DeletionResponse with result DELETED on one affected row', async () => {
            harness.plan.listAffected = () => 1;

            const response = await service.deleteReorderList(ctx, LIST_ID);

            expect(response).not.toBeInstanceOf(ReorderListNotFoundError);
            expect((response as DeletionResponse).result).toBe(DeletionResult.DELETED);
            // No plugin-owned deletion payload is invented: the object carries the platform's own shape,
            // whose `message` is nullable and therefore legitimately absent
            // [packages/core/src/api/schema/common/common-types.graphql:L64-L67].
            expect(Object.keys(response as object).sort()).toEqual(['__typename', 'result']);
        });

        it('returns ReorderListNotFoundError on no affected row, which is how a repeat delete is refused', async () => {
            harness.plan.listAffected = () => 0;

            const first = await service.deleteReorderList(ctx, LIST_ID);
            const second = await service.deleteReorderList(ctx, LIST_ID);

            expect(first).toBeInstanceOf(ReorderListNotFoundError);
            expect(second).toBeInstanceOf(ReorderListNotFoundError);
        });

        it('removes the lines through the foreign-key cascade rather than in a loop', async () => {
            harness.plan.listAffected = () => 1;

            await service.deleteReorderList(ctx, LIST_ID);

            const deletes = statementsOfKind(harness, 'ReorderList', 'delete');
            expect(deletes).toHaveLength(1);
            expect(statementsAgainst(harness, 'ReorderListLine')).toEqual([]);
        });

        it('addresses the delete by the row identifier together with the acting customer and channel', async () => {
            await service.deleteReorderList(ctx, LIST_ID);

            const deletes = statementsOfKind(harness, 'ReorderList', 'delete');
            expect(conditionTextOf(deletes[0])).toContain('id = :id');
            expect(scopeBoundBy(deletes[0])).toEqual({ customer: CUSTOMER_ID, channel: CHANNEL_ID });
        });
    });

    describe('adjustReorderListLine, whose two miss branches must not be conflated', () => {
        it('returns ReorderListNotFoundError when the list does not resolve under the predicate', async () => {
            harness.plan.lineAffected = () => 0;
            harness.plan.listGetOne = () => null;

            const result = await service.adjustReorderListLine(ctx, {
                reorderListId: LIST_ID,
                lineId: LINE_ID,
                quantity: 2,
            });

            expect(result).toBeInstanceOf(ReorderListNotFoundError);
            expect(result).not.toBeInstanceOf(ReorderListLineNotFoundError);
        });

        it('returns ReorderListLineNotFoundError when the list resolves and the line statement misses', async () => {
            harness.plan.lineAffected = () => 0;
            harness.plan.listGetOne = () => ownedList();
            // No line row exists to have been the no-op case, which is what leaves the miss a genuine miss.
            harness.plan.lineGetOne = () => null;

            const result = await service.adjustReorderListLine(ctx, {
                reorderListId: LIST_ID,
                lineId: LINE_ID,
                quantity: 2,
            });

            expect(result).toBeInstanceOf(ReorderListLineNotFoundError);
            expect((result as ReorderListLineNotFoundError).errorCode).toBe(
                'REORDER_LIST_LINE_NOT_FOUND_ERROR',
            );
        });

        it('returns the owning list when no affected row is reported because the line already holds the requested quantity', async () => {
            // THE IDEMPOTENCE THIS OPERATION IS PUBLISHED FOR, UNDER THE ONE DRIVER CONFIGURATION THAT WOULD
            // OTHERWISE BREAK IT. Setting a line to the quantity it already holds matches the row and writes
            // nothing, which a connection reporting CHANGED rather than MATCHED rows reports as zero affected.
            // That is not this repository's default connection — mysql2 negotiates `FOUND_ROWS`, so the case
            // reports one — but it is what `flags: '-FOUND_ROWS'` produces, and what any driver reporting no
            // affected count at all produces. The absolute set is the published remedy for an add a client
            // could not confirm, so a client resolving that uncertainty by setting the value already stored is
            // the operation's intended use, not an edge case: reporting it as `ReorderListLineNotFoundError`
            // would deny a line that is present and already in the requested state. See the rename test above
            // for the connector citations.
            harness.plan.lineAffected = () => 0;
            harness.plan.listGetOne = () => ownedList();
            harness.plan.lineGetOne = () => ownedLine({ quantity: 4 });

            const result = await service.adjustReorderListLine(ctx, {
                reorderListId: LIST_ID,
                lineId: LINE_ID,
                quantity: 4,
            });

            expect(result).toBeInstanceOf(ReorderList);
            expect(result).not.toBeInstanceOf(ReorderListLineNotFoundError);
            // No second write was attempted to force a value that was already there, and the counter is
            // untouched exactly as it is on the ordinary path.
            expect(statementsOfKind(harness, 'ReorderListLine', 'update')).toHaveLength(1);
            expect(harness.journal.some(isLineCountRelease)).toBe(false);
            expect(harness.journal.some(isLineCountClaim)).toBe(false);
        });

        it('classifies the parent before the line on the zero path, so an inaccessible list is never told about its lines', async () => {
            // The order is not interchangeable. A line row carries no customer and no channel, so a read
            // scoped only by its parent's identifier is not ownership-scoped; the parent read is what
            // establishes the scope, and it is also what keeps the two not-found results distinct. A list
            // that does not resolve therefore ends the classification before any line is read at all.
            harness.plan.lineAffected = () => 0;
            harness.plan.listGetOne = () => null;
            harness.plan.lineGetOne = () => ownedLine({ quantity: 4 });

            const result = await service.adjustReorderListLine(ctx, {
                reorderListId: LIST_ID,
                lineId: LINE_ID,
                quantity: 4,
            });

            expect(result).toBeInstanceOf(ReorderListNotFoundError);
            expect(statementsOfKind(harness, 'ReorderListLine', 'select')).toEqual([]);
        });

        it('scopes the line classification read to the line and its parent, and takes it only on the zero path', async () => {
            harness.plan.lineAffected = () => 0;
            harness.plan.listGetOne = () => ownedList();
            harness.plan.lineGetOne = () => ownedLine({ quantity: 4 });

            await service.adjustReorderListLine(ctx, {
                reorderListId: LIST_ID,
                lineId: LINE_ID,
                quantity: 4,
            });

            const selects = statementsOfKind(harness, 'ReorderListLine', 'select');
            expect(selects).toHaveLength(1);
            expect(conditionTextOf(selects[0])).toContain('reorderlistline.id = :lineId');
            expect(conditionTextOf(selects[0])).toContain('reorderlistline.reorderListId = :listId');

            // And the successful path pays for neither read, which is what keeps the classification free in
            // the ordinary case.
            resetRecorders(harness);
            harness.plan.lineAffected = () => 1;

            await service.adjustReorderListLine(ctx, {
                reorderListId: LIST_ID,
                lineId: LINE_ID,
                quantity: 4,
            });

            expect(statementsOfKind(harness, 'ReorderListLine', 'select')).toEqual([]);
        });

        it('refuses to call a differing quantity a no-op, keeping the conservative line not-found', async () => {
            // A matched row whose quantity differs means the write both matched and failed to apply, which no
            // engine does. It keeps the not-found rather than claiming a set that demonstrably did not
            // happen, and says so in the log — a silent wrong success is far worse than a visible wrong
            // refusal.
            harness.plan.lineAffected = () => 0;
            harness.plan.listGetOne = () => ownedList();
            harness.plan.lineGetOne = () => ownedLine({ quantity: 4 });

            const result = await service.adjustReorderListLine(ctx, {
                reorderListId: LIST_ID,
                lineId: LINE_ID,
                quantity: 9,
            });

            expect(result).toBeInstanceOf(ReorderListLineNotFoundError);
            expect(loggedWarnings.join(' ')).toContain('holds a different quantity');
        });

        it('returns the owning list when the conditional statement reports one affected row', async () => {
            harness.plan.lineAffected = () => 1;

            const result = await service.adjustReorderListLine(ctx, {
                reorderListId: LIST_ID,
                lineId: LINE_ID,
                quantity: 2,
            });

            expect(result).toBeInstanceOf(ReorderList);
        });

        it('sets an absolute quantity rather than incrementing, which is what makes it idempotent', async () => {
            await service.adjustReorderListLine(ctx, {
                reorderListId: LIST_ID,
                lineId: LINE_ID,
                quantity: 7,
            });

            const updates = statementsOfKind(harness, 'ReorderListLine', 'update');
            expect(updates).toHaveLength(1);
            expect(updates[0].updateSet?.quantity).toBe(7);
            expect(typeof updates[0].updateSet?.quantity).not.toBe('function');
        });

        it('scopes the line statement to the owning list, the acting customer and the active channel', async () => {
            await service.adjustReorderListLine(ctx, {
                reorderListId: LIST_ID,
                lineId: LINE_ID,
                quantity: 2,
            });

            const updates = statementsOfKind(harness, 'ReorderListLine', 'update');
            expect(conditionTextOf(updates[0])).toContain('id = :lineId');
            expect(conditionTextOf(updates[0])).toContain('reorderListId = :reorderListId');
            expect(updates[0].parameters.lineId).toBe(LINE_ID);
            expect(updates[0].parameters.reorderListId).toBe(LIST_ID);
            // The whole sub-query, parsed. A line row holds neither a customer nor a channel, so this
            // correlated `EXISTS` over the parent table IS the ownership predicate of the one statement whose
            // affected-row count decides the outcome — and its correlation to the row being written is what
            // stops it from being satisfied by some other list of the caller's [FEATURE-001-01:§2.11].
            expect(ownershipSubqueryOf(updates[0])).toEqual(ownedLineScope('reorderListId'));
        });

        it('never consults the line bound and never writes lineCount, because no line is created', async () => {
            await service.adjustReorderListLine(ctx, {
                reorderListId: LIST_ID,
                lineId: LINE_ID,
                quantity: 2,
            });

            expect(harness.journal.some(isLineCountClaim)).toBe(false);
            expect(harness.journal.some(isLineCountRelease)).toBe(false);
            expect(harness.journal.some(isLineCountRepair)).toBe(false);
            expect(harness.journal.some(statement => 'maxLinesPerList' in statement.parameters)).toBe(false);
            expect(harness.journal.some(statement => 'lineCount' in (statement.updateSet ?? {}))).toBe(false);
        });
    });

    describe('removeReorderListLine, which decrements in the transaction that deleted', () => {
        it('returns ReorderListNotFoundError before issuing any line statement when the parent is absent', async () => {
            harness.plan.listGetOne = () => null;

            const result = await service.removeReorderListLine(ctx, {
                reorderListId: LIST_ID,
                lineId: LINE_ID,
            });

            expect(result).toBeInstanceOf(ReorderListNotFoundError);
            expect(statementsAgainst(harness, 'ReorderListLine')).toEqual([]);
        });

        it('returns ReorderListLineNotFoundError when the list resolves and the delete misses', async () => {
            harness.plan.lineAffected = () => 0;
            harness.plan.listGetOne = () => ownedList();

            const first = await service.removeReorderListLine(ctx, {
                reorderListId: LIST_ID,
                lineId: LINE_ID,
            });
            const second = await service.removeReorderListLine(ctx, {
                reorderListId: LIST_ID,
                lineId: LINE_ID,
            });

            expect(first).toBeInstanceOf(ReorderListLineNotFoundError);
            expect(second).toBeInstanceOf(ReorderListLineNotFoundError);
        });

        it('issues the guarded lineCount decrement inside the same transaction as the delete', async () => {
            harness.plan.lineAffected = () => 1;
            harness.plan.listAffected = () => 1;

            await service.removeReorderListLine(ctx, { reorderListId: LIST_ID, lineId: LINE_ID });

            const deletes = statementsOfKind(harness, 'ReorderListLine', 'delete');
            const releases = harness.journal.filter(isLineCountRelease);
            expect(deletes).toHaveLength(1);
            expect(releases).toHaveLength(1);
            expect(harness.transactionsOpened).toBe(1);
            expect(deletes[0].transaction).toBeGreaterThan(0);
            expect(releases[0].transaction).toBe(deletes[0].transaction);
        });

        it('guards the decrement so the non-negative check on the counter stays satisfiable', async () => {
            await service.removeReorderListLine(ctx, { reorderListId: LIST_ID, lineId: LINE_ID });

            const release = harness.journal.find(isLineCountRelease) as JournalledStatement;
            expect(conditionTextOf(release)).toContain('lineCount > 0');
            expect(setExpressionOf(release, 'lineCount')).toBe(`${escaped('lineCount')} - 1`);
        });

        it('carries the acting customer and the active channel in the decrement, as every other statement addressing a list does', async () => {
            // The counter is a column of the list row, so the statement that writes it is a statement
            // addressing a list — and every one of those in this service carries the full three-way predicate
            // rather than an identifier alone. Under correct use the conjuncts change no outcome, the caller
            // having already resolved this same list under this same scope in this same transaction; what
            // they change is where the guarantee lives. A write reached with a caller-supplied identifier and
            // no owner predicate is one refactor away from being reachable without the thing that makes it
            // safe, and this was the only statement in the service that would have been.
            await service.removeReorderListLine(ctx, { reorderListId: LIST_ID, lineId: LINE_ID });

            const release = harness.journal.find(isLineCountRelease) as JournalledStatement;
            expect(conditionTextOf(release)).toContain('id = :listId');
            expect(conditionTextOf(release)).toContain('customerId = :customerId');
            expect(conditionTextOf(release)).toContain('channelId = :channelId');
            expect(scopeBoundBy(release)).toEqual({ customer: CUSTOMER_ID, channel: CHANNEL_ID });
        });

        it('reports a counter that was already zero rather than writing a negative value', async () => {
            harness.plan.lineAffected = () => 1;
            harness.plan.listAffected = statement => (isLineCountRelease(statement) ? 0 : 1);

            const result = await service.removeReorderListLine(ctx, {
                reorderListId: LIST_ID,
                lineId: LINE_ID,
            });

            expect(result).toBeInstanceOf(ReorderList);
            expect(loggedWarnings.join(' ')).toContain('lineCount of zero');
        });

        it('scopes the delete to the owning list, the acting customer and the active channel', async () => {
            await service.removeReorderListLine(ctx, { reorderListId: LIST_ID, lineId: LINE_ID });

            const deletes = statementsOfKind(harness, 'ReorderListLine', 'delete');
            expect(conditionTextOf(deletes[0])).toContain('id = :lineId');
            expect(conditionTextOf(deletes[0])).toContain('reorderListId = :reorderListId');
            expect(deletes[0].parameters.lineId).toBe(LINE_ID);
            expect(deletes[0].parameters.reorderListId).toBe(LIST_ID);
            // The same parsed sub-query as the adjust path, asserted the same way: a delete that reached a
            // line through an uncorrelated `EXISTS` would remove another customer's row while every
            // response-shaped assertion stayed green.
            expect(ownershipSubqueryOf(deletes[0])).toEqual(ownedLineScope('reorderListId'));
        });
    });

    // ---------------------------------------------------------------------------------------------------
    // The add path: a fixed ordering, an atomic accumulation, and a bound claimed before anything is
    // created [FEATURE-001-01:§2.11], [STORY-001-01-02:AC-2, AC-5, AC-6].
    // ---------------------------------------------------------------------------------------------------

    describe('addItemToReorderList on the insert path', () => {
        beforeEach(() => {
            harness.plan.lineGetOne = () => null;
        });

        it('claims a line of capacity as the first write of the transaction, then inserts', async () => {
            harness.plan.listAffected = () => 1;

            await service.addItemToReorderList(ctx, {
                reorderListId: LIST_ID,
                productVariantId: VARIANT_ID,
                quantity: 2,
            });

            const writes = writeStatements(harness);
            expect(writes.length).toBeGreaterThanOrEqual(2);
            expect(isLineCountClaim(writes[0])).toBe(true);
            expect(writes[1].entity).toBe('ReorderListLine');
            expect(writes[1].operation).toBe('insert');
            expect(writes[0].transaction).toBe(writes[1].transaction);
        });

        // NOTE ON THE LINE INSERT: it is an ordinary builder insert and reads no affected-row count.
        // The statement that used to carry `orIgnore()` — and with it the raw query runner, its positional
        // parameters and TypeORM's structured-result flag — was withdrawn because `INSERT IGNORE` downgrades a
        // failed foreign key, an over-long value and an empty NOT NULL column to "affected 0 rows" on the
        // MySQL family, which is indistinguishable from a duplicate. The insert's values are asserted exactly
        // where they are observable, on the builder probe, by 'inserts exactly the three declared members and
        // neither reads nor emits a withdrawn one'; a losing insert is now driven by making the statement fail
        // with a violation of the named per-variant uniqueness object, which the bounded retry recognises.

        it('bounds the claim by the configured maximum and increments the counter in the database', async () => {
            await service.addItemToReorderList(ctx, {
                reorderListId: LIST_ID,
                productVariantId: VARIANT_ID,
                quantity: 2,
            });

            const claim = harness.journal.find(isLineCountClaim) as JournalledStatement;
            expect(conditionTextOf(claim)).toContain('lineCount < :maxLinesPerList');
            expect(claim.parameters.maxLinesPerList).toBe(MAX_LINES_PER_LIST);
            expect(setExpressionOf(claim, 'lineCount')).toBe(`${escaped('lineCount')} + 1`);
            expect(scopeBoundBy(claim)).toEqual({ customer: CUSTOMER_ID, channel: CHANNEL_ID });
        });

        it('returns ReorderListLimitError carrying the breached maximum and attempts no insert', async () => {
            harness.plan.listAffected = () => 0;
            harness.plan.listGetOne = () => ownedList({ lineCount: MAX_LINES_PER_LIST });

            const result = await service.addItemToReorderList(ctx, {
                reorderListId: LIST_ID,
                productVariantId: VARIANT_ID,
                quantity: 1,
            });

            expect(result).toBeInstanceOf(ReorderListLimitError);
            expect((result as ReorderListLimitError).maxItems).toBe(MAX_LINES_PER_LIST);
            expect(insertProbes(harness)).toEqual([]);
            expect(statementsOfKind(harness, 'ReorderListLine', 'insert')).toEqual([]);
        });

        it('returns ReorderListNotFoundError when the owning list disappeared before the claim', async () => {
            harness.plan.listAffected = () => 0;
            harness.plan.listGetOne = () => null;

            const result = await service.addItemToReorderList(ctx, {
                reorderListId: LIST_ID,
                productVariantId: VARIANT_ID,
                quantity: 1,
            });

            expect(result).toBeInstanceOf(ReorderListNotFoundError);
            expect(insertProbes(harness)).toEqual([]);
        });

        it('returns ReorderListNotFoundError for a list the caller does not own, writing nothing', async () => {
            harness.plan.listFindOne = rowMatchingPredicate(ownedList({ customerId: FOREIGN_CUSTOMER_ID }));

            const result = await service.addItemToReorderList(ctx, {
                reorderListId: LIST_ID,
                productVariantId: VARIANT_ID,
                quantity: 1,
            });

            expect(result).toBeInstanceOf(ReorderListNotFoundError);
            expect(pluginStatements(harness)).toHaveLength(1);
            expect(writeStatements(harness)).toEqual([]);
            expect(unscopedRowLookups(harness)).toEqual([]);
        });

        it('inserts exactly the three declared members and neither reads nor emits a withdrawn one', async () => {
            // Members the published input does not declare, supplied WITH VALUES so that "they are never
            // read" is a fact about this request rather than about an input that never carried them. A
            // request-deduplication key and its request fingerprint were withdrawn from the entity mapping,
            // and the assertions below fail if an implementation consumes one when it is present — which a
            // comment alone could not detect, because nothing was present to consume. The operation's
            // guarantee is at-least-once delivery and its remedy is the absolute-set adjust, not a claim
            // column [FEATURE-001-01:§2.11], [STORY-001-01-01:§DoD].
            //
            // ★ **Each one is supplied through a getter, and that is what makes NON-ACCESS observable.**
            // Plain properties can only evidence the second half of the requirement — that neither value was
            // emitted into a statement, a parameter or an inserted value. They say nothing about the first
            // half: a service may READ a withdrawn member and act on it without its name or value ever
            // reaching a statement — branching on it, logging it, counting it, using it as a cache key, or
            // rejecting a repeat because of it — and every journal assertion below would still pass while the
            // operation's behaviour silently depended on a column the mapping withdrew. The accessors record
            // every read, so the empty log is the evidence. They are `enumerable` deliberately: a spread, an
            // `Object.assign` or an `Object.keys` walk over the input trips them exactly as a direct property
            // read does, which is how a request copied wholesale into the insert values would be caught.
            const claimMemberReads: string[] = [];
            const request: Record<string, unknown> = {
                reorderListId: LIST_ID,
                productVariantId: VARIANT_ID,
                quantity: 4,
            };
            for (const [member, sentinel] of [
                ['lastAddIdempotencyKey', WITHDRAWN_IDEMPOTENCY_SENTINEL],
                ['lastAddRequestFingerprint', WITHDRAWN_FINGERPRINT_SENTINEL],
            ] as const) {
                Object.defineProperty(request, member, {
                    enumerable: true,
                    configurable: true,
                    get: () => {
                        claimMemberReads.push(member);
                        return sentinel;
                    },
                });
            }

            await service.addItemToReorderList(ctx, request as never);

            // Snapshotted the instant the operation returns, before any assertion in this test can touch the
            // request itself — so what is asserted is what the SERVICE did, and a later read by the test
            // cannot manufacture a failure.
            const readsDuringOperation = [...claimMemberReads];
            expect(readsDuringOperation).toEqual([]);

            const inserts = insertProbes(harness);
            expect(inserts).toHaveLength(1);
            expect(Object.keys(inserts[0].insertValues ?? {}).sort()).toEqual([
                'productVariantId',
                'quantity',
                'reorderListId',
            ]);
            // Nothing anywhere in the journal — no insert value, no rendered statement, no bound parameter,
            // no predicate — carries either member's name or either sentinel value.
            const serialisedJournal = JSON.stringify(harness.journal).toLowerCase();
            expect(serialisedJournal).not.toContain('idempotency');
            expect(serialisedJournal).not.toContain('fingerprint');
            expect(serialisedJournal).not.toContain(WITHDRAWN_IDEMPOTENCY_SENTINEL.toLowerCase());
            expect(serialisedJournal).not.toContain(WITHDRAWN_FINGERPRINT_SENTINEL.toLowerCase());
            // And the values the insert did carry are the ones the request supplied, so the assertion above
            // is about a statement that really wrote this line rather than about an empty values object.
            expect(inserts[0].insertValues).toEqual({
                reorderListId: LIST_ID,
                productVariantId: VARIANT_ID,
                quantity: 4,
            });
        });

        it('resolves the variant once and reads no availability at all', async () => {
            await service.addItemToReorderList(ctx, {
                reorderListId: LIST_ID,
                productVariantId: VARIANT_ID,
                quantity: 1,
            });

            expect(harness.productVariantService.findOne).toHaveBeenCalledTimes(1);
            expect(harness.productVariantService.findOne).toHaveBeenCalledWith(
                expect.anything(),
                VARIANT_ID,
                [],
            );
            expect(harness.productVariantService.getSaleableStockLevel).toHaveBeenCalledTimes(0);
            expect(harness.productVariantService.getDisplayStockLevel).toHaveBeenCalledTimes(0);
        });

        it('requests no repository beyond Customer, ReorderList and ReorderListLine', async () => {
            await service.addItemToReorderList(ctx, {
                reorderListId: LIST_ID,
                productVariantId: VARIANT_ID,
                quantity: 1,
            });

            expect([...new Set(harness.repositoryRequests)].sort()).toEqual([
                'Customer',
                'ReorderList',
                'ReorderListLine',
            ]);
            expect(harness.repositoryRequests).not.toContain('Unknown');
        });

        it('refuses an unresolvable variant with the plugin message key and the offending identifier', async () => {
            harness.plan.variant = undefined;

            const failure = await captureRejection(() =>
                service.addItemToReorderList(ctx, {
                    reorderListId: LIST_ID,
                    productVariantId: VARIANT_ID,
                    quantity: 1,
                }),
            );

            expect(failure).toBeInstanceOf(UserInputError);
            expect((failure as UserInputError).message).toBe(VARIANT_NOT_FOUND_KEY);
            expect((failure as UserInputError).variables).toEqual({ id: String(VARIANT_ID) });
            expect(writeStatements(harness)).toEqual([]);
        });

        it('reconciles a concurrent insert of the same variant by accumulating rather than failing', async () => {
            // The first attempt sees no line and loses the insert to a competitor; the second reads the
            // committed row and accumulates onto it, which is a path that cannot hit the same duplicate.
            harness.plan.lineGetOne = answeringInSequence<ReorderListLine | null>(
                null,
                ownedLine({ quantity: 3 }),
            );
            harness.plan.listAffected = () => 1;
            harness.plan.lineInsertFailure = duplicateLineViolation();
            harness.plan.lineAffected = () => 1;

            const result = await service.addItemToReorderList(ctx, {
                reorderListId: LIST_ID,
                productVariantId: VARIANT_ID,
                quantity: 2,
            });

            expect(result).toBeInstanceOf(ReorderList);
            expect(harness.transactionsOpened).toBe(2);
        });

        it('sanitises an exhausted reconciliation budget instead of surfacing the internal signal', async () => {
            harness.plan.listAffected = () => 1;
            harness.plan.lineInsertFailure = duplicateLineViolation();

            const failure = await captureRejection(() =>
                service.addItemToReorderList(ctx, {
                    reorderListId: LIST_ID,
                    productVariantId: VARIANT_ID,
                    quantity: 1,
                }),
            );

            expect(failure).toBeInstanceOf(InternalServerError);
            expect((failure as InternalServerError).message).toBe(UNCLASSIFIED_FAILURE_MESSAGE);
            expect(harness.transactionsOpened).toBe(3);
            expect(loggedErrors.map(entry => entry.message).join(' ')).toContain('addItemToReorderList');
        });
    });

    describe('addItemToReorderList on the accumulate path', () => {
        it('adds to the existing line without creating one, so a full list still accepts a duplicate', async () => {
            harness.plan.lineGetOne = () => ownedLine({ quantity: 1 });
            harness.plan.listFindOne = () => ownedList({ lineCount: MAX_LINES_PER_LIST });
            harness.plan.lineAffected = () => 1;

            const result = await service.addItemToReorderList(ctx, {
                reorderListId: LIST_ID,
                productVariantId: VARIANT_ID,
                quantity: 2,
            });

            expect(result).toBeInstanceOf(ReorderList);
            // The bound is not consulted at all, because no line is created and therefore none is breached.
            expect(harness.journal.some(isLineCountClaim)).toBe(false);
            expect(insertProbes(harness)).toEqual([]);
        });

        it('increments in the database, addressed by the line identifier, rather than assigning a total', async () => {
            harness.plan.lineGetOne = () => ownedLine({ quantity: 6 });
            harness.plan.lineAffected = () => 1;

            await service.addItemToReorderList(ctx, {
                reorderListId: LIST_ID,
                productVariantId: VARIANT_ID,
                quantity: 3,
            });

            const updates = statementsOfKind(harness, 'ReorderListLine', 'update');
            expect(updates).toHaveLength(1);
            expect(conditionTextOf(updates[0])).toContain('id = :lineId');
            expect(updates[0].parameters.lineId).toBe(LINE_ID);
            expect(updates[0].parameters.delta).toBe(3);
            expect(setExpressionOf(updates[0], 'quantity')).toBe(`${escaped('quantity')} + :delta`);
            expect(updates[0].terminal).toBe('execute');
        });

        it('escapes the identifier of the raw increment through the driver rather than quoting it inline', async () => {
            harness.plan.lineGetOne = () => ownedLine({ quantity: 1 });

            await service.addItemToReorderList(ctx, {
                reorderListId: LIST_ID,
                productVariantId: VARIANT_ID,
                quantity: 1,
            });

            const update = statementsOfKind(harness, 'ReorderListLine', 'update')[0];
            expect(harness.escapedIdentifiers).toContain('quantity');
            expect(setExpressionOf(update, 'quantity')).toContain(ESCAPE_PREFIX);
            expect(setExpressionOf(update, 'quantity')).toContain(ESCAPE_SUFFIX);
        });

        it('bounds the resulting quantity inside the same statement that increments it', async () => {
            harness.plan.lineGetOne = () => ownedLine({ quantity: 6 });
            harness.plan.lineAffected = () => 1;

            await service.addItemToReorderList(ctx, {
                reorderListId: LIST_ID,
                productVariantId: VARIANT_ID,
                quantity: 3,
            });

            const update = statementsOfKind(harness, 'ReorderListLine', 'update')[0];
            expect(conditionTextOf(update)).toContain(':maxBeforeIncrement');
            expect(update.parameters.maxBeforeIncrement).toBe(MAX_QUANTITY_PER_LINE - 3);
        });

        it('carries the ownership predicate in the statement that increments, not in a read before it', async () => {
            harness.plan.lineGetOne = () => ownedLine({ quantity: 1 });
            harness.plan.lineAffected = () => 1;

            await service.addItemToReorderList(ctx, {
                reorderListId: LIST_ID,
                productVariantId: VARIANT_ID,
                quantity: 2,
            });

            const update = statementsOfKind(harness, 'ReorderListLine', 'update')[0];
            // The accumulate path is the one line write with no parent lock and no preceding conditional
            // statement of its own, so the correlated sub-query is the ONLY thing standing between this
            // increment and another customer's line. It is asserted in full for that reason: the parent list
            // is addressed here as `:listId` rather than `:reorderListId`, and the correlation still has to
            // reach the line's own parent reference [FEATURE-001-01:§2.11].
            expect(conditionTextOf(update)).toContain('id = :lineId');
            expect(conditionTextOf(update)).toContain('reorderListId = :listId');
            expect(update.parameters.lineId).toBe(LINE_ID);
            expect(update.parameters.listId).toBe(LIST_ID);
            expect(ownershipSubqueryOf(update)).toEqual(ownedLineScope('reorderListId'));
        });

        it('scopes the existing-line lookup to the addressed list and the addressed variant', async () => {
            harness.plan.lineGetOne = () => ownedLine({ quantity: 1 });
            harness.plan.lineAffected = () => 1;

            await service.addItemToReorderList(ctx, {
                reorderListId: LIST_ID,
                productVariantId: VARIANT_ID,
                quantity: 2,
            });

            // The lookup that decides between accumulating and inserting is itself scoped, so a variant two
            // lists share cannot resolve the other list's line and have this request accumulate onto it. The
            // parent list it names has already been resolved under the full predicate by the statement before
            // it, which is why the pair of conjuncts here is the whole of what this lookup needs.
            const lookup = statementsAgainst(harness, 'ReorderListLine').find(
                statement => statement.terminal === 'getOne',
            ) as JournalledStatement;
            expect(lookup).toBeDefined();
            expect(predicateValueFor(lookup, 'reorderListId')).toBe(LIST_ID);
            expect(predicateValueFor(lookup, 'productVariantId')).toBe(VARIANT_ID);
        });

        it('never reads then saves the line, because a read-compute-save loses one of two concurrent adds', async () => {
            harness.plan.lineGetOne = () => ownedLine({ quantity: 2 });
            harness.plan.lineAffected = () => 1;

            await service.addItemToReorderList(ctx, {
                reorderListId: LIST_ID,
                productVariantId: VARIANT_ID,
                quantity: 2,
            });

            const lineStatements = statementsAgainst(harness, 'ReorderListLine');
            expect(lineStatements.some(statement => statement.terminal === 'save')).toBe(false);
            expect(lineStatements.some(statement => statement.terminal === 'findOne')).toBe(false);
            expect(insertProbes(harness)).toEqual([]);
        });

        it('resolves the existing line before validating the quantity, which is what makes AC-6 decidable', async () => {
            harness.plan.lineGetOne = () => ownedLine({ quantity: 6 });

            // A MALFORMED increment, and that is what makes the ordering observable at all. Driven with a
            // legal quantity the request runs to completion, and "the lookup came before the first write"
            // holds under either order: validation moved ahead of the lookup would still leave the lookup
            // ahead of the write, so such an assertion cannot fail when the behaviour is absent. A refused
            // quantity separates the two: the request stops AT validation, so the scoped lookup is in the
            // journal if and only if it ran first. The order is not stylistic — the bound applies to the
            // RESULTING quantity, which is the increment plus whatever the existing line holds, so the line
            // has to be resolved before the total can be judged
            // [STORY-001-01-02:AC-6], [FEATURE-001-01:§2.11].
            const failure = await captureRejection(() =>
                service.addItemToReorderList(ctx, {
                    reorderListId: LIST_ID,
                    productVariantId: VARIANT_ID,
                    quantity: 0,
                }),
            );

            expect(failure).toBeInstanceOf(UserInputError);
            expect((failure as UserInputError).message).toBe(QUANTITY_MUST_BE_POSITIVE_KEY);

            const lookup = statementsAgainst(harness, 'ReorderListLine').find(
                statement => statement.terminal === 'getOne',
            ) as JournalledStatement;
            expect(lookup).toBeDefined();
            // And it was the SCOPED lookup rather than any read of the line table, so the ordering asserted
            // here is the ordering the contract names.
            expect(predicateValueFor(lookup, 'reorderListId')).toBe(LIST_ID);
            expect(predicateValueFor(lookup, 'productVariantId')).toBe(VARIANT_ID);
            // Nothing followed it: no capacity claimed, no line inserted and no quantity written, so a
            // refused increment cannot have touched the list it addressed.
            expect(writeStatements(harness)).toEqual([]);
            expect(harness.journal.some(isLineCountClaim)).toBe(false);
            expect(insertProbes(harness)).toEqual([]);
        });

        it('creates a line when the existing one vanished, claiming capacity for the row it now creates', async () => {
            harness.plan.lineGetOne = answeringInSequence<ReorderListLine | null>(
                ownedLine({ quantity: 2 }),
                null,
                null,
            );
            harness.plan.lineAffected = () => 0;
            harness.plan.listAffected = () => 1;

            const result = await service.addItemToReorderList(ctx, {
                reorderListId: LIST_ID,
                productVariantId: VARIANT_ID,
                quantity: 2,
            });

            expect(result).toBeInstanceOf(ReorderList);
            expect(harness.journal.some(isLineCountClaim)).toBe(true);
        });

        it('refuses an accumulation the stored quantity has outgrown since it was read', async () => {
            harness.plan.lineGetOne = answeringInSequence(
                ownedLine({ quantity: 2 }),
                ownedLine({ quantity: 9 }),
            );
            harness.plan.lineAffected = () => 0;

            const failure = await captureRejection(() =>
                service.addItemToReorderList(ctx, {
                    reorderListId: LIST_ID,
                    productVariantId: VARIANT_ID,
                    quantity: 2,
                }),
            );

            expect(failure).toBeInstanceOf(UserInputError);
            expect((failure as UserInputError).message).toBe(QUANTITY_ABOVE_MAXIMUM_KEY);
            expect((failure as UserInputError).variables).toEqual({ max: MAX_QUANTITY_PER_LINE });
        });

        it('reports the owning list as absent when the increment matched nothing and nothing else explains it', async () => {
            harness.plan.lineGetOne = () => ownedLine({ quantity: 2 });
            harness.plan.lineAffected = () => 0;

            const result = await service.addItemToReorderList(ctx, {
                reorderListId: LIST_ID,
                productVariantId: VARIANT_ID,
                quantity: 2,
            });

            expect(result).toBeInstanceOf(ReorderListNotFoundError);
        });

        it('accumulates onto a line another request replaced, rather than reporting the replacement', async () => {
            harness.plan.lineGetOne = answeringInSequence(
                ownedLine({ id: LINE_ID, quantity: 2 }),
                ownedLine({ id: OTHER_LINE_ID, quantity: 2 }),
                ownedLine({ id: OTHER_LINE_ID, quantity: 2 }),
            );
            harness.plan.lineAffected = answeringInSequence(0, 1);

            const result = await service.addItemToReorderList(ctx, {
                reorderListId: LIST_ID,
                productVariantId: VARIANT_ID,
                quantity: 2,
            });

            expect(result).toBeInstanceOf(ReorderList);
            expect(harness.transactionsOpened).toBe(2);
        });
    });

    // ---------------------------------------------------------------------------------------------------
    // Quantity validation. A malformed quantity is a bad request rather than a business outcome, which is
    // exactly why this feature declares four error results and not five [EPIC-001:R13].
    // ---------------------------------------------------------------------------------------------------

    describe('quantity validation, which refuses rather than returning a fifth error result', () => {
        const malformed: Array<{ label: string; quantity: number }> = [
            { label: 'zero', quantity: 0 },
            { label: 'a negative value', quantity: -1 },
            { label: 'a fractional value', quantity: 1.5 },
            { label: 'NaN', quantity: Number.NaN },
            { label: 'Infinity', quantity: Number.POSITIVE_INFINITY },
        ];

        for (const candidate of malformed) {
            it(`refuses ${candidate.label} on the add path with the must-be-positive key and no variables`, async () => {
                harness.plan.lineGetOne = () => null;

                const failure = await captureRejection(() =>
                    service.addItemToReorderList(ctx, {
                        reorderListId: LIST_ID,
                        productVariantId: VARIANT_ID,
                        quantity: candidate.quantity,
                    }),
                );

                expect(failure).toBeInstanceOf(UserInputError);
                expect((failure as UserInputError).message).toBe(QUANTITY_MUST_BE_POSITIVE_KEY);
                expect((failure as UserInputError).variables).toEqual({});
                expect((failure as UserInputError).code).toBe('USER_INPUT_ERROR');
                expect(writeStatements(harness)).toEqual([]);
            });

            it(`refuses ${candidate.label} on the adjust path before opening a transaction`, async () => {
                const failure = await captureRejection(() =>
                    service.adjustReorderListLine(ctx, {
                        reorderListId: LIST_ID,
                        lineId: LINE_ID,
                        quantity: candidate.quantity,
                    }),
                );

                expect(failure).toBeInstanceOf(UserInputError);
                expect((failure as UserInputError).message).toBe(QUANTITY_MUST_BE_POSITIVE_KEY);
                expect((failure as UserInputError).variables).toEqual({});
                expect(harness.transactionsOpened).toBe(0);
                expect(writeStatements(harness)).toEqual([]);
            });
        }

        it('refuses a quantity above the configured maximum on the adjust path, naming the bound', async () => {
            const failure = await captureRejection(() =>
                service.adjustReorderListLine(ctx, {
                    reorderListId: LIST_ID,
                    lineId: LINE_ID,
                    quantity: MAX_QUANTITY_PER_LINE + 1,
                }),
            );

            expect(failure).toBeInstanceOf(UserInputError);
            expect((failure as UserInputError).message).toBe(QUANTITY_ABOVE_MAXIMUM_KEY);
            expect((failure as UserInputError).variables).toEqual({ max: MAX_QUANTITY_PER_LINE });
            expect(writeStatements(harness)).toEqual([]);
        });

        it('applies the bound to the resulting quantity and not to the increment', async () => {
            harness.plan.lineGetOne = () => ownedLine({ quantity: 6 });
            harness.plan.lineAffected = () => 1;

            const refused = await captureRejection(() =>
                service.addItemToReorderList(ctx, {
                    reorderListId: LIST_ID,
                    productVariantId: VARIANT_ID,
                    quantity: 6,
                }),
            );

            expect(refused).toBeInstanceOf(UserInputError);
            expect((refused as UserInputError).message).toBe(QUANTITY_ABOVE_MAXIMUM_KEY);
            expect((refused as UserInputError).variables).toEqual({ max: MAX_QUANTITY_PER_LINE });
            expect(writeStatements(harness)).toEqual([]);

            const accepted = await service.addItemToReorderList(ctx, {
                reorderListId: LIST_ID,
                productVariantId: VARIANT_ID,
                quantity: MAX_QUANTITY_PER_LINE - 6,
            });

            expect(accepted).toBeInstanceOf(ReorderList);
        });

        it('accepts a quantity of exactly one and of exactly the configured maximum', async () => {
            harness.plan.lineGetOne = () => null;
            harness.plan.listAffected = () => 1;

            const one = await service.addItemToReorderList(ctx, {
                reorderListId: LIST_ID,
                productVariantId: VARIANT_ID,
                quantity: 1,
            });
            const atBound = await service.addItemToReorderList(ctx, {
                reorderListId: LIST_ID,
                productVariantId: VARIANT_ID,
                quantity: MAX_QUANTITY_PER_LINE,
            });

            expect(one).toBeInstanceOf(ReorderList);
            expect(atBound).toBeInstanceOf(ReorderList);
        });

        it('raises the platform input error for a refused quantity rather than any negative-quantity type', async () => {
            const failure = await captureRejection(() =>
                service.adjustReorderListLine(ctx, {
                    reorderListId: LIST_ID,
                    lineId: LINE_ID,
                    quantity: -1,
                }),
            );

            // The platform's own negative-quantity result describes an OrderLine, covers `quantity < 0`
            // only and is silent on zero, so it is not the vocabulary for this refusal [EPIC-001:R13].
            expect((failure as Error).constructor.name).toBe('UserInputError');
            expect((failure as { __typename?: string }).__typename).toBeUndefined();
            expect((failure as { errorCode?: string }).errorCode).toBeUndefined();
        });
    });

    // ---------------------------------------------------------------------------------------------------
    // Constraint translation. A widened mapping would report a duplicate LINE as a duplicate NAME, which is
    // a wrong answer that reads like a right one [FEATURE-001-01:§2.11].
    // ---------------------------------------------------------------------------------------------------

    describe('the narrow translation of one named database object', () => {
        /** '  Pantry   Top-Up  ' canonicalises to this display value and this key. Written as literals so
         * the assertion is independent of the canonicalisation module rather than a restatement of it. */
        const SUBMITTED_NAME = '  Pantry   Top-Up  ';
        const CANONICAL_KEY = 'pantry top-up';

        it('maps a violation of the list name constraint to ReorderListNameConflictError', async () => {
            harness.plan.saveList = () => {
                throw driverFailure(
                    `duplicate key value violates unique constraint "${NAME_CONFLICT_CONSTRAINT}"`,
                    { query: 'INSERT INTO "reorder_list" ...' },
                );
            };

            const result = await service.createReorderList(ctx, { name: SUBMITTED_NAME });

            expect(result).toBeInstanceOf(ReorderListNameConflictError);
            // The key echoes the caller's own submission and discloses nothing about the row it collided
            // with [FEATURE-001-01:§2.10].
            expect((result as ReorderListNameConflictError).conflictingNameKey).toBe(CANONICAL_KEY);
            expect((result as ReorderListNameConflictError).errorCode).toBe(
                'REORDER_LIST_NAME_CONFLICT_ERROR',
            );
        });

        it('matches the constraint name irrespective of the case the engine reports it in', async () => {
            harness.plan.saveList = () => {
                throw driverFailure(
                    `Duplicate entry 'x' for key '${NAME_CONFLICT_CONSTRAINT.toUpperCase()}'`,
                    { driverError: { sqlMessage: NAME_CONFLICT_CONSTRAINT.toUpperCase() } },
                );
            };

            const result = await service.createReorderList(ctx, { name: SUBMITTED_NAME });

            expect(result).toBeInstanceOf(ReorderListNameConflictError);
            expect((result as ReorderListNameConflictError).conflictingNameKey).toBe(CANONICAL_KEY);
        });

        it('recognises the same object where an engine names its columns instead of its constraint', async () => {
            harness.plan.saveList = () => {
                throw driverFailure(
                    'UNIQUE constraint failed: reorder_list.customerId, reorder_list.channelId, reorder_list.nameKey',
                );
            };

            const result = await service.createReorderList(ctx, { name: SUBMITTED_NAME });

            expect(result).toBeInstanceOf(ReorderListNameConflictError);
        });

        it('translates a rename collision on the update path with the same narrow match', async () => {
            harness.plan.listAffected = () => {
                throw driverFailure(
                    `duplicate key value violates unique constraint "${NAME_CONFLICT_CONSTRAINT}"`,
                );
            };

            const result = await service.updateReorderList(ctx, { id: LIST_ID, name: SUBMITTED_NAME });

            expect(result).toBeInstanceOf(ReorderListNameConflictError);
            expect((result as ReorderListNameConflictError).conflictingNameKey).toBe(CANONICAL_KEY);
        });

        it('does NOT map a violation of the line uniqueness object to a name conflict', async () => {
            harness.plan.saveList = () => {
                throw driverFailure(
                    `duplicate key value violates unique constraint "${LINE_DEDUPLICATION_CONSTRAINT}"`,
                    { query: 'INSERT INTO "reorder_list_line" ...' },
                );
            };

            const failure = await captureRejection(() =>
                service.createReorderList(ctx, { name: SUBMITTED_NAME }),
            );

            // The two objects are separate, are named separately and carry different columns, so neither
            // descriptor can match the other's failure — a duplicate line reaching here is an internal
            // defect rather than a buyer outcome [FEATURE-001-01:§2.11].
            expect(failure).not.toBeInstanceOf(ReorderListNameConflictError);
            expect(failure).toBeInstanceOf(InternalServerError);
            expect((failure as InternalServerError).message).toBe(UNCLASSIFIED_FAILURE_MESSAGE);
        });

        it('decides every duplicate at the named constraint, issuing no name pre-check of its own', async () => {
            // An ordinary duplicate — not a race — and the insert is still attempted, because the named unique
            // object is required to BE the uniqueness authority rather than a backstop behind a service
            // pre-check that ordinarily decides first [FEATURE-001-01:§2.11].
            harness.plan.saveList = () => {
                throw driverFailure(
                    `duplicate key value violates unique constraint "${NAME_CONFLICT_CONSTRAINT}"`,
                );
            };

            const result = await service.createReorderList(ctx, { name: SUBMITTED_NAME });

            expect(result).toBeInstanceOf(ReorderListNameConflictError);
            expect((result as ReorderListNameConflictError).conflictingNameKey).toBe(CANONICAL_KEY);
            // The insert really was attempted, so the constraint really did decide.
            expect(statementsOfKind(harness, 'ReorderList', 'insert')).toHaveLength(1);
        });

        it('issues no nameKey count anywhere on the create path', async () => {
            await service.createReorderList(ctx, { name: SUBMITTED_NAME });

            const counts = harness.journal.filter(statement => statement.terminal === 'count');
            // Exactly one count is issued, and it is the list bound's — a count whose predicate carried
            // `nameKey` would be the pre-check this path must not have.
            expect(counts).toHaveLength(1);
            expect(Object.keys((counts[0].findOptions?.where ?? {}) as object).sort()).toEqual([
                'channelId',
                'customerId',
            ]);
        });
    });

    describe('the sanitised rethrow of every failure that is not that one object', () => {
        const HOSTILE_DRIVER_MESSAGE =
            "ER_DUP_ENTRY: Duplicate entry 'T_5-T_1-pantry' for key 'IDX_reorder_list_customer_channel'";

        function rejectSaveWithDriverFailure(): void {
            harness.plan.saveList = () => {
                throw driverFailure(HOSTILE_DRIVER_MESSAGE, {
                    query: 'INSERT INTO `reorder_list` (`customerId`, `nameKey`) VALUES (?, ?)',
                    parameters: [CUSTOMER_ID, 'pantry'],
                    driverError: { code: 'ER_DUP_ENTRY', sqlMessage: HOSTILE_DRIVER_MESSAGE },
                });
            };
        }

        it('re-raises an unclassified database failure as an internal error', async () => {
            rejectSaveWithDriverFailure();

            const failure = await captureRejection(() => service.createReorderList(ctx, { name: 'Pantry' }));

            expect(failure).toBeInstanceOf(InternalServerError);
            expect((failure as InternalServerError).code).toBe('INTERNAL_SERVER_ERROR');
            expect((failure as InternalServerError).message).toBe(UNCLASSIFIED_FAILURE_MESSAGE);
        });

        it('publishes no driver text, no SQL fragment, no table name and no constraint name', async () => {
            rejectSaveWithDriverFailure();

            const failure = await captureRejection(() => service.createReorderList(ctx, { name: 'Pantry' }));
            const message = (failure as InternalServerError).message;

            expect(message).not.toContain('ER_DUP_ENTRY');
            expect(message).not.toContain('INSERT');
            expect(message).not.toContain('SELECT');
            expect(message).not.toContain(REORDER_LIST_TABLE);
            expect(message).not.toContain(REORDER_LIST_LINE_TABLE);
            expect(message).not.toContain('UQ_');
            expect(message).not.toContain('IDX_');
            expect(message).not.toContain('CHK_');
        });

        it('replaces the captured frames, so no build path reaches the platform exception logger', async () => {
            rejectSaveWithDriverFailure();

            const failure = await captureRejection(() => service.createReorderList(ctx, { name: 'Pantry' }));

            const error = failure as Error;
            // One information-free line in the shape a log formatter expects — the error's own class and
            // its already-sanitised message — carrying no absolute source path and no captured frame. The
            // platform's exception logger logs `exception.stack`, so leaving the frames intact would open
            // the boundary one layer out from this service.
            expect(error.stack).toBe(`${error.name}: ${UNCLASSIFIED_FAILURE_MESSAGE}`);
            expect(error.stack?.split('\n')).toHaveLength(1);
            expect(error.stack).not.toContain('/');
            expect(error.stack).not.toContain(' at ');
        });

        it('does not swallow the failure: the operation and its class are logged under the plugin context', async () => {
            rejectSaveWithDriverFailure();

            await captureRejection(() => service.createReorderList(ctx, { name: 'Pantry' }));

            expect(loggedErrors).toHaveLength(1);
            expect(loggedErrors[0].context).toBe(loggerCtx);
            expect(loggedErrors[0].message).toContain('createReorderList');
            expect(loggedErrors[0].message).toContain('a database query failure');
            expect(loggedErrors[0].message).toContain('correlation id');
            // The log line is inside the disclosure boundary too: an application log outlives the request
            // and is read by tools that were never entitled to the driver's wording.
            expect(loggedErrors[0].message).not.toContain('ER_DUP_ENTRY');
            expect(loggedErrors[0].message).not.toContain(REORDER_LIST_TABLE);
            expect(loggedErrors[0].message).not.toContain('IDX_');
        });

        it('classifies a thrown value that is not an Error without letting it reach the caller', async () => {
            const nonErrorFailure: unknown = { detail: 'a value that is not an Error at all' };
            harness.plan.saveList = () => {
                throw nonErrorFailure;
            };

            const failure = await captureRejection(() => service.createReorderList(ctx, { name: 'Pantry' }));

            expect(failure).toBeInstanceOf(InternalServerError);
            expect(loggedErrors[0].message).toContain('a non-error value');
        });

        it('classifies an unexpected Error carrying no statement as such', async () => {
            harness.plan.saveList = () => {
                throw new Error('a defect in this file rather than in the database');
            };

            const failure = await captureRejection(() => service.createReorderList(ctx, { name: 'Pantry' }));

            expect(failure).toBeInstanceOf(InternalServerError);
            expect((failure as InternalServerError).message).toBe(UNCLASSIFIED_FAILURE_MESSAGE);
            expect(loggedErrors[0].message).toContain('an unexpected error');
        });

        it('replaces an internal error raised inside a collaborator rather than forwarding its wording', async () => {
            harness.plan.saveList = () => {
                throw new InternalServerError('The configured strategy rejected reorder_list.nameKey');
            };

            const failure = await captureRejection(() => service.createReorderList(ctx, { name: 'Pantry' }));

            expect(failure).toBeInstanceOf(InternalServerError);
            expect((failure as InternalServerError).message).toBe(UNCLASSIFIED_FAILURE_MESSAGE);
            expect((failure as InternalServerError).message).not.toContain(REORDER_LIST_TABLE);
        });

        it('forwards a caller-classified input failure unchanged, because it is already safe to read', async () => {
            harness.plan.saveList = () => {
                throw new UserInputError('error.some-platform-input-failure', { limit: 3 });
            };

            const failure = await captureRejection(() => service.createReorderList(ctx, { name: 'Pantry' }));

            expect(failure).toBeInstanceOf(UserInputError);
            expect((failure as UserInputError).message).toBe('error.some-platform-input-failure');
            expect((failure as UserInputError).variables).toEqual({ limit: 3 });
            expect(loggedErrors).toEqual([]);
        });

        it('sanitises a failure of the owner lookup, so the one statement every operation issues is inside the boundary', async () => {
            harness.plan.customerFailure = driverFailure('relation "customer" does not exist', {
                query: 'SELECT "customer"."id" FROM "customer"',
            });

            const failure = await captureRejection(() => service.getReorderList(ctx, LIST_ID));

            expect(failure).toBeInstanceOf(InternalServerError);
            expect((failure as InternalServerError).message).toBe(UNCLASSIFIED_FAILURE_MESSAGE);
            expect((failure as InternalServerError).message).not.toContain('customer');
            expect(loggedErrors[0].message).toContain('getReorderList');
            // The owner look-up runs before any plugin statement, so none was reached.
            expect(pluginStatements(harness)).toEqual([]);
        });
    });

    // ---------------------------------------------------------------------------------------------------
    // The reads. Clamping is the platform's, the tie-break is appended rather than substituted, and the
    // stored counter is the only authority for the number [FEATURE-001-01:§2.6, §2.6.2].
    // ---------------------------------------------------------------------------------------------------

    describe('page bounds, which are delegated to the platform rather than reimplemented', () => {
        it('applies the configured default page size where the caller supplies no take', async () => {
            await service.getReorderLists(ctx);

            expect(harness.builds[0].options.take).toBe(DEFAULT_LISTS_PAGE_SIZE);
        });

        it('applies the configured default nested page size where the caller supplies no take', async () => {
            await service.getLinesForLists(ctx, [LIST_ID]);

            expect(harness.builds[0].options.take).toBe(DEFAULT_LINES_PAGE_SIZE);
        });

        it('passes a caller-supplied take through unchanged on both reads', async () => {
            await service.getReorderLists(ctx, { take: 7 });
            const listsBuild = harness.builds[0];
            resetRecorders(harness);
            await service.getLinesForLists(ctx, [LIST_ID], { take: 9 });

            expect(listsBuild.options.take).toBe(7);
            expect(harness.builds[0].options.take).toBe(9);
        });

        it('lets the platform refuse an over-limit take rather than clamping it or refusing it here', async () => {
            const failure = await captureRejection(() =>
                service.getReorderLists(ctx, { take: SHOP_LIST_QUERY_LIMIT + 400 }),
            );

            // The refusal is the platform's, with the platform's key and the platform's limit; the service
            // neither substituted a message of its own nor quietly reduced the number
            // [packages/core/src/service/helpers/list-query-builder/list-query-builder.ts:L637-L639].
            expect(failure).toBeInstanceOf(UserInputError);
            expect((failure as UserInputError).message).toBe('error.list-query-limit-exceeded');
            expect((failure as UserInputError).variables).toEqual({ limit: SHOP_LIST_QUERY_LIMIT });
            expect(harness.builds[0].options.take).toBe(SHOP_LIST_QUERY_LIMIT + 400);
        });

        it('never asks the builder to ignore the query limits on either read', async () => {
            await service.getReorderLists(ctx, { take: 5 });
            await service.getLinesForLists(ctx, [LIST_ID], { take: 5 });

            expect(harness.builds).toHaveLength(2);
            for (const build of harness.builds) {
                expect('ignoreQueryLimits' in build.extendedOptions).toBe(false);
                expect(build.extendedOptions.ignoreQueryLimits).not.toBe(true);
            }
        });
    });

    describe('the server-side scope, which no caller filter can widen', () => {
        it('keeps the acting customer pinned when the caller filters for a different one', async () => {
            await service.getReorderLists(ctx, {
                filter: { name: { contains: 'pantry' } },
            } as ListQueryOptions<ReorderList>);

            expect(harness.builds[0].extendedOptions.where).toEqual({
                customerId: CUSTOMER_ID,
                channelId: CHANNEL_ID,
            });
            expect(harness.builds[0].options.filter).toEqual({ name: { contains: 'pantry' } });
        });

        it('scopes the nested read to the requested parents and to the owning customer and channel', async () => {
            await service.getLinesForLists(ctx, [LIST_ID, SECOND_LIST_ID]);

            const where = harness.builds[0].extendedOptions.where as Record<string, unknown>;
            expect(where.reorderListId).toBeInstanceOf(FindOperator);
            expect((where.reorderListId as FindOperator<ID>).value).toEqual([LIST_ID, SECOND_LIST_ID]);
            expect(where.reorderList).toEqual({ customerId: CUSTOMER_ID, channelId: CHANNEL_ID });
        });
    });

    describe('the deterministic sort, whose tie-break is appended and never substituted', () => {
        it('orders a page of lists by creation time then identifier, both descending, by default', async () => {
            await service.getReorderLists(ctx);

            expect(harness.builds[0].extendedOptions.orderBy).toEqual({
                createdAt: 'DESC',
                id: 'DESC',
            });
            expect(harness.builds[0].options.sort).toBeUndefined();
        });

        it('orders a page of lines by creation time then identifier, both ascending, by default', async () => {
            await service.getLinesForLists(ctx, [LIST_ID]);

            expect(harness.builds[0].extendedOptions.orderBy).toEqual({ createdAt: 'ASC', id: 'ASC' });
            expect(harness.builds[0].options.sort).toBeUndefined();
        });

        it('leaves a caller sort untouched and contributes only the identifier tie-break', async () => {
            await service.getReorderLists(ctx, { sort: { name: 'ASC' } } as ListQueryOptions<ReorderList>);

            const build = harness.builds[0];
            expect(build.options.sort).toEqual({ name: 'ASC' });
            expect(build.extendedOptions.orderBy).toEqual({ id: 'DESC' });
            // The platform merges the extended options LAST, so the caller's key leads and the tie-break
            // trails — which is what "appended" means and is the only mechanism that can express it.
            const merged = Object.assign({}, build.options.sort, build.extendedOptions.orderBy);
            expect(Object.keys(merged)).toEqual(['name', 'id']);
        });

        it('appends nothing for the identifier where the caller already named it, keeping their direction', async () => {
            await service.getReorderLists(ctx, {
                sort: { name: 'ASC', id: 'ASC' },
            } as ListQueryOptions<ReorderList>);

            const build = harness.builds[0];
            expect(build.extendedOptions.orderBy).toEqual({});
            const merged = Object.assign({}, build.options.sort, build.extendedOptions.orderBy) as Record<
                string,
                string
            >;
            expect(merged.id).toBe('ASC');
        });

        it('appends nothing for the identifier on a nested read where the caller already named it', async () => {
            await service.getLinesForLists(ctx, [LIST_ID], {
                sort: { quantity: 'DESC', id: 'DESC' },
            } as ListQueryOptions<ReorderListLine>);

            expect(harness.builds[0].extendedOptions.orderBy).toEqual({});
        });

        it('treats a sort whose every direction is absent as no sort at all', async () => {
            await service.getReorderLists(ctx, {
                sort: { name: null },
            } as unknown as ListQueryOptions<ReorderList>);

            expect(harness.builds[0].options.sort).toBeUndefined();
            expect(harness.builds[0].extendedOptions.orderBy).toEqual({
                createdAt: 'DESC',
                id: 'DESC',
            });
        });

        it('contributes the tie-break where a caller names the identifier with an absent direction', async () => {
            await service.getReorderLists(ctx, {
                sort: { name: 'ASC', id: null },
            } as unknown as ListQueryOptions<ReorderList>);

            expect(harness.builds[0].options.sort).toEqual({ name: 'ASC' });
            expect(harness.builds[0].extendedOptions.orderBy).toEqual({ id: 'DESC' });
        });
    });

    describe('lineCount, which is the stored column and the only authority for the number', () => {
        it('arrives with the row, so a page of lists issues no further statement for the count', async () => {
            harness.plan.listPage = () => [
                [ownedList({ lineCount: 12 }), ownedList({ id: SECOND_LIST_ID, lineCount: 4 })],
                2,
            ];

            const page = await service.getReorderLists(ctx);

            expect(page.items.map(item => item.lineCount)).toEqual([12, 4]);
            expect(pluginStatements(harness)).toHaveLength(1);
            expect(pluginStatements(harness)[0].terminal).toBe('getManyAndCount');
        });

        it('is not derived from the length of a nested page, which is a different number', async () => {
            harness.plan.listPage = () => [[ownedList({ lineCount: 12 })], 1];
            harness.plan.linePage = () => [ownedLine({ id: LINE_ID }), ownedLine({ id: OTHER_LINE_ID })];
            harness.plan.lineTotals = { [LIST_ID]: 12 };

            const page = await service.getReorderLists(ctx);
            const lines = await service.getLinesForLists(ctx, [LIST_ID], { take: 2 });

            const nested = lines.get(LIST_ID);
            expect(page.items[0].lineCount).toBe(12);
            expect(nested?.items).toHaveLength(2);
            // The summary number and the page are not the same number wearing two names.
            expect(page.items[0].lineCount).not.toBe(nested?.items.length);
            expect(nested?.totalItems).toBe(12);
        });

        it('is never repaired by the collection read, which has no observed total to compare against', async () => {
            harness.plan.listPage = () => [[ownedList({ lineCount: 99 })], 1];

            await service.getReorderLists(ctx);

            expect(harness.journal.some(isLineCountRepair)).toBe(false);
            expect(statementsOfKind(harness, 'ReorderList', 'update')).toEqual([]);
        });
    });

    describe('the nested-lines read, which is resolved once per page and never once per entry', () => {
        beforeEach(() => {
            harness.plan.linePage = () => [
                ownedLine({ id: LINE_ID, reorderListId: LIST_ID }),
                ownedLine({ id: OTHER_LINE_ID, reorderListId: SECOND_LIST_ID }),
            ];
            harness.plan.lineTotals = { [LIST_ID]: 1, [SECOND_LIST_ID]: 1 };
        });

        it('costs the same number of statements for six parents as for three', async () => {
            const threeParents = [LIST_ID, SECOND_LIST_ID, 'T_102'];
            const sixParents = [...threeParents, 'T_103', 'T_104', 'T_105'];

            // A FRESH request for each page size, so neither run can be cheapened by the other's
            // request-scoped owner scope, and the two are therefore comparable. The count asserted is the
            // plugin-statement count — statements against `reorder_list` and `reorder_list_line`, filtered by
            // table — which is the boundary an exact number may be asserted at [EPIC-001:§7.7].
            await service.getLinesForLists(createCtx(), threeParents);
            const forThree = pluginStatements(harness).length;
            const buildsForThree = harness.builds.length;
            resetRecorders(harness);

            await service.getLinesForLists(createCtx(), sixParents);

            expect(pluginStatements(harness).length).toBe(forThree);
            expect(harness.builds.length).toBe(buildsForThree);
            expect(harness.builds).toHaveLength(1);
        });

        it('resolves the owner scope once per request, however many reads the request performs', async () => {
            // A root read that selects the nested `lines` field asks for the scope twice — once for the page
            // and once for the batched lines — and each asks independently, so neither is safe only by virtue
            // of its caller. The second ask is served from the request-scoped cache, so the Customer lookup is
            // issued once. It is keyed on the RequestContext, so a second request resolves its own.
            await service.getReorderLists(ctx);
            await service.getLinesForLists(ctx, [LIST_ID]);

            expect(statementsAgainst(harness, 'Customer')).toHaveLength(1);

            await service.getLinesForLists(createCtx(), [LIST_ID]);

            expect(statementsAgainst(harness, 'Customer')).toHaveLength(2);
        });

        it('never caches a refusal, so a failed scope resolution is re-attempted rather than remembered', async () => {
            harness.plan.customerRow = null;

            const first = await captureRejection(() => service.getLinesForLists(ctx, [LIST_ID]));
            const second = await captureRejection(() => service.getLinesForLists(ctx, [LIST_ID]));

            expect(first).toBeInstanceOf(InternalServerError);
            expect(second).toBeInstanceOf(InternalServerError);
            // Two lookups for two asks: nothing about the failure was remembered, so no path can read a
            // cached refusal in place of the check that would have decided.
            expect(statementsAgainst(harness, 'Customer')).toHaveLength(2);
        });

        it('returns a page for every requested parent, empty where that parent holds no line', async () => {
            const result = await service.getLinesForLists(ctx, [LIST_ID, SECOND_LIST_ID, 'T_102']);

            expect([...result.keys()]).toEqual([LIST_ID, SECOND_LIST_ID, 'T_102']);
            expect(result.get(LIST_ID)?.items.map(line => line.id)).toEqual([LINE_ID]);
            expect(result.get(SECOND_LIST_ID)?.items.map(line => line.id)).toEqual([OTHER_LINE_ID]);
            expect(result.get('T_102')).toEqual({
                items: [],
                totalItems: 0,
                // An unfiltered read establishes the parent's whole line count, so a parent with no line
                // reports an authoritative zero rather than withholding the number.
                authoritativeTotalItems: 0,
            });
        });

        it('publishes the counter-repair total only where the caller narrowed nothing', async () => {
            harness.plan.lineTotals = { [LIST_ID]: 7 };

            const unfiltered = await service.getLinesForLists(ctx, [LIST_ID]);

            // Unfiltered: the grouped count IS the list's line count, so it may repair the stored counter.
            expect(unfiltered.get(LIST_ID)?.totalItems).toBe(7);
            expect(unfiltered.get(LIST_ID)?.authoritativeTotalItems).toBe(7);
        });

        it('withholds the counter-repair total from a filtered read, whose count is a subset', async () => {
            harness.plan.lineTotals = { [LIST_ID]: 1 };

            const filtered = await service.getLinesForLists(ctx, [LIST_ID], {
                filter: { quantity: { eq: 3 } },
            });

            // The published total still answers the caller's question...
            expect(filtered.get(LIST_ID)?.totalItems).toBe(1);
            // ...but it is NOT offered as the counter's authority, because it counts a subset of the lines.
            // Writing it into `reorder_list.lineCount` would let a caller who filters to nothing reset the
            // counter the atomic line bound is enforced against [FEATURE-001-01:§2.6.2.1].
            expect(filtered.get(LIST_ID)?.authoritativeTotalItems).toBeUndefined();
            expect('authoritativeTotalItems' in (filtered.get(LIST_ID) as object)).toBe(false);
        });

        it('withholds the counter-repair total from a read carrying only a filter operator', async () => {
            harness.plan.lineTotals = { [LIST_ID]: 4 };

            const filtered = await service.getLinesForLists(ctx, [LIST_ID], {
                filterOperator: LogicalOperator.OR,
            });

            expect(filtered.get(LIST_ID)?.totalItems).toBe(4);
            expect(filtered.get(LIST_ID)?.authoritativeTotalItems).toBeUndefined();
        });

        it('withholds the counter-repair total from a refused read, which establishes nothing', async () => {
            const refused = await service.getLinesForLists(createCtx({ anonymous: true }), [LIST_ID]);

            expect(refused.get(LIST_ID)).toEqual({ items: [], totalItems: 0 });
            expect(refused.get(LIST_ID)?.authoritativeTotalItems).toBeUndefined();
        });

        it('treats an empty filter object as no filter, because it narrows nothing', async () => {
            harness.plan.lineTotals = { [LIST_ID]: 4 };

            const result = await service.getLinesForLists(ctx, [LIST_ID], {
                filter: {},
            } as ListQueryOptions<ReorderListLine>);

            expect(result.get(LIST_ID)?.authoritativeTotalItems).toBe(4);
        });

        it('withholds the counter-repair total from every page a filtered read produced', async () => {
            harness.plan.lineTotals = { [LIST_ID]: 2, [SECOND_LIST_ID]: 5 };

            const result = await service.getLinesForLists(ctx, [LIST_ID, SECOND_LIST_ID], {
                take: 1,
                filter: { quantity: { gt: 0 } },
            } as ListQueryOptions<ReorderListLine>);

            // Narrowing is a property of the REQUEST, not of one parent's page: neither parent's count
            // describes its whole collection once a filter is in force.
            expect(result.get(LIST_ID)).not.toHaveProperty('authoritativeTotalItems');
            expect(result.get(SECOND_LIST_ID)).not.toHaveProperty('authoritativeTotalItems');
        });

        it('issues no statement at all for an empty set of parents', async () => {
            const result = await service.getLinesForLists(ctx, []);

            expect(result.size).toBe(0);
            expect(harness.journal).toEqual([]);
            expect(harness.listQueryBuilder.build).not.toHaveBeenCalled();
        });

        it('windows each parent by rank, so one statement serves the whole page', async () => {
            await service.getLinesForLists(ctx, [LIST_ID, SECOND_LIST_ID], { take: 4, skip: 2 });

            const reads = statementsAgainst(harness, 'ReorderListLine');
            const page = reads.find(statement => statement.terminal === 'getMany') as JournalledStatement;
            expect(conditionTextOf(page)).toContain('IN (SELECT');
            expect(conditionTextOf(page)).toContain('ROW_NUMBER() OVER (PARTITION BY');
            // The resolved window is bound rather than interpolated, and its upper edge is skip + take.
            expect(Object.values(page.parameters).sort()).toEqual([2, 6]);
        });

        it('counts each parent total from a projection taken before the window predicate is applied', async () => {
            await service.getLinesForLists(ctx, [LIST_ID, SECOND_LIST_ID]);

            const totals = statementsAgainst(harness, 'ReorderListLine').find(
                statement => statement.terminal === 'getRawMany',
            ) as JournalledStatement;
            expect(totals).toBeDefined();
            expect(conditionTextOf(totals)).not.toContain('IN (SELECT');
        });

        it('groups the totals by the parent column it projects and counts rows rather than anything else', async () => {
            const result = await service.getLinesForLists(ctx, [LIST_ID, SECOND_LIST_ID]);

            const totals = statementsAgainst(harness, 'ReorderListLine').find(
                statement => statement.terminal === 'getRawMany',
            ) as JournalledStatement;
            const parentColumn = `${escaped('reorderlistline')}.${escaped('reorderListId')}`;
            // The SHAPE of the aggregate, asserted rather than assumed from the numbers it returned. A
            // statement that dropped the grouping would return one row for the whole page, one that grouped by
            // a different expression would attribute another parent's lines, and one that counted a nullable
            // column instead of rows would under-report — and every one of those returns a plausible number.
            // Both projections are alias-qualified through the driver, which is what makes the same fragment
            // correct on an engine that folds an unquoted camel-cased identifier to lower case.
            expect(totals.selections).toHaveLength(2);
            expect(totals.selections[0].expression).toBe(parentColumn);
            expect(totals.selections[1].expression).toBe('COUNT(*)');
            expect(totals.groupings).toEqual([parentColumn]);
            // Each projection is read back under its own alias, and the two are distinct — the service reads
            // the raw rows by those keys, so a shared or absent alias would leave it reading `undefined`.
            const [parentAlias, countAlias] = totals.selections.map(selection => selection.alias);
            expect(typeof parentAlias).toBe('string');
            expect(typeof countAlias).toBe('string');
            expect(parentAlias).not.toBe(countAlias);
            // And the totals really did come back through that projection: the harness answers a
            // grouped-count statement only when its shape is the one asserted above, so these numbers are
            // evidence of the shape rather than a value configured independently of it.
            expect(result.get(LIST_ID)?.totalItems).toBe(1);
            expect(result.get(SECOND_LIST_ID)?.totalItems).toBe(1);
        });

        it('escapes every identifier of its raw fragments through the driver', async () => {
            await service.getLinesForLists(ctx, [LIST_ID]);

            expect(harness.escapedIdentifiers).toContain('id');
            expect(harness.escapedIdentifiers).toContain('reorderListId');
            expect(harness.metadataRequests).toContain('ReorderListLine');
        });
    });

    describe('reconcileLineCount, the one compare-and-set repair', () => {
        it('issues no statement where the stored value already equals the observed total', async () => {
            const repaired = await service.reconcileLineCount(ctx, LIST_ID, 4, 4);

            expect(repaired).toBe(4);
            expect(harness.journal).toEqual([]);
        });

        it('issues exactly one guarded update where the two disagree, and reports the observed total', async () => {
            const repaired = await service.reconcileLineCount(ctx, LIST_ID, 4, 2);

            const updates = statementsOfKind(harness, 'ReorderList', 'update');
            expect(repaired).toBe(2);
            expect(updates).toHaveLength(1);
            expect(updates[0].updateSet).toEqual({ lineCount: 2 });
            expect(conditionTextOf(updates[0])).toContain('id = :id');
            expect(conditionTextOf(updates[0])).toContain('lineCount = :storedLineCount');
            expect(updates[0].parameters.id).toBe(LIST_ID);
            expect(updates[0].parameters.storedLineCount).toBe(4);
        });

        it('is idempotent: a second pass over the now-equal values issues nothing', async () => {
            await service.reconcileLineCount(ctx, LIST_ID, 4, 2);
            const statementsAfterRepair = harness.journal.length;

            const second = await service.reconcileLineCount(ctx, LIST_ID, 2, 2);

            expect(second).toBe(2);
            expect(harness.journal).toHaveLength(statementsAfterRepair);
        });

        it('reports the observed total and records the miss where a competing repair changed the guard', async () => {
            harness.plan.listAffected = () => 0;

            const repaired = await service.reconcileLineCount(ctx, LIST_ID, 4, 2);

            expect(repaired).toBe(2);
            expect(statementsOfKind(harness, 'ReorderList', 'update')).toHaveLength(1);
            expect(loggedDebug.join(' ')).toContain('changed concurrently');
        });

        it('refuses to write an observed total that is not a non-negative integer', async () => {
            const negative = await service.reconcileLineCount(ctx, LIST_ID, 4, -1);
            const fractional = await service.reconcileLineCount(ctx, LIST_ID, 4, 2.5);

            expect(negative).toBe(4);
            expect(fractional).toBe(4);
            expect(harness.journal).toEqual([]);
            expect(loggedErrors).toHaveLength(2);
            expect(loggedErrors[0].message).toContain('non-negative integer');
            expect(loggedErrors[0].context).toBe(loggerCtx);
        });
    });

    describe('the forward-compatible sharing surface, published now and implemented later', () => {
        it('accepts includeShared at both values on the collection read and composes the same scope', async () => {
            await service.getReorderLists(ctx, undefined, false);
            const whenFalse = harness.builds[0].extendedOptions.where;
            resetRecorders(harness);

            await service.getReorderLists(ctx, undefined, true);
            const whenTrue = harness.builds[0].extendedOptions.where;
            resetRecorders(harness);

            await service.getReorderLists(ctx);
            const whenOmitted = harness.builds[0].extendedOptions.where;

            expect(whenTrue).toEqual(whenFalse);
            expect(whenOmitted).toEqual(whenFalse);
        });

        it('accepts includeShared at both values on the single-list read without refusing either', async () => {
            const whenFalse = await service.getReorderList(ctx, LIST_ID, false);
            const whenTrue = await service.getReorderList(ctx, LIST_ID, true);

            expect(whenTrue).toEqual(whenFalse);
        });

        it('accepts includeShared as an explicit null on both reads, which is what a nullable argument permits', async () => {
            // NOT the same value as an omitted argument, and the distinction is the schema's. Neither read
            // declares the argument non-null, so a client may send it as a literal `null` or as a variable
            // whose value is `null` — and a `null` argument reaches a resolver as `null`, not normalised to
            // `undefined` and not replaced by the field's declared default, which applies only where the
            // argument was omitted entirely. A signature admitting only `boolean | undefined` therefore
            // describes a narrower contract than the one clients hold, and its callers are type-checked
            // against the wrong thing.
            await service.getReorderLists(ctx, undefined, null);
            const whenNull = harness.builds[0].extendedOptions.where;
            resetRecorders(harness);

            await service.getReorderLists(ctx);
            const whenOmitted = harness.builds[0].extendedOptions.where;

            expect(whenNull).toEqual(whenOmitted);
            expect(await service.getReorderList(ctx, LIST_ID, null)).toEqual(
                await service.getReorderList(ctx, LIST_ID),
            );
        });

        it('accepts the page options as an explicit null and applies the configured default page size to it', async () => {
            // The other nullable boundary value, and the one with an observable consequence rather than none:
            // options sent as `null` must reach the same page the omitted case reaches, which means the
            // configured default `take` still has to be applied rather than skipped because the object it
            // would have been merged into was null.
            await service.getReorderLists(ctx, null);
            const whenNull = harness.builds[0].options;
            resetRecorders(harness);

            await service.getReorderLists(ctx, undefined);
            const whenOmitted = harness.builds[0].options;

            expect(whenNull).toEqual(whenOmitted);
            expect(whenNull.take).toBe(DEFAULT_LISTS_PAGE_SIZE);
        });

        it('references no share table and no grant field anywhere in the statements it composes', async () => {
            await service.getReorderLists(ctx, undefined, true);
            await service.getReorderList(ctx, LIST_ID, true);

            const composed = JSON.stringify({
                journal: harness.journal,
                builds: harness.builds.map(build => ({
                    options: build.options,
                    extendedOptions: { where: build.extendedOptions.where },
                })),
                repositories: harness.repositoryRequests,
            }).toLowerCase();
            expect(composed).not.toContain('grant');
            expect(composed).not.toContain('share');
        });

        it('reports OWNED access with no granted capability, at no statement cost at all', async () => {
            // The provenance the derivation reads is recorded by the read itself, so the subject has to come
            // from a read rather than from a bare constructor call. The recorders are then emptied, which is
            // what makes "at no statement cost" measurable: the zero being asserted is this call's own.
            const list = (await service.getReorderList(ctx, LIST_ID)) as ReorderList;
            resetRecorders(harness);
            harness.listQueryBuilder.build.mockClear();

            const access = service.getViewerAccess(ctx, list);

            expect(access).toEqual({ access: 'OWNED', grantedCapabilities: [] });
            expect(harness.journal).toEqual([]);
            expect(harness.repositoryRequests).toEqual([]);
            expect(harness.metadataRequests).toEqual([]);
            expect(harness.listQueryBuilder.build).not.toHaveBeenCalled();
        });

        it('derives the answer from provenance rather than asserting it, refusing a row it never resolved', () => {
            // A row that reached the derivation without passing the predicate is the case a constant return
            // value would have described as OWNED. It is refused instead, as the internal defect it is, and
            // the refusal costs no statement either.
            const rejection = captureThrow(() => service.getViewerAccess(ctx, ownedList()));

            expect(rejection).toBeInstanceOf(InternalServerError);
            expect((rejection as InternalServerError).message).toBe(UNCLASSIFIED_FAILURE_MESSAGE);
            expect(harness.journal).toEqual([]);
        });

        it('refuses a row whose owning customer disagrees with the scope it was read under', async () => {
            harness.plan.listFindOne = () => ownedList({ customerId: FOREIGN_CUSTOMER_ID });
            const list = (await service.getReorderList(ctx, LIST_ID)) as ReorderList;

            const rejection = captureThrow(() => service.getViewerAccess(ctx, list));

            expect(rejection).toBeInstanceOf(InternalServerError);
        });

        it('refuses a row read under one channel when the request now carries another', async () => {
            const list = (await service.getReorderList(ctx, LIST_ID)) as ReorderList;

            const rejection = captureThrow(() =>
                service.getViewerAccess(createCtx({ channelId: FOREIGN_CHANNEL_ID }), list),
            );

            expect(rejection).toBeInstanceOf(InternalServerError);
        });

        it('refuses to describe a row for a request carrying no authenticated session', async () => {
            const list = (await service.getReorderList(ctx, LIST_ID)) as ReorderList;

            const rejection = captureThrow(() =>
                service.getViewerAccess(createCtx({ anonymous: true }), list),
            );

            expect(rejection).toBeInstanceOf(InternalServerError);
        });

        it('describes every list of a collection page, because the page records its scope on each item', async () => {
            harness.plan.listPage = () => [[ownedList(), ownedList({ id: SECOND_LIST_ID })], 2];
            const page = await service.getReorderLists(ctx);

            expect(page.items.map(item => service.getViewerAccess(ctx, item))).toEqual([
                { access: 'OWNED', grantedCapabilities: [] },
                { access: 'OWNED', grantedCapabilities: [] },
            ]);
        });

        it('describes the row createReorderList returned, which is saved rather than re-read', async () => {
            const created = (await service.createReorderList(ctx, { name: 'Pantry' })) as ReorderList;

            expect(service.getViewerAccess(ctx, created)).toEqual({
                access: 'OWNED',
                grantedCapabilities: [],
            });
        });
    });

    // ---------------------------------------------------------------------------------------------------
    // The list bound. Counted and inserted inside one transaction, with a row lock where the engine has one
    // and the single connection where it does not [FEATURE-001-01:§2.11].
    // ---------------------------------------------------------------------------------------------------

    describe('createReorderList and the list bound', () => {
        it('counts and inserts inside one transaction', async () => {
            await service.createReorderList(ctx, { name: 'Pantry' });

            const counts = harness.journal.filter(statement => statement.terminal === 'count');
            const saves = harness.journal.filter(statement => statement.terminal === 'save');
            expect(harness.transactionsOpened).toBe(1);
            // ONE count: the list bound's. The name is not pre-checked — the named unique object decides every
            // duplicate [FEATURE-001-01:§2.11].
            expect(counts).toHaveLength(1);
            expect(saves).toHaveLength(1);
            expect(counts[0].transaction).toBeGreaterThan(0);
            for (const statement of [...counts, ...saves]) {
                expect(statement.transaction).toBe(counts[0].transaction);
            }
        });

        it('scopes the one count to the acting customer and the active channel', async () => {
            await service.createReorderList(ctx, { name: 'Pantry' });

            const counts = harness.journal.filter(statement => statement.terminal === 'count');
            expect(counts).toHaveLength(1);
            expect(counts[0].findOptions?.where).toEqual({
                customerId: CUSTOMER_ID,
                channelId: CHANNEL_ID,
            });
            // And no count anywhere carries the canonical key, which is what a name pre-check would look like.
            expect(
                counts.some(statement =>
                    Object.prototype.hasOwnProperty.call(
                        (statement.findOptions?.where ?? {}) as object,
                        'nameKey',
                    ),
                ),
            ).toBe(false);
        });

        it('returns ReorderListLimitError carrying the configured maximum and inserts nothing', async () => {
            harness.plan.heldListCount = MAX_LISTS_PER_CUSTOMER;

            const result = await service.createReorderList(ctx, { name: 'Pantry' });

            expect(result).toBeInstanceOf(ReorderListLimitError);
            expect((result as ReorderListLimitError).maxItems).toBe(MAX_LISTS_PER_CUSTOMER);
            expect(harness.journal.some(statement => statement.terminal === 'save')).toBe(false);
        });

        it('proceeds with the insert one below the configured maximum', async () => {
            harness.plan.heldListCount = MAX_LISTS_PER_CUSTOMER - 1;

            const result = await service.createReorderList(ctx, { name: 'Pantry' });

            expect(result).toBeInstanceOf(ReorderList);
            expect(harness.journal.some(statement => statement.terminal === 'save')).toBe(true);
        });

        it('invents no per-customer counter row and writes nothing to the core customer table', async () => {
            await service.createReorderList(ctx, { name: 'Pantry' });

            expect([...new Set(harness.repositoryRequests)].sort()).toEqual(['Customer', 'ReorderList']);
            expect(harness.repositoryRequests).not.toContain('Unknown');
            expect(
                statementsAgainst(harness, 'Customer').every(statement => statement.operation === 'select'),
            ).toBe(true);
        });

        it('initialises the row with a zero line count, the canonical pair and the session owner', async () => {
            let saved: ReorderList | undefined;
            harness.plan.saveList = entity => {
                saved = entity;
                entity.id = LIST_ID;
                return entity;
            };

            await service.createReorderList(ctx, { name: '  Weekly   Kitchen Restock  ' });

            expect(saved).toBeInstanceOf(ReorderList);
            expect(saved?.lineCount).toBe(0);
            expect(saved?.name).toBe('Weekly Kitchen Restock');
            expect(saved?.nameKey).toBe('weekly kitchen restock');
            expect(saved?.customerId).toBe(CUSTOMER_ID);
            expect(saved?.channelId).toBe(CHANNEL_ID);
        });

        it('writes no monetary value, no stock state and no field beyond the five the row declares', async () => {
            let saved: ReorderList | undefined;
            harness.plan.saveList = entity => {
                saved = entity;
                return entity;
            };

            await service.createReorderList(ctx, { name: 'Pantry' });

            expect(Object.keys(saved ?? {}).sort()).toEqual([
                'channelId',
                'customerId',
                'lineCount',
                'name',
                'nameKey',
            ]);
        });

        it('ignores an owner nominated by the caller, deriving ownership from the session alone', async () => {
            let saved: ReorderList | undefined;
            harness.plan.saveList = entity => {
                saved = entity;
                return entity;
            };

            await service.createReorderList(ctx, {
                name: 'Pantry',
                // Neither field is declared by the published input; both are supplied to prove that no
                // argument can nominate a different owner or a different channel [FEATURE-001-01:§2.7].
                customerId: FOREIGN_CUSTOMER_ID,
                channelId: FOREIGN_CHANNEL_ID,
            } as never);

            expect(saved?.customerId).toBe(CUSTOMER_ID);
            expect(saved?.channelId).toBe(CHANNEL_ID);
        });

        it('refuses a name that fails the input contract without counting or inserting anything', async () => {
            const failure = await captureRejection(() => service.createReorderList(ctx, { name: '   ' }));

            expect(failure).toBeInstanceOf(UserInputError);
            expect(harness.journal).toEqual([]);
            expect(harness.transactionsOpened).toBe(0);
        });
    });

    describe('the engine branch, taken verbatim from the platform scheduler strategy', () => {
        for (const engine of ['postgres', 'mysql', 'mariadb']) {
            it(`takes a pessimistic write lock on the owning customer row on ${engine}`, async () => {
                harness.plan.engine = engine;

                await service.createReorderList(ctx, { name: 'Pantry' });

                const customerLookups = statementsAgainst(harness, 'Customer');
                expect(customerLookups).toHaveLength(1);
                expect(customerLookups[0].locks).toEqual(['pessimistic_write']);
            });

            it(`locks the row of the authenticated customer, reading its identifier alone, on ${engine}`, async () => {
                harness.plan.engine = engine;

                await service.createReorderList(ctx, { name: 'Pantry' });

                const [lockedLookup] = statementsAgainst(harness, 'Customer');
                // WHICH row is locked is the whole of the claim, and a lock mode says nothing about it. All
                // four properties below are load-bearing:
                //  - the projection is the identifier alone, so no personal field of a customer or of the
                //    user row joined to it reaches process memory where it could reach a log line;
                //  - the join is written explicitly rather than as a find-options relation condition, because
                //    TypeORM realises a relation condition as a LEFT join and PostgreSQL refuses `FOR UPDATE`
                //    on the nullable side of one — a one-engine failure;
                //  - the predicate names the joined user, so an arbitrary customer row cannot be selected;
                //  - and it is bound to the ACTING session's user rather than to anything the caller sent,
                //    which is what makes ownership underivable from an argument [FEATURE-001-01:§2.7].
                expect(lockedLookup.selections).toEqual([{ expression: ['customer.id'], alias: undefined }]);
                expect(lockedLookup.joins).toEqual([['customer.user', 'user']]);
                expect(lockedLookup.conditions).toEqual(['user.id = :userId']);
                expect(lockedLookup.parameters).toEqual({ userId: USER_ID });
            });

            it(`locks the owner row before either list count on ${engine}`, async () => {
                harness.plan.engine = engine;

                await service.createReorderList(ctx, { name: 'Pantry' });

                const counts = harness.journal.filter(statement => statement.terminal === 'count');
                const firstCountIndex = harness.journal.findIndex(
                    statement => statement.terminal === 'count',
                );
                // ORDER, not merely presence, and asserted on the FIRST statement rather than on the first
                // customer statement. On MariaDB and MySQL, whose default isolation level is REPEATABLE READ,
                // InnoDB builds a transaction's consistent-read view at its FIRST consistent read — so a plain
                // customer lookup issued before the lock fixes the view before the lock is taken, and the
                // later count then answers from a snapshot older than a competing creator's commit. Two
                // creators at the bound would both count one below the maximum and both insert, with nothing
                // about the lock looking wrong. So the transaction's opening statement must itself be the
                // locking read, there must be no other customer statement to have fixed the view ahead of it,
                // and the count must follow it inside the same transaction.
                //
                // ONE count follows it, not two: the list bound's. The name is deliberately NOT pre-counted,
                // because the named unique object is the sole duplicate authority and a pre-check cannot be
                // made race-free [FEATURE-001-01:§2.11].
                expect(counts).toHaveLength(1);
                expect(statementsAgainst(harness, 'Customer')).toHaveLength(1);
                expect(harness.journal[0].entity).toBe('Customer');
                expect(harness.journal[0].locks).toEqual(['pessimistic_write']);
                expect(harness.journal[0].transaction).toBeGreaterThan(0);
                expect(firstCountIndex).toBe(1);
                expect(counts[0].transaction).toBe(harness.journal[0].transaction);
            });
        }

        it('derives the locked owner from the session, so a second session locks its own customer row', async () => {
            const secondSessionUserId = 'T_11';
            harness.plan.engine = 'postgres';

            const result = await service.createReorderList(createCtx({ userId: secondSessionUserId }), {
                name: 'Pantry',
            });

            const [lockedLookup] = statementsAgainst(harness, 'Customer');
            // The bound identifier follows the request rather than a constant. The harness answers this
            // look-up only for a statement bound to the acting session's user, so an implementation resolving
            // the owner from anywhere else — a literal, a cached value, an argument — finds no customer row
            // and the operation fails rather than quietly writing under the wrong owner.
            expect(lockedLookup.parameters).toEqual({ userId: secondSessionUserId });
            expect(result).toBeInstanceOf(ReorderList);
        });

        for (const engine of ['sqljs', 'better-sqlite3', 'sqlite']) {
            it(`attempts no lock on ${engine}, where a single connection cannot interleave`, async () => {
                harness.plan.engine = engine;

                await service.createReorderList(ctx, { name: 'Pantry' });

                expect(harness.journal.every(statement => statement.locks.length === 0)).toBe(true);
            });
        }

        it('still counts and inserts inside one transaction where no lock is available', async () => {
            harness.plan.engine = 'sqljs';

            const result = await service.createReorderList(ctx, { name: 'Pantry' });

            expect(result).toBeInstanceOf(ReorderList);
            expect(harness.transactionsOpened).toBe(1);
        });

        it('locks the parent list before removing a line where the engine supports it', async () => {
            harness.plan.engine = 'postgres';

            await service.removeReorderListLine(ctx, { reorderListId: LIST_ID, lineId: LINE_ID });

            const parentLookup = statementsAgainst(harness, 'ReorderList').find(
                statement => statement.terminal === 'getOne',
            ) as JournalledStatement;
            expect(parentLookup.locks).toEqual(['pessimistic_write']);
            expect(conditionTextOf(parentLookup)).toContain('customerId = :customerId');
            expect(conditionTextOf(parentLookup)).toContain('channelId = :channelId');
        });

        it('keeps the full ownership scope on the unlocked fallback path', async () => {
            harness.plan.engine = 'sqljs';

            const result = await service.removeReorderListLine(ctx, {
                reorderListId: LIST_ID,
                lineId: LINE_ID,
            });

            const parentLookup = statementsAgainst(harness, 'ReorderList').find(
                statement => statement.terminal === 'findOne',
            ) as JournalledStatement;
            expect(result).toBeInstanceOf(ReorderList);
            expect(whereKeysOf(parentLookup)).toEqual(
                expect.arrayContaining(['id', 'customerId', 'channelId']),
            );
            expect(parentLookup.locks).toEqual([]);
        });

        it('takes a current read on the line only where the engine can hold one', async () => {
            harness.plan.engine = 'sqljs';
            harness.plan.lineGetOne = () => ownedLine({ quantity: 2 });
            harness.plan.lineAffected = () => 1;

            await service.addItemToReorderList(ctx, {
                reorderListId: LIST_ID,
                productVariantId: VARIANT_ID,
                quantity: 1,
            });

            expect(harness.journal.every(statement => statement.locks.length === 0)).toBe(true);
        });
    });

    // ---------------------------------------------------------------------------------------------------
    // Boundaries. Each absence below is a ruling rather than an omission, so each is asserted rather than
    // described [EPIC-001:R13, R19], [FEATURE-001-01:§2.10, §2.12].
    // ---------------------------------------------------------------------------------------------------

    describe('the boundaries this service is bounded by', () => {
        it('declares exactly four error results, each carrying its field-complete shape', () => {
            const results = [
                new ReorderListNotFoundError(),
                new ReorderListNameConflictError('pantry'),
                new ReorderListLimitError(MAX_LINES_PER_LIST),
                new ReorderListLineNotFoundError(),
            ];

            for (const result of results) {
                expect(typeof result.__typename).toBe('string');
                expect(result.__typename).toBe(result.constructor.name);
                expect(typeof result.errorCode).toBe('string');
                expect(result.message.length).toBeGreaterThan(0);
            }
            expect(results.map(result => result.errorCode)).toEqual([
                'REORDER_LIST_NOT_FOUND_ERROR',
                'REORDER_LIST_NAME_CONFLICT_ERROR',
                'REORDER_LIST_LIMIT_ERROR',
                'REORDER_LIST_LINE_NOT_FOUND_ERROR',
            ]);
        });

        it('carries the field a client needs to act on, on each result that needs one', () => {
            expect(new ReorderListNameConflictError('pantry top-up').conflictingNameKey).toBe(
                'pantry top-up',
            );
            expect(new ReorderListLimitError(MAX_LINES_PER_LIST).maxItems).toBe(MAX_LINES_PER_LIST);
        });

        it('exposes no scheduled task, event, job-queue or disposal member on its surface', () => {
            const surface = [
                ...Object.getOwnPropertyNames(ReorderListService.prototype),
                ...Object.getOwnPropertyNames(service),
            ];

            // Nothing disposes of customer data before a later batch, and this service publishes nothing to
            // an event bus and schedules nothing — a soft-deleted customer's list rows persist by design
            // [EPIC-001:R19].
            const forbidden =
                /schedul|event|jobqueue|job_queue|purge|anonymis|anonymiz|retention|retain|dispose|strategy/i;
            expect(surface.filter(member => forbidden.test(member))).toEqual([]);
        });

        it('publishes nothing to an event bus while completing a write', async () => {
            const result = await service.createReorderList(ctx, { name: 'Pantry' });

            expect(result).toBeInstanceOf(ReorderList);
            // The only collaborators reached are the three the constructor declares.
            expect(harness.productVariantService.findOne).not.toHaveBeenCalled();
            expect(harness.listQueryBuilder.build).not.toHaveBeenCalled();
        });

        it('offers no operation that disposes of a customer, only of a list the caller owns', async () => {
            harness.plan.listAffected = () => 1;

            await service.deleteReorderList(ctx, LIST_ID);

            expect(statementsAgainst(harness, 'Customer').every(entry => entry.operation === 'select')).toBe(
                true,
            );
            expect(statementsOfKind(harness, 'ReorderList', 'delete')).toHaveLength(1);
        });
    });

    // ---------------------------------------------------------------------------------------------------
    // The declared option defaults, exercised through the value the PLUGIN resolves rather than through a
    // partial object assembled here.
    //
    // The distinction is the whole point of this block. The service is injected
    // `ResolvedReorderPluginOptions` — every key present, validated once at plugin initialisation, frozen —
    // so a service constructed with a partial object could only ever exercise a fallback that production
    // never reaches. Reading `ReorderPlugin.options` instead exercises the one place the five numbers are
    // declared, by way of the same provider expression the plugin metadata registers
    // (`useFactory: () => ReorderPlugin.options`). A default changed in the plugin and not here therefore
    // fails these assertions, which is exactly the coupling a duplicated default destroys.
    // ---------------------------------------------------------------------------------------------------

    describe('the declared defaults a deployment gets when it supplies no value', () => {
        let defaulted: ReorderListService;

        beforeEach(() => {
            defaulted = new ReorderListService(
                harness.connection,
                harness.productVariantService as unknown as ProductVariantService,
                harness.listQueryBuilder as unknown as ListQueryBuilder,
                new RequestContextCacheService(),
                ReorderPlugin.options,
            );
        });

        it('resolves the five declared defaults, frozen and complete, from the plugin itself', () => {
            expect(ReorderPlugin.options).toEqual({
                maxListsPerCustomer: 25,
                maxLinesPerList: 200,
                maxQuantityPerLine: 999,
                defaultReorderListsPageSize: 25,
                defaultReorderListLinesPageSize: 50,
            });
            expect(Object.isFrozen(ReorderPlugin.options)).toBe(true);
        });

        it('pages a list of lists at twenty-five and a page of lines at fifty', async () => {
            await defaulted.getReorderLists(ctx);
            const listsTake = harness.builds[0].options.take;
            resetRecorders(harness);

            await defaulted.getLinesForLists(ctx, [LIST_ID]);

            expect(listsTake).toBe(25);
            expect(harness.builds[0].options.take).toBe(50);
        });

        it('bounds a list at twenty-five held lists', async () => {
            harness.plan.heldListCount = 25;

            const result = await defaulted.createReorderList(ctx, { name: 'Pantry' });

            expect(result).toBeInstanceOf(ReorderListLimitError);
            expect((result as ReorderListLimitError).maxItems).toBe(25);
        });

        it('bounds a list at two hundred lines', async () => {
            harness.plan.lineGetOne = () => null;
            harness.plan.listAffected = () => 0;
            harness.plan.listGetOne = () => ownedList();

            const result = await defaulted.addItemToReorderList(ctx, {
                reorderListId: LIST_ID,
                productVariantId: VARIANT_ID,
                quantity: 1,
            });

            expect(result).toBeInstanceOf(ReorderListLimitError);
            expect((result as ReorderListLimitError).maxItems).toBe(200);
            const claim = harness.journal.find(isLineCountClaim) as JournalledStatement;
            expect(claim.parameters.maxLinesPerList).toBe(200);
        });

        it('bounds a line at nine hundred and ninety-nine units, comparing a number rather than NaN', async () => {
            const failure = await captureRejection(() =>
                defaulted.adjustReorderListLine(ctx, {
                    reorderListId: LIST_ID,
                    lineId: LINE_ID,
                    quantity: 1000,
                }),
            );

            expect(failure).toBeInstanceOf(UserInputError);
            expect((failure as UserInputError).message).toBe(QUANTITY_ABOVE_MAXIMUM_KEY);
            expect((failure as UserInputError).variables).toEqual({ max: 999 });

            const accepted = await defaulted.adjustReorderListLine(ctx, {
                reorderListId: LIST_ID,
                lineId: LINE_ID,
                quantity: 999,
            });
            expect(accepted).toBeInstanceOf(ReorderList);
        });
    });

    // ---------------------------------------------------------------------------------------------------
    // Every remaining failure path, so that no operation has a statement outside the disclosure boundary.
    // ---------------------------------------------------------------------------------------------------

    describe('the disclosure boundary, which covers every statement of every operation', () => {
        const failure = () => driverFailure('relation "reorder_list" does not exist', { query: 'SELECT 1' });

        it('sanitises a failure of the page statement on the collection read', async () => {
            harness.plan.listPage = () => {
                throw failure();
            };

            const thrown = await captureRejection(() => service.getReorderLists(ctx));

            expect(thrown).toBeInstanceOf(InternalServerError);
            expect((thrown as InternalServerError).message).toBe(UNCLASSIFIED_FAILURE_MESSAGE);
            expect(loggedErrors[0].message).toContain('getReorderLists');
        });

        it('sanitises a failure of the row lookup on the single-list read', async () => {
            harness.plan.listFindOne = () => {
                throw failure();
            };

            const thrown = await captureRejection(() => service.getReorderList(ctx, LIST_ID));

            expect(thrown).toBeInstanceOf(InternalServerError);
            expect(loggedErrors[0].message).toContain('getReorderList');
        });

        it('sanitises a failure of the batched statement on the nested-lines read', async () => {
            harness.plan.linePage = () => {
                throw failure();
            };

            const thrown = await captureRejection(() => service.getLinesForLists(ctx, [LIST_ID]));

            expect(thrown).toBeInstanceOf(InternalServerError);
            expect(loggedErrors[0].message).toContain('getLinesForLists');
        });

        it('sanitises a failure of the repair statement', async () => {
            harness.plan.listAffected = () => {
                throw failure();
            };

            const thrown = await captureRejection(() => service.reconcileLineCount(ctx, LIST_ID, 4, 2));

            expect(thrown).toBeInstanceOf(InternalServerError);
            expect(loggedErrors[0].message).toContain('reconcileLineCount');
        });

        it('sanitises a failure of the delete statement', async () => {
            harness.plan.listAffected = () => {
                throw failure();
            };

            const thrown = await captureRejection(() => service.deleteReorderList(ctx, LIST_ID));

            expect(thrown).toBeInstanceOf(InternalServerError);
            expect(loggedErrors[0].message).toContain('deleteReorderList');
        });

        it('sanitises a generic failure of the rename statement, which its conflict mapping must not absorb', async () => {
            // The rename is the one write whose failure path is a TRANSLATOR rather than a plain rethrow: it
            // inspects the caught error for one named constraint and maps that one to a buyer-facing conflict.
            // Everything else it catches has to leave by the sanitised route, and a translator that returned
            // or rethrew the driver's own error for the non-matching case would leak driver text, SQL and
            // schema names on every rename that deadlocked, timed out or hit an unrelated constraint. The
            // failure below is deliberately hostile: a real driver code, a real statement, bound parameters
            // carrying identifiers, and the name of a DIFFERENT named object [FEATURE-001-01:§2.10].
            const hostileRenameMessage =
                'ER_LOCK_DEADLOCK: Deadlock found when trying to get lock; try restarting transaction';
            harness.plan.listAffected = () => {
                throw driverFailure(hostileRenameMessage, {
                    query:
                        'UPDATE `reorder_list` SET `name` = ?, `nameKey` = ? ' +
                        'WHERE `id` = ? AND `customerId` = ? AND `channelId` = ?',
                    parameters: ['Pantry top-up', 'pantry top-up', LIST_ID, CUSTOMER_ID, CHANNEL_ID],
                    driverError: {
                        code: 'ER_LOCK_DEADLOCK',
                        sqlMessage: hostileRenameMessage,
                        constraint: 'IDX_reorder_list_customer_channel',
                    },
                });
            };

            const thrown = await captureRejection(() =>
                service.updateReorderList(ctx, { id: LIST_ID, name: 'Pantry top-up' }),
            );

            // It is neither mapped to the name conflict nor returned as any other business outcome.
            expect(thrown).toBeInstanceOf(InternalServerError);
            expect(thrown).not.toBeInstanceOf(ReorderListNameConflictError);
            expect((thrown as InternalServerError).code).toBe('INTERNAL_SERVER_ERROR');
            expect((thrown as InternalServerError).message).toBe(UNCLASSIFIED_FAILURE_MESSAGE);

            // The API-visible message carries no driver code, no SQL fragment, no table name and no named
            // database object.
            const message = (thrown as InternalServerError).message;
            expect(message).not.toContain('ER_LOCK_DEADLOCK');
            expect(message).not.toContain('UPDATE');
            expect(message).not.toContain('Deadlock');
            expect(message).not.toContain(REORDER_LIST_TABLE);
            expect(message).not.toContain('UQ_');
            expect(message).not.toContain('IDX_');
            expect(message).not.toContain('CHK_');

            // And the frames are replaced, so the platform's exception logger — which logs the stack — cannot
            // reopen the boundary one layer out from this service.
            const error = thrown as Error;
            expect(error.stack).toBe(`${error.name}: ${UNCLASSIFIED_FAILURE_MESSAGE}`);
            expect(error.stack?.split('\n')).toHaveLength(1);

            // The failure is not swallowed either: it is logged, attributed to this operation, under the
            // plugin's context — and the log line is inside the boundary too, because an application log
            // outlives the request and is read by tools never entitled to the driver's wording.
            expect(loggedErrors).toHaveLength(1);
            expect(loggedErrors[0].context).toBe(loggerCtx);
            expect(loggedErrors[0].message).toContain('updateReorderList');
            expect(loggedErrors[0].message).not.toContain('ER_LOCK_DEADLOCK');
            expect(loggedErrors[0].message).not.toContain('Deadlock');
            expect(loggedErrors[0].message).not.toContain(REORDER_LIST_TABLE);
            expect(loggedErrors[0].message).not.toContain('IDX_');
        });

        it('sanitises a failure of the adjust statement', async () => {
            harness.plan.lineAffected = () => {
                throw failure();
            };

            const thrown = await captureRejection(() =>
                service.adjustReorderListLine(ctx, {
                    reorderListId: LIST_ID,
                    lineId: LINE_ID,
                    quantity: 2,
                }),
            );

            expect(thrown).toBeInstanceOf(InternalServerError);
            expect(loggedErrors[0].message).toContain('adjustReorderListLine');
        });

        it('sanitises a failure of the line delete statement', async () => {
            harness.plan.lineAffected = () => {
                throw failure();
            };

            const thrown = await captureRejection(() =>
                service.removeReorderListLine(ctx, { reorderListId: LIST_ID, lineId: LINE_ID }),
            );

            expect(thrown).toBeInstanceOf(InternalServerError);
            expect(loggedErrors[0].message).toContain('removeReorderListLine');
        });

        it('sanitises a failure of the locked owner lookup the create path performs', async () => {
            harness.plan.customerFailure = failure();

            const thrown = await captureRejection(() => service.createReorderList(ctx, { name: 'Pantry' }));

            expect(thrown).toBeInstanceOf(InternalServerError);
            expect((thrown as InternalServerError).message).toBe(UNCLASSIFIED_FAILURE_MESSAGE);
            expect(loggedErrors[0].message).toContain('createReorderList');
        });

        it('reports an authenticated user with no customer row from the locked lookup as an internal failure', async () => {
            harness.plan.customerRow = null;

            const thrown = await captureRejection(() => service.createReorderList(ctx, { name: 'Pantry' }));

            expect(thrown).toBeInstanceOf(InternalServerError);
            expect((thrown as InternalServerError).message).toBe(
                'The authenticated user has no associated Customer',
            );
        });

        it('sanitises a metadata defect in its own raw fragments and names it in the log', async () => {
            harness.plan.lineColumns = [];

            const thrown = await captureRejection(() => service.getLinesForLists(ctx, [LIST_ID]));

            expect(thrown).toBeInstanceOf(InternalServerError);
            expect((thrown as InternalServerError).message).toBe(UNCLASSIFIED_FAILURE_MESSAGE);
        });

        it('sanitises a missing column on the ownership sub-query and logs the property it wanted', async () => {
            harness.plan.listColumns = [];

            const thrown = await captureRejection(() =>
                service.adjustReorderListLine(ctx, {
                    reorderListId: LIST_ID,
                    lineId: LINE_ID,
                    quantity: 2,
                }),
            );

            expect(thrown).toBeInstanceOf(InternalServerError);
            expect((thrown as InternalServerError).message).toBe(UNCLASSIFIED_FAILURE_MESSAGE);
            expect(loggedErrors.map(entry => entry.message).join(' ')).toContain('declares no column');
            expect(loggedErrors[0].context).toBe(loggerCtx);
        });

        it('issues the line insert through the request repository, inside the transaction', async () => {
            harness.plan.lineGetOne = () => null;
            harness.plan.listAffected = () => 1;

            const result = await service.addItemToReorderList(ctx, {
                reorderListId: LIST_ID,
                productVariantId: VARIANT_ID,
                quantity: 1,
            });

            expect(result).toBeInstanceOf(ReorderList);
            const inserts = statementsOfKind(harness, 'ReorderListLine', 'insert');
            expect(inserts).toHaveLength(1);
            // The insert is an ordinary builder insert on the request's own repository — no ignore form, and
            // no second connection — so it belongs to the transaction the capacity claim opened.
            expect(inserts[0].terminal).toBe('execute');
            expect(inserts[0].transaction).toBe(
                (harness.journal.find(isLineCountClaim) as JournalledStatement).transaction,
            );
            expect(insertProbes(harness).every(probe => probe.conflictIgnored === false)).toBe(true);
        });

        it('re-raises a line insert failure that is NOT the named duplicate rather than retrying it', async () => {
            harness.plan.lineGetOne = () => null;
            harness.plan.listAffected = () => 1;
            // A foreign-key failure is what `INSERT IGNORE` would have swallowed on MySQL and MariaDB and
            // reported as "affected 0 rows", indistinguishable from a duplicate: it would then have been
            // retried as a concurrent insert. It is neither retried nor disguised here.
            harness.plan.lineInsertFailure = driverFailure(
                'Cannot add or update a child row: a foreign key constraint fails (`FK_reorder_list_line_variant`)',
                { query: 'INSERT INTO `reorder_list_line` ...' },
            );

            const thrown = await captureRejection(() =>
                service.addItemToReorderList(ctx, {
                    reorderListId: LIST_ID,
                    productVariantId: VARIANT_ID,
                    quantity: 1,
                }),
            );

            expect(thrown).toBeInstanceOf(InternalServerError);
            expect((thrown as InternalServerError).message).toBe(UNCLASSIFIED_FAILURE_MESSAGE);
            // One attempt only: a failure that is not the named line-uniqueness object is not reconcilable.
            expect(harness.transactionsOpened).toBe(1);
            expect(loggedErrors.map(entry => entry.message).join(' ')).toContain('addItemToReorderList');
        });

        it('reports the list as absent where the row it just wrote is no longer resolvable', async () => {
            harness.plan.listAffected = () => 1;
            harness.plan.listFindOne = () => null;

            const result = await service.updateReorderList(ctx, { id: LIST_ID, name: 'Pantry' });

            expect(result).toBeInstanceOf(ReorderListNotFoundError);
        });

        it('sanitises a database failure carrying no readable text at all', async () => {
            harness.plan.saveList = () => {
                throw driverFailure('');
            };

            const thrown = await captureRejection(() => service.createReorderList(ctx, { name: 'Pantry' }));

            expect(thrown).toBeInstanceOf(InternalServerError);
            expect((thrown as InternalServerError).message).toBe(UNCLASSIFIED_FAILURE_MESSAGE);
        });

        it('sanitises a rejection that is a primitive rather than an object', async () => {
            const primitiveFailure: unknown = 'a rejection that is not an object at all';
            harness.plan.saveList = () => {
                throw primitiveFailure;
            };

            const thrown = await captureRejection(() => service.createReorderList(ctx, { name: 'Pantry' }));

            expect(thrown).toBeInstanceOf(InternalServerError);
            expect(loggedErrors[0].message).toContain('a non-error value');
        });

        it('retries a duplicate line the capacity claim saw first, rather than reporting the list as full', async () => {
            harness.plan.lineGetOne = answeringInSequence<ReorderListLine | null>(
                null,
                ownedLine({ quantity: 1 }),
            );
            harness.plan.listAffected = () => 0;
            harness.plan.listGetOne = () => ownedList({ lineCount: MAX_LINES_PER_LIST });
            harness.plan.lineAffected = () => 1;

            const result = await service.addItemToReorderList(ctx, {
                reorderListId: LIST_ID,
                productVariantId: VARIANT_ID,
                quantity: 1,
            });

            expect(result).toBeInstanceOf(ReorderList);
            expect(result).not.toBeInstanceOf(ReorderListLimitError);
            expect(harness.transactionsOpened).toBe(2);
        });
    });

    describe('the nested window ordering, which follows the sort the page was resolved under', () => {
        it('appends the ascending identifier tie-break to a caller sort that omits it', async () => {
            await service.getLinesForLists(ctx, [LIST_ID], {
                sort: { quantity: 'DESC' },
            } as ListQueryOptions<ReorderListLine>);

            expect(harness.builds[0].options.sort).toEqual({ quantity: 'DESC' });
            expect(harness.builds[0].extendedOptions.orderBy).toEqual({ id: 'ASC' });
        });

        it('carries a descending direction into the per-parent ranking expression', async () => {
            harness.plan.linePage = () => [ownedLine()];
            harness.plan.lineTotals = { [LIST_ID]: 1 };

            await service.getLinesForLists(ctx, [LIST_ID], {
                sort: { quantity: 'DESC' },
            } as ListQueryOptions<ReorderListLine>);

            const page = statementsAgainst(harness, 'ReorderListLine').find(
                statement => statement.terminal === 'getMany',
            ) as JournalledStatement;
            expect(conditionTextOf(page)).toContain(`${escaped('quantity')} DESC`);
            expect(conditionTextOf(page)).toContain(`${escaped('id')} ASC`);
        });

        it('reads an ordering the platform expressed as an object, and a key it resolved elsewhere', async () => {
            // Both forms are ones TypeORM's own map holds: `orderBy(sort, order, nulls)` stores an object,
            // and a key resolved against a joined table is not spelled `alias.column`. The ranking
            // expression has to survive either, because it reads that map directly.
            harness.plan.decorateBuiltQuery = probe => {
                probe.expressionMap.orderBys = {
                    [`${probe.alias}.quantity`]: { order: 'DESC', nulls: 'NULLS LAST' },
                    'lineTranslation.label': 'ASC',
                };
            };

            await service.getLinesForLists(ctx, [LIST_ID]);

            const page = statementsAgainst(harness, 'ReorderListLine').find(
                statement => statement.terminal === 'getMany',
            ) as JournalledStatement;
            expect(conditionTextOf(page)).toContain(`${escaped('quantity')} DESC`);
            expect(conditionTextOf(page)).toContain('lineTranslation.label ASC');
        });
    });

    describe('the owner look-up failure, which every operation shares', () => {
        it('sanitises it on the collection read rather than answering with an empty page', async () => {
            harness.plan.customerFailure = driverFailure('connection terminated unexpectedly', {
                query: 'SELECT 1',
            });

            const thrown = await captureRejection(() => service.getReorderLists(ctx));

            // An empty page here would report "you have no lists" for what is actually an outage.
            expect(thrown).toBeInstanceOf(InternalServerError);
            expect((thrown as InternalServerError).message).toBe(UNCLASSIFIED_FAILURE_MESSAGE);
            expect(loggedErrors[0].message).toContain('getReorderLists');
        });

        it('sanitises it on the nested-lines read rather than answering with empty pages', async () => {
            harness.plan.customerFailure = driverFailure('connection terminated unexpectedly', {
                query: 'SELECT 1',
            });

            const thrown = await captureRejection(() => service.getLinesForLists(ctx, [LIST_ID]));

            expect(thrown).toBeInstanceOf(InternalServerError);
            expect(loggedErrors[0].message).toContain('getLinesForLists');
        });

        it('sanitises it on every mutation that resolves the owner before its own statement', async () => {
            harness.plan.customerFailure = driverFailure('connection terminated unexpectedly', {
                query: 'SELECT 1',
            });

            const thrown = await captureRejection(() => service.deleteReorderList(ctx, LIST_ID));

            expect(thrown).toBeInstanceOf(InternalServerError);
            expect(writeStatements(harness)).toEqual([]);
        });
    });
});
