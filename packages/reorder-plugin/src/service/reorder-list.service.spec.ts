/*
 * Unit specification for the reorder list service — what it pins, and what it deliberately leaves to the
 * end-to-end suites.
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
import { DocumentNode, FragmentDefinitionNode, GraphQLResolveInfo, parse } from 'graphql';
import { FindOperator } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ReorderListEntityResolver, ReorderListLinesArgs } from '../api/reorder-list-entity.resolver';
import { ReorderListShopResolver, singleListReadMarked } from '../api/reorder-list-shop.resolver';
import { loggerCtx } from '../constants';
import { ReorderListLine } from '../entities/reorder-list-line.entity';
import { ReorderList } from '../entities/reorder-list.entity';
import { ReorderPlugin } from '../reorder.plugin';
import { ResolvedReorderPluginOptions } from '../types';

import {
    ENGINES_REQUIRING_EXCLUSIVE_PARENT_FOR_LINE_WRITES,
    ENGINES_SUPPORTING_PESSIMISTIC_LOCKING,
    ReorderListLimitError,
    ReorderListLineNotFoundError,
    ReorderListLinePage,
    ReorderListNameConflictError,
    ReorderListNotFoundError,
    ReorderListService,
} from './reorder-list.service';

const USER_ID = 'T_10';
/**
 * A second authenticated user, in the SAME channel as {@link USER_ID}.
 *
 * It exists for the one adversary neither a foreign customer nor a foreign channel describes: a second
 * ordinary buyer, signed in, shopping the same channel. Provenance recorded under one session and re-read
 * under this one agrees on every scope value there is — the row's customer, the row's channel and the
 * request's channel — so the only thing that can tell the two apart is *whose session recorded it*.
 */
const FOREIGN_USER_ID = 'T_11';
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
 * The shape of the correlation id the module appends to every internal diagnostic — a v4 UUID, as
 * `crypto.randomUUID` produces it.
 */
const CORRELATION_ID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * Splits a logged diagnostic into its prose and its correlation id.
 *
 * An assertion that a diagnostic does not ECHO some value has to be made against the prose alone. The
 * correlation id is random hexadecimal, so it contains short substrings by chance: a v4 UUID has four
 * hyphens, and two of the digits following them are FIXED by the format — the third group always begins
 * `4` and the fourth always begins `8`, `9`, `a` or `b` — leaving two free hex digits, so `-1` lands
 * inside an identifier with probability `1 - (15/16)² = 31/256`, about one line in eight. (Measured over
 * ten thousand `crypto.randomUUID()` values: 12.4%, against the 12.1% the arithmetic predicts.) Asserting
 * over the whole line would therefore fail on the identifier rather than on an echoed value, roughly one
 * run in eight. Returning the two parts separately lets the caller assert the prose carries no value AND
 * that the identifier is present and well formed, so nothing can hide in the part that was set aside.
 *
 * The pattern uses `[\s\S]*?` rather than `.*?` with the `s` flag deliberately: the dotAll flag is
 * ES2018, this package's `tsconfig.json` targets `es2017`, and `tsc -p tsconfig.json` rejects the flag
 * with TS1501. The character class is the same match under the declared target.
 *
 * @returns the prose with the trailing `(correlation id …)` removed, and the identifier itself. Where the
 * line carries no correlation id the identifier is the empty string, which fails
 * {@link CORRELATION_ID_SHAPE} rather than passing silently.
 */
function splitCorrelationId(message: string): [prose: string, correlationId: string] {
    const match = /^([\s\S]*?)\s*\(correlation id ([^)]*)\)\s*$/.exec(message);
    return match ? [match[1], match[2]] : [message, ''];
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

/**
 * The database column on `customer` that holds the id of the `User` a buyer signs in as.
 *
 * The core entity declares the relation as `@OneToOne(() => User) @JoinColumn()` and declares no property for
 * its foreign key, so this is the name TypeORM derives — and the create path's owner lock addresses its row by
 * it. It is stated once here and read from the metadata double rather than spelled into any assertion, so a
 * schema change in core would move both together.
 */
const CUSTOMER_USER_JOIN_COLUMN = 'userId';

// The statement journal. This is the instrument every structural assertion in this file reads.

/** Which table a statement was addressed to. `Unknown` exists so that an unexpected repository request is
 * recorded rather than silently served, which is what makes "no other repository is requested" checkable
 * [FEATURE-001-01:§2.11]. */
type ProbedEntity = 'Customer' | 'ReorderList' | 'ReorderListLine' | 'Unknown';

/** The four statement kinds the service composes. `select` covers every read; the other three are the
 * write half that a refused caller must produce none of [FEATURE-001-01:§2.6.1.1]. */
type StatementOperation = 'select' | 'update' | 'delete' | 'insert';

/**
 * One transaction the harness opened: its ordinal, whether it was NESTED inside an already-open one, and how it
 * ended.
 *
 * The distinction is not bookkeeping. TypeORM opens a nested transaction as a savepoint, and rolling back to a
 * savepoint retains the row locks taken after it on the MySQL family while keeping the enclosing transaction's
 * snapshot — so a retry nested inside a failed attempt begins holding what that attempt held. Rolling back a
 * real transaction releases everything, so a retry begins holding nothing. Which of the two a retry gets is what
 * decides whether the plugin's one lock-ordering rule survives across attempts.
 */
interface TransactionOutcome {
    id: number;
    nested: boolean;
    outcome: 'open' | 'commit' | 'rollback';
}

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
    parameters: Record<string, unknown>;
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
    insertValues?: Record<string, unknown>;
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

// The plan. Every double reads its answers from here, so a test states the database state it is asserting
// against as data rather than by re-wiring the harness.

interface HarnessPlan {
    /** What `rawConnection.options.type` reports, which is the only input to the locking branch. */
    engine: string;
    customerRow: Customer | null;
    /** Where set, every owner look-up fails with this value — the one statement every operation issues
     * before its own, and therefore the one that must also be inside the disclosure boundary. */
    customerFailure?: unknown;
    /**
     * The join columns the metadata double reports for `Customer.user`, which is where the create path's owner
     * lock reads its column name from.
     *
     * It is one column in the shipped schema, and it is configurable here so that the service's refusal to
     * guess at any other cardinality is itself testable: a relation that reported none, or two, is a schema the
     * addressed lock cannot express, and answering it with a lock on an arbitrary row would be worse than
     * failing.
     */
    customerUserJoinColumns: string[];
    /**
     * The schema or database segment the metadata double prefixes onto each entity's `tablePath`, or
     * `undefined` for an unqualified connection.
     *
     * TypeORM composes `tablePath` as `driver.buildTableName(tableName, schema, database)`, so a connection
     * configured with PostgreSQL's `schema` (which the development server exposes as `DB_SCHEMA`) or the MySQL
     * family's `database` makes every table reference a qualified one. This is configurable because the raw
     * fragment that consults the PARENT table decides whether a line may be changed or removed: rendered
     * unqualified it would resolve through the connection's search path instead, and a table of the same name
     * there would answer the ownership question from rows this deployment does not own.
     */
    tableQualifier: string | undefined;
    /**
     * What the metadata double reports as `tablePath`, given the bare table name. Absent, it reports the bare
     * name — which is what a connection carrying neither a schema nor a database option produces.
     */
    tablePathFor?: (tableName: string) => string;
    /** The properties the metadata double will resolve, so a missing column can be driven deliberately. */
    listColumns: string[];
    lineColumns: string[];
    /** A repository `findOne` against `reorder_list`, answered from the predicate it was handed. */
    listFindOne: (options: Record<string, unknown>) => ReorderList | null;
    /**
     * How many rows the **advisory name pre-check** finds — the count whose predicate carries `nameKey`
     * alongside the owner conjuncts. It is answered from the predicate rather than from a fixed number so a
     * test can assert what the pre-check actually asked, and it is kept separate from
     * {@link HarnessPlan.heldListCount} so the list bound and the name rule cannot be satisfied by one value.
     */
    conflictingNameCount: (options: Record<string, unknown>) => number;
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

class ServiceHarness {
    readonly journal: JournalledStatement[] = [];
    readonly builds: JournalledBuild[] = [];
    readonly probes: QueryBuilderProbe[] = [];
    readonly repositoryRequests: string[] = [];
    readonly metadataRequests: string[] = [];
    readonly escapedIdentifiers: string[] = [];
    transactionsOpened = 0;
    /**
     * Every transaction this harness opened, whether it was NESTED inside another, and how it ended.
     *
     * Read together with the journal's own transaction tags this is what makes the lock ORDER assertable across
     * attempts rather than only within one: a nested transaction's rollback leaves its row locks behind, a real
     * one's does not, so whether a retry starts holding anything is decided here.
     */
    readonly transactionOutcomes: TransactionOutcome[] = [];
    private transactionDepth = 0;

    readonly plan: HarnessPlan = {
        engine: 'postgres',
        customerRow: new Customer({ id: CUSTOMER_ID }),
        customerUserJoinColumns: [CUSTOMER_USER_JOIN_COLUMN],
        tableQualifier: undefined,
        listColumns: [...REORDER_LIST_COLUMNS],
        lineColumns: [...REORDER_LIST_LINE_COLUMNS],
        listFindOne: () => ownedList(),
        conflictingNameCount: () => 0,
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
     *  - **The shape is required before any total is produced.** The statement must project the parent column
     *    under an alias, project `COUNT(*)` under a second alias, and group by the same expression it
     *    projected as the parent. A statement missing the grouping, counting something else, or grouping by a
     *    different expression is answered with NO rows, which surfaces as a per-parent total of zero and fails
     *    the assertions that read the total. Manufacturing perfect totals for a statement that could not have
     *    produced them is exactly how "removing the `GROUP BY` still passes" happens
     *    [FEATURE-001-01:§2.6.3].
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
     *  - **The projection is the identifier alone.** `Customer` carries personal data and an eagerly declared
     *    `user` relation, so a look-up whose entire output is one id must say so; a widened projection loads
     *    fields that can then reach a log line or a serialised context [FEATURE-001-01:§2.7].
     *  - **NOTHING is joined.** The lock TypeORM emits for `pessimistic_write` is the unqualified `FOR UPDATE`,
     *    which locks a row of every table the statement reads — so a statement that joined `user` would lock the
     *    `User` row as well as the `Customer` row, and the bound requires the owning customer and nothing more.
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
        const joinsNothing = probe.joins.length === 0;
        const namesTheUser = probe.conditions.some(
            condition =>
                condition.replace(/\s+/g, '') ===
                `${escaped(probe.alias)}.${escaped(CUSTOMER_USER_JOIN_COLUMN)}=:userId`,
        );
        if (!projectsIdentifierOnly || !joinsNothing || !namesTheUser) {
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

    private async runInTransaction(
        ctx: RequestContext,
        work: (transactionCtx: RequestContext) => Promise<unknown>,
    ): Promise<unknown> {
        this.transactionsOpened += 1;
        const id = this.transactionsOpened;
        // NESTING IS MODELLED, because it decides what a rolled-back attempt leaves behind. `withTransaction`
        // inherits an already-open transaction from the context, and TypeORM opens a nested one as a SAVEPOINT —
        // whose rollback retains the row locks taken after it on the MySQL family and keeps the enclosing
        // transaction's snapshot. A transaction opened at depth zero is a real one, and rolling it back releases
        // everything. `openOuterTransaction` is how a test asks for the first shape, which is what a resolver
        // decorated `@Transaction()` in its default mode produces.
        const nested = this.transactionDepth > 0;
        this.transactionDepth += 1;
        this.transactionOutcomes.push({ id, nested, outcome: 'open' });
        // A prototype-linked child rather than a copy, so every getter on RequestContext keeps working
        // while the child remains a distinct object this harness can tag. That tag is what turns "in the
        // same transaction as the delete" into an assertion rather than a hope [FEATURE-001-01:§2.11].
        const transactionCtx = Object.create(ctx) as RequestContext;
        this.transactionIds.set(transactionCtx, this.transactionsOpened);
        try {
            const result = await work(transactionCtx);
            this.transactionDepth -= 1;
            this.outcomeOf(id).outcome = 'commit';
            return result;
        } catch (err) {
            this.transactionDepth -= 1;
            this.outcomeOf(id).outcome = 'rollback';
            throw err;
        }
    }

    /**
     * Models a transaction already open on the runner when the service is called — the shape a resolver
     * decorated with the transaction decorator's DEFAULT mode produces.
     *
     * The shipped `addItemToReorderList` resolver declares `'manual'` instead, so nothing is open when its
     * service method starts. This exists so that the consequence of the other choice can be asserted rather than
     * argued: the same statement sequence, run under a nested boundary, inverts the plugin's lock order.
     */
    openOuterTransaction(): void {
        this.transactionDepth += 1;
    }

    private outcomeOf(id: number): TransactionOutcome {
        const found = this.transactionOutcomes.find(outcome => outcome.id === id);
        if (found === undefined) {
            throw new Error(`the harness lost the record of transaction ${id}`);
        }
        return found;
    }

    private rawConnection(): unknown {
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
        const tableName = tableFor(name);
        return {
            name,
            tableName,
            // A real `EntityMetadata` carries BOTH names and they are not interchangeable: `tableName` is the
            // bare relation, while `tablePath` is what the driver built from it together with the configured
            // schema and database [node_modules/typeorm/metadata/EntityMetadata.js:L627]. The double supplies
            // both, composed the way the driver composes it
            // [node_modules/typeorm/driver/postgres/PostgresDriver.js:L683-L689], because a double holding
            // only the bare name cannot judge a fragment whose whole job is to render the qualified one. A
            // test states the composed path outright through `tablePathFor` where it needs a shape a schema
            // alone cannot reach (SQL Server's `database..table`), and states just the leading segment through
            // `tableQualifier` where the ordinary `schema.table` composition is what matters.
            tablePath: this.plan.tablePathFor
                ? this.plan.tablePathFor(tableName)
                : this.plan.tableQualifier === undefined
                  ? tableName
                  : `${this.plan.tableQualifier}.${tableName}`,
            findColumnWithPropertyName: column,
            findColumnWithPropertyPath: column,
            // The relation look-up the create path's owner lock resolves its column name through. Only
            // `Customer.user` is answered, and only with the ONE join column the core entity declares
            // (`@OneToOne(() => User) @JoinColumn()`), because the service treats any other cardinality as a
            // schema it cannot express and refuses rather than guessing. Configurable through the plan so the
            // refusal itself is testable.
            findRelationWithPropertyPath: (propertyPath: string) =>
                name === 'Customer' && propertyPath === 'user'
                    ? {
                          joinColumns: this.plan.customerUserJoinColumns.map(databaseName => ({
                              databaseName,
                          })),
                      }
                    : undefined,
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
                    // TWO counts exist on this service and they are answered SEPARATELY, keyed on the
                    // predicate rather than on call order. One is the list bound's, scoped to the owning
                    // customer and channel; the other is the advisory name pre-check, which additionally
                    // carries the canonical `nameKey` — the layer §2.11 requires the service to perform
                    // alongside catching the constraint violation. Answering both from one configured number
                    // would make the bound's own tests pass for the wrong reason (a `heldListCount` of one
                    // would read as a name collision), and answering the pre-check unconditionally with zero
                    // would let a missing predicate pass [FEATURE-001-01:§2.11].
                    const where = (options.where ?? {}) as Record<string, unknown>;
                    if (Object.prototype.hasOwnProperty.call(where, 'nameKey')) {
                        return this.plan.conflictingNameCount(options);
                    }
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

// Journal queries. Each is named for the claim it supports, so an assertion reads as the clause it pins.

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

/**
 * The statements that look a ROW up, as distinct from the ones that count rows.
 *
 * Both are `SELECT`s, and the distinction matters wherever an assertion is about how many times a row was
 * addressed: an aggregate reads no row into process memory and answers a different question, so counting it
 * alongside the lookups would make a claim about disclosure depend on how many bounds an operation checks.
 */
function rowLookupsAgainst(harness: ServiceHarness, entity: ProbedEntity): JournalledStatement[] {
    return statementsOfKind(harness, entity, 'select').filter(statement => statement.terminal !== 'count');
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

/**
 * Replays the journal against the transaction record and returns every place the plugin's one lock-ordering rule
 * was broken — a lock or write acquired on the PARENT table while one on a CHILD row was still held.
 *
 * ★ WHY A REPLAY, AND WHY NOT A CHECK INSIDE ONE STATEMENT. FEATURE-001-01 §5's lock-ordering item is a rule
 * about TRANSACTIONS, not about statements: a transaction touching both rows takes the parent first. Two things
 * follow that no single-statement assertion can see. A row is locked by being WRITTEN as much as by a `FOR
 * UPDATE` — an `UPDATE` of a line takes that line's row lock — so the holds include writes and not only explicit
 * lock modes. And a transaction's holds can OUTLIVE the attempt that took them: TypeORM opens a nested
 * transaction as a savepoint, and rolling back to a savepoint retains the locks taken after it on the MySQL
 * family, so a bounded retry nested inside a failed attempt begins already holding that attempt's child locks and
 * inverts the order the moment it touches the parent. Replaying the whole sequence, with the nesting and the
 * outcomes, is what makes that visible.
 */
function lockOrderViolations(harness: ServiceHarness): string[] {
    const outcomes = new Map(harness.transactionOutcomes.map(outcome => [outcome.id, outcome]));
    const violations: string[] = [];
    const held = new Set<ProbedEntity>();
    // The same predicate the service reads to decide whether to take a row lock at all, so the model and the
    // implementation agree about which engines have an order to impose.
    const locksRows = ENGINES_SUPPORTING_PESSIMISTIC_LOCKING.includes(harness.plan.engine);
    let currentTransaction = 0;
    for (const statement of harness.journal) {
        if (statement.transaction !== currentTransaction) {
            const previous = outcomes.get(currentTransaction);
            // A real transaction's end releases every hold. A nested one's rollback does not, which is the whole
            // point of distinguishing them; its commit releases nothing either, the enclosing transaction still
            // holding what the savepoint took.
            if (previous === undefined || previous.nested === false) {
                held.clear();
            }
            currentTransaction = statement.transaction;
        }
        const acquires = statement.locks.length > 0 || statement.operation !== 'select';
        if (!acquires) {
            continue;
        }
        if (statement.entity === 'ReorderList' && held.has('ReorderListLine')) {
            violations.push(
                `transaction ${statement.transaction} acquired ${statement.entity} (${statement.operation}) ` +
                    'while holding ReorderListLine',
            );
        }
        held.add(statement.entity);
        // THE ACQUISITION THE STATEMENT DOES NOT DECLARE. Modelled after the child hold above, because that is
        // the order the engine takes them in, and only on an engine that takes row locks.
        if (
            locksRows &&
            statement.entity === 'ReorderListLine' &&
            ownershipSubqueryOf(statement) !== undefined
        ) {
            if (!held.has('ReorderList')) {
                violations.push(
                    `transaction ${statement.transaction} acquired ReorderList (correlated current read ` +
                        `inside a ReorderListLine ${statement.operation}) while holding ReorderListLine`,
                );
            }
            held.add('ReorderList');
        }
    }
    return violations;
}

/**
 * The same replay over a journal with one statement withheld, which is how the counterfactual is expressed.
 *
 * ★ A lock-order assertion that passes is only worth what its failure would have been, and the acquisition this
 * rule turns on — the accumulation branch's shared parent lock — cannot be removed from the service by a test.
 * Withholding it from the journal and replaying is the next best thing and answers the same question: does the
 * ORDER depend on that statement, or would the sequence be acceptable without it? Applied to an accumulation the
 * answer must be that it depends on it, because what follows is a child write whose correlated sub-query then
 * acquires the parent second.
 */
function lockOrderViolationsWithout(
    harness: ServiceHarness,
    withheld: (statement: JournalledStatement) => boolean,
): string[] {
    const kept = harness.journal.filter(statement => !withheld(statement));
    return lockOrderViolations({ ...harness, journal: kept } as ServiceHarness);
}

interface OwnershipSubquery {
    /** The table the sub-query reads, which must be the list table for the predicate to mean anything. */
    table: string;
    /**
     * The FULL reference to that table, segments unescaped and rejoined — so `reorder_list` on an unqualified
     * connection and `configured.reorder_list` on one carrying a schema or a database.
     */
    tablePath: string;
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
    // The table reference is read SEGMENT BY SEGMENT, and every segment must have gone through the driver's
    // escape. Two spellings are refused by that, and each is a real defect: a bare `reorder_list`, which
    // PostgreSQL folds to lower case and which names whatever the search path resolves rather than the schema
    // the statement's own target carries; and a whole dotted path escaped as ONE identifier, which produces the
    // single quoted name `"configured.reorder_list"` — not a qualified reference to anything that exists.
    const referenceSegments = relation[1].split('.');
    const unescapedSegments = referenceSegments.map(segment => unescapeIdentifier(segment));
    if (unescapedSegments.some((segment, index) => segment === referenceSegments[index].trim())) {
        return undefined;
    }
    const tablePath = unescapedSegments.join('.');
    const table = unescapedSegments[unescapedSegments.length - 1];
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
        tablePath,
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
function ownedLineScope(correlatedTo: string, tablePath: string = REORDER_LIST_TABLE): OwnershipSubquery {
    return {
        table: REORDER_LIST_TABLE,
        tablePath,
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

        it('answers an authenticated user with no customer row exactly as it answers an absent session', async () => {
            // ★ A SESSION THAT IS NOT A BUYER IS REFUSED, NOT REPORTED AS A FAILURE, AND THE READ CONVENTION
            // THEREFORE COVERS IT. The Shop API's `login` restricts nothing about which `User` may
            // authenticate, so an administrator — or a user from a custom `AuthenticationStrategy` that
            // creates no customer — holds a session with `activeUserId` set and no customer row. Classifying
            // that as internal answered all eight operations with a 500 for a caller who simply owns no
            // lists; it is now the same `ForbiddenError` an absent session raises, which is what makes the
            // single read answer `null` and the collection read answer the empty page (AAP section 0.5.2.3).
            harness.plan.customerRow = null;

            expect(await service.getReorderList(ctx, LIST_ID)).toBeNull();
            expect(await service.getReorderLists(ctx)).toEqual({ items: [], totalItems: 0 });
            expect(harness.listQueryBuilder.build).not.toHaveBeenCalled();

            // And a WRITE lets the same refusal propagate, so the caller sees one top-level `FORBIDDEN`
            // entry rather than an internal error.
            const failure = await captureRejection(() =>
                service.createReorderList(ctx, { name: 'Weekly kitchen restock' }),
            );

            expect(failure).toBeInstanceOf(ForbiddenError);
            expect(failure).not.toBeInstanceOf(InternalServerError);
        });

        it('succeeds for an ordinary customer session that holds no plugin-registered permission', async () => {
            const created = await service.createReorderList(ctx, { name: 'Weekly kitchen restock' });
            const read = await service.getReorderList(ctx, LIST_ID);

            expect(created).toBeInstanceOf(ReorderList);
            expect(read).toBeInstanceOf(ReorderList);
        });
    });

    describe('the table the ownership predicate names, on a connection that qualifies its identifiers', () => {
        /*
         * ★ WHY THESE EXIST. The correlated sub-query every line write carries is what decides whether that
         * line may be changed or removed, and it names the PARENT table in a raw fragment this service renders
         * itself. TypeORM renders the statement's own target from `EntityMetadata.tablePath`, which is
         * `driver.buildTableName(tableName, schema, database)` — so a connection configured with PostgreSQL's
         * `schema` (the development server exposes it as `DB_SCHEMA`) or the MySQL family's `database` gets a
         * QUALIFIED target. A sub-query naming the bare table would then read some other table of that name on
         * the connection's search path, and the two failures that follows are not equivalent: where no such
         * table exists the statement errors, and where one DOES exist it answers the ownership question from
         * rows this deployment does not own. Identifiers are allocated sequentially by the default strategy, so
         * a row of the same id in a same-named table is an ordinary occurrence rather than a contrivance.
         */
        const QUALIFIER = 'reorder_alt';

        it('renders the bare escaped table where the connection qualifies nothing', async () => {
            await service.adjustReorderListLine(ctx, {
                reorderListId: LIST_ID,
                lineId: LINE_ID,
                quantity: 3,
            });

            const update = statementsOfKind(harness, 'ReorderListLine', 'update')[0];
            expect(ownershipSubqueryOf(update)).toEqual(ownedLineScope('reorderListId'));
        });

        it('qualifies the table with the configured schema on all three line-writing paths', async () => {
            harness.plan.tableQualifier = QUALIFIER;
            const qualified = `${QUALIFIER}.${REORDER_LIST_TABLE}`;

            await service.adjustReorderListLine(ctx, {
                reorderListId: LIST_ID,
                lineId: LINE_ID,
                quantity: 3,
            });
            await service.removeReorderListLine(ctx, { reorderListId: LIST_ID, lineId: LINE_ID });
            harness.plan.lineGetOne = () => ownedLine({ quantity: 2 });
            await service.addItemToReorderList(ctx, {
                reorderListId: LIST_ID,
                productVariantId: VARIANT_ID,
                quantity: 1,
            });

            // Every statement that carries the predicate, whichever operation produced it: the absolute set,
            // the removal, and the accumulation onto an existing line.
            const carriers = harness.journal.filter(
                statement =>
                    statement.entity === 'ReorderListLine' &&
                    (statement.operation === 'update' || statement.operation === 'delete') &&
                    ownershipSubqueryOf(statement) !== undefined,
            );
            expect(carriers.length).toBeGreaterThanOrEqual(3);
            for (const carrier of carriers) {
                expect(ownershipSubqueryOf(carrier)).toEqual(ownedLineScope('reorderListId', qualified));
            }
        });

        it('qualifies with a database segment too, which is the shape the MySQL family produces', async () => {
            // `MysqlDriver.buildTableName` prefixes the DATABASE rather than a schema, so the same fragment
            // must be correct for a two-segment path that is not a schema at all. Nothing in the rendering may
            // depend on which of the two the segment is.
            harness.plan.engine = 'mariadb';
            harness.plan.tableQualifier = 'vendure_dev';

            await service.adjustReorderListLine(ctx, {
                reorderListId: LIST_ID,
                lineId: LINE_ID,
                quantity: 3,
            });

            const update = statementsOfKind(harness, 'ReorderListLine', 'update')[0];
            expect(ownershipSubqueryOf(update)).toEqual(
                ownedLineScope('reorderListId', `vendure_dev.${REORDER_LIST_TABLE}`),
            );
        });

        it('escapes each segment separately rather than the dotted path as one identifier', async () => {
            // THE ADVERSARIAL CASE, and the one an ordinary reading of the fragment would produce. Handing the
            // dotted path to the driver's escape whole yields the single quoted name `"schema.reorder_list"`,
            // which is not a qualified reference to anything — it is one identifier that happens to contain a
            // dot, and it names no table on any engine. Both halves are asserted: the correct spelling is
            // present, and the wrong one is absent from the rendered SQL text.
            harness.plan.tableQualifier = QUALIFIER;

            await service.adjustReorderListLine(ctx, {
                reorderListId: LIST_ID,
                lineId: LINE_ID,
                quantity: 3,
            });

            const update = statementsOfKind(harness, 'ReorderListLine', 'update')[0];
            const text = conditionTextOf(update);
            expect(text).toContain(`${escaped(QUALIFIER)}.${escaped(REORDER_LIST_TABLE)}`);
            expect(text).not.toContain(escaped(`${QUALIFIER}.${REORDER_LIST_TABLE}`));
            // And the segments reached the driver as separate identifiers, which is what produced that
            // spelling — read off the escape calls rather than inferred from the text.
            expect(harness.escapedIdentifiers).toContain(QUALIFIER);
            expect(harness.escapedIdentifiers).toContain(REORDER_LIST_TABLE);
            expect(harness.escapedIdentifiers).not.toContain(`${QUALIFIER}.${REORDER_LIST_TABLE}`);
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

    describe('updateReorderList, whose affected-row count decides the outcome', () => {
        it('returns the renamed list when the conditional statement reports one affected row', async () => {
            harness.plan.listAffected = () => 1;
            harness.plan.listFindOne = () => ownedList({ name: 'Pantry top-up', nameKey: 'pantry top-up' });

            const result = await service.updateReorderList(ctx, { id: LIST_ID, name: 'Pantry top-up' });

            expect(result).toBeInstanceOf(ReorderList);
            expect((result as ReorderList).name).toBe('Pantry top-up');
        });

        it('refuses a list this caller may not have with ONE scoped select and no DML at all', async () => {
            // THE REFUSED-WRITE EVIDENCE CONTRACT, ASSERTED AS A STATEMENT SHAPE RATHER THAN AS A PAYLOAD.
            // A caller who is not the owner, or who carries another channel's token, must be refused by
            // exactly one scoped `SELECT` that returns no rows, with NO `INSERT`, `UPDATE` or `DELETE` issued
            // on their behalf. A refusal reached by writing first and classifying the affected count
            // afterwards produces the identical `ReorderListNotFoundError` while having issued DML for a
            // caller entitled to none, which is what this assertion exists to fail [FEATURE-001-01:§2.6.1.1].
            harness.plan.listGetOne = () => null;
            harness.plan.listFindOne = () => null;

            const result = await service.updateReorderList(ctx, { id: LIST_ID, name: 'Pantry top-up' });

            expect(result).toBeInstanceOf(ReorderListNotFoundError);
            expect((result as ReorderListNotFoundError).errorCode).toBe('REORDER_LIST_NOT_FOUND_ERROR');
            const selects = rowLookupsAgainst(harness, 'ReorderList');
            expect(selects).toHaveLength(1);
            expect(writeStatements(harness)).toEqual([]);
            // And the one statement is scoped, not a bare lookup by identifier: the ownership conjuncts sit in
            // the same `WHERE` clause as the id, which is what makes the refusal return zero rows rather than
            // load a row and discard it.
            expect(conditionTextOf(selects[0])).toContain('reorderlist.id = :id');
            expect(conditionTextOf(selects[0])).toContain('reorderlist.customerId = :customerId');
            expect(conditionTextOf(selects[0])).toContain('reorderlist.channelId = :channelId');
            expect(scopeBoundBy(selects[0])).toEqual({ customer: CUSTOMER_ID, channel: CHANNEL_ID });
        });

        it('reads nothing about another customer, because the scope comes from the session', async () => {
            // A table holding the addressed row for a DIFFERENT customer. The service binds the customer its
            // own session resolved, so the admission statement matches nothing and the caller is refused
            // without a write — and without the foreign row ever reaching process memory.
            const foreignRow = ownedList({ customerId: FOREIGN_CUSTOMER_ID });
            harness.plan.listGetOne = probe =>
                String(probe.parameters.customerId) === String(foreignRow.customerId) ? foreignRow : null;
            harness.plan.listFindOne = rowMatchingPredicate(foreignRow);

            const result = await service.updateReorderList(ctx, { id: LIST_ID, name: 'Pantry top-up' });

            expect(result).toBeInstanceOf(ReorderListNotFoundError);
            expect(writeStatements(harness)).toEqual([]);
            expect(rowLookupsAgainst(harness, 'ReorderList')).toHaveLength(1);
        });

        it('returns ReorderListNotFoundError when the admitted row is gone by the time the write is issued', async () => {
            // The admitted-path zero, which is a different case from a refusal: the row passed the admission
            // read and then left this caller's scope — deleted, or moved — before the conditional statement
            // ran. The write is the authority on what happened, so its zero affected count is what produces
            // the answer, and the classification read then confirms the row is genuinely gone.
            harness.plan.listAffected = () => 0;
            harness.plan.listGetOne = answeringInSequence<ReorderList | null>(ownedList(), null);

            const result = await service.updateReorderList(ctx, { id: LIST_ID, name: 'Pantry top-up' });

            expect(result).toBeInstanceOf(ReorderListNotFoundError);
            expect((result as ReorderListNotFoundError).errorCode).toBe('REORDER_LIST_NOT_FOUND_ERROR');
            // Two scoped row lookups: the admission read and the classification read. Both carry the same
            // three conjuncts, and neither of them is a bare lookup by identifier. The name pre-check's
            // aggregate is a different kind of statement and is asserted separately.
            const selects = rowLookupsAgainst(harness, 'ReorderList');
            expect(selects).toHaveLength(2);
            for (const select of selects) {
                expect(conditionTextOf(select)).toContain('reorderlist.id = :id');
                expect(scopeBoundBy(select)).toEqual({ customer: CUSTOMER_ID, channel: CHANNEL_ID });
            }
        });

        it('keeps the conservative not-found when the write affected nothing and the row carries a different name', async () => {
            // The row is accessible and does NOT hold the requested name, so the write both matched and failed
            // to apply — which no engine does. It stays a not-found rather than claiming a rename that
            // demonstrably did not happen.
            harness.plan.listAffected = () => 0;

            const result = await service.updateReorderList(ctx, { id: LIST_ID, name: 'Pantry top-up' });

            expect(result).toBeInstanceOf(ReorderListNotFoundError);
            expect(loggedWarnings.join(' ')).toContain('carries a different name');
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
            // Two scoped row lookups and no third: the admission read that let this caller through, and the
            // classification read taken after the write under the same predicate — which IS the post-write
            // state, so there is nothing for a reload to add.
            expect(rowLookupsAgainst(harness, 'ReorderList')).toHaveLength(2);
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

        it('answers an unknown identifier, a foreign list and a foreign channel with indistinguishable refusals', async () => {
            // The three refusal reasons must be indistinguishable, because identifiers are sequential under
            // the default id strategy and a distinguishable refusal would confirm the existence of another
            // buyer's row to anyone who counts. Each is asserted to produce the same result object AND the same
            // statement shape: one scoped select, no DML [FEATURE-001-01:§2.6.1.1].
            const refusals: Array<{ result: unknown; selects: number; writes: number }> = [];
            const ownedRow = ownedList();
            for (const shape of [
                // An identifier no row carries.
                { listGetOne: () => null, requestCtx: ctx },
                // A row owned by another customer: the bound customer is this session's, so nothing matches.
                {
                    listGetOne: (probe: QueryBuilderProbe) =>
                        String(probe.parameters.customerId) === String(FOREIGN_CUSTOMER_ID)
                            ? ownedList({ customerId: FOREIGN_CUSTOMER_ID })
                            : null,
                    requestCtx: ctx,
                },
                // The caller's own row, addressed under a second channel token.
                {
                    listGetOne: (probe: QueryBuilderProbe) =>
                        String(probe.parameters.channelId) === String(ownedRow.channelId) ? ownedRow : null,
                    requestCtx: createCtx({ channelId: FOREIGN_CHANNEL_ID }),
                },
            ]) {
                resetRecorders(harness);
                harness.plan.listGetOne = shape.listGetOne;
                harness.plan.listFindOne = () => null;

                const result = await service.updateReorderList(shape.requestCtx, {
                    id: LIST_ID,
                    name: 'Pantry top-up',
                });

                refusals.push({
                    result,
                    selects: rowLookupsAgainst(harness, 'ReorderList').length,
                    writes: writeStatements(harness).length,
                });
            }

            for (const refusal of refusals) {
                expect(refusal.result).toBeInstanceOf(ReorderListNotFoundError);
                expect({ ...(refusal.result as ReorderListNotFoundError) }).toEqual({
                    ...(refusals[0].result as ReorderListNotFoundError),
                });
                expect(refusal.selects).toBe(1);
                expect(refusal.writes).toBe(0);
            }
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

        it('pre-checks the new name against the caller own rows, excluding the row being renamed', async () => {
            // The advisory half of the uniqueness rule on the rename path. Its predicate carries the canonical
            // key beside both owner conjuncts — so it can only see the caller's own rows — and excludes the
            // addressed row, because a rename that changes only display casing leaves the canonical key
            // identical and must not be reported as colliding with itself [FEATURE-001-01:§2.11].
            await service.updateReorderList(ctx, { id: LIST_ID, name: 'Pantry top-up' });

            const preChecks = harness.journal.filter(
                statement => statement.entity === 'ReorderList' && statement.terminal === 'count',
            );
            expect(preChecks).toHaveLength(1);
            const where = (preChecks[0].findOptions?.where ?? {}) as Record<string, unknown>;
            expect(Object.keys(where).sort()).toEqual(['channelId', 'customerId', 'id', 'nameKey']);
            expect(where.customerId).toBe(CUSTOMER_ID);
            expect(where.channelId).toBe(CHANNEL_ID);
            expect(where.nameKey).toBe('pantry top-up');
            // The exclusion is expressed as a negated identifier the database evaluates, rather than by
            // filtering in process, so the count cannot be inflated by the row being renamed.
            expect(where.id).toBeInstanceOf(FindOperator);
            expect((where.id as FindOperator<unknown>).type).toBe('not');
            expect((where.id as FindOperator<unknown>).value).toBe(LIST_ID);
        });

        it('returns ReorderListNameConflictError from the rename pre-check without writing', async () => {
            harness.plan.conflictingNameCount = () => 1;

            const result = await service.updateReorderList(ctx, { id: LIST_ID, name: 'Pantry top-up' });

            expect(result).toBeInstanceOf(ReorderListNameConflictError);
            expect((result as ReorderListNameConflictError).conflictingNameKey).toBe('pantry top-up');
            expect(writeStatements(harness)).toEqual([]);
        });

        it('never asks about other names for a list this caller may not have', async () => {
            // ORDER, not merely presence. The pre-check is a question about OTHER rows, so asking it before
            // admission would tell a caller renaming a list they cannot reach that the name they chose
            // collides — confirming both that the name is theirs and that the identifier they guessed was
            // worth asking about, and replacing the one normalised not-found every inaccessible case produces.
            harness.plan.listGetOne = () => null;
            harness.plan.conflictingNameCount = () => 1;

            const result = await service.updateReorderList(ctx, { id: LIST_ID, name: 'Pantry top-up' });

            expect(result).toBeInstanceOf(ReorderListNotFoundError);
            expect(result).not.toBeInstanceOf(ReorderListNameConflictError);
            expect(harness.journal.some(statement => statement.terminal === 'count')).toBe(false);
        });

        it('still maps the named constraint on the rename path, which the pre-check cannot pre-empt', async () => {
            // A name taken between the pre-check and the write. The pre-check found nothing, the write was
            // refused by `UQ_reorder_list_customer_channel_name_key`, and the caller receives the same result
            // the pre-check would have returned [FEATURE-001-01:§2.11].
            harness.plan.conflictingNameCount = () => 0;
            harness.plan.listAffected = () => {
                throw driverFailure(
                    `duplicate key value violates unique constraint "${NAME_CONFLICT_CONSTRAINT}"`,
                );
            };

            const result = await service.updateReorderList(ctx, { id: LIST_ID, name: 'Pantry top-up' });

            expect(result).toBeInstanceOf(ReorderListNameConflictError);
            expect((result as ReorderListNameConflictError).conflictingNameKey).toBe('pantry top-up');
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

        it('refuses a list this caller may not have with ONE scoped select and no DML at all', async () => {
            // The refused-write evidence contract on the delete path: one scoped `SELECT` returning no rows,
            // and no `DELETE` issued on behalf of a caller entitled to none. Issuing the delete first and
            // reading its affected count instead returns the identical payload while having issued DML, which
            // is what this assertion exists to fail [FEATURE-001-01:§2.6.1.1].
            harness.plan.listGetOne = () => null;
            harness.plan.listFindOne = () => null;

            const result = await service.deleteReorderList(ctx, LIST_ID);

            expect(result).toBeInstanceOf(ReorderListNotFoundError);
            expect(writeStatements(harness)).toEqual([]);
            const selects = rowLookupsAgainst(harness, 'ReorderList');
            expect(selects).toHaveLength(1);
            expect(conditionTextOf(selects[0])).toContain('reorderlist.id = :id');
            expect(scopeBoundBy(selects[0])).toEqual({ customer: CUSTOMER_ID, channel: CHANNEL_ID });
        });

        it('refuses a repeat delete on the admission read, the row it addressed being already gone', async () => {
            // The first call removes the row; the second addresses a row that no longer exists, so it is
            // refused by the admission read rather than reported as a second success.
            harness.plan.listAffected = () => 1;
            harness.plan.listGetOne = answeringInSequence<ReorderList | null>(ownedList(), null);

            const first = await service.deleteReorderList(ctx, LIST_ID);
            const second = await service.deleteReorderList(ctx, LIST_ID);

            expect((first as DeletionResponse).result).toBe(DeletionResult.DELETED);
            expect(second).toBeInstanceOf(ReorderListNotFoundError);
        });

        it('returns ReorderListNotFoundError when the admitted row is deleted before its own statement runs', async () => {
            // The admitted-path zero: the row passed the admission read and a concurrent request removed it
            // before this transaction's own delete ran. The affected-row count remains the authority on what
            // happened, so the operation reports the same normalised not-found rather than a success.
            harness.plan.listAffected = () => 0;

            const result = await service.deleteReorderList(ctx, LIST_ID);

            expect(result).toBeInstanceOf(ReorderListNotFoundError);
            expect(statementsOfKind(harness, 'ReorderList', 'delete')).toHaveLength(1);
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
        it('refuses a list this caller may not have with ONE scoped select and no DML at all', async () => {
            // The refused-write evidence contract on the adjust path. The scoped read over `reorder_list` is
            // this transaction's first statement against either plugin table, so a caller who cannot reach the
            // list is refused by one `SELECT` returning no rows with no `UPDATE` issued on their behalf — and
            // learns nothing about which of the list's lines exist [FEATURE-001-01:§2.6.1.1].
            harness.plan.lineAffected = () => 0;
            harness.plan.listFindOne = () => null;
            harness.plan.listGetOne = () => null;

            const result = await service.adjustReorderListLine(ctx, {
                reorderListId: LIST_ID,
                lineId: LINE_ID,
                quantity: 2,
            });

            expect(result).toBeInstanceOf(ReorderListNotFoundError);
            expect(result).not.toBeInstanceOf(ReorderListLineNotFoundError);
            expect(writeStatements(harness)).toEqual([]);
            expect(statementsAgainst(harness, 'ReorderListLine')).toEqual([]);
            const selects = rowLookupsAgainst(harness, 'ReorderList');
            expect(selects).toHaveLength(1);
            // ONE statement, and all three conjuncts inside its own `WHERE`. The read is a locking one on this
            // engine, so the predicate is asserted through the statement's conditions rather than through
            // find-options — the shape is what matters and it is unchanged by the lock.
            expect(conditionTextOf(selects[0])).toContain('reorderlist.id = :id');
            expect(conditionTextOf(selects[0])).toContain('reorderlist.customerId = :customerId');
            expect(conditionTextOf(selects[0])).toContain('reorderlist.channelId = :channelId');
            expect(selects[0].parameters).toMatchObject({
                id: LIST_ID,
                customerId: CUSTOMER_ID,
                channelId: CHANNEL_ID,
            });
        });

        it('takes a SHARED lock on the parent before writing the line, so the order is parent first', async () => {
            // THE LOCK ORDER, WHICH IS THE WHOLE OF THIS CLAIM [FEATURE-001-01:§5 lock-ordering seam]. Any
            // transaction in this plugin touching both the parent row and a child row takes the parent FIRST,
            // and this one is a child write: `removeReorderListLine` and `deleteReorderList` take the same
            // parent row exclusively as their own first statement, so an adjust that locked the line first
            // would be waiting for the parent while a remove holding the parent waited for the line — the
            // definition of a deadlock, resolved by the engine killing one buyer's request.
            harness.plan.engine = 'postgres';

            await service.adjustReorderListLine(ctx, {
                reorderListId: LIST_ID,
                lineId: LINE_ID,
                quantity: 2,
            });

            const statements = pluginStatements(harness);
            expect(statements[0].entity).toBe('ReorderList');
            expect(statements[0].terminal).toBe('getOne');
            expect(statements[0].locks).toEqual(['pessimistic_read']);
            // And no LINE row is locked by this path at all: the child is written by one conditional statement
            // whose affected-row count is the authority, never by a read-then-save under a row lock.
            expect(
                statements
                    .filter(statement => statement.entity === 'ReorderListLine')
                    .every(statement => statement.locks.length === 0),
            ).toBe(true);
        });

        it('attempts no parent lock where the engine serves a single connection', async () => {
            // The in-process SQLite engine cannot interleave two transactions, so there is no order to impose
            // and asking that driver for a lock raises rather than degrades. The statement count is unchanged
            // by the difference, which is what keeps this file's counted assertions engine-independent.
            harness.plan.engine = 'sqljs';

            await service.adjustReorderListLine(ctx, {
                reorderListId: LIST_ID,
                lineId: LINE_ID,
                quantity: 2,
            });

            expect(harness.journal.every(statement => statement.locks.length === 0)).toBe(true);
            // The admission read is still the transaction's first statement against either plugin table, and
            // still ONE scoped `SELECT` carrying all three conjuncts: only the lock differs between the
            // engines, never the predicate. The terminal differs with it — an unlockable engine takes the
            // repository's own `findOne`, which is the same single statement expressed through find-options —
            // and the predicate is asserted through whichever form the path took.
            const statements = pluginStatements(harness);
            expect(statements[0].entity).toBe('ReorderList');
            expect(statements[0].terminal).toBe('findOne');
            expect(statements[0].findOptions?.where).toEqual({
                id: LIST_ID,
                customerId: CUSTOMER_ID,
                channelId: CHANNEL_ID,
            });
        });

        it('returns ReorderListLineNotFoundError when the list resolves and the line statement misses', async () => {
            harness.plan.lineAffected = () => 0;
            harness.plan.listFindOne = rowMatchingPredicate(ownedList());
            harness.plan.listGetOne = () => ownedList();
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
            harness.plan.listFindOne = rowMatchingPredicate(ownedList());
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

    describe('the one lock order every line write takes, parent before child', () => {
        // FEATURE-001-01:§5's lock-ordering seam item fixes one rule for the whole plugin: a transaction that
        // touches both the parent `reorder_list` row and a child `reorder_list_line` row takes the parent
        // FIRST. Two transactions taking the same two rows in opposite orders deadlock rather than wait, which
        // a buyer observes as an operation that failed for no reason they can act on.

        for (const engine of ['postgres', 'mysql', 'mariadb']) {
            // The MODE is engine-dependent and the ORDER is not, which is the whole of the difference this loop
            // carries. `ENGINES_REQUIRING_EXCLUSIVE_PARENT_FOR_LINE_WRITES` is read from the service rather than
            // restated here so the model cannot drift from the implementation it replays: on the MySQL family
            // two shared holders were measured to deadlock at the line row when it is removed beneath them, and
            // an InnoDB deadlock inside a savepoint surfaces as an unrecoverable savepoint error rather than as
            // the retriable deadlock it is. Everything else about the case is identical on all three engines.
            const exclusiveParent = ENGINES_REQUIRING_EXCLUSIVE_PARENT_FOR_LINE_WRITES.includes(engine);
            const expectedParentLock = exclusiveParent ? 'pessimistic_write' : 'pessimistic_read';
            it(`takes ${
                exclusiveParent ? 'an EXCLUSIVE' : 'a SHARED'
            } lock on the parent before accumulating onto an existing line on ${engine}`, async () => {
                // THE ACQUISITION THE ENGINE WOULD OTHERWISE MAKE IMPLICITLY, taken deliberately and first.
                // The increment below carries its ownership predicate as a correlated `EXISTS` over the parent
                // table, and on the MySQL family a sub-query evaluated by a DML statement is a CURRENT read:
                // the statement takes the child row exclusively and then a shared lock on the parent row it
                // read, in that order. So the branch does touch both rows, child first, and
                // `removeReorderListLine` and `deleteReorderList` touch the same two parent first — the
                // inversion the rule exists to prevent [FEATURE-001-01:§5 lock-ordering seam]. Asserting the
                // ABSENCE of a lock here, on the reasoning that the branch "writes only the child", would be
                // true of what it writes and false of what it locks.
                harness.plan.engine = engine;
                harness.plan.lineGetOne = () => ownedLine({ quantity: 4 });
                harness.plan.lineAffected = () => 1;

                await service.addItemToReorderList(ctx, {
                    reorderListId: LIST_ID,
                    productVariantId: VARIANT_ID,
                    quantity: 2,
                });

                const locked = harness.journal.filter(statement => statement.locks.length > 0);
                expect(locked).toHaveLength(1);
                expect(locked[0].entity).toBe('ReorderList');
                expect(locked[0].locks).toEqual([expectedParentLock]);
                const lockIndex = harness.journal.indexOf(locked[0]);
                const firstLineStatement = harness.journal.findIndex(
                    statement => statement.entity === 'ReorderListLine' && statement.operation !== 'select',
                );
                expect(firstLineStatement).toBeGreaterThan(lockIndex);
                // Scoped exactly as every other ownership read is, so the lock cannot be taken on a row this
                // caller does not own.
                expect(scopeBoundBy(locked[0])).toEqual({
                    customer: CUSTOMER_ID,
                    channel: CHANNEL_ID,
                });

                // It writes no parent row — which is what makes the shared mode available at all where the
                // engine can honour it, and, on either mode, what makes the lock taken at admission the ONLY
                // one this branch takes on the parent: nothing upgrades, so two accumulations cannot deadlock
                // on an upgrade either.
                expect(
                    writeStatements(harness).filter(statement => statement.entity === 'ReorderList'),
                    'an accumulation wrote the parent row',
                ).toEqual([]);
                const increment = statementsOfKind(harness, 'ReorderListLine', 'update')[0];
                expect(ownershipSubqueryOf(increment)).toEqual(ownedLineScope('reorderListId'));

                expect(lockOrderViolations(harness)).toEqual([]);

                // AND THE ORDER DEPENDS ON THAT ONE STATEMENT. Withheld from the journal, the same replay
                // reports the inversion — which is what makes the assertion above evidence rather than a
                // sequence that happened to be acceptable.
                const withoutTheLock = lockOrderViolationsWithout(
                    harness,
                    statement => statement === locked[0],
                );
                expect(withoutTheLock.length).toBeGreaterThan(0);
                expect(withoutTheLock.join(' | ')).toContain('correlated current read');
            });

            it(`refuses an accumulation whose list left scope before the lock, without issuing the increment, on ${engine}`, async () => {
                // THE REACHABLE WINDOW, WHICH IS THE ONE BEFORE THE LOCK. The admission read found the list and
                // the line, and the list was then deleted or moved out of this caller's scope before the shared
                // parent lock was taken — so the locking read matches no row, and the branch refuses there.
                // Reported as the same normalised not-found every inaccessible case produces, with NOTHING
                // written, no increment issued at all, and NO retry: this is a decision about the request rather
                // than a state to reconcile.
                harness.plan.engine = engine;
                harness.plan.lineGetOne = () => ownedLine({ quantity: 4 });
                // The admission read resolves — it is the repository's own `findOne` — and the LOCKING read that
                // follows it, which the query builder issues, matches nothing.
                harness.plan.listFindOne = rowMatchingPredicate(ownedList());
                harness.plan.listGetOne = () => null;

                const result = await service.addItemToReorderList(ctx, {
                    reorderListId: LIST_ID,
                    productVariantId: VARIANT_ID,
                    quantity: 2,
                });

                expect(result).toBeInstanceOf(ReorderListNotFoundError);
                // NO INCREMENT WAS ISSUED. The refusal happened at the lock, so the child was never addressed —
                // which is also why no lock order could have been inverted.
                expect(statementsOfKind(harness, 'ReorderListLine', 'update')).toEqual([]);
                expect(
                    writeStatements(harness).filter(statement => statement.entity === 'ReorderList'),
                    'the refused accumulation wrote the parent row',
                ).toEqual([]);
                expect(harness.transactionsOpened, 'a decision about the request was retried').toBe(1);
                expect(lockOrderViolations(harness)).toEqual([]);
            });

            it(`classifies an increment that matches nothing as not-found, as defence in depth, on ${engine}`, async () => {
                // WHAT THIS CASE IS AND IS NOT. It drives the affected count to zero directly, and it is a claim
                // about CLASSIFICATION rather than about a reachable interleaving: with the shared parent lock
                // held, a committed deletion or re-owning of the list cannot happen between the lock and the
                // increment, so on these engines the ownership conjunct of the increment should never be the one
                // that fails. The conjunct stays in the statement regardless — it is what scopes the write on an
                // engine where no lock was available, and what would answer if a future revision ever moved or
                // dropped the lock — so the behaviour behind it is asserted rather than left untested. It is
                // NOT a concurrent deletion: the lock has already made that impossible.
                harness.plan.engine = engine;
                harness.plan.lineGetOne = () => ownedLine({ quantity: 4 });
                harness.plan.lineAffected = () => 0;

                const result = await service.addItemToReorderList(ctx, {
                    reorderListId: LIST_ID,
                    productVariantId: VARIANT_ID,
                    quantity: 2,
                });

                expect(result).toBeInstanceOf(ReorderListNotFoundError);
                expect(
                    writeStatements(harness).filter(statement => statement.entity === 'ReorderList'),
                    'the refused accumulation wrote the parent row',
                ).toEqual([]);
                expect(harness.transactionsOpened, 'a decision about the request was retried').toBe(1);
                expect(lockOrderViolations(harness)).toEqual([]);
            });

            it(`writes the parent before inserting a line, and locks nothing first, on ${engine}`, async () => {
                // The insert branch's half of the same rule. The conditional capacity claim is a write of the
                // parent row, so the engine takes that row exclusively to evaluate it: the ordering is
                // satisfied by the claim itself, which is why no lock statement precedes it.
                harness.plan.engine = engine;
                harness.plan.lineGetOne = () => null;
                harness.plan.listAffected = () => 1;

                await service.addItemToReorderList(ctx, {
                    reorderListId: LIST_ID,
                    productVariantId: VARIANT_ID,
                    quantity: 2,
                });

                expect(
                    harness.journal.filter(statement => statement.locks.length > 0),
                    'the insert branch took a lock before its capacity claim, which serialises every add',
                ).toEqual([]);
                const writes = writeStatements(harness);
                expect(writes.length).toBeGreaterThanOrEqual(2);
                expect(isLineCountClaim(writes[0])).toBe(true);
                expect(writes[0].entity).toBe('ReorderList');
                expect(writes[1].entity).toBe('ReorderListLine');
                expect(writes[1].operation).toBe('insert');
                expect(writes[0].transaction).toBe(writes[1].transaction);
            });

            it(`resolves the variant before touching the parent row on ${engine}`, async () => {
                // The same ticket item's second obligation: no transaction holds the parent row across a call
                // it does not control. `ProductVariantService.findOne` is exactly such a call, so it happens
                // before the capacity claim — otherwise the window that row is held for would include a
                // collaborator's own database work, and the window a row is held for is the whole of its cost.
                harness.plan.engine = engine;
                harness.plan.lineGetOne = () => null;
                harness.plan.listAffected = () => 1;
                let statementsWhenVariantResolved = -1;
                harness.productVariantService.findOne.mockImplementationOnce(() => {
                    statementsWhenVariantResolved = pluginStatements(harness).length;
                    return Promise.resolve(harness.plan.variant);
                });

                await service.addItemToReorderList(ctx, {
                    reorderListId: LIST_ID,
                    productVariantId: VARIANT_ID,
                    quantity: 2,
                });

                const statements = pluginStatements(harness);
                const parentWrite = statements.findIndex(
                    statement => statement.entity === 'ReorderList' && statement.operation === 'update',
                );
                expect(statementsWhenVariantResolved).toBeGreaterThan(-1);
                expect(parentWrite).toBeGreaterThan(-1);
                expect(parentWrite).toBeGreaterThanOrEqual(statementsWhenVariantResolved);
            });

            it(`retries as an insert in a FRESH transaction when the line is removed under it on ${engine}`, async () => {
                /*
                 * The one path that crosses from the accumulation branch into the insert branch — the increment
                 * matching nothing because a concurrent request removed the line. It does NOT continue inside the
                 * same transaction, and the reason is the rule: by then the attempt holds a lock on a line row
                 * (the increment examined one, and the current read that established the state holds either the
                 * replacement or the gap the removed row left), so taking the parent now would be exactly the
                 * inversion a removal or a deletion is the other half of.
                 */
                harness.plan.engine = engine;
                let lineReads = 0;
                harness.plan.lineGetOne = () => {
                    lineReads += 1;
                    return lineReads === 1 ? ownedLine({ quantity: 4 }) : null;
                };
                harness.plan.lineAffected = () => 0;
                harness.plan.listAffected = () => 1;

                await service.addItemToReorderList(ctx, {
                    reorderListId: LIST_ID,
                    productVariantId: VARIANT_ID,
                    quantity: 2,
                });

                const statements = pluginStatements(harness);
                const admissionReads = statements
                    .map((statement, index) => ({ statement, index }))
                    .filter(
                        entry =>
                            entry.statement.entity === 'ReorderList' &&
                            entry.statement.operation === 'select' &&
                            entry.statement.locks.length === 0,
                    )
                    .map(entry => entry.index);
                const parentWrite = statements.findIndex(
                    statement => statement.entity === 'ReorderList' && statement.operation === 'update',
                );
                expect(parentWrite, 'the retry never claimed capacity').toBeGreaterThan(-1);
                expect(
                    admissionReads.length,
                    'the operation did not open a second attempt, so it never retried',
                ).toBeGreaterThanOrEqual(2);
                expect(parentWrite).toBeGreaterThan(admissionReads[1]);
                // The first attempt ENDED, and ended by rolling back — which is what released the line locks it
                // had taken. Two transactions, neither nested.
                expect(harness.transactionOutcomes).toHaveLength(2);
                expect(harness.transactionOutcomes[0]).toMatchObject({ nested: false, outcome: 'rollback' });
                expect(harness.transactionOutcomes[1]).toMatchObject({ nested: false, outcome: 'commit' });
                expect(lockOrderViolations(harness)).toEqual([]);
            });

            it(`would invert that order if the retry were nested, which is why the resolver declares manual mode on ${engine}`, async () => {
                /*
                 * ★ THE REASON FOR THE TRANSACTION MODE, MADE EXECUTABLE. This drives the identical sequence with
                 * a transaction already open on the runner — the shape a resolver decorated in the decorator's
                 * DEFAULT mode produces. Each attempt then opens a nested transaction, TypeORM realises that as a
                 * savepoint, and rolling back to a savepoint retains the row locks taken after it on the MySQL
                 * family. The retry therefore begins holding the first attempt's LINE locks and inverts the
                 * plugin's order the moment its capacity claim touches the parent.
                 */
                harness.plan.engine = engine;
                harness.openOuterTransaction();
                let lineReads = 0;
                harness.plan.lineGetOne = () => {
                    lineReads += 1;
                    return lineReads === 1 ? ownedLine({ quantity: 4 }) : null;
                };
                harness.plan.lineAffected = () => 0;
                harness.plan.listAffected = () => 1;

                await service.addItemToReorderList(ctx, {
                    reorderListId: LIST_ID,
                    productVariantId: VARIANT_ID,
                    quantity: 2,
                });

                expect(harness.transactionOutcomes[0]).toMatchObject({ nested: true, outcome: 'rollback' });
                expect(lockOrderViolations(harness)).not.toEqual([]);
                expect(lockOrderViolations(harness)[0]).toContain('while holding ReorderListLine');
            });
        }

        for (const engine of ['sqljs', 'better-sqlite3', 'sqlite']) {
            it(`issues no lock statement at all on ${engine}`, async () => {
                // A single-connection driver cannot interleave two transactions, so there is no order to
                // impose, its correlated read takes no lock either, and asking it for one raises rather than
                // degrades. So the accumulation branch's shared parent lock — which the cases above require on
                // every locking engine — is SKIPPED here rather than degraded to an unlocked read: skipping it
                // issues no statement, which is what keeps the end-to-end statement-count claims, running on
                // exactly this engine, unchanged by that fix.
                harness.plan.engine = engine;
                harness.plan.lineGetOne = () => ownedLine({ quantity: 4 });
                harness.plan.lineAffected = () => 1;

                await service.addItemToReorderList(ctx, {
                    reorderListId: LIST_ID,
                    productVariantId: VARIANT_ID,
                    quantity: 2,
                });

                expect(harness.journal.every(statement => statement.locks.length === 0)).toBe(true);
                expect(lockOrderViolations(harness)).toEqual([]);
                // TWO reads of the parent and no third: the admission read that decides the branch, and the
                // reload that answers the caller. The lock statement the locking engines take is not among them.
                expect(rowLookupsAgainst(harness, 'ReorderList')).toHaveLength(2);
                // And the write is still scoped by the increment's own correlated predicate, which is what
                // enforces ownership on an engine where no lock was available.
                const increment = statementsOfKind(harness, 'ReorderListLine', 'update')[0];
                expect(ownershipSubqueryOf(increment)).toEqual(ownedLineScope('reorderListId'));
            });
        }
    });
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
        // `orIgnore()` — and with it the raw query runner, its positional parameters and TypeORM's
        // structured-result flag — is deliberately not used, because `INSERT IGNORE` downgrades a failed
        // foreign key, an over-long value and an empty NOT NULL column to "affected 0 rows" on the
        // MySQL family, which is indistinguishable from a duplicate. The insert's values are asserted exactly
        // where they are observable, on the builder probe, by 'inserts exactly the three declared members and
        // neither reads nor emits a withdrawn one'; a losing insert is driven by making the statement fail
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

        // THE COUNTER'S FLOOR, which is the portable half of an invariant the database does not hold up
        // everywhere. `CHK_reorder_list_line_count_non_negative` is not created by TypeORM on MySQL or MariaDB
        // (conflict C-E), so on those engines this predicate is the only place the floor exists at all. Without
        // it a counter that has drifted below zero satisfies `< maxLinesPerList` however many lines the list
        // really holds, and every subsequent add is granted capacity the bound exists to withhold.
        it('carries the counter floor beside the maximum so drift cannot widen the bound', async () => {
            await service.addItemToReorderList(ctx, {
                reorderListId: LIST_ID,
                productVariantId: VARIANT_ID,
                quantity: 2,
            });

            const claim = harness.journal.find(isLineCountClaim) as JournalledStatement;
            expect(conditionTextOf(claim)).toContain('lineCount >= 0');
        });

        it('refuses to build on a negative counter, reporting it internally and inserting no line', async () => {
            harness.plan.listAffected = () => 0;
            harness.plan.listGetOne = () => ownedList({ lineCount: -1 });

            const failure = await service
                .addItemToReorderList(ctx, {
                    reorderListId: LIST_ID,
                    productVariantId: VARIANT_ID,
                    quantity: 1,
                })
                .catch((err: unknown) => err);

            // Deliberately NOT a limit error: a negative counter has not been shown to have reached any
            // maximum, so reporting one would state a bound this list has not hit and would bury a data defect
            // behind an outcome an operator reads as ordinary.
            expect(failure).toBeInstanceOf(InternalServerError);
            expect((failure as InternalServerError).message).toBe(UNCLASSIFIED_FAILURE_MESSAGE);
            expect(insertProbes(harness)).toEqual([]);
            expect(statementsOfKind(harness, 'ReorderListLine', 'insert')).toEqual([]);
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

        // THE STORED QUANTITY'S FLOOR, and the reason the ceiling above is not enough on its own. This
        // statement adds to a number it never reads, so a stored quantity that already violates the column's
        // positive invariant is carried forward by the arithmetic rather than caught by it.
        // `CHK_reorder_list_line_quantity_positive` is absent on MySQL and MariaDB (conflict C-E), so this
        // predicate is what stops one corrupt row becoming the author of the next corrupt total.
        it('bounds the stored quantity from below inside the same statement that increments it', async () => {
            harness.plan.lineGetOne = () => ownedLine({ quantity: 6 });
            harness.plan.lineAffected = () => 1;

            await service.addItemToReorderList(ctx, {
                reorderListId: LIST_ID,
                productVariantId: VARIANT_ID,
                quantity: 3,
            });

            const update = statementsOfKind(harness, 'ReorderListLine', 'update')[0];
            expect(conditionTextOf(update)).toContain(`${escaped('quantity')} > 0`);
        });

        // Every non-positive stored base is refused, and refused as a DATA DEFECT rather than as the buyer's
        // fault. The two rows straddle zero deliberately: `-5 + 2` stays non-positive and `-1 + 2` crosses
        // above it, which is exactly the pair that separates "the resulting-quantity arithmetic happened to
        // reject it" from "the stored base was classified". Before the base was classified first, the former
        // reached the caller as `UserInputError` — naming the one party who did not write the row, on the
        // least investigated outcome this service produces, so the defect reached no operator at all.
        it.each([
            { base: -5, delta: 2, note: 'the sum stays non-positive' },
            { base: -1, delta: 2, note: 'the sum crosses above zero' },
            { base: 0, delta: 2, note: 'the sum is legal arithmetic throughout' },
        ])('refuses a stored base of $base as an internal defect, where $note', async ({ base, delta }) => {
            harness.plan.lineGetOne = () => ownedLine({ quantity: base });

            const failure = await service
                .addItemToReorderList(ctx, {
                    reorderListId: LIST_ID,
                    productVariantId: VARIANT_ID,
                    quantity: delta,
                })
                .catch((err: unknown) => err);

            // Not a user input error, because the request was well formed and did not write the offending row;
            // and not a not-found, because the line is demonstrably present and owned.
            expect(failure).toBeInstanceOf(InternalServerError);
            expect((failure as InternalServerError).message).toBe(UNCLASSIFIED_FAILURE_MESSAGE);
            expect(failure).not.toBeInstanceOf(UserInputError);
            // And it never reached a write.
            expect(statementsOfKind(harness, 'ReorderListLine', 'update')).toEqual([]);
        });

        it('still refuses when the row is corrupted between the read and the increment', async () => {
            // THE RACE THE STATEMENT-LEVEL FLOOR EXISTS FOR, which the pre-check above cannot cover because it
            // is a read. The first read sees a sound row, so validation passes and the statement is issued;
            // by then the row holds a value the column may not hold, the floor refuses it, and the zero-path
            // classifier reports `'line-invalid'`. Without two-stage state this case would be answered by the
            // pre-check instead and would prove nothing about the classifier.
            let read = 0;
            harness.plan.lineGetOne = () => ownedLine({ quantity: read++ === 0 ? 6 : 0 });
            harness.plan.lineAffected = () => 0;

            const failure = await service
                .addItemToReorderList(ctx, {
                    reorderListId: LIST_ID,
                    productVariantId: VARIANT_ID,
                    quantity: 2,
                })
                .catch((err: unknown) => err);

            expect(failure).toBeInstanceOf(InternalServerError);
            expect((failure as InternalServerError).message).toBe(UNCLASSIFIED_FAILURE_MESSAGE);
            // The statement WAS issued — this is the floor refusing it, not the pre-check declining to try.
            expect(statementsOfKind(harness, 'ReorderListLine', 'update')).toHaveLength(1);
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
            // The accumulate path takes a SHARED parent lock and no conditional parent statement of its own, so
            // on an engine that cannot lock a row the correlated sub-query is the ONLY thing standing between
            // this increment and another customer's line — and on one that can, it is the conjunct whose
            // affected-row count remains the authority. It is asserted in full for that reason: the parent list
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

    describe("the sub-query relation, which must be qualified the way the statement's own target is", () => {
        /** The alias the fragment introduces, spelled here because the service keeps its constant private. */
        const SUBQUERY_ALIAS = 'owned_list_scope';

        /**
         * The whole ownership fragment, given the relation it should be reading.
         *
         * Composed rather than substring-matched because the relation is the ONE part under test: a fragment
         * that qualified the relation but lost a conjunct, or qualified it and stopped escaping the rest,
         * would satisfy a `toContain('tenant')` while being a different predicate.
         */
        const ownershipClauseReading = (relation: string) =>
            `EXISTS (SELECT 1 FROM ${relation} ${escaped(SUBQUERY_ALIAS)}` +
            ` WHERE ${escaped(SUBQUERY_ALIAS)}.${escaped('id')} = ${escaped('reorderListId')}` +
            ` AND ${escaped(SUBQUERY_ALIAS)}.${escaped('customerId')} = :ownerCustomerId` +
            ` AND ${escaped(SUBQUERY_ALIAS)}.${escaped('channelId')} = :ownerChannelId)`;

        const lineWrites: Array<{
            path: string;
            issue: () => Promise<unknown>;
            statement: () => JournalledStatement;
        }> = [
            {
                path: 'adjustReorderListLine',
                issue: () =>
                    service.adjustReorderListLine(ctx, {
                        reorderListId: LIST_ID,
                        lineId: LINE_ID,
                        quantity: 2,
                    }),
                statement: () => statementsOfKind(harness, 'ReorderListLine', 'update')[0],
            },
            {
                path: 'removeReorderListLine',
                issue: () => service.removeReorderListLine(ctx, { reorderListId: LIST_ID, lineId: LINE_ID }),
                statement: () => statementsOfKind(harness, 'ReorderListLine', 'delete')[0],
            },
            {
                path: 'addItemToReorderList on the accumulate path',
                issue: () => {
                    harness.plan.lineGetOne = () => ownedLine({ quantity: 1 });
                    return service.addItemToReorderList(ctx, {
                        reorderListId: LIST_ID,
                        productVariantId: VARIANT_ID,
                        quantity: 1,
                    });
                },
                statement: () => statementsOfKind(harness, 'ReorderListLine', 'update')[0],
            },
        ];

        for (const lineWrite of lineWrites) {
            it(`names the configured schema on ${lineWrite.path}, so the predicate cannot resolve elsewhere`, async () => {
                // ★ WHY THIS IS A SECURITY PROPERTY. The statements this fragment is appended to are rendered
                // by the query builder from `metadata.tablePath`, so under `dbConnectionOptions.schema` their
                // target is `"tenant"."reorder_list_line"`. A sub-query naming the BARE relation is resolved by
                // PostgreSQL through `search_path` — which the driver does not set from the schema option — so
                // it either fails outright or, silently, correlates the ownership predicate against a
                // same-named table in another schema. One tenant's write would then be admitted or refused by
                // another tenant's rows, and every response-shaped assertion would stay green
                // [node_modules/typeorm/metadata/EntityMetadata.js:L627].
                harness.plan.tablePathFor = tableName => `tenant.${tableName}`;

                await lineWrite.issue();

                expect(conditionTextOf(lineWrite.statement())).toContain(
                    ownershipClauseReading(`${escaped('tenant')}.${escaped(REORDER_LIST_TABLE)}`),
                );
                // Each part went through the driver on its own. A path escaped whole would arrive as one
                // quoted identifier containing a dot, which names a table whose name contains a dot rather
                // than a table in a schema.
                expect(harness.escapedIdentifiers).toContain('tenant');
                expect(harness.escapedIdentifiers).not.toContain(`tenant.${REORDER_LIST_TABLE}`);
            });
        }

        it('reads the bare relation where the connection carries no schema and no database', async () => {
            // The control. Without it the qualification could be unconditional — a prefix invented by this
            // service rather than read from the metadata — and every engine without a configured schema would
            // then be issued a statement naming a relation that does not exist.
            await service.adjustReorderListLine(ctx, {
                reorderListId: LIST_ID,
                lineId: LINE_ID,
                quantity: 2,
            });

            const statement = statementsOfKind(harness, 'ReorderListLine', 'update')[0];
            expect(conditionTextOf(statement)).toContain(ownershipClauseReading(escaped(REORDER_LIST_TABLE)));
        });

        it('passes an empty path part through unescaped, which is what keeps `database..table` valid', async () => {
            // TypeORM's own rule, reproduced rather than guessed: `QueryBuilder.getTableName` escapes every
            // part of the path EXCEPT an empty one, because SQL Server renders a database configured without a
            // schema as `database..table` and an escaped empty identifier is not valid there
            // [node_modules/typeorm/query-builder/QueryBuilder.js:L362-L372].
            harness.plan.tablePathFor = tableName => `ledger..${tableName}`;

            await service.adjustReorderListLine(ctx, {
                reorderListId: LIST_ID,
                lineId: LINE_ID,
                quantity: 2,
            });

            const statement = statementsOfKind(harness, 'ReorderListLine', 'update')[0];
            expect(conditionTextOf(statement)).toContain(
                ownershipClauseReading(`${escaped('ledger')}..${escaped(REORDER_LIST_TABLE)}`),
            );
            expect(harness.escapedIdentifiers).not.toContain('');
        });
    });

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

        it('decides the race at the named constraint, which the advisory pre-check cannot pre-empt', async () => {
            // THE LAYER THE PRE-CHECK CANNOT REPLACE. The pre-check found nothing — which is exactly the state
            // two concurrent creates are both in — and the row was then refused by the named unique object.
            // §2.11 requires the service to perform the pre-check AND catch the insert failure, and this is the
            // half no read can supply [FEATURE-001-01:§2.11].
            harness.plan.conflictingNameCount = () => 0;
            harness.plan.saveList = () => {
                throw driverFailure(
                    `duplicate key value violates unique constraint "${NAME_CONFLICT_CONSTRAINT}"`,
                );
            };

            const result = await service.createReorderList(ctx, { name: SUBMITTED_NAME });

            expect(result).toBeInstanceOf(ReorderListNameConflictError);
            expect((result as ReorderListNameConflictError).conflictingNameKey).toBe(CANONICAL_KEY);
            expect(statementsOfKind(harness, 'ReorderList', 'insert')).toHaveLength(1);
        });

        it('answers both uniqueness layers with the identical result, so a caller cannot tell them apart', async () => {
            // The two layers are indistinguishable by construction: both carry the caller's own canonical key
            // and neither discloses anything about the row that already holds the name. That is what makes the
            // pre-check advisory rather than a second contract [FEATURE-001-01:§2.11].
            harness.plan.conflictingNameCount = () => 1;
            const fromPreCheck = await service.createReorderList(ctx, { name: SUBMITTED_NAME });

            resetRecorders(harness);
            harness.plan.conflictingNameCount = () => 0;
            harness.plan.saveList = () => {
                throw driverFailure(
                    `duplicate key value violates unique constraint "${NAME_CONFLICT_CONSTRAINT}"`,
                );
            };
            const fromConstraint = await service.createReorderList(ctx, { name: SUBMITTED_NAME });

            expect(fromPreCheck).toBeInstanceOf(ReorderListNameConflictError);
            expect(fromConstraint).toBeInstanceOf(ReorderListNameConflictError);
            expect({ ...(fromPreCheck as ReorderListNameConflictError) }).toEqual({
                ...(fromConstraint as ReorderListNameConflictError),
            });
        });

        it('issues exactly one nameKey pre-check on the create path, scoped to the caller', async () => {
            await service.createReorderList(ctx, { name: SUBMITTED_NAME });

            const counts = harness.journal.filter(statement => statement.terminal === 'count');
            // Two counts: the list bound's, and the advisory name pre-check. The pre-check's predicate carries
            // the canonical key beside both owner conjuncts, so it can only ever see the caller's own rows.
            expect(counts).toHaveLength(2);
            const preChecks = counts.filter(statement =>
                Object.prototype.hasOwnProperty.call(
                    (statement.findOptions?.where ?? {}) as object,
                    'nameKey',
                ),
            );
            expect(preChecks).toHaveLength(1);
            expect(Object.keys((preChecks[0].findOptions?.where ?? {}) as object).sort()).toEqual([
                'channelId',
                'customerId',
                'nameKey',
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
            expect(pluginStatements(harness)).toEqual([]);
        });
    });

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

            const first = await service.getLinesForLists(ctx, [LIST_ID]);
            const second = await service.getLinesForLists(ctx, [LIST_ID]);

            // The refusal reaches the caller as the read convention's empty page, per parent, both times.
            expect(first.get(LIST_ID)).toEqual({ items: [], totalItems: 0 });
            expect(second.get(LIST_ID)).toEqual({ items: [], totalItems: 0 });
            // Two lookups for two asks: nothing about the refusal was remembered, so no path can read a
            // cached refusal in place of the check that would have decided. Only a RESOLVED scope is cached,
            // which is what keeps this asymmetry from turning a transient failure into a request-long one.
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

            expect(unfiltered.get(LIST_ID)?.totalItems).toBe(7);
            expect(unfiltered.get(LIST_ID)?.authoritativeTotalItems).toBe(7);
        });

        it('withholds the counter-repair total from a filtered read, whose count is a subset', async () => {
            harness.plan.lineTotals = { [LIST_ID]: 1 };

            const filtered = await service.getLinesForLists(ctx, [LIST_ID], {
                filter: { quantity: { eq: 3 } },
            });

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
        /**
         * The subject of every case below: the row as the single-list read actually hands it over.
         *
         * ★ IT HAS TO COME FROM A READ, and that is the point rather than set-up noise. The repair scopes its
         * write by the provenance recorded against the row when the ownership predicate was applied, so a row
         * built by a bare constructor call has no scope to build a predicate from and is refused. Obtaining the
         * subject the way the api layer obtains it is what makes these cases exercise the shipped path; the
         * recorders are then emptied so every statement counted below belongs to the repair itself.
         */
        async function readList(overrides: Partial<ReorderList> = {}): Promise<ReorderList> {
            harness.plan.listFindOne = rowMatchingPredicate(ownedList(overrides));
            return readThroughSingleListRead();
        }

        /**
         * The same read, but with the double answering REGARDLESS of the predicate the service composed.
         *
         * It exists for one case only: a row whose own `customerId` disagrees with the scope it was recorded
         * under. A predicate-honouring double cannot produce that state — the read would correctly return
         * nothing — so the double has to be made to hand back a row the predicate would have excluded, which is
         * exactly the shape "a row reached this member without passing the predicate" describes.
         */
        async function readListBypassingPredicate(overrides: Partial<ReorderList>): Promise<ReorderList> {
            harness.plan.listFindOne = () => ownedList(overrides);
            return readThroughSingleListRead();
        }

        async function readThroughSingleListRead(): Promise<ReorderList> {
            const list = (await service.getReorderList(ctx, LIST_ID)) as ReorderList;
            expect(list, 'the fixture read must return the row the repair cases operate on').not.toBeNull();
            resetRecorders(harness);
            return list;
        }

        it('issues no statement where the stored value already equals the observed total', async () => {
            const list = await readList();

            const repaired = await service.reconcileLineCount(ctx, list, 4, 4);

            expect(repaired).toBe(4);
            expect(harness.journal).toEqual([]);
        });

        it('issues exactly one guarded update where the two disagree, and reports the observed total', async () => {
            const list = await readList();

            const repaired = await service.reconcileLineCount(ctx, list, 4, 2);

            const updates = statementsOfKind(harness, 'ReorderList', 'update');
            expect(repaired).toBe(2);
            expect(updates).toHaveLength(1);
            expect(updates[0].updateSet).toEqual({ lineCount: 2 });
            expect(conditionTextOf(updates[0])).toContain('id = :id');
            expect(conditionTextOf(updates[0])).toContain('lineCount = :storedLineCount');
            expect(updates[0].parameters.id).toBe(LIST_ID);
            expect(updates[0].parameters.storedLineCount).toBe(4);
        });

        it('scopes that update by the acting customer and the active channel, not by the id alone', async () => {
            const list = await readList();

            await service.reconcileLineCount(ctx, list, 4, 2);

            // ALL FOUR CONJUNCTS, each reached by following the predicate to the value rather than by finding
            // the value in the parameter bag. This is the only production write whose target is chosen by a
            // caller-supplied object, and identifiers are sequential under the default id strategy, so a
            // predicate naming the row and the stale counter alone would let a caller that had lost track of
            // provenance rewrite a neighbouring buyer's counter [FEATURE-001-01:§2.6.1.1].
            const update = statementsOfKind(harness, 'ReorderList', 'update')[0];
            expect(predicateValueFor(update, 'id')).toBe(LIST_ID);
            expect(predicateValueFor(update, 'lineCount')).toBe(4);
            expect(scopeBoundBy(update)).toEqual({ customer: CUSTOMER_ID, channel: CHANNEL_ID });
            // And the four are CONJUNCTS of one statement rather than four statements or an OR of any of them.
            expect(update.conditions).toHaveLength(4);
        });

        it('is idempotent: a second pass over the now-equal values issues nothing', async () => {
            const list = await readList();
            await service.reconcileLineCount(ctx, list, 4, 2);
            const statementsAfterRepair = harness.journal.length;

            const second = await service.reconcileLineCount(ctx, list, 2, 2);

            expect(second).toBe(2);
            expect(harness.journal).toHaveLength(statementsAfterRepair);
        });

        it('reports the column as it now stands where the guarded row no longer matched', async () => {
            // ★ A LOST RACE ESTABLISHES THAT THIS REQUEST DOES NOT KNOW THE COUNTER, so answering with the
            // total it counted before the competing write would publish a number that is neither the stored
            // column nor what the winner committed — and the stored column is the authority. The repair
            // therefore reads the column back, once, under the same ownership conjuncts its update carried.
            // The fixture row stores 0, so that is what a caller must be told.
            const list = await readList();
            harness.plan.listAffected = () => 0;

            const repaired = await service.reconcileLineCount(ctx, list, 4, 2);

            expect(repaired).toBe(0);
            expect(statementsOfKind(harness, 'ReorderList', 'update')).toHaveLength(1);
            expect(loggedDebug.join(' ')).toContain('changed concurrently');

            // ONE re-read, and it is scoped exactly as the write was: the row, the acting customer and the
            // active channel. A read-back naming the identifier alone would answer from a neighbouring
            // buyer's row, identifiers being sequential under the default id strategy.
            const reads = rowLookupsAgainst(harness, 'ReorderList');
            expect(reads).toHaveLength(1);
            expect(reads[0].findOptions?.where).toEqual({
                id: LIST_ID,
                customerId: CUSTOMER_ID,
                channelId: CHANNEL_ID,
            });
        });

        it('falls back to the observed total where the row has left this scope entirely', async () => {
            // The other half of a lost race: the row was deleted, or moved out of scope, in the same window.
            // There is then no stored value to report at all, so the total this request observed is the only
            // answer it has — and it is the one consistent with the page the read is about to return.
            const list = await readList();
            harness.plan.listAffected = () => 0;
            harness.plan.listFindOne = () => null;

            const repaired = await service.reconcileLineCount(ctx, list, 4, 2);

            expect(repaired).toBe(2);
            expect(statementsOfKind(harness, 'ReorderList', 'update')).toHaveLength(1);
            expect(rowLookupsAgainst(harness, 'ReorderList')).toHaveLength(1);
        });

        it.each([
            ['a negative counter', -1],
            ['a fractional counter', 2.5],
            ['a counter beyond the safe integer range', Number.MAX_SAFE_INTEGER + 2],
        ])('fails the request where the row is still there but carries %s', async (_label, storedValue) => {
            // ★ THE THIRD OUTCOME OF A LOST RACE, AND THE ONE THAT MUST NOT ANSWER WITH A NUMBER. The
            // row exists within the owner scope, so there IS a stored value — it simply is not a count.
            // Reporting the observed total here would publish a number that is not the stored column
            // while the stored column exists, silently, which is precisely what the read-back exists to
            // prevent. Nothing this plugin writes can produce such a value (every write is a guarded
            // increment, a guarded decrement or this compare-and-set, and
            // `CHK_reorder_list_line_count_non_negative` refuses a negative wherever TypeORM creates it),
            // so it means something else has written to shared data — reachable on MySQL and MariaDB,
            // where that constraint is discarded (conflict C-E).
            const list = await readList();
            harness.plan.listAffected = () => 0;
            harness.plan.listFindOne = () =>
                ({ id: LIST_ID, lineCount: storedValue }) as unknown as ReorderList;

            const rejection = await captureRejection(() => service.reconcileLineCount(ctx, list, 4, 2));

            expect(rejection).toBeInstanceOf(InternalServerError);
            // The caller-visible message is the module's one generic sentence: it names no column, no
            // value and no table.
            expect((rejection as Error).message).toBe(UNCLASSIFIED_FAILURE_MESSAGE);
            expect((rejection as Error).message).not.toContain(String(storedValue));
            // The diagnostic that names what happened goes to the log, with a correlation id, and it
            // carries no value either. The value assertion is made against the PROSE alone, because the
            // correlation id is a fresh v4 UUID: two of the four digits following its hyphens are fixed by
            // the format and two are free, so it contains the characters "-1" with probability 31/256 —
            // about one line in eight — and asserting over the whole line would fail on the identifier
            // rather than on an echoed value that often. Splitting the two apart is what makes the claim
            // about the value rather than about luck, and the parenthetical is asserted on its own so
            // nothing can hide inside the part that was removed. See {@link splitCorrelationId}.
            expect(loggedErrors).toHaveLength(1);
            const [prose, correlation] = splitCorrelationId(loggedErrors[0].message);
            expect(correlation, 'the diagnostic must carry a correlation id').toMatch(CORRELATION_ID_SHAPE);
            expect(prose).toContain('not a non-negative safe integer');
            expect(prose).not.toContain(String(storedValue));
            expect(loggedErrors[0].context).toBe(loggerCtx);
            // The compare-and-set was attempted and the read-back happened; no second write followed.
            expect(statementsOfKind(harness, 'ReorderList', 'update')).toHaveLength(1);
            expect(rowLookupsAgainst(harness, 'ReorderList')).toHaveLength(1);
        });

        it('refuses to write an observed total that is not a non-negative integer', async () => {
            const list = await readList();

            const negative = await service.reconcileLineCount(ctx, list, 4, -1);
            const fractional = await service.reconcileLineCount(ctx, list, 4, 2.5);

            expect(negative).toBe(4);
            expect(fractional).toBe(4);
            expect(harness.journal).toEqual([]);
            expect(loggedErrors).toHaveLength(2);
            expect(loggedErrors[0].message).toContain('non-negative integer');
            expect(loggedErrors[0].context).toBe(loggerCtx);
        });

        // ★ THE FIVE REFUSALS. Each is a row arriving without provenance this request can stand behind, and
        // each is answered by writing NOTHING — not by writing under the request's own scope, which would be
        // the same defect wearing a predicate. They mirror the `getViewerAccess` refusals exactly, because
        // both members read the same derivation.
        it('refuses a row it never resolved, writing nothing at all', async () => {
            const rejection = await captureRejection(() =>
                service.reconcileLineCount(ctx, ownedList(), 4, 2),
            );

            expect(rejection).toBeInstanceOf(InternalServerError);
            expect((rejection as InternalServerError).message).toBe(UNCLASSIFIED_FAILURE_MESSAGE);
            expect(harness.journal).toEqual([]);
            expect(loggedErrors[0].message).toContain('reconcileLineCount');
        });

        it('refuses even when the two values agree, so the guard holds on every branch', async () => {
            // The agreeing path writes nothing anyway, so this is not about the write — it is about the member
            // refusing to ACT on a row it cannot vouch for, without a branch on which the check is skipped.
            const rejection = await captureRejection(() =>
                service.reconcileLineCount(ctx, ownedList(), 4, 4),
            );

            expect(rejection).toBeInstanceOf(InternalServerError);
            expect(harness.journal).toEqual([]);
        });

        it('refuses a row whose owning customer disagrees with the scope it was read under', async () => {
            const list = await readListBypassingPredicate({ customerId: FOREIGN_CUSTOMER_ID });

            const rejection = await captureRejection(() => service.reconcileLineCount(ctx, list, 4, 2));

            expect(rejection).toBeInstanceOf(InternalServerError);
            expect(harness.journal).toEqual([]);
        });

        it('refuses a row read under one channel when the request now carries another', async () => {
            const list = await readList();

            const rejection = await captureRejection(() =>
                service.reconcileLineCount(createCtx({ channelId: FOREIGN_CHANNEL_ID }), list, 4, 2),
            );

            expect(rejection).toBeInstanceOf(InternalServerError);
            expect(harness.journal).toEqual([]);
        });

        it('refuses to repair for a request carrying no authenticated session', async () => {
            const list = await readList();

            const rejection = await captureRejection(() =>
                service.reconcileLineCount(createCtx({ anonymous: true }), list, 4, 2),
            );

            expect(rejection).toBeInstanceOf(InternalServerError);
            expect(harness.journal).toEqual([]);
        });

        /**
         * ★ THE REFUSAL EVERY OTHER CONJUNCT MISSES: a row read for one buyer, repaired on another buyer's
         * call, in the SAME channel.
         *
         * Take the four checks above away one at a time and this case still passes them all. The scope was
         * recorded, so "never resolved" does not catch it. The row's `customerId` and `channelId` agree with
         * the recording, because they describe the buyer it was genuinely read for. The request's channel is
         * the recorded channel — the assertion below states that explicitly, so the case cannot be mistaken
         * for the channel one. And a session is present, so "no authenticated session" does not catch it
         * either. What is left is a write correctly scoped **to the first buyer** and issued **on the second
         * buyer's call** — which is exactly the shape a caller-supplied row makes reachable, since this member
         * is `public` and a row can be held past its request by a cache or an integration.
         *
         * Comparing the recorded session against the asking one is the only conjunct that can refuse it: the
         * row carries no evidence of who read it, and neither does the channel the two buyers share.
         */
        it('refuses a row recorded under one authenticated session when another session asks, same channel', async () => {
            const list = await readList();
            const secondBuyer = createCtx({ userId: FOREIGN_USER_ID });
            // Stated rather than implied: this is NOT the foreign-channel case wearing a different name.
            expect(
                secondBuyer.channelId,
                'the second session must be in the same channel, or this case proves the channel conjunct instead',
            ).toBe(CHANNEL_ID);

            const rejection = await captureRejection(() =>
                service.reconcileLineCount(secondBuyer, list, 4, 2),
            );

            expect(rejection).toBeInstanceOf(InternalServerError);
            expect((rejection as InternalServerError).message).toBe(UNCLASSIFIED_FAILURE_MESSAGE);
            // No statement of any kind: not the write, and not a lookup that would have disclosed the row.
            expect(harness.journal).toEqual([]);
            expect(loggedErrors[0].message).toContain('reconcileLineCount');
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

        it('refuses a row recorded under one authenticated session when another session asks, same channel', async () => {
            // The mirror of the repair's own version of this case, and it has to be asserted on both members
            // rather than on the shared helper: what is being pinned is that NEITHER public entry point can be
            // reached with a row belonging to a different buyer of the same channel. Describing such a row as
            // OWNED would tell the asking buyer that a list they cannot see is theirs.
            const list = (await service.getReorderList(ctx, LIST_ID)) as ReorderList;
            const secondBuyer = createCtx({ userId: FOREIGN_USER_ID });
            expect(secondBuyer.channelId).toBe(CHANNEL_ID);
            // Emptied so the zero asserted below is this call's own rather than the read's.
            resetRecorders(harness);

            const rejection = captureThrow(() => service.getViewerAccess(secondBuyer, list));

            expect(rejection).toBeInstanceOf(InternalServerError);
            expect((rejection as InternalServerError).message).toBe(UNCLASSIFIED_FAILURE_MESSAGE);
            expect(harness.journal).toEqual([]);
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

    describe('createReorderList and the list bound', () => {
        // A submitted display name and the canonical key the pipeline produces from it, so the name-rule tests
        // below assert against the value the constraint actually compares rather than against the raw input.
        const SUBMITTED_LIST_NAME = '  Pantry   Top-Up  ';
        const CANONICAL_LIST_NAME_KEY = 'pantry top-up';

        it('counts, pre-checks the name and inserts inside one transaction', async () => {
            await service.createReorderList(ctx, { name: 'Pantry' });

            const counts = harness.journal.filter(statement => statement.terminal === 'count');
            const saves = harness.journal.filter(statement => statement.terminal === 'save');
            expect(harness.transactionsOpened).toBe(1);
            // TWO counts, and both are required. One is the list bound's; the other is the advisory name
            // pre-check §2.11 requires the service to perform *and* back with the constraint catch. Everything
            // shares the one transaction, so a bound or a name decided in a transaction the insert did not join
            // would be decided against a state the insert never saw [FEATURE-001-01:§2.11].
            expect(counts).toHaveLength(2);
            expect(saves).toHaveLength(1);
            expect(counts[0].transaction).toBeGreaterThan(0);
            for (const statement of [...counts, ...saves]) {
                expect(statement.transaction).toBe(counts[0].transaction);
            }
        });

        it('scopes the bound count to the acting customer and the active channel', async () => {
            await service.createReorderList(ctx, { name: 'Pantry' });

            const counts = harness.journal.filter(statement => statement.terminal === 'count');
            const boundCounts = counts.filter(
                statement =>
                    !Object.prototype.hasOwnProperty.call(
                        (statement.findOptions?.where ?? {}) as object,
                        'nameKey',
                    ),
            );
            expect(boundCounts).toHaveLength(1);
            expect(boundCounts[0].findOptions?.where).toEqual({
                customerId: CUSTOMER_ID,
                channelId: CHANNEL_ID,
            });
        });

        it('scopes the advisory name pre-check to the acting customer, the active channel and the canonical key', async () => {
            // The pre-check is a question about the caller's OWN rows, so its predicate carries all three
            // conjuncts. Dropping the owner or the channel would let one buyer's name collide with another's,
            // and comparing the display name rather than the canonical key would make the comparison
            // case-sensitive where the contract requires it to be case-insensitive and accent-preserving
            // [FEATURE-001-01:§2.11].
            await service.createReorderList(ctx, { name: SUBMITTED_LIST_NAME });

            const preChecks = harness.journal.filter(
                statement =>
                    statement.terminal === 'count' &&
                    Object.prototype.hasOwnProperty.call(
                        (statement.findOptions?.where ?? {}) as object,
                        'nameKey',
                    ),
            );
            expect(preChecks).toHaveLength(1);
            expect(preChecks[0].findOptions?.where).toEqual({
                customerId: CUSTOMER_ID,
                channelId: CHANNEL_ID,
                nameKey: CANONICAL_LIST_NAME_KEY,
            });
        });

        it('returns ReorderListNameConflictError from the pre-check without attempting an insert', async () => {
            // The advisory layer, answering an ordinary duplicate before a row is written. It carries the
            // caller's own canonical key and nothing about the row that already holds it.
            harness.plan.conflictingNameCount = () => 1;

            const result = await service.createReorderList(ctx, { name: SUBMITTED_LIST_NAME });

            expect(result).toBeInstanceOf(ReorderListNameConflictError);
            expect((result as ReorderListNameConflictError).conflictingNameKey).toBe(CANONICAL_LIST_NAME_KEY);
            expect(harness.journal.some(statement => statement.terminal === 'save')).toBe(false);
        });

        it('consults the list bound before the name, so a full list is refused for the bound it breached', async () => {
            // Both layers would refuse this call, and the order decides which reason the caller is told. The
            // bound is the one that is true of the request as a whole, so it is asked first and the name
            // pre-check is never issued.
            harness.plan.heldListCount = MAX_LISTS_PER_CUSTOMER;
            harness.plan.conflictingNameCount = () => 1;

            const result = await service.createReorderList(ctx, { name: SUBMITTED_LIST_NAME });

            expect(result).toBeInstanceOf(ReorderListLimitError);
            expect(
                harness.journal.some(statement =>
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
                // WHICH rows are locked is the whole of the claim, and a lock mode says nothing about it. All
                // four properties below are load-bearing:
                //  - the projection is the identifier alone, so no personal field of the customer reaches
                //    process memory where it could reach a log line;
                //  - NOTHING is joined, because `pessimistic_write` emits the unqualified `FOR UPDATE` and that
                //    locks a row of every table the statement reads. Joining `customer.user` and filtering on
                //    `user.id` would lock the `User` row too — a row this feature never writes, shared with
                //    authentication, held for the whole of a create. The bound is a lock on
                //    the owning customer and nothing more. `FOR UPDATE OF customer` is not the portable way to
                //    say that: TypeORM raises "Lock tables not supported in selected driver" for the MySQL
                //    family, so a single-table statement is the only form that means the same on all three;
                //  - the predicate names the acting user through the customer table's own foreign-key column,
                //    escaped through the driver — unescaped, PostgreSQL folds the camel case and matches nothing
                //    while sql.js passes — so an arbitrary customer row cannot be selected;
                //  - and it is bound to the ACTING session's user rather than to anything the caller sent,
                //    which is what makes ownership underivable from an argument [FEATURE-001-01:§2.7].
                expect(lockedLookup.selections).toEqual([{ expression: ['customer.id'], alias: undefined }]);
                expect(lockedLookup.joins).toEqual([]);
                expect(lockedLookup.conditions).toEqual([
                    `${escaped('customer')}.${escaped(CUSTOMER_USER_JOIN_COLUMN)} = :userId`,
                ]);
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
                // and both counts must follow it inside the same transaction.
                expect(counts).toHaveLength(2);
                expect(statementsAgainst(harness, 'Customer')).toHaveLength(1);
                expect(harness.journal[0].entity).toBe('Customer');
                expect(harness.journal[0].locks).toEqual(['pessimistic_write']);
                expect(harness.journal[0].transaction).toBeGreaterThan(0);
                expect(firstCountIndex).toBe(1);
                expect(counts[0].transaction).toBe(harness.journal[0].transaction);
            });
        }

        it('locks one table, so no row of the joined user is taken with it', async () => {
            // The reason the statement joins nothing, asserted as the property rather than as the absence of a
            // line of code: TypeORM emits the unqualified `FOR UPDATE` for `pessimistic_write`, which locks a
            // row of EVERY table the statement reads. One table in the statement is therefore the whole of
            // "the owning customer and nothing more" — and it is the portable form, since `FOR UPDATE OF
            // customer` is refused for the MySQL family with "Lock tables not supported in selected driver".
            harness.plan.engine = 'postgres';

            await service.createReorderList(ctx, { name: 'Pantry' });

            const [lockedLookup] = statementsAgainst(harness, 'Customer');
            expect(lockedLookup.joins).toEqual([]);
            expect(lockedLookup.locks).toEqual(['pessimistic_write']);
            // Nothing anywhere in the operation reaches for the `User` entity — not as a repository and not as
            // metadata — so there is no second table for the lock to have covered.
            expect(harness.repositoryRequests).not.toContain('User');
            expect(harness.metadataRequests).not.toContain('User');
        });

        it('reads the locked column from the relation metadata rather than assuming its name', async () => {
            // The column is a join column the core entity declares no property for, so it cannot be resolved
            // the way every other identifier in the service is. It is read from the relation's own metadata,
            // and the escaping is the driver's — unescaped, PostgreSQL folds the camel case and the predicate
            // matches nothing there while passing on sql.js.
            harness.plan.engine = 'postgres';

            await service.createReorderList(ctx, { name: 'Pantry' });

            expect(harness.metadataRequests).toContain('Customer');
            expect(harness.escapedIdentifiers).toContain(CUSTOMER_USER_JOIN_COLUMN);
            const [lockedLookup] = statementsAgainst(harness, 'Customer');
            expect(lockedLookup.conditions).toEqual([
                `${escaped('customer')}.${escaped(CUSTOMER_USER_JOIN_COLUMN)} = :userId`,
            ]);
        });

        for (const [label, joinColumns] of [
            ['no join column', [] as string[]],
            ['two join columns', ['userId', 'legacyUserId']],
        ] as const) {
            it(`refuses rather than locking an arbitrary row where the relation reports ${label}`, async () => {
                // A relation with any other cardinality is a schema this addressed lock cannot express. Guessing
                // would either lock the wrong row or lock none while looking like it had, so the operation fails
                // with the same generic internal message every unclassified failure carries — and writes
                // nothing.
                harness.plan.engine = 'postgres';
                harness.plan.customerUserJoinColumns = [...joinColumns];

                const failure = await captureRejection(() =>
                    service.createReorderList(ctx, { name: 'Pantry' }),
                );

                expect(failure).toBeInstanceOf(InternalServerError);
                expect(String((failure as Error).message)).not.toContain(CUSTOMER_USER_JOIN_COLUMN);
                expect(writeStatements(harness)).toEqual([]);
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

    // The declared option defaults, exercised through the value the PLUGIN resolves rather than through a
    // partial object assembled here.
    //
    // The distinction is the whole point of this block. The service is injected
    // `ResolvedReorderPluginOptions` — every key present, validated in `ReorderPlugin.init()` and
    // re-asserted at application bootstrap rather than per request, frozen —
    // so a service constructed with a partial object could only ever exercise a fallback that production
    // never reaches. Reading `ReorderPlugin.options` instead exercises the one place the five numbers are
    // declared. A default changed in the plugin and not here therefore fails these assertions, which is
    // exactly the coupling a duplicated default destroys.

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
            // Read first, so the subject carries the provenance the repair scopes its write by, and the failure
            // under test is the STATEMENT's rather than the guard's.
            harness.plan.listFindOne = rowMatchingPredicate(ownedList());
            const list = (await service.getReorderList(ctx, LIST_ID)) as ReorderList;
            harness.plan.listAffected = () => {
                throw failure();
            };

            const thrown = await captureRejection(() => service.reconcileLineCount(ctx, list, 4, 2));

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

        it('refuses rather than fails when the locked lookup finds no customer row for the user', async () => {
            // The locked resolver answers the same way as the plain one: a session that is not this
            // feature's buyer is refused, and a refusal is not something the sanitiser sees at all — it is a
            // caller-level outcome carrying no driver text to withhold. Nothing is logged for it either,
            // which is the second half of that distinction.
            harness.plan.customerRow = null;

            const thrown = await captureRejection(() => service.createReorderList(ctx, { name: 'Pantry' }));

            expect(thrown).toBeInstanceOf(ForbiddenError);
            expect(thrown).not.toBeInstanceOf(InternalServerError);
            expect(loggedErrors).toEqual([]);
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

// THE API LAYER'S HALF OF THE SAME RECONCILIATION — WHEN IT HAPPENS, AND WHICH OBJECT IS ELIGIBLE
//
// Everything above pins the SERVICE half of the compare-and-set repair: its guard, its arithmetic and its
// refusal of a value the column may not hold. The section below pins the half the service cannot see —
// WHEN the reconciliation happens relative to GraphQL's own execution, and WHICH parent object is eligible
// for it. Both are api-layer properties, both are invisible in the payload of every request that has
// nothing to repair, and each has one way of being wrong that no payload assertion catches:
//
//   - Performing the reconciliation inside the nested `lines` resolver corrects the row but reports the
//     stale number, because the executor completes an object's fields by walking its selection set
//     synchronously and takes a scalar with no field resolver straight off the source object, awaiting only
//     the promises that walk collected. The request that most needs the corrected value is exactly the one
//     that reports the wrong one.
//
//   - Deciding eligibility from the request context or the row's identifier rather than from the object the
//     single read returned licenses the wrong parent. One document may carry both reads, so an
//     identifier-keyed licence is satisfied by the collection's own entry for the same row and would let it
//     repair; a context-keyed one is absent where a field resolver receives another root's context, and the
//     required repair is then silently skipped.

describe('the lineCount reconciliation as the api layer performs it', () => {
    const RECONCILED_LIST_ID = 'T_1';
    const RECONCILED_CHANNEL_ID = 'T_1';
    const RECONCILED_LINES_PAGE_SIZE = 50;

    const PLUGIN_OPTIONS: ResolvedReorderPluginOptions = {
        maxListsPerCustomer: 25,
        maxLinesPerList: 200,
        maxQuantityPerLine: 999,
        defaultReorderListsPageSize: 25,
        defaultReorderListLinesPageSize: RECONCILED_LINES_PAGE_SIZE,
    };

    /**
     * The subset of `ReorderListService` these resolvers reach, as spies.
     *
     * It is a double rather than the real service because what is under test is the api layer's ordering and
     * eligibility, and a real service would make every assertion below depend on a database. The service's own
     * behaviour is pinned, against its own statement journal, in `reorder-list.service.spec.ts`.
     */
    interface ServiceDouble {
        getReorderList: ReturnType<typeof vi.fn>;
        getLinesForLists: ReturnType<typeof vi.fn>;
        reconcileLineCount: ReturnType<typeof vi.fn>;
        getViewerAccess: ReturnType<typeof vi.fn>;
    }

    function ctxFor(): RequestContext {
        return new RequestContext({
            apiType: 'shop',
            channel: new Channel({ id: RECONCILED_CHANNEL_ID, code: 'default' }),
            session: { user: { id: 'T_2' } } as unknown as RequestContext['session'],
            isAuthorized: true,
            authorizedAsOwnerOnly: true,
        });
    }

    /** A hydrated list row carrying the given stored counter. Each call produces a DISTINCT object. */
    function listRow(lineCount: number, id: string = RECONCILED_LIST_ID): ReorderList {
        return new ReorderList({
            id,
            customerId: 'T_5',
            channelId: RECONCILED_CHANNEL_ID,
            name: 'Weekly',
            nameKey: 'weekly',
            lineCount,
        });
    }

    /**
     * A page of lines as the service publishes it.
     *
     * `authoritativeTotalItems` is present only for an unfiltered request, exactly as the service behaves: a
     * filtered request counts the caller's own subset and so publishes no authoritative total. Passing that
     * faithfully is what lets the filtered cases below assert "no repair" for the reason the service gives rather
     * than for a reason this file invented.
     */
    function linePage(totalItems: number, authoritativeTotalItems?: number): ReorderListLinePage {
        return {
            items: [
                new ReorderListLine({
                    id: 'T_9',
                    reorderListId: RECONCILED_LIST_ID,
                    productVariantId: 'T_3',
                    quantity: 1,
                }),
            ],
            totalItems,
            authoritativeTotalItems,
        };
    }

    /**
     * A `GraphQLResolveInfo` for the FIRST root field of the given document, with its fragments indexed.
     */
    function infoFor(document: string, variableValues: Record<string, unknown> = {}): GraphQLResolveInfo {
        const parsed: DocumentNode = parse(document);
        const operation = parsed.definitions.find(definition => definition.kind === 'OperationDefinition');
        if (!operation || operation.kind !== 'OperationDefinition') {
            throw new Error('The document under test declares no operation');
        }
        const rootField = operation.selectionSet.selections[0];
        if (rootField.kind !== 'Field') {
            throw new Error('The first root selection of the document under test is not a field');
        }
        const fragments: Record<string, FragmentDefinitionNode> = {};
        for (const definition of parsed.definitions) {
            if (definition.kind === 'FragmentDefinition') {
                fragments[definition.name.value] = definition;
            }
        }
        return { fieldNodes: [rootField], fragments, variableValues } as unknown as GraphQLResolveInfo;
    }

    /** The generator-supplied arguments of `ReorderList.lines`, built without spelling a generated input name. */
    function linesArgs(options?: Record<string, unknown>): ReorderListLinesArgs {
        return { options: options as ReorderListLinesArgs['options'] };
    }

    /**
     * Narrows a nullable read to its value, failing the test rather than asserting through a non-null assertion.
     *
     * Every case in this file arranges a list that resolves, so a null here is a defect in the case and is worth
     * saying so out loud.
     */
    function present<T>(value: T | null | undefined): T {
        if (value == null) {
            throw new Error('The single-list read returned nothing, which no case in this file arranges');
        }
        return value;
    }

    /** The method function a decorator wrote its metadata onto, read without holding an unbound method. */
    function methodOf(target: NewableFunction, name: string): object {
        const descriptor = Object.getOwnPropertyDescriptor(target.prototype as object, name);
        if (!descriptor) {
            throw new Error(`${target.name} declares no member named ${name}`);
        }
        return descriptor.value as object;
    }

    /** A fresh service double whose line loads answer with an unfiltered total unless the request narrows. */
    function serviceDoubleFor(row: ReorderList | null): ServiceDouble {
        return {
            getReorderList: vi.fn(() => Promise.resolve(row)),
            getLinesForLists: vi.fn(
                (_ctx: unknown, ids: Array<string | number>, options?: { filter?: unknown }) => {
                    const narrowed = options?.filter != null && Object.keys(options.filter).length > 0;
                    return Promise.resolve(
                        new Map(ids.map(id => [id, linePage(1, narrowed ? undefined : 1)])),
                    );
                },
            ),
            // The second parameter is the LIST ROW rather than its identifier, because the row is what carries
            // the owner provenance the real member scopes its write by. The double asserts that below.
            reconcileLineCount: vi.fn(
                (_ctx: unknown, _list: ReorderList, _stale: unknown, observed: number) =>
                    Promise.resolve(observed),
            ),
            getViewerAccess: vi.fn(() => ({ access: 'OWNED', grantedCapabilities: [] })),
        };
    }

    function shopResolverFor(service: ServiceDouble): ReorderListShopResolver {
        return new ReorderListShopResolver(service as unknown as ReorderListService, PLUGIN_OPTIONS);
    }

    function entityResolverFor(service: ServiceDouble): ReorderListEntityResolver {
        return new ReorderListEntityResolver(
            service as unknown as ReorderListService,
            {} as unknown as ProductVariantService,
            new RequestContextCacheService(),
            PLUGIN_OPTIONS,
        );
    }

    describe('the single-list read reconciles the stored lineCount before the parent is exposed', () => {
        let service: ServiceDouble;
        let shop: ReorderListShopResolver;
        let entity: ReorderListEntityResolver;
        let row: ReorderList;

        beforeEach(() => {
            // Stored 3, observed 1: a counter that disagrees, so every ordering assertion below has something to
            // be wrong about.
            row = listRow(3);
            service = serviceDoubleFor(row);
            shop = shopResolverFor(service);
            entity = entityResolverFor(service);
        });

        it('reports the corrected count on the object it returns, not after a field has resolved', async () => {
            // The canonical document, reaching `lines` through a NESTED fragment spread - the shape this
            // package's own end-to-end read uses, and the one a walk of direct field selections would miss.
            const info = infoFor(`
                query Q($id: ID!) { activeCustomerReorderList(id: $id) { ...ListWithLines } }
                fragment ListWithLines on ReorderList { ...ListFields lines { totalItems items { id } } }
                fragment ListFields on ReorderList { id name lineCount }
            `);

            const returned = present(
                await shop.activeCustomerReorderList(ctxFor(), { id: RECONCILED_LIST_ID }, info),
            );

            // The whole of the ordering requirement: the value a synchronously-read sibling scalar would take off
            // this object is already the corrected one.
            expect(returned).toBe(row);
            expect(returned.lineCount).toBe(1);
            expect(service.reconcileLineCount).toHaveBeenCalledTimes(1);
            expect(service.getLinesForLists).toHaveBeenCalledTimes(1);
            expect(singleListReadMarked(returned)).toBe(true);
            // ★ AND IT HANDED OVER THE ROW OBJECT, not the row's identifier. The service scopes the repair's
            // `WHERE` by the provenance recorded against that object, so a caller passing an id would leave the
            // statement unable to carry the acting customer and the active channel at all — the caller half of
            // the same statement-level ownership rule the service half enforces [FEATURE-001-01:§2.6.1.1].
            const [, subject, stale, observed] = service.reconcileLineCount.mock.calls[0] as [
                unknown,
                ReorderList,
                number,
                number,
            ];
            expect(subject).toBe(row);
            expect(stale).toBe(3);
            expect(observed).toBe(1);
        });

        it('serves the nested field from the page it already read, issuing no second load', async () => {
            const ctx = ctxFor();
            const info = infoFor(
                `query Q($id: ID!) { activeCustomerReorderList(id: $id) { lineCount lines { totalItems } } }`,
            );

            const returned = present(
                await shop.activeCustomerReorderList(ctx, { id: RECONCILED_LIST_ID }, info),
            );
            const page = await entity.lines(ctx, returned, linesArgs());

            expect(page.totalItems).toBe(1);
            expect(service.getLinesForLists).toHaveBeenCalledTimes(1);
            expect(service.reconcileLineCount).toHaveBeenCalledTimes(1);
        });

        it('computes the same window as the field resolver for a document written with variables', async () => {
            const ctx = ctxFor();
            const info = infoFor(
                `query Q($id: ID!, $take: Int, $order: SortOrder) {
                    activeCustomerReorderList(id: $id) {
                        lineCount
                        lines(options: { take: $take, sort: { createdAt: $order } }) { totalItems }
                    }
                }`,
                { id: RECONCILED_LIST_ID, take: 2, order: 'ASC' },
            );

            const returned = present(
                await shop.activeCustomerReorderList(ctx, { id: RECONCILED_LIST_ID }, info),
            );
            await entity.lines(ctx, returned, linesArgs({ take: 2, sort: { createdAt: 'ASC' } }));

            // One load, because both sides rendered the identical window: the argument was read off the document
            // through the request's own variable values rather than reconstructed.
            expect(service.getLinesForLists).toHaveBeenCalledTimes(1);
            expect(service.getLinesForLists.mock.calls[0][2]).toEqual({
                take: 2,
                sort: { createdAt: 'ASC' },
            });
            expect(returned.lineCount).toBe(1);
        });

        it('reads nothing at all when the document selects no lines field', async () => {
            const info = infoFor(`query Q($id: ID!) { activeCustomerReorderList(id: $id) { id lineCount } }`);

            const returned = present(
                await shop.activeCustomerReorderList(ctxFor(), { id: RECONCILED_LIST_ID }, info),
            );

            // No observed total exists for this request, which is the collection read's permanent position: the
            // stored counter is reported exactly as it stands.
            expect(service.getLinesForLists).not.toHaveBeenCalled();
            expect(service.reconcileLineCount).not.toHaveBeenCalled();
            expect(returned.lineCount).toBe(3);
        });

        it('reads nothing when every lines selection narrows the collection', async () => {
            const info = infoFor(`
                query Q($id: ID!) {
                    activeCustomerReorderList(id: $id) {
                        lineCount
                        a: lines(options: { filter: { quantity: { eq: 2 } } }) { totalItems }
                        b: lines(options: { filter: { quantity: { eq: 7 } } }) { totalItems }
                    }
                }
            `);

            const returned = present(
                await shop.activeCustomerReorderList(ctxFor(), { id: RECONCILED_LIST_ID }, info),
            );

            // A filtered total counts the caller's own subset. Writing it into `reorder_list.lineCount` would
            // replace the number the atomic line bound is enforced against with one the caller chose.
            expect(service.getLinesForLists).not.toHaveBeenCalled();
            expect(service.reconcileLineCount).not.toHaveBeenCalled();
            expect(returned.lineCount).toBe(3);
        });

        it('reads nothing for a lines selection the document excluded with @skip', async () => {
            const info = infoFor(
                `query Q($id: ID!, $skip: Boolean!) {
                    activeCustomerReorderList(id: $id) { lineCount lines @skip(if: $skip) { totalItems } }
                }`,
                { id: RECONCILED_LIST_ID, skip: true },
            );

            await shop.activeCustomerReorderList(ctxFor(), { id: RECONCILED_LIST_ID }, info);

            // The field is not part of the request, so reading it would issue two statements nobody asked for and
            // repair from a page the response never carries.
            expect(service.getLinesForLists).not.toHaveBeenCalled();
            expect(service.reconcileLineCount).not.toHaveBeenCalled();
        });

        it('treats a nested member whose variable was not supplied as absent, exactly as the executor does', async () => {
            /*
             * THE OMITTED NESTED VARIABLE, which is the case that separates reading the document from coercing
             * it. `valueFromASTUntyped` keeps a field whose variable was not supplied and gives it the value
             * `undefined`, so `{ filter: { quantity: $unset } }` reads as a filter with ONE key; the executor's
             * own input coercion omits the field, so the argument the field resolver receives is a filter with
             * NONE. Both consequences of that divergence were silent: the request counted as narrowing and lost
             * the reconciliation it was entitled to, and the two spellings rendered to different cache keys so
             * the nested resolver reloaded a page that had already been resolved for it.
             */
            const ctx = ctxFor();
            const info = infoFor(
                `query Q($id: ID!, $unset: Int) {
                    activeCustomerReorderList(id: $id) {
                        lineCount
                        lines(options: { filter: { quantity: $unset } }) { totalItems }
                    }
                }`,
                // `$unset` is deliberately absent from the variable values, which is the whole case.
                { id: RECONCILED_LIST_ID },
            );

            const returned = present(
                await shop.activeCustomerReorderList(ctx, { id: RECONCILED_LIST_ID }, info),
            );

            // The reconciliation happened, and it happened BEFORE the parent was exposed.
            expect(returned).toBe(row);
            expect(returned.lineCount).toBe(1);
            expect(service.reconcileLineCount).toHaveBeenCalledTimes(1);
            // The window the pre-read used is the one the executor produces for the same document: the absent
            // member is gone rather than present-and-undefined.
            expect(service.getLinesForLists).toHaveBeenCalledTimes(1);
            expect(service.getLinesForLists.mock.calls[0][2]).toEqual({
                filter: {},
                take: RECONCILED_LINES_PAGE_SIZE,
            });
            // And because the two agree, the field resolver is served from the cache: exactly ONE line-page
            // load for the whole request.
            const page = await entity.lines(ctx, returned, linesArgs({ filter: {} }));
            expect(page.totalItems).toBe(1);
            expect(service.getLinesForLists).toHaveBeenCalledTimes(1);
        });

        it('still declines to reconcile when a nested filter member really was supplied', async () => {
            /*
             * THE CONTROL FOR THE TWO ABOVE. Stripping an ABSENT member must not turn into stripping a PRESENT
             * one: a filter the caller actually sent still narrows the collection, and a narrowed request has
             * no unfiltered total to reconcile against. Without this case the fix could have been "ignore the
             * filter", which would let a caller's own subset count overwrite the counter the atomic line bound
             * is enforced against.
             */
            const info = infoFor(
                `query Q($id: ID!, $quantity: Int) {
                    activeCustomerReorderList(id: $id) {
                        lineCount
                        lines(options: { filter: { quantity: $quantity } }) { totalItems }
                    }
                }`,
                { id: RECONCILED_LIST_ID, quantity: 2 },
            );

            const returned = present(
                await shop.activeCustomerReorderList(ctxFor(), { id: RECONCILED_LIST_ID }, info),
            );

            expect(service.getLinesForLists).not.toHaveBeenCalled();
            expect(service.reconcileLineCount).not.toHaveBeenCalled();
            expect(returned.lineCount).toBe(3);
        });

        it('fails the request when the counter repair rejects, rather than serving a cached page', async () => {
            /*
             * THE REPAIR REJECTION, which must not be indistinguishable from a failed pre-read. Caching the
             * page BEFORE reconciling and catching both failures in one handler would swallow a rejected
             * compare-and-set: the nested field would be served the cached page and the request would succeed
             * while reporting the counter the code had just established was wrong, with nothing observing the
             * rejection.
             */
            const ctx = ctxFor();
            const info = infoFor(
                `query Q($id: ID!) { activeCustomerReorderList(id: $id) { lineCount lines { totalItems } } }`,
            );
            service.reconcileLineCount.mockRejectedValueOnce(new Error('the counter repair failed'));

            await expect(
                shop.activeCustomerReorderList(ctx, { id: RECONCILED_LIST_ID }, info),
            ).rejects.toThrow('the counter repair failed');

            expect(service.getLinesForLists).toHaveBeenCalledTimes(1);
            expect(service.reconcileLineCount).toHaveBeenCalledTimes(1);
            // And nothing was cached: the nested field resolver has to load the page itself, which is what
            // makes "no successful cached fallback hides it" a fact rather than an intention. Its own repair
            // then surfaces the same one attempt, because a rejected repair is deliberately not retried.
            await expect(entity.lines(ctx, row, linesArgs())).rejects.toThrow('the counter repair failed');
            expect(service.getLinesForLists).toHaveBeenCalledTimes(2);
            expect(service.reconcileLineCount).toHaveBeenCalledTimes(1);
        });

        it('retries a transiently failed pre-resolve and reconciles BEFORE the parent is exposed', async () => {
            /*
             * ★ A REPAIR THAT ARRIVES AFTER THE PARENT IS A REPAIR THAT CANNOT FIX THE ANSWER.
             */
            const ctx = ctxFor();
            const info = infoFor(
                `query Q($id: ID!) { activeCustomerReorderList(id: $id) { lineCount lines { totalItems } } }`,
            );
            service.getLinesForLists.mockRejectedValueOnce(new Error('a transient read failure'));

            const returned = present(
                await shop.activeCustomerReorderList(ctx, { id: RECONCILED_LIST_ID }, info),
            );

            expect(returned).toBe(row);
            expect(service.getLinesForLists).toHaveBeenCalledTimes(2);
            // THE ASSERTION THAT MATTERS, made before `lines` is touched: the counter the response will report is
            // already the observed one, so the repair happened while the parent was still this function's to hold.
            expect(service.reconcileLineCount).toHaveBeenCalledTimes(1);
            expect(returned.lineCount).toBe(1);

            const page = await entity.lines(ctx, returned, linesArgs());
            expect(page.totalItems).toBe(1);
            expect(service.getLinesForLists).toHaveBeenCalledTimes(2);
            expect(service.reconcileLineCount).toHaveBeenCalledTimes(1);
        });

        it('leaves a malformed nested window to the nested field, unretried and unraised', async () => {
            const ctx = ctxFor();
            const info = infoFor(
                `query Q($id: ID!) { activeCustomerReorderList(id: $id) { lineCount lines { totalItems } } }`,
            );
            const refusal = new UserInputError('error.list-query-limit-exceeded' as never);
            service.getLinesForLists.mockRejectedValue(refusal);

            const returned = present(
                await shop.activeCustomerReorderList(ctx, { id: RECONCILED_LIST_ID }, info),
            );

            expect(returned).toBe(row);
            expect(returned.lineCount).toBe(3);
            expect(service.getLinesForLists).toHaveBeenCalledTimes(1);
            // Nothing reconciled and nothing cached, so the nested field reads for itself and meets the same
            // refusal — at its own path, which is the point.
            expect(service.reconcileLineCount).not.toHaveBeenCalled();
            await expect(entity.lines(ctx, returned, linesArgs())).rejects.toBe(refusal);
            expect(service.getLinesForLists).toHaveBeenCalledTimes(2);
        });

        it('fails the read when the pre-resolve cannot be read even on the retry', async () => {
            /*
             * The other side of the same rule. A failure that survives the bounded retry is propagated rather than
             * absorbed: exposing the parent would mean answering with a counter this request was entitled to
             * reconcile and could not, which is the wrong answer dressed as a successful one. What propagates is
             * already sanitised by the service — the same object it raised — so the client receives one top-level
             * `errors` entry carrying no driver text.
             */
            const ctx = ctxFor();
            const info = infoFor(
                `query Q($id: ID!) { activeCustomerReorderList(id: $id) { lineCount lines { totalItems } } }`,
            );
            const sanitised = new Error('An error occurred while reading the reorder list lines');
            service.getLinesForLists.mockRejectedValue(sanitised);

            await expect(shop.activeCustomerReorderList(ctx, { id: RECONCILED_LIST_ID }, info)).rejects.toBe(
                sanitised,
            );

            expect(service.getLinesForLists).toHaveBeenCalledTimes(2);
            // Nothing was repaired and nothing was cached, so no later reader is served a page this request never
            // reconciled.
            expect(service.reconcileLineCount).not.toHaveBeenCalled();
            expect(row.lineCount).toBe(3);
        });
    });

    /*
     * Aliases are what make "does this document narrow the collection" a question about the WHOLE selection set.
     * GraphQL lets one document select `lines` more than once with different arguments, so a filtered occurrence
     * and an unfiltered one can sit side by side. A reconciliation that inspected only the first occurrence would
     * decline a filtered one - correctly, in isolation - and the unfiltered alias behind it would then establish
     * the true total in the field resolver, repairing the row after the executor had already taken `lineCount`.
     * That is the stale-first-response defect reintroduced through an alias, and these are the cases that catch it.
     */
    describe('an unfiltered lines window is found wherever in the selection set it appears', () => {
        let service: ServiceDouble;
        let shop: ReorderListShopResolver;
        let entity: ReorderListEntityResolver;
        let row: ReorderList;

        beforeEach(() => {
            row = listRow(3);
            service = serviceDoubleFor(row);
            shop = shopResolverFor(service);
            entity = entityResolverFor(service);
        });

        it('reconciles from a later unfiltered alias when the FIRST alias is filtered', async () => {
            const info = infoFor(`
                query Q($id: ID!) {
                    activeCustomerReorderList(id: $id) {
                        lineCount
                        filtered: lines(options: { filter: { quantity: { eq: 2 } } }) { totalItems }
                        all: lines { totalItems }
                    }
                }
            `);

            const returned = present(
                await shop.activeCustomerReorderList(ctxFor(), { id: RECONCILED_LIST_ID }, info),
            );

            // The corrected value is on the object BEFORE it is returned, even though the document's first
            // occurrence of `lines` narrows.
            expect(returned.lineCount).toBe(1);
            expect(service.reconcileLineCount).toHaveBeenCalledTimes(1);
            expect(service.getLinesForLists).toHaveBeenCalledTimes(1);
            expect(service.getLinesForLists.mock.calls[0][2]).toEqual({ take: RECONCILED_LINES_PAGE_SIZE });
        });

        it('serves the unfiltered alias from the cache and lets the filtered alias load its own page', async () => {
            const ctx = ctxFor();
            const info = infoFor(`
                query Q($id: ID!) {
                    activeCustomerReorderList(id: $id) {
                        lineCount
                        filtered: lines(options: { filter: { quantity: { eq: 2 } } }) { totalItems }
                        all: lines { totalItems }
                    }
                }
            `);

            const returned = present(
                await shop.activeCustomerReorderList(ctx, { id: RECONCILED_LIST_ID }, info),
            );

            // Asserted BEFORE either field resolves, which is the discriminating observation: a request that
            // reconciled only in the field resolver's fallback would still end up with the corrected value, but not
            // yet - and the executor takes `lineCount` off this object at exactly this point.
            expect(returned.lineCount).toBe(1);
            expect(service.getLinesForLists).toHaveBeenCalledTimes(1);

            const filtered = await entity.lines(
                ctx,
                returned,
                linesArgs({ filter: { quantity: { eq: 2 } } }),
            );
            const all = await entity.lines(ctx, returned, linesArgs());

            expect(filtered.totalItems).toBe(1);
            expect(all.totalItems).toBe(1);
            // Two loads in total: the pre-resolved unfiltered page, plus the filtered alias's own. The unfiltered
            // alias added none, having been served from the cache.
            expect(service.getLinesForLists).toHaveBeenCalledTimes(2);
            // And exactly one compare-and-set for the request: the filtered alias publishes no authoritative
            // total, so it cannot repair, and the unfiltered one was already reconciled before the parent was
            // exposed.
            expect(service.reconcileLineCount).toHaveBeenCalledTimes(1);
            expect(returned.lineCount).toBe(1);
        });

        it('finds an unfiltered alias that a filtered one precedes inside a fragment', async () => {
            const info = infoFor(`
                query Q($id: ID!) { activeCustomerReorderList(id: $id) { ...Windows } }
                fragment Windows on ReorderList {
                    lineCount
                    narrowed: lines(options: { filter: { quantity: { eq: 2 } } }) { totalItems }
                    ...Whole
                }
                fragment Whole on ReorderList { whole: lines { totalItems } }
            `);

            const returned = present(
                await shop.activeCustomerReorderList(ctxFor(), { id: RECONCILED_LIST_ID }, info),
            );

            expect(returned.lineCount).toBe(1);
            expect(service.getLinesForLists).toHaveBeenCalledTimes(1);
            expect(service.getLinesForLists.mock.calls[0][2]).toEqual({ take: RECONCILED_LINES_PAGE_SIZE });
            expect(service.reconcileLineCount).toHaveBeenCalledTimes(1);
        });

        it('finds an unfiltered alias inside an inline fragment behind a filtered one', async () => {
            const info = infoFor(`
                query Q($id: ID!) {
                    activeCustomerReorderList(id: $id) {
                        lineCount
                        narrowed: lines(options: { filterOperator: OR }) { totalItems }
                        ... on ReorderList { whole: lines(options: { take: 5 }) { totalItems } }
                    }
                }
            `);

            const returned = present(
                await shop.activeCustomerReorderList(ctxFor(), { id: RECONCILED_LIST_ID }, info),
            );

            // A `filterOperator` alone counts as narrowing - it can only have been sent to combine filters - so
            // the first occurrence is declined and the inline fragment's window is the one used.
            expect(returned.lineCount).toBe(1);
            expect(service.getLinesForLists).toHaveBeenCalledTimes(1);
            expect(service.getLinesForLists.mock.calls[0][2]).toEqual({ take: 5 });
        });

        it('passes over an unfiltered alias the document skipped and uses the next one', async () => {
            const info = infoFor(
                `query Q($id: ID!, $skip: Boolean!) {
                    activeCustomerReorderList(id: $id) {
                        lineCount
                        hidden: lines(options: { take: 7 }) @skip(if: $skip) { totalItems }
                        shown: lines(options: { take: 9 }) { totalItems }
                    }
                }`,
                { id: RECONCILED_LIST_ID, skip: true },
            );

            const returned = present(
                await shop.activeCustomerReorderList(ctxFor(), { id: RECONCILED_LIST_ID }, info),
            );

            // The skipped occurrence is not part of the request, so its window must not be the one pre-resolved -
            // that would load a page the response never carries and leave the executed alias to repair too late.
            expect(service.getLinesForLists).toHaveBeenCalledTimes(1);
            expect(service.getLinesForLists.mock.calls[0][2]).toEqual({ take: 9 });
            expect(returned.lineCount).toBe(1);
        });

        it('honours @include(if: false) the same way, taking the alias that will actually run', async () => {
            const info = infoFor(
                `query Q($id: ID!, $withNarrowed: Boolean!) {
                    activeCustomerReorderList(id: $id) {
                        lineCount
                        excluded: lines(options: { take: 3 }) @include(if: $withNarrowed) { totalItems }
                        included: lines(options: { take: 4 }) { totalItems }
                    }
                }`,
                { id: RECONCILED_LIST_ID, withNarrowed: false },
            );

            const returned = present(
                await shop.activeCustomerReorderList(ctxFor(), { id: RECONCILED_LIST_ID }, info),
            );

            expect(service.getLinesForLists).toHaveBeenCalledTimes(1);
            expect(service.getLinesForLists.mock.calls[0][2]).toEqual({ take: 4 });
            expect(returned.lineCount).toBe(1);
        });

        it('issues one compare-and-set when two unfiltered aliases ask for different windows', async () => {
            const ctx = ctxFor();
            const info = infoFor(`
                query Q($id: ID!) {
                    activeCustomerReorderList(id: $id) {
                        lineCount
                        first: lines(options: { take: 2 }) { totalItems }
                        second: lines(options: { take: 6 }) { totalItems }
                    }
                }
            `);

            const returned = present(
                await shop.activeCustomerReorderList(ctx, { id: RECONCILED_LIST_ID }, info),
            );
            await entity.lines(ctx, returned, linesArgs({ take: 2 }));
            await entity.lines(ctx, returned, linesArgs({ take: 6 }));

            // Which unfiltered window is chosen cannot change the reconciled value, because every unfiltered
            // window reports the same unfiltered total. The second alias loads its own page and then finds stored
            // and observed already in agreement, so it issues no further statement.
            expect(returned.lineCount).toBe(1);
            expect(service.reconcileLineCount).toHaveBeenCalledTimes(1);
            expect(service.getLinesForLists).toHaveBeenCalledTimes(2);
        });
    });

    describe('eligibility for the repair is decided by object identity', () => {
        let service: ServiceDouble;
        let shop: ReorderListShopResolver;
        let entity: ReorderListEntityResolver;
        let row: ReorderList;

        beforeEach(() => {
            row = listRow(3);
            service = serviceDoubleFor(row);
            shop = shopResolverFor(service);
            entity = entityResolverFor(service);
        });

        it('never licenses or repairs an object the collection read produced', async () => {
            const collectionEntry = listRow(3);

            const page = await entity.lines(ctxFor(), collectionEntry, linesArgs());

            expect(page.totalItems).toBe(1);
            expect(singleListReadMarked(collectionEntry)).toBe(false);
            expect(service.reconcileLineCount).not.toHaveBeenCalled();
            expect(collectionEntry.lineCount).toBe(3);
        });

        it('does not depend on which RequestContext instance the field resolver receives', async () => {
            const rootCtx = ctxFor();
            const fieldCtx = ctxFor();
            // No `lines` selection, so nothing is pre-resolved and the field resolver takes the fallback - the
            // path on which a context-keyed licence would have been looked for and not found.
            const info = infoFor(`query Q($id: ID!) { activeCustomerReorderList(id: $id) { id lineCount } }`);

            const returned = present(
                await shop.activeCustomerReorderList(rootCtx, { id: RECONCILED_LIST_ID }, info),
            );
            await entity.lines(fieldCtx, returned, linesArgs());

            expect(service.reconcileLineCount).toHaveBeenCalledTimes(1);
            expect(returned.lineCount).toBe(1);
        });

        it('issues one compare-and-set for concurrent fallback resolutions of one object', async () => {
            const ctx = ctxFor();
            const info = infoFor(`query Q($id: ID!) { activeCustomerReorderList(id: $id) { id lineCount } }`);
            const returned = present(
                await shop.activeCustomerReorderList(ctx, { id: RECONCILED_LIST_ID }, info),
            );

            await Promise.all([
                entity.lines(ctx, returned, linesArgs()),
                entity.lines(ctx, returned, linesArgs()),
            ]);

            expect(service.reconcileLineCount).toHaveBeenCalledTimes(1);
            expect(returned.lineCount).toBe(1);
        });

        it('carries no licence, gate or cached page from one request into the next', async () => {
            const document = `query Q($id: ID!) { activeCustomerReorderList(id: $id) { lineCount lines { totalItems } } }`;

            const first = listRow(3);
            service.getReorderList.mockResolvedValueOnce(first);
            await shop.activeCustomerReorderList(ctxFor(), { id: RECONCILED_LIST_ID }, infoFor(document));
            expect(first.lineCount).toBe(1);
            expect(service.reconcileLineCount).toHaveBeenCalledTimes(1);

            // Request two: a DIFFERENT object for the same row, now storing the corrected value. It inherits
            // nothing, is reconciled on its own merits, and issues no repair because the counter now agrees.
            const second = listRow(1);
            service.getReorderList.mockResolvedValueOnce(second);
            const returned = present(
                await shop.activeCustomerReorderList(ctxFor(), { id: RECONCILED_LIST_ID }, infoFor(document)),
            );
            expect(returned).toBe(second);
            expect(second.lineCount).toBe(1);
            expect(service.reconcileLineCount).toHaveBeenCalledTimes(1);
            expect(singleListReadMarked(second)).toBe(true);

            // Its nested field is served from ITS OWN pre-resolved page - a third context instance and a
            // different resolver instance, because the cache is keyed on the row object and on nothing else.
            const page = await entityResolverFor(service).lines(ctxFor(), second, linesArgs());
            expect(page.totalItems).toBe(1);
            expect(service.getLinesForLists).toHaveBeenCalledTimes(2);
        });

        it('licenses nothing when the read resolves to null', async () => {
            const nullService = serviceDoubleFor(null);
            const nullShop = shopResolverFor(nullService);
            const info = infoFor(
                `query Q($id: ID!) { activeCustomerReorderList(id: $id) { lineCount lines { totalItems } } }`,
            );

            const returned = await nullShop.activeCustomerReorderList(
                ctxFor(),
                { id: RECONCILED_LIST_ID },
                info,
            );

            expect(returned).toBeNull();
            expect(nullService.getLinesForLists).not.toHaveBeenCalled();
            expect(nullService.reconcileLineCount).not.toHaveBeenCalled();
        });
    });

    describe('the per-page contracts the reconciliation must not have disturbed', () => {
        async function linesForPageOf(size: number): Promise<{ loads: number; repairs: number }> {
            const service = serviceDoubleFor(null);
            const entity = entityResolverFor(service);
            const ctx = ctxFor();
            const parents = Array.from({ length: size }, (_unused, index) =>
                listRow(1, `T_${String(index + 1)}`),
            );

            await Promise.all(parents.map(parent => entity.lines(ctx, parent, linesArgs())));

            return {
                loads: service.getLinesForLists.mock.calls.length,
                repairs: service.reconcileLineCount.mock.calls.length,
            };
        }

        it('loads one page of lines per page of lists, whatever the page holds', async () => {
            const three = await linesForPageOf(3);
            const six = await linesForPageOf(6);

            expect(three.loads).toBe(1);
            expect(six.loads).toBe(1);
            // Equal, not merely small: this is the assertion STORY-001-01-04 makes across a page of three lists
            // and a page of six.
            expect(six.loads).toBe(three.loads);
        });

        it('repairs no counter from the collection path, at either page size', async () => {
            const three = await linesForPageOf(3);
            const six = await linesForPageOf(6);

            expect(three.repairs).toBe(0);
            expect(six.repairs).toBe(0);
        });

        it('resolves viewerAccess without reading anything', () => {
            const service = serviceDoubleFor(null);
            const entity = entityResolverFor(service);

            const access = entity.viewerAccess(ctxFor(), listRow(1));

            expect(access).toEqual({ access: 'OWNED', grantedCapabilities: [] });
            expect(service.getViewerAccess).toHaveBeenCalledTimes(1);
            expect(service.getLinesForLists).not.toHaveBeenCalled();
            expect(service.reconcileLineCount).not.toHaveBeenCalled();
        });
    });

    /*
     * The resolve-info parameter is the one signature change the reconciliation required, and a parameter
     * decorator that landed on the wrong index would bind a resolver's arguments to the wrong values at run time
     * while compiling perfectly. These read the metadata the decorators actually wrote: `@nestjs/common` and
     * `@nestjs/graphql` share one parameter bag, defined on the CLASS and keyed by method name, whose own keys are
     * `<paramtype>:<index>`. The paramtype is a `GqlParamtype` ordinal for the graphql decorators, and a
     * uid-prefixed `__customRouteArgs__` token for anything built with `createParamDecorator` - which is how
     * Vendure's own `@Ctx()` is built.
     */
    describe('the resolver parameter bindings the reconciliation depends on', () => {
        const PARAM_ARGS = '__routeArguments__';
        const RESOLVER_TYPE = 'graphql:resolver_type';
        const RESOLVER_PROPERTY = 'graphql:resolve_property';
        const PARAMTYPE_NAMES: Record<string, string> = {
            '0': 'parent',
            '1': 'context',
            '2': 'info',
            '3': 'args',
        };

        function bindingsOf(target: NewableFunction, method: string): string[] {
            const declared: Record<string, { index: number }> =
                (Reflect.getMetadata(PARAM_ARGS, target, method) as Record<string, { index: number }>) ?? {};
            return Object.entries(declared)
                .sort(([, left], [, right]) => left.index - right.index)
                .map(([key, entry]) => {
                    const paramtype = key.slice(0, key.lastIndexOf(':'));
                    const named = paramtype.includes('__customRouteArgs__')
                        ? 'ctx'
                        : (PARAMTYPE_NAMES[paramtype] ?? paramtype);
                    return `${String(entry.index)}:${named}`;
                });
        }

        it('binds ctx, args and info on the single-list read, in that order', () => {
            expect(bindingsOf(ReorderListShopResolver, 'activeCustomerReorderList')).toEqual([
                '0:ctx',
                '1:args',
                '2:info',
            ]);
            expect(
                Reflect.getMetadata(
                    RESOLVER_TYPE,
                    methodOf(ReorderListShopResolver, 'activeCustomerReorderList'),
                ),
            ).toBe('Query');
        });

        it('leaves the collection read and every mutation on two bindings', () => {
            for (const method of [
                'activeCustomerReorderLists',
                'createReorderList',
                'updateReorderList',
                'deleteReorderList',
                'addItemToReorderList',
                'adjustReorderListLine',
                'removeReorderListLine',
            ]) {
                expect(bindingsOf(ReorderListShopResolver, method)).toEqual(['0:ctx', '1:args']);
            }
            expect(
                Reflect.getMetadata(RESOLVER_TYPE, methodOf(ReorderListShopResolver, 'createReorderList')),
            ).toBe('Mutation');
        });

        it('keeps the entity resolver field bindings, including its second parent type', () => {
            expect(bindingsOf(ReorderListEntityResolver, 'lines')).toEqual(['0:ctx', '1:parent', '2:args']);
            expect(bindingsOf(ReorderListEntityResolver, 'viewerAccess')).toEqual(['0:ctx', '1:parent']);
            expect(bindingsOf(ReorderListEntityResolver, 'productVariant')).toEqual(['0:ctx', '1:parent']);
            expect(
                Reflect.getMetadata(RESOLVER_PROPERTY, methodOf(ReorderListEntityResolver, 'productVariant')),
            ).toBe(true);
            expect(
                Reflect.getMetadata(RESOLVER_TYPE, methodOf(ReorderListEntityResolver, 'productVariant')),
            ).toBe('ReorderListLine');
            expect(Reflect.getMetadata(RESOLVER_TYPE, ReorderListEntityResolver)).toBe('ReorderList');
        });

        it('declares no field resolver for lineCount, which is the stored column', () => {
            expect(Reflect.getMetadata(PARAM_ARGS, ReorderListEntityResolver, 'lineCount')).toBeUndefined();
            expect(Object.getOwnPropertyNames(ReorderListEntityResolver.prototype)).not.toContain(
                'lineCount',
            );
        });
    });
});
