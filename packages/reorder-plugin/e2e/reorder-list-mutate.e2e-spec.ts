/*
 * End-to-end specification for STORY-001-01-03 — the four mutations that keep a saved set current in
 * place: `adjustReorderListLine`, `removeReorderListLine`, `updateReorderList` and `deleteReorderList`.
 *
 * WHAT THIS FILE ASSERTS, AND THE TWO STRUCTURAL CLAIMS IT EXISTS FOR.
 *
 * Beyond the eight criteria and the four scenarios, two claims run through every one of the four
 * operations and are asserted rather than assumed (FEATURE-001-01 §2.11):
 *
 * 1. **Affected-row-count authority.** Each operation is a single conditional statement whose `WHERE`
 *    carries the row's own identifier together with the acting customer and the active channel, and its
 *    affected-row count is the authority on what happened — 1 means applied, 0 means the row was not
 *    there and yields the operation's own not-found member rather than a success. A read-then-write with
 *    no affected-row check is not acceptable, so the assertions below are made against the CAPTURED
 *    STATEMENT TEXT and not only against the response: an implementation that read the row, decided in
 *    TypeScript and then wrote unconditionally fails them.
 * 2. **The same-transaction counter decrement.** `removeReorderListLine` decrements
 *    `reorder_list.lineCount` in the same transaction as the `DELETE`, so the counter and the rows are
 *    never observable disagreeing. Asserted by locating both statements in one capture window, on one
 *    query runner, with no transaction-control statement between them — an assertion that fails if the
 *    decrement is moved outside the transaction.
 */
import { LanguageCode } from '@vendure/common/lib/generated-shop-types';
import {
    ConfigService,
    generateMigration,
    mergeConfig,
    Order,
    OrderLine,
    Permission,
    ProductVariant,
    RequestContext,
    RequestContextService,
    Session,
    SessionService,
    TransactionalConnection,
    VendureConfig,
} from '@vendure/core';
import { createTestEnvironment, E2E_DEFAULT_CHANNEL_TOKEN, SimpleGraphQLClient } from '@vendure/testing';
import fs from 'fs-extra';
import gql from 'graphql-tag';
import os from 'os';
import path from 'path';
import { DataSource, EntityManager, QueryRunner } from 'typeorm';
import type { SqljsConnectionOptions } from 'typeorm/driver/sqljs/SqljsConnectionOptions';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { initialData } from '../../../e2e-common/e2e-initial-data';
import { TEST_SETUP_TIMEOUT_MS, testConfig } from '../../../e2e-common/test-config';
import { ReorderList, ReorderListLine, ReorderPlugin } from '../index';
import { AddReorderLists1786838400000 } from '../src/migrations/1786838400000-add-reorder-lists';
import {
    AdjustReorderListLineResult,
    RemoveReorderListLineResult,
    ReorderListLineNotFoundError,
    ReorderListService,
} from '../src/service/reorder-list.service';

import {
    asShopApiContext,
    BarrierParticipantSpec,
    createTransactionBinder,
    FORCED_INTERLEAVING_ENGINES,
    resolveConfiguredEngine,
    runBarrieredPair,
    runSequentialPair,
    SINGLE_CONNECTION_ENGINES,
    SQLJS_EXCLUSION_REASON,
    supportsForcedInterleaving,
    TransactionBinder,
} from './fixtures/concurrency-barrier';
import {
    canonicaliseCell,
    describeRowDifferences,
    describeSettledOutcomes,
    NO_ROW_DIFFERENCE,
    redactTeardownDiagnostic,
    rethrowRedacted,
    runAllTeardownStages,
} from './fixtures/diagnostic-redaction';
import { committedMigrationApplies } from './fixtures/migration-state';
import {
    CapturedStatement,
    CorrelatedOwnershipRequirement,
    isStatementCountEngine,
    queryCaptureConfig,
    QueryCaptureLogger,
    STATEMENT_COUNT_ENGINE_REASON,
    STATEMENT_COUNT_ENGINES,
    whereMentionsColumns,
    whereRequiresCorrelatedOwnership,
    whereRequiresScopedPredicates,
} from './fixtures/query-capture';
import {
    ADD_ITEM_TO_REORDER_LIST,
    AddItemToReorderListMutation,
    AddItemToReorderListMutationVariables,
    ADJUST_REORDER_LIST_LINE,
    AdjustReorderListLineMutation,
    AdjustReorderListLineMutationVariables,
    CREATE_REORDER_LIST,
    CreateReorderListMutation,
    CreateReorderListMutationVariables,
    DELETE_REORDER_LIST,
    DeleteReorderListMutation,
    DeleteReorderListMutationVariables,
    GET_ACTIVE_CUSTOMER_REORDER_LIST,
    GetActiveCustomerReorderListQuery,
    GetActiveCustomerReorderListQueryVariables,
    REMOVE_REORDER_LIST_LINE,
    RemoveReorderListLineMutation,
    RemoveReorderListLineMutationVariables,
    ReorderApiId,
    UPDATE_REORDER_LIST,
    UpdateReorderListMutation,
    UpdateReorderListMutationVariables,
} from './graphql/reorder-definitions';

/**
 * The quantity ceiling this test deployment is configured with.
 *
 * It is deliberately far below the plugin's declared default of 999 so that AC-2's above-maximum case is
 * reachable with a small, readable number. **Configuring a value for a test deployment is not choosing a
 * product default**: the declared defaults live with the options themselves
 * [packages/reorder-plugin/src/types.ts] and STORY-001-01-01 owns them.
 */
const MAX_QUANTITY_PER_LINE = 10;

const MAX_LINES_PER_LIST = 200;

const MAX_LISTS_PER_CUSTOMER = 25;

/**
 * The suffix that marks the counted form of a claim in a test title, naming the engine it is counted on.
 *
 * ★ The engine named is the one the counted form RUNS ON, taken from the gate's own list, and never the engine
 * the current run happens to use. Interpolating `resolveConfiguredEngine()` here would make the label state the
 * opposite of the truth on every job except the one it is counted on: a MySQL run would print
 * `[counted form, mysql only]` against tests it had just SKIPPED. Reading the label off
 * `STATEMENT_COUNT_ENGINES` also means it cannot drift from the gate it describes.
 */
const COUNTED_FORM = `[counted form, ${STATEMENT_COUNT_ENGINES.join(' / ')} only]`;

const SECOND_CHANNEL_TOKEN = 'reorder-mutate-second-channel';

/** An identifier in the platform's external `T_n` form that no `reorder_list` row can carry. */
const UNKNOWN_LIST_ID = 'T_999999';

/** An identifier in the platform's external `T_n` form that no `reorder_list_line` row can carry. */
const UNKNOWN_LINE_ID = 'T_999999';

/** The two plugin-owned tables this story writes to, child first — the order `afterEach` deletes in. */
const PLUGIN_TABLES_CHILD_FIRST = ['reorder_list_line', 'reorder_list'] as const;

const QUANTITY_MUST_BE_POSITIVE_MESSAGE = 'The quantity for a reorder list line must be a positive integer';

const QUANTITY_ABOVE_MAXIMUM_MESSAGE =
    `The resulting quantity for this reorder list line would exceed the maximum of ` +
    `${String(MAX_QUANTITY_PER_LINE)}`;

/** The resolved English message for a name whose canonical form cannot be stored. */
const NAME_EMPTY_MESSAGE =
    'The reorder list name must be between 1 and 191 characters once surrounding whitespace is removed, ' +
    'and must not contain control or zero-width characters';

const MONETARY_OR_STOCK_FIELD_NAME = /price|currenc|stock|money|amount|saleable|inventory|tax/i;

/** The resolved English message the platform's own `ForbiddenError` carries. */
const FORBIDDEN_MESSAGE = 'You are not currently authorized to perform this action';

// Local documents
//
// Every reorder document comes from `./graphql/reorder-definitions`, which is their single authority — no
// copy of one is inlined here. The documents below address the PLATFORM's own operations, which that
// module does not declare and must not grow to: the customer roster and the second channel this suite
// needs as fixtures, the active order AC-7 and AC-8 assert is untouched, and the runtime introspection
// AC-8 compares against the checked-in snapshot.

/** The seeded customer roster, read once so this suite never hard-codes a generated email address. */
const GET_CUSTOMER_LIST = gql`
    query GetCustomerListForReorderMutate {
        customers(options: { take: 2, sort: { id: ASC } }) {
            totalItems
            items {
                id
                emailAddress
            }
        }
    }
`;

/** The active channel, so the channel identifier the ownership predicate carries is read and not assumed. */
const GET_ACTIVE_CHANNEL = gql`
    query GetActiveChannelForReorderMutate {
        activeChannel {
            id
            code
            token
        }
    }
`;

const CREATE_SECOND_CHANNEL = gql`
    mutation CreateSecondChannelForReorderMutate($input: CreateChannelInput!) {
        createChannel(input: $input) {
            __typename
            ... on Channel {
                id
                code
                token
            }
            ... on ErrorResult {
                errorCode
                message
            }
        }
    }
`;

/**
 * The existing Shop `addItemToOrder` mutation, used only to give the buyer an active order that AC-7 and
 * AC-8 then assert is untouched. **No argument is passed beyond the two the platform declares**, which is
 * itself part of the additive-only claim: this feature registers no custom field, so that operation gains
 * no `customFields` argument.
 */
const ADD_ITEM_TO_ORDER = gql`
    mutation AddItemToOrderForReorderMutate($productVariantId: ID!, $quantity: Int!) {
        addItemToOrder(productVariantId: $productVariantId, quantity: $quantity) {
            __typename
            ... on Order {
                id
                totalQuantity
                lines {
                    id
                    quantity
                }
            }
            ... on ErrorResult {
                errorCode
                message
            }
        }
    }
`;

const GET_ACTIVE_ORDER = gql`
    query GetActiveOrderForReorderMutate {
        activeOrder {
            id
            totalQuantity
            lines {
                id
                quantity
            }
        }
    }
`;

const INTROSPECT_ROOT_TYPE = gql`
    query IntrospectRootTypeForReorderMutate($typeName: String!) {
        __type(name: $typeName) {
            name
            fields(includeDeprecated: true) {
                name
                args {
                    name
                    defaultValue
                    type {
                        ...ReorderMutateTypeRef
                    }
                }
                type {
                    ...ReorderMutateTypeRef
                }
            }
        }
    }
    fragment ReorderMutateTypeRef on __Type {
        kind
        name
        ofType {
            kind
            name
            ofType {
                kind
                name
                ofType {
                    kind
                    name
                }
            }
        }
    }
`;

/**
 * Runtime introspection of one type's own fields or input fields.
 *
 * The currency dimension of STORY-001-01-03 §10 is discharged at the PAYLOAD level rather than by a
 * sentence: none of the four inputs and none of the four results carries a monetary field, a currency code
 * or a stock field, asserted against the running schema for all four operations rather than for one.
 */
const INTROSPECT_TYPE_FIELDS = gql`
    query IntrospectTypeFieldsForReorderMutate($typeName: String!) {
        __type(name: $typeName) {
            name
            kind
            fields(includeDeprecated: true) {
                name
            }
            inputFields {
                name
            }
        }
    }
`;

const INTROSPECT_ENUM = gql`
    query IntrospectEnumForReorderMutate($typeName: String!) {
        __type(name: $typeName) {
            name
            enumValues(includeDeprecated: true) {
                name
            }
        }
    }
`;

// Local result shapes for the platform documents above
//
// Written out rather than generated, for the reason `./graphql/reorder-definitions` records: this
// plugin's types can never appear in the checked-in introspection snapshot, so no generated artefact
// covers a suite that mixes the two. These cover the platform half only.

interface SeededCustomer {
    id: string;
    emailAddress: string;
}

interface GetCustomerListQuery {
    customers: { totalItems: number; items: SeededCustomer[] };
}

interface GetActiveChannelQuery {
    activeChannel: { id: string; code: string; token: string };
}

interface CreateSecondChannelMutation {
    createChannel:
        | { __typename: 'Channel'; id: string; code: string; token: string }
        | { __typename: string; errorCode: string; message: string };
}

/** An active order as both order documents select it. */
interface ActiveOrderShape {
    id: string;
    totalQuantity: number;
    lines: Array<{ id: string; quantity: number }>;
}

interface AddItemToOrderMutation {
    addItemToOrder: ActiveOrderShape | { __typename: string; errorCode: string; message: string };
}

interface GetActiveOrderQuery {
    activeOrder: ActiveOrderShape | null;
}

interface IntrospectedTypeRef {
    kind: string;
    name: string | null;
    ofType?: IntrospectedTypeRef | null;
}

interface IntrospectedArg {
    name: string;
    defaultValue: string | null;
    type: IntrospectedTypeRef;
}

interface IntrospectedField {
    name: string;
    args: IntrospectedArg[];
    type: IntrospectedTypeRef;
}

interface IntrospectRootTypeQuery {
    __type: { name: string; fields: IntrospectedField[] } | null;
}

interface IntrospectEnumQuery {
    __type: { name: string; enumValues: Array<{ name: string }> } | null;
}
interface IntrospectTypeFieldsQuery {
    __type: {
        name: string;
        kind: string;
        fields: Array<{ name: string }> | null;
        inputFields: Array<{ name: string }> | null;
    } | null;
}

/** The shape a GraphQL response carrying top-level errors arrives in, as the shipped client exposes it. */
interface TopLevelErrorResponse {
    errors: Array<{ message: string; path?: readonly string[]; extensions?: { code?: string } }>;
    /**
     * Optional because the three envelopes a refusal can produce are materially different and each assertion
     * names the one it requires: an execution-time refusal of a Non-Null field carries `data` exactly null,
     * whereas a document rejected BEFORE execution begins carries no `data` entry at all.
     */
    data?: Record<string, unknown> | null;
    status: number;
}

interface StoredList {
    id: number | string;
    name: string;
    nameKey: string;
    lineCount: number;
    customerId: number | string;
    channelId: number | string;
}

interface StoredLine {
    id: number | string;
    reorderListId: number | string;
    productVariantId: number | string;
    quantity: number;
}

interface SeededList {
    listId: string;
    lineIds: string[];
}

// The server, the instrument, and the configuration that installs it
//
// `testConfig()` is called HERE, at the top level of this spec file, and never from a helper module: it
// derives its port from the calling file's own index within its own directory listing
// [e2e-common/test-config.ts], so a call made from anywhere else indexes against the wrong directory and
// can collide two suites on one port. `reorder-plugin` carries no base-port entry in that file's own table,
// so the base is the shared fallback of 3250 and the per-file index is what separates the suites in this
// package from one another.

const capture = new QueryCaptureLogger();

// THE SQL.JS SNAPSHOT DIRECTORY, CREATED IDEMPOTENTLY AND AT MODULE SCOPE, FOR TWO SEPARATE REASONS.
//
// The first is a race. The platform's own initializer creates it with a bare, non-recursive `mkdirSync`
// guarded by a preceding `existsSync` (`packages/testing/src/initializers/sqljs-initializer.ts` L31-L35),
// which is a check-then-act race: this package's e2e suites start together, so when the directory is absent —
// as it is on a fresh checkout, and after the operational reset a schema change requires — two of them can
// both observe it missing and the loser fails its `beforeAll` with `EEXIST`. The three server engines use no
// snapshot directory and are unaffected.
//
// The second is ordering. The directory has to exist before `testConfig()` reads the `e2e/` directory index
// it derives this file's port from, which is why the call sits at module scope rather than in `beforeAll`.
// Recursive creation is idempotent, so a directory another suite already made is not an error, and an empty
// directory is not a cached snapshot file — the initializer still synchronises a fresh schema.
fs.mkdirSync(path.join(__dirname, '__data__'), { recursive: true });

const serverConfig = mergeConfig(testConfig(), {
    plugins: [
        ReorderPlugin.init({
            maxListsPerCustomer: MAX_LISTS_PER_CUSTOMER,
            maxLinesPerList: MAX_LINES_PER_LIST,
            maxQuantityPerLine: MAX_QUANTITY_PER_LINE,
            defaultReorderListsPageSize: 25,
            defaultReorderListLinesPageSize: 50,
        }),
    ],
    importExportOptions: {
        // The four enabled variants this story's fixtures reference come from core's own minimal product
        // source, and its assets come from beside it — the shipped precedent being
        // `packages/dashboard/e2e/global-setup.ts`. The harness's own default asset directory points inside
        // this package, where no asset fixture exists or may be added.
        importAssetsDir: path.join(__dirname, '../../core/e2e/fixtures/assets'),
    },
    ...queryCaptureConfig(capture),
});

/**
 * One order a fixture in this file created, together with the exact child rows it brought with it.
 *
 * Both halves are recorded because teardown must remove them in that order — children by identifier, then
 * the parent — rather than letting a parent cascade decide what disappears.
 */
interface TrackedFixtureOrder {
    readonly orderId: number;
    /**
     * The decoded database identifiers of every `OrderLine` the fixture put on it.
     *
     * Mutable, and filled in AFTER the entry joins the ledger, because the order is already committed by
     * the time the fixture can look at it: registering the parent first and the children second is what
     * keeps a failure between the two from leaving teardown knowing about neither. Where it is still empty
     * at teardown, the children are re-queried from the parent.
     */
    lineIds: number[];
}

describe('Reorder list mutations — adjust, remove, rename and delete (STORY-001-01-03)', () => {
    const { server, adminClient, shopClient } = createTestEnvironment(serverConfig);

    let customers: SeededCustomer[] = [];
    /** The active channel's identifier in its external form, read from the server rather than assumed. */
    let activeChannelId = '';
    /** The live data source, for the raw reads every stored-row assertion is made against. */
    let dataSource: DataSource;

    /**
     * The running server's own service instance, resolved from the injector rather than constructed.
     *
     * Used by the forced-interleaving races only, which have to hold the rendezvous inside the real service
     * transaction; every other assertion in this file drives the published mutations over HTTP.
     */
    let reorderListService: ReorderListService;

    /**
     * The verified binding that puts a real service operation on a barrier participant's own transaction.
     *
     * Built once, and `createTransactionBinder` proves the platform honours it before returning — so a
     * mechanism that stopped working fails here, loudly, rather than leaving every race silently unbound.
     */
    let transactionBinder: TransactionBinder;
    /** Temporary directories the empty-generation assertion writes into, removed in `afterEach`. */
    let temporaryDirectories: string[] = [];
    /**
     * Undo actions for core rows a test mutated but did not create, run in `afterEach`.
     *
     * EPIC-001 §11.6.1 requires such a row to be restored in the same hook, because the catalogue the harness
     * populated is shared by every test in the file. A queue rather than an ad-hoc `finally` block, so a test
     * that fails part-way through still leaves the catalogue as it found it.
     */
    let coreRowRestorers: Array<() => Promise<void>> = [];

    /** The identifiers of every order this file's own fixture created, removed in `afterEach`. */
    let ordersToRemove: TrackedFixtureOrder[] = [];

    beforeAll(async () => {
        await server.init({
            initialData,
            productsCsvPath: path.join(__dirname, '../../core/e2e/fixtures/e2e-products-minimal.csv'),
            // Two is the minimum this story needs and therefore the number it asks for: AC-3 requires a
            // SECOND customer owning a list in the same channel.
            customerCount: 2,
        });
        await adminClient.asSuperAdmin();

        const { customers: roster } = await adminClient.query<GetCustomerListQuery>(GET_CUSTOMER_LIST);
        expect(roster.items.length).toBe(2);
        customers = roster.items;

        const { activeChannel } = await adminClient.query<GetActiveChannelQuery>(GET_ACTIVE_CHANNEL);
        expect(activeChannel.token).toBe(E2E_DEFAULT_CHANNEL_TOKEN);
        activeChannelId = activeChannel.id;

        // A SECOND REAL CHANNEL, created through the Admin API and addressed by its own token — never a
        // mutated variable, which is what STORY-001-01-03 §10 requires of the foreign-channel case.
        const { createChannel } = await adminClient.query<CreateSecondChannelMutation>(
            CREATE_SECOND_CHANNEL,
            {
                input: {
                    code: 'reorder-mutate-second-channel',
                    token: SECOND_CHANNEL_TOKEN,
                    defaultLanguageCode: LanguageCode.en,
                    currencyCode: 'GBP',
                    pricesIncludeTax: true,
                    defaultShippingZoneId: 'T_1',
                    defaultTaxZoneId: 'T_1',
                },
            },
        );
        expect(createChannel.__typename).toBe('Channel');

        dataSource = server.app.get(TransactionalConnection).rawConnection;
        reorderListService = server.app.get(ReorderListService);
        transactionBinder = await createTransactionBinder(server.app.get(TransactionalConnection));
    }, TEST_SETUP_TIMEOUT_MS);

    afterAll(async () => {
        // UNCONDITIONALLY, per EPIC-001 §11.6.1: a specification that destroys the server only on its
        // success path leaks a listening port into the next file.
        await server.destroy();
    });

    beforeEach(() => {
        // EPIC-001 §11.6.2's first rule: the captured array is emptied per test, so a count is scoped to
        // one test rather than to a file. Capture itself stays CLOSED here and is opened only immediately
        // around the operation under test, so fixture writes, authentication and cleanup fall outside every
        // number this file asserts.
        capture.reset();
        capture.disable();
    });

    afterEach(async () => {
        // EVERY STAGE RUNS, whatever any of them does, and the failures are reported once at the end.
        //
        // Plugin-owned rows go first, CHILD TABLE BEFORE PARENT so a foreign key is never what fails the
        // cleanup (EPIC-001 §11.6.1, §7.8). Only this suite writes those two tables in this database, so
        // emptying them deletes exactly this test's rows and nothing else. The harness's wholesale table clear
        // is deliberately NOT used: it synchronises the schema and drops the populated catalogue every later
        // test reads.
        const queued = coreRowRestorers.slice().reverse();
        coreRowRestorers = [];
        const directories = temporaryDirectories.slice();
        temporaryDirectories = [];
        await runAllTeardownStages([
            { what: 'plugin rows', run: deleteAllPluginRows },
            { what: 'fixture orders', run: removeTrackedOrders },
            ...queued.map((restore, index) => ({
                what: `core row restorer ${String(queued.length - index)}`,
                run: restore,
            })),
            // ★ AN INDEX, NEVER THE PATH. `stage.what` is reproduced VERBATIM by the teardown aggregator —
            // that is deliberate, because the stage name is this file's own text and is what identifies the
            // step that failed — so anything interpolated into it is published as-is. An absolute temporary
            // directory discloses the layout of whatever machine ran the suite, developer or CI worker, and
            // nothing about the assertion needs it: the path stays in the closure below, where the removal
            // uses it and no log reads it.
            ...directories.map((directory, index) => ({
                what: `temporary directory ${String(index + 1)} of ${String(directories.length)}`,
                run: () => fs.remove(directory),
            })),
            {
                what: 'capture reset',
                run: () => {
                    capture.reset();
                    capture.disable();
                    return Promise.resolve();
                },
            },
        ]);
    });

    // Fixture helpers. Every one of them is a FUNCTION each test calls from its own body — never a
    // leftover a sibling criterion built, which is what lets any test here run alone and the file run in
    // reverse order with the same result (EPIC-001 §11.6.1).

    /**
     * Decodes the platform's external `T_n` identifier to the value the database column actually holds.
     *
     * The e2e harness configures an id strategy that prefixes every identifier with `T_`, so a predicate
     * assertion made against the external form would never match a captured statement. Numeric decoding is
     * what the statement carries — inlined as a literal by the SQLite family and bound as a parameter by the
     * others, both of which the capture helpers resolve.
     */
    function decodeId(externalId: ReorderApiId): number {
        const decoded = Number(String(externalId).replace(/^T_/, ''));
        expect(Number.isInteger(decoded)).toBe(true);
        return decoded;
    }

    async function authenticateAs(customer: SeededCustomer): Promise<void> {
        await shopClient.asUserWithCredentials(customer.emailAddress, 'test');
    }

    /**
     * Seeds one list, optionally with lines, for the given buyer and returns the identifiers.
     */
    async function seedList(
        customer: SeededCustomer,
        name: string,
        lines: Array<{ productVariantId: string; quantity: number }> = [],
    ): Promise<SeededList> {
        await authenticateAs(customer);
        const { createReorderList } = await shopClient.query<
            CreateReorderListMutation,
            CreateReorderListMutationVariables
        >(CREATE_REORDER_LIST, { input: { name } });
        expect(createReorderList.__typename).toBe('ReorderList');
        if (createReorderList.__typename !== 'ReorderList') {
            throw new Error(`Fixture could not create the list "${name}"`);
        }
        const listId = String(createReorderList.id);
        const lineIds: string[] = [];
        for (const line of lines) {
            const { addItemToReorderList } = await shopClient.query<
                AddItemToReorderListMutation,
                AddItemToReorderListMutationVariables
            >(ADD_ITEM_TO_REORDER_LIST, {
                input: {
                    reorderListId: listId,
                    productVariantId: line.productVariantId,
                    quantity: line.quantity,
                },
            });
            if (addItemToReorderList.__typename !== 'ReorderList') {
                throw new Error(`Fixture could not add ${line.productVariantId} to the list "${name}"`);
            }
            const seeded = addItemToReorderList.lines.items.find(
                entry => String(entry.productVariantId) === line.productVariantId,
            );
            expect(seeded).toBeDefined();
            lineIds.push(String(seeded?.id));
        }
        return { listId, lineIds };
    }

    async function readStoredList(externalListId: ReorderApiId): Promise<StoredList | null> {
        const row = await dataSource
            .getRepository(ReorderList)
            .createQueryBuilder('list')
            .where('list.id = :id', { id: decodeId(externalListId) })
            .getOne();
        return row === null
            ? null
            : {
                  id: row.id,
                  name: row.name,
                  nameKey: row.nameKey,
                  lineCount: row.lineCount,
                  customerId: row.customerId,
                  channelId: row.channelId,
              };
    }

    /** Reads every stored line of one list, ordered exactly as the published default sort orders them. */
    async function readStoredLines(externalListId: ReorderApiId): Promise<StoredLine[]> {
        const rows = await dataSource
            .getRepository(ReorderListLine)
            .createQueryBuilder('line')
            .where('line.reorderListId = :listId', { listId: decodeId(externalListId) })
            .orderBy('line.createdAt', 'ASC')
            .addOrderBy('line.id', 'ASC')
            .getMany();
        return rows.map(row => ({
            id: row.id,
            reorderListId: row.reorderListId,
            productVariantId: row.productVariantId,
            quantity: row.quantity,
        }));
    }

    /** Counts the lists one customer holds in one channel, which is the count AC-7 asserts reaches zero. */
    async function countStoredLists(customerId: ReorderApiId, channelId: ReorderApiId): Promise<number> {
        return dataSource
            .getRepository(ReorderList)
            .createQueryBuilder('list')
            .where('list.customerId = :customerId', { customerId: decodeId(customerId) })
            .andWhere('list.channelId = :channelId', { channelId: decodeId(channelId) })
            .getCount();
    }

    /** Empties both plugin tables, child before parent. */
    async function deleteAllPluginRows(): Promise<void> {
        for (const table of PLUGIN_TABLES_CHILD_FIRST) {
            await dataSource.createQueryBuilder().delete().from(table).where('1 = 1').execute();
        }
    }

    /**
     * Replaces the two plugin tables with THE CHECKED-IN MIGRATION'S OWN OUTPUT, on the live connection.
     *
     * **It is available on the generation engine alone**, because the shipped artefact is the migration
     * generator's PostgreSQL output and an emitted migration is bound to the engine it was generated against
     * ({@link committedMigrationApplies} carries the reasoning and the citations). Elsewhere the rebuild is
     * skipped and the caller says what its assertion then rests on; the migration suite is where the shipped
     * file is applied, and `withIsolatedMigrationState` is where another engine's own emission is.
     *
     * @returns Whether the schema underneath is now the migration's own.
     */
    async function rebuildPluginSchemaFromCheckedInMigration(): Promise<boolean> {
        if (!committedMigrationApplies(String(dataSource.options.type))) {
            return false;
        }
        const migration = new AddReorderLists1786838400000();
        const runner = dataSource.createQueryRunner();
        try {
            await migration.down(runner);
            await migration.up(runner);
        } finally {
            await runner.release();
        }
        return true;
    }

    /**
     * The configuration the platform generator runs against, resolved so that the plugin tables in the
     * database it opens are the ones the checked-in migration created.
     *
     * On the server engines the generator's own connection reaches the live database, so the live options are
     * handed over unchanged. On sql.js they do NOT: the initializer points `location` at a snapshot file and
     * disables auto-save once populating is finished, so a second connection loads the SYNCHRONISED snapshot
     * from disk and never observes the live in-memory schema at all. The live database is therefore exported
     * to a scratch file first and the generator pointed at that, so the diff is against the migration's own
     * output on all four engines rather than on three of them.
     */
    async function generatorConfigAgainstMigratedSchema(
        scratchDirectory: string,
    ): Promise<Partial<VendureConfig>> {
        if (dataSource.options.type !== 'sqljs') {
            return serverConfig;
        }
        const snapshot = path.join(scratchDirectory, 'migrated-schema.sqlite');
        await dataSource.sqljsManager.saveDatabase(snapshot);
        return {
            ...serverConfig,
            dbConnectionOptions: {
                ...(serverConfig.dbConnectionOptions as SqljsConnectionOptions),
                location: snapshot,
                autoSave: false,
            },
        };
    }

    /**
     * Captures EVERY COLUMN of one variant's row and queues its exact restoration, with the assertion that it
     * happened, before the caller changes anything.
     *
     * Two weaker forms are ruled out rather than untried. Restoring the whole catalogue in `afterEach` —
     * `UPDATE product_variant SET enabled = true, deletedAt = NULL WHERE 1 = 1` — reaches every row in the
     * database rather than the ones section 7's second scenario touches: a variant the seed had legitimately
     * disabled would be silently enabled, and a defect elsewhere that disabled or soft-deleted a variant it
     * should not have would be quietly repaired between tests instead of failing something. Capturing only
     * `enabled` and `deletedAt` fares no better: the compensating write puts those two back and advances the
     * row's `updatedAt` on its way — restoring the columns under test while changing one that was not, and
     * reporting success either way.
     */
    async function captureVariantAvailability(externalVariantId: string): Promise<void> {
        const variantId = decodeId(externalVariantId);
        const captured = await captureCoreRows('product_variant', 'captured_row.id = :variantId', {
            variantId,
        });
        // A COUNT rather than the array, for the same reason the soft-delete capture is counted: `toHaveLength`
        // prints the received rows on failure, and a captured core row is a value-bearing capture whatever
        // table it came from.
        expect(captured.rows.length, `No product_variant row with id ${String(variantId)} to capture`).toBe(
            1,
        );
    }

    /**
     * Sets one variant's `enabled` flag directly, so §7's scenario can observe a disabled variant.
     *
     * The prior value is captured and its restoration queued BEFORE the change, so an assertion failing
     * anywhere afterwards still leaves the catalogue exactly as it was found.
     */
    async function setVariantEnabled(externalVariantId: string, enabled: boolean): Promise<void> {
        await captureVariantAvailability(externalVariantId);
        const result = await dataSource
            .createQueryBuilder()
            .update(ProductVariant)
            .set({ enabled })
            .where('id = :id', { id: decodeId(externalVariantId) })
            .execute();
        expect(result.affected).toBe(1);
    }

    /** Soft-deletes one variant, which sets a timestamp and leaves the row — and the line — in place. */
    async function softDeleteVariant(externalVariantId: string): Promise<void> {
        await captureVariantAvailability(externalVariantId);
        const result = await dataSource
            .createQueryBuilder()
            .update(ProductVariant)
            .set({ deletedAt: new Date() })
            .where('id = :id', { id: decodeId(externalVariantId) })
            .execute();
        expect(result.affected).toBe(1);
    }

    /**
     * Gives the authenticated buyer an active order holding one line, and returns its recorded total
     * quantity.
     */
    async function recordActiveOrderTotalQuantity(productVariantId: string): Promise<number> {
        const existing = await shopClient.query<GetActiveOrderQuery>(GET_ACTIVE_ORDER);
        if (existing.activeOrder && existing.activeOrder.lines.length > 0) {
            await trackOrderForRemoval(existing.activeOrder.id);
            return existing.activeOrder.totalQuantity;
        }
        const { addItemToOrder } = await trackOrdersCommittedBy(() =>
            shopClient.query<AddItemToOrderMutation>(ADD_ITEM_TO_ORDER, {
                productVariantId,
                quantity: 1,
            }),
        );
        if (!('totalQuantity' in addItemToOrder)) {
            throw new Error(`Fixture could not create an active order: ${JSON.stringify(addItemToOrder)}`);
        }
        await trackOrderForRemoval(addItemToOrder.id);
        return addItemToOrder.totalQuantity;
    }

    /**
     * Puts one order in the cleanup ledger, without asserting anything, and returns its entry.
     *
     * Idempotent by order identifier, and it never downgrades a populated child list to an empty one, so a
     * delta discovery and an explicit registration of the same order agree rather than compete.
     */
    function registerOrderInLedger(orderId: number, lineIds: number[]): TrackedFixtureOrder {
        const existing = ordersToRemove.find(queued => queued.orderId === orderId);
        if (existing !== undefined) {
            if (existing.lineIds.length === 0 && lineIds.length > 0) {
                existing.lineIds = lineIds;
            }
            return existing;
        }
        const created: TrackedFixtureOrder = { orderId, lineIds };
        ordersToRemove.push(created);
        return created;
    }

    /**
     * Runs a fixture step that may commit an order, and registers every order it committed — whatever the
     * step, or anything the caller does with its response, then does.
     *
     * THE WINDOW THIS COVERS. A Shop mutation COMMITS before its response is read, so every step between the
     * commit and the ledger is a place the identifier can be lost: an assertion on `__typename`, a decode of
     * the identifier, a guard on the response shape. A ledger populated from the response therefore cannot
     * see the one case that matters — a committed row whose response the caller rejects — and the order, its
     * lines and the session link pointing at it survive into the next test, where they become that test's
     * baseline. Discovery is a DELTA taken in a `finally`, so no assertion, decode or throw can skip it.
     */
    async function trackOrdersCommittedBy<T>(run: () => Promise<T>): Promise<T> {
        const before = (await dataSource.getRepository(Order).find({ select: { id: true } })).map(row =>
            Number(row.id),
        );
        try {
            return await run();
        } finally {
            const after = await dataSource.getRepository(Order).find({ relations: { lines: true } });
            for (const order of after) {
                const orderId = Number(order.id);
                if (!before.includes(orderId)) {
                    registerOrderInLedger(
                        orderId,
                        (order.lines ?? []).map(line => Number(line.id)),
                    );
                }
            }
        }
    }

    /**
     * Records one order this file's fixture brought into existence, so teardown removes it.
     */
    async function trackOrderForRemoval(externalOrderId: ReorderApiId): Promise<void> {
        const orderId = decodeId(externalOrderId);
        const alreadyTracked = ordersToRemove.find(queued => queued.orderId === orderId);
        if (alreadyTracked !== undefined && alreadyTracked.lineIds.length > 0) {
            return;
        }
        // THE EXACT CHILD ROWS, READ BACK RATHER THAN INFERRED. This fixture is the only thing in the file
        // that creates an order, so every line on the order it just created or reused is one it caused;
        // reading them through the declared `lines` relation records their real identifiers instead of
        // trusting a cascade to find them later. The count is asserted, because a capture that silently
        // recorded nothing would let a teardown that deletes nothing report success.
        const ledgerEntry = registerOrderInLedger(orderId, []);

        const order = await dataSource
            .getRepository(Order)
            .findOne({ where: { id: orderId }, relations: { lines: true } });
        expect(order, `the fixture order ${orderId} is not readable back`).not.toBeNull();
        const lineIds = (order?.lines ?? []).map(line => Number(line.id));
        expect(
            lineIds.length,
            `the fixture order ${orderId} carries no line to track, so cleanup would prove nothing`,
        ).toBeGreaterThan(0);
        ledgerEntry.lineIds = lineIds;
    }

    /**
     * Removes every order this test's fixture created, CHILD ROWS BEFORE PARENT.
     *
     * THE EXACT ROWS, IN THE EXACT ORDER, AND NOT BY CASCADE. `OrderLine.order` does declare
     * `onDelete: 'CASCADE'`, so deleting the parent would take the lines with it — which is precisely why
     * leaning on it proves nothing: a relation later reconfigured to `SET NULL`, or a child this fixture
     * created under a table the cascade does not reach, would leave rows behind and every run would still
     * report a clean teardown. So the tracked line identifiers are deleted FIRST, by identifier, then the
     * session link is cleared — `Session.activeOrder` declares no delete action, so a session still
     * pointing at the order would make the parent delete fail on a foreign key — and only then the exact
     * parent. Each step is then VERIFIED: neither the tracked lines nor the tracked order may survive, and
     * a survivor is raised rather than ignored, which is what makes this cleanup falsifiable.
     */
    async function removeTrackedOrders(): Promise<void> {
        const tracked = ordersToRemove.slice();
        ordersToRemove = [];
        // EACH ENTRY IS ATTEMPTED WHATEVER THE OTHERS DO. One order whose removal throws must not strand the
        // orders queued behind it: the failures are collected and reported once, which is the same discipline
        // the outer teardown runner applies to its stages, applied here to the entries within one stage.
        const failures: string[] = [];
        for (const entry of tracked) {
            try {
                await removeOneTrackedOrder(entry);
            } catch (err: unknown) {
                // MEASURED, NOT REPRODUCED. Removing an order writes across `order`, `order_line` and the
                // buyer's `session` rows, so a driver failure here is a `QueryFailedError` carrying the
                // statement and its bound values — and this aggregate is thrown and printed by the runner.
                // The order identifier is kept, on the same footing as a row id: it is what locates the
                // entry that would not go, and it describes nobody.
                failures.push(`order ${entry.orderId}: ${redactTeardownDiagnostic(err)}`);
            }
        }
        if (failures.length > 0) {
            throw new Error(`tracked fixture orders were not all removed — ${failures.join(' | ')}`);
        }
    }

    /** Removes one ledger entry: its exact child rows first, then the session link, then the exact parent. */
    async function removeOneTrackedOrder(entry: TrackedFixtureOrder): Promise<void> {
        {
            const orderId = entry.orderId;
            // WHERE THE LEDGER CARRIES NO CHILDREN, THEY ARE RE-QUERIED FROM THE PARENT. An entry reaches
            // teardown with an empty list only when the fixture's own inspection did not complete, which is
            // exactly the case cleanup must still handle: the identifiers are recovered here rather than
            // assumed, so a failed setup cannot leave a child row behind.
            const lineIds =
                entry.lineIds.length > 0
                    ? [...entry.lineIds]
                    : (
                          (
                              await dataSource
                                  .getRepository(Order)
                                  .findOne({ where: { id: orderId }, relations: { lines: true } })
                          )?.lines ?? []
                      ).map(line => Number(line.id));
            if (lineIds.length > 0) {
                await dataSource.getRepository(OrderLine).delete([...lineIds]);
                const survivingLines = await dataSource
                    .getRepository(OrderLine)
                    .createQueryBuilder('line')
                    .whereInIds([...lineIds])
                    .getCount();
                if (survivingLines !== 0) {
                    throw new Error(
                        `${survivingLines} of the ${lineIds.length} tracked order line(s) of order ` +
                            `${orderId} survived their own deletion`,
                    );
                }
            }
            await dataSource
                .createQueryBuilder()
                .update(Session)
                .set({ activeOrderId: null })
                .where('activeOrderId = :orderId', { orderId })
                .execute();
            await dataSource.getRepository(Order).delete({ id: orderId });
            const survivingOrder = await dataSource.getRepository(Order).count({ where: { id: orderId } });
            if (survivingOrder !== 0) {
                throw new Error(`the tracked fixture order ${orderId} survived its own deletion`);
            }
        }
    }

    // Exact restoration of the core rows a test changes
    //
    // A core row this suite touches is put back COLUMN FOR COLUMN, and the restoration is then ASSERTED
    // against what was captured. Two mechanisms make that stricter than it first sounds: the compensating
    // write goes through the RAW TABLE rather than the entity manager, so restoring a captured value cannot
    // itself move an entity-managed audit column, and it covers an inserted row and a deleted row alike by
    // deleting or re-inserting as the capture requires. The restoration is then read back and compared for
    // equality, so a column the compensating write missed fails the test rather than leaking into the next.

    /**
     * The inherited audit column every core table carries, named once because the restoration has to re-state
     * it explicitly on every compensating write. See `restoreCoreRowsExactly` for why.
     */
    const UPDATE_DATE_COLUMN = 'updatedAt';

    /** Every column of exactly the rows one predicate names, as they stood before a test changed them. */
    interface CoreRowsCapture {
        /** The table the rows live in, addressed by name so no entity metadata is involved. */
        readonly table: string;
        readonly where: string;
        readonly parameters: Record<string, unknown>;
        readonly rows: Array<Record<string, unknown>>;
    }

    /**
     * One identifier, quoted the way the connected engine quotes identifiers.
     *
     * Taken from the driver rather than hard-coded, because the four engines do not agree — backticks on the
     * MySQL family, double quotes on PostgreSQL and SQLite.
     */
    function quotedIdentifier(identifier: string): string {
        return dataSource.driver.escape(identifier);
    }

    /**
     * Runs ONE statement written with `:named` parameters, translated to the engine's own placeholder syntax.
     */
    async function executeRawStatement(sql: string, parameters: Record<string, unknown>): Promise<void> {
        const [query, bound] = dataSource.driver.escapeQueryWithParameters(sql, parameters, {});
        try {
            await dataSource.query(query, bound);
        } catch (err: unknown) {
            // ★ THE ONE DIAGNOSTIC SINK THAT REDACTING AT THE CALLER CANNOT CLOSE, WHICH IS WHY IT IS CLOSED
            // HERE.
            //
            // Every statement this helper runs binds CAPTURED CELLS: the values a restoration is putting
            // back, which on the soft-delete path are a live buyer's `customer`, `user` and `session` rows —
            // an address, a password hash, an authentication token. TypeORM raises a failure from
            // `dataSource.query` as a `QueryFailedError` that has copied the driver's error ONTO ITSELF, so
            // `query` and `parameters` are its own ENUMERABLE properties: `String(err)` and
            // `JSON.stringify(err)` both publish the statement and every bound value, and so does the runner
            // when it prints an unhandled rejection.
            //
            // A QUEUED restoration runs inside `runAllTeardownStages`, which already measures a failure
            // rather than reproducing it. What that cannot cover is a restoration driven DIRECTLY from a test
            // body, so the functional half can be asserted while the server is still up — those calls sit
            // outside the aggregator and travel straight to the runner. Sanitising HERE covers both, and
            // covers a call added later by someone who never read this comment, which is the only version of
            // this fix that stays true.
            rethrowRedacted('a captured-row restoration statement', err);
        }
    }

    /** Reads every column of every row one predicate names, through the raw table rather than an entity. */
    async function readCoreRows(
        table: string,
        where: string,
        parameters: Record<string, unknown>,
    ): Promise<Array<Record<string, unknown>>> {
        const rows: Array<Record<string, unknown>> = await dataSource
            .createQueryBuilder()
            // The alias is deliberately NOT `row`: `ROW` is a reserved word in MySQL 8, and the alias is
            // emitted UNQUOTED in the projection, so `SELECT row.* FROM …` is a syntax error there while
            // parsing cleanly on the other three engines. Measured, not guessed.
            .select('captured_row.*')
            .from(table, 'captured_row')
            .where(where, parameters)
            .getRawMany();
        return rows.map(row => ({ ...row }));
    }

    /**
     * Captures every column of the rows a predicate names, and QUEUES both their exact restoration and the
     * assertion that it happened — before the caller writes anything.
     */
    async function captureCoreRows(
        table: string,
        where: string,
        parameters: Record<string, unknown>,
    ): Promise<CoreRowsCapture> {
        const rows = await readCoreRows(table, where, parameters);
        for (const row of rows) {
            expect(
                row.id,
                `${table} returned a row with no id, so it could not be restored by identifier`,
            ).toBeDefined();
        }
        const captured: CoreRowsCapture = { table, where, parameters, rows };
        coreRowRestorers.push(async () => {
            await restoreCoreRowsExactly(captured);
            await expectCoreRowsRestored(captured);
        });
        return captured;
    }

    /**
     * Puts the captured rows back exactly: moved columns rewritten, deleted rows re-inserted, added rows
     * removed. Idempotent, so a test may call it mid-way to return to its own starting state and the queued
     * copy can still run afterwards.
     */
    async function restoreCoreRowsExactly(rowsCapture: CoreRowsCapture): Promise<void> {
        const current = await readCoreRows(rowsCapture.table, rowsCapture.where, rowsCapture.parameters);
        const currentById = new Map(current.map(row => [String(row.id), row]));

        for (const captured of rowsCapture.rows) {
            const now = currentById.get(String(captured.id));
            if (now === undefined) {
                const columns = Object.keys(captured);
                const insertBindings: Record<string, unknown> = {};
                columns.forEach((column, index) => {
                    insertBindings[`insertValue${index}`] = captured[column];
                });
                await executeRawStatement(
                    `INSERT INTO ${quotedIdentifier(rowsCapture.table)} ` +
                        `(${columns.map(column => quotedIdentifier(column)).join(', ')}) ` +
                        `VALUES (${columns.map((_, index) => `:insertValue${index}`).join(', ')})`,
                    insertBindings,
                );
                continue;
            }
            const moved = Object.entries(captured).filter(
                ([column, value]) => canonicaliseCell(now[column]) !== canonicaliseCell(value),
            );
            if (moved.length === 0) {
                continue;
            }
            // AND THE UPDATE-DATE COLUMN IS ALWAYS RE-STATED, even when it did not move. On the MySQL family
            // the column is declared `datetime(6) on update CURRENT_TIMESTAMP(6)` — read out of
            // `information_schema.COLUMNS` on the live e2e schema, not inferred — so ANY update that omits it
            // from its SET list is re-timestamped BY THE ENGINE, below TypeORM and below this helper. That was
            // observed: a compensating write that restored only `deletedAt` left `user.updatedAt` moved by
            // 865 milliseconds, because the captured value happened to equal the current one and so was not
            // in `moved` at all.
            if (UPDATE_DATE_COLUMN in captured && !moved.some(([column]) => column === UPDATE_DATE_COLUMN)) {
                moved.push([UPDATE_DATE_COLUMN, captured[UPDATE_DATE_COLUMN]]);
            }
            const updateBindings: Record<string, unknown> = { restoreRowId: captured.id };
            moved.forEach(([, value], index) => {
                updateBindings[`restoreValue${index}`] = value;
            });
            await executeRawStatement(
                `UPDATE ${quotedIdentifier(rowsCapture.table)} SET ` +
                    moved
                        .map(([column], index) => `${quotedIdentifier(column)} = :restoreValue${index}`)
                        .join(', ') +
                    ` WHERE ${quotedIdentifier('id')} = :restoreRowId`,
                updateBindings,
            );
        }

        const capturedIds = new Set(rowsCapture.rows.map(row => String(row.id)));
        for (const row of current) {
            if (capturedIds.has(String(row.id))) {
                continue;
            }
            await executeRawStatement(
                `DELETE FROM ${quotedIdentifier(rowsCapture.table)} ` +
                    `WHERE ${quotedIdentifier('id')} = :addedRowId`,
                { addedRowId: row.id },
            );
        }
    }

    /**
     * Requires the rows the predicate names to equal the capture cell for cell, so restoration is proved.
     *
     * ★ THE COMPARISON IS OVER FULL VALUES; THE ASSERTION IS OVER A REDACTED DESCRIPTION OF THE RESULT. Those
     * are two separate things and an earlier revision conflated them: it rendered every cell of every row
     * into two arrays and handed both to `toEqual`, so a failure printed the arrays — and on the soft-delete
     * path those arrays hold a real `session.token` and the buyer's own contact fields. Comparing here
     * instead, and asserting on the difference DESCRIPTION, keeps the check exactly as strict — every column
     * of every captured row is compared through {@link canonicaliseCell}, a captured row that has gone is
     * reported missing and a row that appeared is reported added — while leaving the assertion's own actual
     * and expected values two short redacted strings that Vitest cannot expand into cell values.
     */
    async function expectCoreRowsRestored(rowsCapture: CoreRowsCapture): Promise<void> {
        const now = await readCoreRows(rowsCapture.table, rowsCapture.where, rowsCapture.parameters);
        const differences = describeRowDifferences(rowsCapture.rows, now);
        expect(
            differences,
            `${rowsCapture.table} was not restored exactly for ${rowsCapture.where}; the difference is ` +
                'reported by row id, column name and value SHAPE only, deliberately — see ' +
                'describeCellForDiagnostic',
        ).toBe(NO_ROW_DIFFERENCE);
        // AND THE ROW COUNT, which the description above already covers through its missing/added entries and
        // which is restated here so a future edit to that description cannot quietly weaken this to a
        // per-column check over a shorter table.
        //
        // Two NUMBERS compared by hand rather than `expect(now).toHaveLength(n)`, because that matcher prints
        // the RECEIVED ARRAY on failure — and on the soft-delete path that array is the buyer's `customer`,
        // `user` and `session` rows, `session.token` included. The numbers say exactly the same thing and
        // cannot be expanded into a cell value.
        if (now.length !== rowsCapture.rows.length) {
            throw new Error(
                `${rowsCapture.table} holds ${String(now.length)} rows for ${rowsCapture.where} where the ` +
                    `capture held ${String(rowsCapture.rows.length)}; the rows themselves are deliberately ` +
                    'not reported',
            );
        }
    }

    /**
     * Runs a request expected to be refused with top-level errors and returns the whole response.
     */
    async function expectTopLevelErrors(run: () => Promise<unknown>): Promise<TopLevelErrorResponse> {
        let response: TopLevelErrorResponse | undefined;
        try {
            const unexpected = await run();
            throw new Error(
                `Expected the request to be refused with a top-level error, but it returned ${JSON.stringify(
                    unexpected,
                )}`,
            );
        } catch (caught: unknown) {
            const thrown = caught as { response?: TopLevelErrorResponse };
            if (!thrown.response || !Array.isArray(thrown.response.errors)) {
                throw caught;
            }
            response = thrown.response;
        }
        return response;
    }

    /**
     * Asserts FEATURE-001-01 §2.6.1.1's refused-write contract over the statements just captured, for a
     * write refused because the addressed LIST is not the caller's in the active channel.
     *
     * `relation` is given as the lower-cased alias and matched case-insensitively, which is what makes ONE
     * assertion correct on every engine: the service reads through a locking query builder aliased
     * `reorderlist` where the engine has a row lock and through the repository's own `ReorderList` alias
     * where it does not.
     */
    function assertRefusedWriteReadOneScopedListRow(addressedListId: ReorderApiId, actingCustomerId: string) {
        const scopedSelects = capture.selectsFor('reorder_list');
        expect(scopedSelects.length, capture.format()).toBe(1);
        expect(
            whereRequiresScopedPredicates(scopedSelects[0], [
                { column: 'id', value: decodeId(addressedListId), relation: 'reorderlist' },
                { column: 'customerId', value: decodeId(actingCustomerId), relation: 'reorderlist' },
                { column: 'channelId', value: decodeId(activeChannelId), relation: 'reorderlist' },
            ]),
            capture.format(),
        ).toBe(true);
        expect(capture.writesFor('reorder_list').length, capture.format()).toBe(0);
        expect(capture.writesFor('reorder_list_line').length, capture.format()).toBe(0);
        expect(capture.count('reorder_list_line'), capture.format()).toBe(0);
        expect(capture.count('reorder_list'), capture.format()).toBe(1);
    }

    describe('AC-1: adjustReorderListLine sets an absolute quantity', () => {
        it('succeeds for a session holding only Permission.Authenticated and stores exactly the submitted quantity', async () => {
            const seeded = await seedList(customers[0], 'Weekly Kitchen Restock', [
                { productVariantId: 'T_1', quantity: 2 },
            ]);
            const lineIdBeforeCall = seeded.lineIds[0];
            const listBeforeCall = await readStoredList(seeded.listId);
            expect(listBeforeCall?.name).toBe('Weekly Kitchen Restock');

            const { adjustReorderListLine } = await shopClient.query<
                AdjustReorderListLineMutation,
                AdjustReorderListLineMutationVariables
            >(ADJUST_REORDER_LIST_LINE, {
                input: { reorderListId: seeded.listId, lineId: lineIdBeforeCall, quantity: 6 },
            });

            // The call SUCCEEDS. The session holds only the single permission the Customer Role is created
            // with and holds `Permission.Owner` under no circumstances — that member is unassignable and
            // internal, so the gate admits on the request context's owner-only marking and the service
            // predicate is the whole of the control. This positive assertion is what would fail if the gate
            // were mistaken for the control.
            expect(adjustReorderListLine.__typename).toBe('ReorderList');
            if (adjustReorderListLine.__typename !== 'ReorderList') {
                throw new Error('adjustReorderListLine did not return a ReorderList');
            }
            expect(adjustReorderListLine.lineCount).toBe(1);
            expect(adjustReorderListLine.lines.totalItems).toBe(1);
            expect(adjustReorderListLine.lines.items.length).toBe(1);

            const [adjustedLine] = adjustReorderListLine.lines.items;
            expect(adjustedLine.quantity).toBe(6);
            expect(String(adjustedLine.id)).toBe(lineIdBeforeCall);
            expect(String(adjustedLine.productVariantId)).toBe('T_1');
            expect(adjustReorderListLine.name).toBe('Weekly Kitchen Restock');

            const storedList = await readStoredList(seeded.listId);
            expect(storedList?.lineCount).toBe(1);
            expect(storedList?.name).toBe('Weekly Kitchen Restock');
            expect(storedList?.nameKey).toBe('weekly kitchen restock');
            const storedLines = await readStoredLines(seeded.listId);
            expect(storedLines.length).toBe(1);
            expect(storedLines[0].quantity).toBe(6);
            expect(String(storedLines[0].id)).toBe(String(decodeId(lineIdBeforeCall)));
        });

        it('returns the same line under a second languageCode, a quantity being an integer and not a translated string', async () => {
            const seeded = await seedList(customers[0], 'Language invariance', [
                { productVariantId: 'T_1', quantity: 2 },
            ]);
            const { adjustReorderListLine } = await shopClient.query<
                AdjustReorderListLineMutation,
                AdjustReorderListLineMutationVariables
            >(ADJUST_REORDER_LIST_LINE, {
                input: { reorderListId: seeded.listId, lineId: seeded.lineIds[0], quantity: 6 },
            });
            if (adjustReorderListLine.__typename !== 'ReorderList') {
                throw new Error('adjustReorderListLine did not return a ReorderList');
            }

            const inChannelDefault = await shopClient.query<
                GetActiveCustomerReorderListQuery,
                GetActiveCustomerReorderListQueryVariables
            >(GET_ACTIVE_CUSTOMER_REORDER_LIST, { id: seeded.listId });
            const inSecondLanguage = await shopClient.query<
                GetActiveCustomerReorderListQuery,
                GetActiveCustomerReorderListQueryVariables
            >(GET_ACTIVE_CUSTOMER_REORDER_LIST, { id: seeded.listId }, { languageCode: LanguageCode.de });

            const defaultLine = inChannelDefault.activeCustomerReorderList?.lines.items[0];
            const secondLanguageLine = inSecondLanguage.activeCustomerReorderList?.lines.items[0];
            expect(defaultLine).toBeDefined();
            expect(secondLanguageLine).toBeDefined();
            expect(String(secondLanguageLine?.id)).toBe(String(defaultLine?.id));
            expect(secondLanguageLine?.quantity).toBe(6);
            expect(String(secondLanguageLine?.productVariantId)).toBe(String(defaultLine?.productVariantId));
            expect(secondLanguageLine?.createdAt).toBe(defaultLine?.createdAt);
            expect(inSecondLanguage.activeCustomerReorderList?.lineCount).toBe(1);
        });

        it('writes no OrderLine row', async () => {
            const seeded = await seedList(customers[0], 'No order leak', [
                { productVariantId: 'T_1', quantity: 2 },
            ]);
            const recordedTotalQuantity = await recordActiveOrderTotalQuantity('T_3');

            const { adjustReorderListLine } = await shopClient.query<
                AdjustReorderListLineMutation,
                AdjustReorderListLineMutationVariables
            >(ADJUST_REORDER_LIST_LINE, {
                input: { reorderListId: seeded.listId, lineId: seeded.lineIds[0], quantity: 6 },
            });
            expect(adjustReorderListLine.__typename).toBe('ReorderList');

            const { activeOrder } = await shopClient.query<GetActiveOrderQuery>(GET_ACTIVE_ORDER);
            expect(activeOrder?.totalQuantity).toBe(recordedTotalQuantity);
        });

        it.skipIf(!isStatementCountEngine())(
            `AC-1 · issues exactly one write, targeting reorder_list_line and never the counter ${COUNTED_FORM}`,
            async () => {
                const seeded = await seedList(customers[0], 'Adjust instrumentation', [
                    { productVariantId: 'T_1', quantity: 2 },
                ]);
                capture.reset();
                const { adjustReorderListLine } = await capture.capture(() =>
                    shopClient.query<AdjustReorderListLineMutation, AdjustReorderListLineMutationVariables>(
                        ADJUST_REORDER_LIST_LINE,
                        { input: { reorderListId: seeded.listId, lineId: seeded.lineIds[0], quantity: 6 } },
                    ),
                );
                expect(adjustReorderListLine.__typename).toBe('ReorderList');

                const lineWrites = capture.writesFor('reorder_list_line');
                expect(lineWrites.length, capture.format()).toBe(1);
                expect(capture.writesFor('reorder_list').length, capture.format()).toBe(0);
                const storedList = await readStoredList(seeded.listId);
                expect(storedList?.lineCount).toBe(1);
            },
        );
    });

    // AC-2 — A zero or negative quantity is refused as a request-level input error
    //
    // The line-count bound is DELIBERATELY not evaluated by this operation: `maxLinesPerList` is
    // evaluated by the add path and explicitly not by an adjustment, because changing the quantity of a
    // line that already exists creates no line and so cannot breach a bound on the NUMBER of lines
    // (FEATURE-001-01 §2.11). No criterion in this story therefore returns `ReorderListLimitError`, and
    // that absence is deliberate rather than an omission.

    describe('AC-2: adjustReorderListLine refuses a quantity it cannot store', () => {
        function expectSingleUserInputError(response: TopLevelErrorResponse, message: string) {
            expect(response.errors.length).toBe(1);
            expect(response.errors[0].extensions?.code).toBe('USER_INPUT_ERROR');
            expect(response.errors[0].message).toBe(message);
            expect(response.data).toBeNull();
        }

        it('refuses a quantity of 0 without treating it as a removal, and writes nothing', async () => {
            const seeded = await seedList(customers[0], 'Zero refusal', [
                { productVariantId: 'T_1', quantity: 2 },
            ]);

            const response = await expectTopLevelErrors(() =>
                shopClient.query<AdjustReorderListLineMutation, AdjustReorderListLineMutationVariables>(
                    ADJUST_REORDER_LIST_LINE,
                    { input: { reorderListId: seeded.listId, lineId: seeded.lineIds[0], quantity: 0 } },
                ),
            );
            expectSingleUserInputError(response, QUANTITY_MUST_BE_POSITIVE_MESSAGE);

            const storedLines = await readStoredLines(seeded.listId);
            expect(storedLines.length).toBe(1);
            expect(storedLines[0].quantity).toBe(2);
            expect((await readStoredList(seeded.listId))?.lineCount).toBe(1);
        });

        it('refuses a quantity of -1 and leaves the line at its exact prior value', async () => {
            const seeded = await seedList(customers[0], 'Negative refusal', [
                { productVariantId: 'T_1', quantity: 2 },
            ]);

            const response = await expectTopLevelErrors(() =>
                shopClient.query<AdjustReorderListLineMutation, AdjustReorderListLineMutationVariables>(
                    ADJUST_REORDER_LIST_LINE,
                    { input: { reorderListId: seeded.listId, lineId: seeded.lineIds[0], quantity: -1 } },
                ),
            );
            expectSingleUserInputError(response, QUANTITY_MUST_BE_POSITIVE_MESSAGE);

            const storedLines = await readStoredLines(seeded.listId);
            expect(storedLines.length).toBe(1);
            expect(storedLines[0].quantity).toBe(2);
        });

        it('refuses a quantity above the configured maximum with its own message key', async () => {
            const seeded = await seedList(customers[0], 'Above maximum refusal', [
                { productVariantId: 'T_1', quantity: 2 },
            ]);

            const response = await expectTopLevelErrors(() =>
                shopClient.query<AdjustReorderListLineMutation, AdjustReorderListLineMutationVariables>(
                    ADJUST_REORDER_LIST_LINE,
                    {
                        input: {
                            reorderListId: seeded.listId,
                            lineId: seeded.lineIds[0],
                            quantity: MAX_QUANTITY_PER_LINE + 1,
                        },
                    },
                ),
            );
            expectSingleUserInputError(response, QUANTITY_ABOVE_MAXIMUM_MESSAGE);

            const storedLines = await readStoredLines(seeded.listId);
            expect(storedLines.length).toBe(1);
            expect(storedLines[0].quantity).toBe(2);
        });

        it('accepts the configured maximum itself, so the bound is inclusive', async () => {
            const seeded = await seedList(customers[0], 'At the maximum', [
                { productVariantId: 'T_1', quantity: 2 },
            ]);
            const { adjustReorderListLine } = await shopClient.query<
                AdjustReorderListLineMutation,
                AdjustReorderListLineMutationVariables
            >(ADJUST_REORDER_LIST_LINE, {
                input: {
                    reorderListId: seeded.listId,
                    lineId: seeded.lineIds[0],
                    quantity: MAX_QUANTITY_PER_LINE,
                },
            });
            if (adjustReorderListLine.__typename !== 'ReorderList') {
                throw new Error('adjustReorderListLine did not return a ReorderList');
            }
            expect(adjustReorderListLine.lines.items[0].quantity).toBe(MAX_QUANTITY_PER_LINE);
        });

        it.skipIf(!isStatementCountEngine())(
            `AC-2 · issues no write at all for a refused quantity ${COUNTED_FORM}`,
            async () => {
                const seeded = await seedList(customers[0], 'Refused quantity instrumentation', [
                    { productVariantId: 'T_1', quantity: 2 },
                ]);
                capture.reset();
                const response = await capture.capture(() =>
                    expectTopLevelErrors(() =>
                        shopClient.query<
                            AdjustReorderListLineMutation,
                            AdjustReorderListLineMutationVariables
                        >(ADJUST_REORDER_LIST_LINE, {
                            input: { reorderListId: seeded.listId, lineId: seeded.lineIds[0], quantity: 0 },
                        }),
                    ),
                );
                expect(response.errors[0].extensions?.code).toBe('USER_INPUT_ERROR');
                expect(capture.writesFor('reorder_list').length, capture.format()).toBe(0);
                expect(capture.writesFor('reorder_list_line').length, capture.format()).toBe(0);
            },
        );
    });

    // AC-3 — A line the caller does not hold returns a not-found result that discloses nothing
    //
    // The two error types are NOT interchangeable and the split is contractual: a line absent from a list
    // the caller DOES own is a different fact from a list the caller does not own, and a client can act on
    // the first by refreshing while the second means the list is not theirs to refresh. What must be
    // indistinguishable is the three ways a LIST can fail to resolve — absent, another customer's, another
    // channel's — because identifiers are sequential under the default strategy and a distinguishable
    // refusal would be an enumeration channel rather than a courtesy.

    describe('AC-3: adjustReorderListLine discloses nothing about a row the caller does not hold', () => {
        it('returns ReorderListLineNotFoundError for a line identifier matching no row on a list the caller does own', async () => {
            const mine = await seedList(customers[0], 'Own list, missing line', [
                { productVariantId: 'T_1', quantity: 2 },
            ]);

            const { adjustReorderListLine } = await shopClient.query<
                AdjustReorderListLineMutation,
                AdjustReorderListLineMutationVariables
            >(ADJUST_REORDER_LIST_LINE, {
                input: { reorderListId: mine.listId, lineId: UNKNOWN_LINE_ID, quantity: 6 },
            });

            expect(adjustReorderListLine).toEqual({
                __typename: 'ReorderListLineNotFoundError',
                errorCode: 'REORDER_LIST_LINE_NOT_FOUND_ERROR',
                message: expect.any(String) as unknown as string,
            });
            const storedLines = await readStoredLines(mine.listId);
            expect(storedLines.length).toBe(1);
            expect(storedLines[0].quantity).toBe(2);
        });

        it('returns an indistinguishable ReorderListNotFoundError for another customer, another channel and an unknown identifier', async () => {
            const theirs = await seedList(customers[1], 'Second customer list', [
                { productVariantId: 'T_1', quantity: 4 },
            ]);
            const theirLineCountBeforeAnyCall = (await readStoredList(theirs.listId))?.lineCount;
            expect(theirLineCountBeforeAnyCall).toBe(1);
            const mine = await seedList(customers[0], 'Acting customer list', [
                { productVariantId: 'T_1', quantity: 2 },
            ]);

            const foreignCustomer = await shopClient.query<
                AdjustReorderListLineMutation,
                AdjustReorderListLineMutationVariables
            >(ADJUST_REORDER_LIST_LINE, {
                input: { reorderListId: theirs.listId, lineId: theirs.lineIds[0], quantity: 6 },
            });

            const unknownIdentifier = await shopClient.query<
                AdjustReorderListLineMutation,
                AdjustReorderListLineMutationVariables
            >(ADJUST_REORDER_LIST_LINE, {
                input: { reorderListId: UNKNOWN_LIST_ID, lineId: UNKNOWN_LINE_ID, quantity: 6 },
            });

            shopClient.setChannelToken(SECOND_CHANNEL_TOKEN);
            let foreignChannel: AdjustReorderListLineMutation['adjustReorderListLine'];
            try {
                const response = await shopClient.query<
                    AdjustReorderListLineMutation,
                    AdjustReorderListLineMutationVariables
                >(ADJUST_REORDER_LIST_LINE, {
                    input: { reorderListId: mine.listId, lineId: mine.lineIds[0], quantity: 6 },
                });
                foreignChannel = response.adjustReorderListLine;
            } finally {
                shopClient.setChannelToken(E2E_DEFAULT_CHANNEL_TOKEN);
            }

            const expected = {
                __typename: 'ReorderListNotFoundError',
                errorCode: 'REORDER_LIST_NOT_FOUND_ERROR',
                message: expect.any(String) as unknown as string,
            };
            expect(foreignCustomer.adjustReorderListLine).toEqual(expected);
            expect(foreignChannel).toEqual(expected);
            expect(unknownIdentifier.adjustReorderListLine).toEqual(expected);
            expect(foreignChannel).toEqual(foreignCustomer.adjustReorderListLine);
            expect(foreignChannel).toEqual(unknownIdentifier.adjustReorderListLine);
            expect(Object.keys(foreignChannel).sort()).toEqual(
                Object.keys(unknownIdentifier.adjustReorderListLine).sort(),
            );

            const theirLinesAfter = await readStoredLines(theirs.listId);
            expect(theirLinesAfter.length).toBe(1);
            expect(theirLinesAfter[0].quantity).toBe(4);
            expect((await readStoredList(theirs.listId))?.lineCount).toBe(theirLineCountBeforeAnyCall);
            const myLinesAfter = await readStoredLines(mine.listId);
            expect(myLinesAfter.length).toBe(1);
            expect(myLinesAfter[0].quantity).toBe(2);
        });

        it.skipIf(!isStatementCountEngine())(
            `AC-3 · reads exactly one scoped row and writes nothing for another customer's list ${COUNTED_FORM}`,
            async () => {
                const theirs = await seedList(customers[1], 'Second customer instrumented list', [
                    { productVariantId: 'T_1', quantity: 4 },
                ]);
                await authenticateAs(customers[0]);

                capture.reset();
                const { adjustReorderListLine } = await capture.capture(() =>
                    shopClient.query<AdjustReorderListLineMutation, AdjustReorderListLineMutationVariables>(
                        ADJUST_REORDER_LIST_LINE,
                        { input: { reorderListId: theirs.listId, lineId: theirs.lineIds[0], quantity: 6 } },
                    ),
                );

                expect(adjustReorderListLine.__typename).toBe('ReorderListNotFoundError');
                assertRefusedWriteReadOneScopedListRow(theirs.listId, customers[0].id);
            },
        );
    });

    // AC-4 — A named line is removed and the line that remains is the one not named
    //
    // The ordering is STATED rather than assumed: the published default sort for lines is ascending by the
    // creation timestamp the base entity supplies, with the identifier appended as the tie-break, so "the
    // first of those two lines" is a fact a test can assert rather than a coincidence of insertion order.

    describe('AC-4: removeReorderListLine removes exactly the line it was given', () => {
        async function seedTwoLineList(): Promise<SeededList> {
            const seeded = await seedList(customers[0], 'Two line list', [
                { productVariantId: 'T_1', quantity: 2 },
                { productVariantId: 'T_2', quantity: 3 },
            ]);
            const storedLines = await readStoredLines(seeded.listId);
            expect(storedLines.length).toBe(2);
            expect(String(storedLines[0].id)).toBe(String(decodeId(seeded.lineIds[0])));
            expect(String(storedLines[1].id)).toBe(String(decodeId(seeded.lineIds[1])));
            return seeded;
        }

        it('leaves the second line, identified by id, variant and quantity, when the first is removed', async () => {
            const seeded = await seedTwoLineList();

            const { removeReorderListLine } = await shopClient.query<
                RemoveReorderListLineMutation,
                RemoveReorderListLineMutationVariables
            >(REMOVE_REORDER_LIST_LINE, {
                input: { reorderListId: seeded.listId, lineId: seeded.lineIds[0] },
            });

            expect(removeReorderListLine.__typename).toBe('ReorderList');
            if (removeReorderListLine.__typename !== 'ReorderList') {
                throw new Error('removeReorderListLine did not return a ReorderList');
            }
            expect(removeReorderListLine.lineCount).toBe(1);
            expect(removeReorderListLine.lines.totalItems).toBe(1);
            expect(removeReorderListLine.lines.items.length).toBe(1);

            const [survivor] = removeReorderListLine.lines.items;
            expect(String(survivor.id)).toBe(seeded.lineIds[1]);
            expect(String(survivor.productVariantId)).toBe('T_2');
            expect(survivor.quantity).toBe(3);
            expect(removeReorderListLine.name).toBe('Two line list');

            const storedLines = await readStoredLines(seeded.listId);
            expect(storedLines.length).toBe(1);
            expect(String(storedLines[0].id)).toBe(String(decodeId(seeded.lineIds[1])));
            expect(storedLines[0].quantity).toBe(3);
            const storedList = await readStoredList(seeded.listId);
            expect(storedList?.lineCount).toBe(1);
            expect(storedList?.name).toBe('Two line list');
        });

        it('deletes and alters no ProductVariant row', async () => {
            const seeded = await seedTwoLineList();
            const variantsBefore = await dataSource
                .getRepository(ProductVariant)
                .createQueryBuilder('variant')
                .select(['variant.id', 'variant.sku', 'variant.enabled', 'variant.deletedAt'])
                .orderBy('variant.id', 'ASC')
                .getMany();

            const { removeReorderListLine } = await shopClient.query<
                RemoveReorderListLineMutation,
                RemoveReorderListLineMutationVariables
            >(REMOVE_REORDER_LIST_LINE, {
                input: { reorderListId: seeded.listId, lineId: seeded.lineIds[0] },
            });
            expect(removeReorderListLine.__typename).toBe('ReorderList');

            const variantsAfter = await dataSource
                .getRepository(ProductVariant)
                .createQueryBuilder('variant')
                .select(['variant.id', 'variant.sku', 'variant.enabled', 'variant.deletedAt'])
                .orderBy('variant.id', 'ASC')
                .getMany();
            expect(variantsAfter.length).toBe(variantsBefore.length);
            expect(variantsAfter.map(variant => ({ ...variant }))).toEqual(
                variantsBefore.map(variant => ({ ...variant })),
            );
        });

        it.skipIf(!isStatementCountEngine())(
            `AC-4 · writes no product_variant row while removing a line ${COUNTED_FORM}`,
            async () => {
                const seeded = await seedTwoLineList();
                capture.reset();
                const { removeReorderListLine } = await capture.capture(() =>
                    shopClient.query<RemoveReorderListLineMutation, RemoveReorderListLineMutationVariables>(
                        REMOVE_REORDER_LIST_LINE,
                        { input: { reorderListId: seeded.listId, lineId: seeded.lineIds[0] } },
                    ),
                );
                expect(removeReorderListLine.__typename).toBe('ReorderList');
                expect(capture.writesFor('product_variant').length, capture.format()).toBe(0);
            },
        );
    });

    // AC-5 — An unauthenticated remove writes nothing, and a second remove of the same line is refused
    //
    // The end state is idempotent while the RESPONSE is not, and the distinction is the point: a caller
    // retrying a removal reaches the same zero-line list either way, so no data is at risk, but a caller
    // who never removed anything and receives a success has been misinformed about a row that was never
    // theirs. That is why a repeated remove is refused rather than reported as a success.

    describe('AC-5: removeReorderListLine refuses an unauthenticated request and a repeat', () => {
        it('refuses the unauthenticated call with exactly one FORBIDDEN entry, no payload and no write', async () => {
            const seeded = await seedList(customers[0], 'Unauthenticated probe', [
                { productVariantId: 'T_1', quantity: 2 },
            ]);
            await shopClient.asAnonymousUser();

            capture.reset();
            const response = await capture.capture(() =>
                expectTopLevelErrors(() =>
                    shopClient.query<RemoveReorderListLineMutation, RemoveReorderListLineMutationVariables>(
                        REMOVE_REORDER_LIST_LINE,
                        { input: { reorderListId: seeded.listId, lineId: seeded.lineIds[0] } },
                    ),
                ),
            );

            // EXACTLY ONE top-level entry, and its code is exactly `FORBIDDEN` — the code the platform's own
            // `ForbiddenError` carries, surfaced through `extensions.code`. Never `UNAUTHORIZED`: that is
            // raised where credentials do not MATCH, whereas an absent session on a permission-gated
            // operation is reported as forbidden.
            expect(response.errors.length).toBe(1);
            expect(response.errors[0].extensions?.code).toBe('FORBIDDEN');
            expect(response.errors[0].message).toBe(FORBIDDEN_MESSAGE);
            expect(response.errors[0].path).toEqual(['removeReorderListLine']);
            // NO PAYLOAD WAS RETURNED. See refinement (R-ii) in this file's header: the field is declared
            // Non-Null, so the error propagates past it to the root and `data` is null WHOLESALE. That is the
            // only envelope this refusal can produce, and it is asserted on its own — a restatement admitting
            // `data: { removeReorderListLine: null }` would also admit a resolver that executed and returned
            // null, which is a different outcome.
            expect(response.data).toBeNull();
            // And the refusal happened before either plugin table was reached at all, which is the one place
            // in this file a claim of ZERO statements is made — the session guard is evaluated before any
            // statement is issued, so this is a path refused before it reached the table rather than a read
            // that discovered a row's absence without asking.
            expect(capture.count('reorder_list'), capture.format()).toBe(0);
            expect(capture.count('reorder_list_line'), capture.format()).toBe(0);

            await authenticateAs(customers[0]);
            const storedLines = await readStoredLines(seeded.listId);
            expect(storedLines.length).toBe(1);
            expect(storedLines[0].quantity).toBe(2);
            expect((await readStoredList(seeded.listId))?.lineCount).toBe(1);
        });

        it("refuses the owner's second remove of the same line with ReorderListLineNotFoundError", async () => {
            const seeded = await seedList(customers[0], 'Repeat remove probe', [
                { productVariantId: 'T_1', quantity: 2 },
            ]);

            const first = await shopClient.query<
                RemoveReorderListLineMutation,
                RemoveReorderListLineMutationVariables
            >(REMOVE_REORDER_LIST_LINE, {
                input: { reorderListId: seeded.listId, lineId: seeded.lineIds[0] },
            });
            expect(first.removeReorderListLine.__typename).toBe('ReorderList');
            if (first.removeReorderListLine.__typename !== 'ReorderList') {
                throw new Error('The first removal did not return a ReorderList');
            }
            expect(first.removeReorderListLine.lineCount).toBe(0);
            expect(first.removeReorderListLine.lines.totalItems).toBe(0);
            expect((await readStoredLines(seeded.listId)).length).toBe(0);
            expect((await readStoredList(seeded.listId))?.lineCount).toBe(0);

            const second = await shopClient.query<
                RemoveReorderListLineMutation,
                RemoveReorderListLineMutationVariables
            >(REMOVE_REORDER_LIST_LINE, {
                input: { reorderListId: seeded.listId, lineId: seeded.lineIds[0] },
            });

            expect(second.removeReorderListLine).toEqual({
                __typename: 'ReorderListLineNotFoundError',
                errorCode: 'REORDER_LIST_LINE_NOT_FOUND_ERROR',
                message: expect.any(String) as unknown as string,
            });
            expect((await readStoredLines(seeded.listId)).length).toBe(0);
            expect((await readStoredList(seeded.listId))?.lineCount).toBe(0);
        });
    });

    // AC-6 — A rename is stored, and a rename onto a name the same customer already holds conflicts
    //
    // Uniqueness is evaluated on the canonical name column this feature stores rather than on a database
    // column collation, so the comparison behaves identically on every engine. The canonical form is the
    // input trimmed, its internal whitespace runs collapsed to one space, normalised to NFC and then
    // lower-cased — so `weekly kitchen restock` collides with `Weekly Kitchen Restock`. Canonicalisation
    // PRESERVES accents, so an accented spelling and its unaccented counterpart remain distinct; that is
    // settled by the feature contract and by the canonicalisation unit spec, and is deliberately not
    // re-asserted numerically here.

    describe('AC-6: updateReorderList renames, conflicts on the canonical name, and refuses a blank one', () => {
        /** Seeds the two lists AC-6 is written against: the second holds the single line. */
        async function seedRenamePair(): Promise<{ first: SeededList; second: SeededList }> {
            const first = await seedList(customers[0], 'Weekly Kitchen Restock');
            const second = await seedList(customers[0], 'Monthly Cleaning', [
                { productVariantId: 'T_1', quantity: 2 },
            ]);
            expect((await readStoredList(first.listId))?.name).toBe('Weekly Kitchen Restock');
            expect((await readStoredList(second.listId))?.name).toBe('Monthly Cleaning');
            return { first, second };
        }

        it('stores the new name and leaves the list line untouched', async () => {
            const { second } = await seedRenamePair();
            const lineBefore = (await readStoredLines(second.listId))[0];

            const { updateReorderList } = await shopClient.query<
                UpdateReorderListMutation,
                UpdateReorderListMutationVariables
            >(UPDATE_REORDER_LIST, { input: { id: second.listId, name: 'Fortnightly Cleaning' } });

            expect(updateReorderList.__typename).toBe('ReorderList');
            if (updateReorderList.__typename !== 'ReorderList') {
                throw new Error('updateReorderList did not return a ReorderList');
            }
            expect(updateReorderList.name).toBe('Fortnightly Cleaning');
            expect(updateReorderList.lineCount).toBe(1);
            expect(updateReorderList.lines.totalItems).toBe(1);
            expect(String(updateReorderList.lines.items[0].id)).toBe(second.lineIds[0]);
            expect(updateReorderList.lines.items[0].quantity).toBe(2);

            const storedList = await readStoredList(second.listId);
            expect(storedList?.name).toBe('Fortnightly Cleaning');
            expect(storedList?.nameKey).toBe('fortnightly cleaning');
            expect(storedList?.lineCount).toBe(1);
            const lineAfter = (await readStoredLines(second.listId))[0];
            expect(lineAfter).toEqual(lineBefore);
        });

        it('returns ReorderListNameConflictError for a name differing only in letter case, and stores nothing', async () => {
            const { first, second } = await seedRenamePair();
            await shopClient.query<UpdateReorderListMutation, UpdateReorderListMutationVariables>(
                UPDATE_REORDER_LIST,
                { input: { id: second.listId, name: 'Fortnightly Cleaning' } },
            );

            const { updateReorderList } = await shopClient.query<
                UpdateReorderListMutation,
                UpdateReorderListMutationVariables
            >(UPDATE_REORDER_LIST, { input: { id: second.listId, name: 'weekly kitchen restock' } });

            expect(updateReorderList.__typename).toBe('ReorderListNameConflictError');
            if (updateReorderList.__typename !== 'ReorderListNameConflictError') {
                throw new Error('updateReorderList did not return a ReorderListNameConflictError');
            }
            expect(updateReorderList.errorCode).toBe('REORDER_LIST_NAME_CONFLICT_ERROR');
            expect(updateReorderList.conflictingNameKey).toBe('weekly kitchen restock');
            expect(updateReorderList.message.length).toBeGreaterThan(0);
            // The API-visible message carries no driver text, no SQL fragment and no constraint name.
            expect(updateReorderList.message).not.toContain('UQ_reorder_list_customer_channel_name_key');
            expect(updateReorderList.message.toUpperCase()).not.toContain('SELECT');
            expect(updateReorderList.message.toUpperCase()).not.toContain('UPDATE');

            expect((await readStoredList(first.listId))?.name).toBe('Weekly Kitchen Restock');
            expect((await readStoredList(second.listId))?.name).toBe('Fortnightly Cleaning');
        });

        it('refuses a whitespace-only new name as a request-level input error and writes nothing', async () => {
            const { second } = await seedRenamePair();

            const response = await expectTopLevelErrors(() =>
                shopClient.query<UpdateReorderListMutation, UpdateReorderListMutationVariables>(
                    UPDATE_REORDER_LIST,
                    { input: { id: second.listId, name: '   \t  ' } },
                ),
            );

            expect(response.errors.length).toBe(1);
            expect(response.errors[0].extensions?.code).toBe('USER_INPUT_ERROR');
            expect(response.errors[0].message).toBe(NAME_EMPTY_MESSAGE);
            expect(response.data).toBeNull();
            expect((await readStoredList(second.listId))?.name).toBe('Monthly Cleaning');
            expect((await readStoredList(second.listId))?.nameKey).toBe('monthly cleaning');
        });

        it.skipIf(!isStatementCountEngine())(
            `AC-6 · a rename writes no line row and only reads the page its own payload asks for ${COUNTED_FORM}`,
            async () => {
                const { second } = await seedRenamePair();
                capture.reset();
                const { updateReorderList } = await capture.capture(() =>
                    shopClient.query<UpdateReorderListMutation, UpdateReorderListMutationVariables>(
                        UPDATE_REORDER_LIST,
                        { input: { id: second.listId, name: 'Fortnightly Cleaning' } },
                    ),
                );
                expect(updateReorderList.__typename).toBe('ReorderList');

                // REFINEMENT (R-i), stated in full in this file's header. The rename path writes exactly one
                // row and it is the LIST row; the filter named here is `reorder_list_line`, and the two
                // equalities below are what "a rename reads and writes no line row" means for a published
                // payload that carries the list's own `lines` page:
                //
                //   - zero WRITE statements whose target is `reorder_list_line`; and
                //   - every statement against that table being a `SELECT`, so nothing on this path mutated a
                //     line row under any shape.
                expect(capture.writesFor('reorder_list_line').length, capture.format()).toBe(0);
                const lineStatements = capture.forTables('reorder_list_line');
                expect(
                    lineStatements.map(statement => statement.kind),
                    capture.format(),
                ).toEqual(lineStatements.map(() => 'select'));
                const listWrites = capture.writesFor('reorder_list');
                expect(listWrites.length, capture.format()).toBe(1);
                expect(listWrites[0].kind, capture.format()).toBe('update');
            },
        );
    });

    // AC-7 — A deleted list takes its lines with it in one transaction, and a repeat delete is refused
    //
    // The cascade is asserted by COUNTING ROWS rather than by naming a database clause: a criterion that
    // asserted the clause would test the migration's text, whereas a row count fails whether the cause is
    // a missing clause, a service that deletes the parent and abandons the children, or a transaction that
    // commits half the work.

    describe('AC-7: deleteReorderList removes the list and its lines, and refuses a repeat', () => {
        it('returns a DeletionResponse, leaves zero lines and zero lists, and refuses the second call', async () => {
            const seeded = await seedList(customers[0], 'Delete with lines', [
                { productVariantId: 'T_1', quantity: 2 },
                { productVariantId: 'T_2', quantity: 3 },
            ]);
            expect((await readStoredLines(seeded.listId)).length).toBe(2);
            const recordedTotalQuantity = await recordActiveOrderTotalQuantity('T_3');

            const first = await shopClient.query<
                DeleteReorderListMutation,
                DeleteReorderListMutationVariables
            >(DELETE_REORDER_LIST, { id: seeded.listId });

            // The platform's OWN `DeletionResponse`, reused verbatim rather than replaced by a plugin-owned
            // deletion payload. Its `message` is nullable and is selected under the alias the shared document
            // applies, because the two union members declare `message` at different nullabilities and
            // selecting both under one response key would make the document invalid.
            expect(first.deleteReorderList.__typename).toBe('DeletionResponse');
            if (first.deleteReorderList.__typename !== 'DeletionResponse') {
                throw new Error('deleteReorderList did not return a DeletionResponse');
            }
            expect(first.deleteReorderList.result).toBe('DELETED');
            expect(first.deleteReorderList.deletionMessage ?? null).toBeNull();

            expect((await readStoredLines(seeded.listId)).length).toBe(0);
            expect(await countStoredLists(customers[0].id, activeChannelId)).toBe(0);
            expect(await readStoredList(seeded.listId)).toBeNull();

            const second = await shopClient.query<
                DeleteReorderListMutation,
                DeleteReorderListMutationVariables
            >(DELETE_REORDER_LIST, { id: seeded.listId });
            expect(second.deleteReorderList).toEqual({
                __typename: 'ReorderListNotFoundError',
                errorCode: 'REORDER_LIST_NOT_FOUND_ERROR',
                message: expect.any(String) as unknown as string,
            });
            expect((await readStoredLines(seeded.listId)).length).toBe(0);
            expect(await countStoredLists(customers[0].id, activeChannelId)).toBe(0);

            const { activeOrder } = await shopClient.query<GetActiveOrderQuery>(GET_ACTIVE_ORDER);
            expect(activeOrder?.totalQuantity).toBe(recordedTotalQuantity);
        });

        it.skipIf(!isStatementCountEngine())(
            `AC-7 · deletes the parent in one statement, writes no line row and no order row ${COUNTED_FORM}`,
            async () => {
                const seeded = await seedList(customers[0], 'Delete instrumentation', [
                    { productVariantId: 'T_1', quantity: 2 },
                    { productVariantId: 'T_2', quantity: 3 },
                ]);
                await recordActiveOrderTotalQuantity('T_3');

                capture.reset();
                const { deleteReorderList } = await capture.capture(() =>
                    shopClient.query<DeleteReorderListMutation, DeleteReorderListMutationVariables>(
                        DELETE_REORDER_LIST,
                        { id: seeded.listId },
                    ),
                );
                expect(deleteReorderList.__typename).toBe('DeletionResponse');

                // ONE conditional `DELETE`, against the PARENT, and nothing loops over the lines: they go
                // through the declared cascade, which is the engine's work and issues no statement of its own.
                const listWrites = capture.writesFor('reorder_list');
                expect(listWrites.length, capture.format()).toBe(1);
                expect(listWrites[0].kind, capture.format()).toBe('delete');
                expect(capture.writesFor('reorder_list_line').length, capture.format()).toBe(0);
                expect(listWrites[0].inTransaction, capture.format()).toBe(true);
                expect(capture.writesFor('order').length, capture.format()).toBe(0);
                expect(capture.writesFor('order_line').length, capture.format()).toBe(0);
                expect((await readStoredLines(seeded.listId)).length).toBe(0);
            },
        );
    });

    // AC-8 — The existing order operations are unchanged and the active order is untouched
    //
    // The comparison is made by RUNTIME INTROSPECTION of a booted server carrying the plugin, compared
    // field-by-field against the checked-in `schema-shop.json`. That snapshot is read READ-ONLY: it is
    // neither edited nor regenerated, and it cannot move, because the introspection that produces it
    // declares its own configuration and never reads the dev-server config (AAP §0.4.1.5). Editing it to
    // "record" the plugin's operations would be both wrong and a boundary breach.

    describe('AC-8: activeOrder is unchanged in signature and in effect', () => {
        async function readShopSnapshotTypes(): Promise<
            Array<{
                name: string;
                fields?: IntrospectedField[] | null;
                enumValues?: Array<{ name: string }> | null;
            }>
        > {
            const snapshot = (await fs.readJson(path.join(__dirname, '../../../schema-shop.json'))) as {
                data: {
                    __schema: {
                        types: Array<{
                            name: string;
                            fields?: IntrospectedField[] | null;
                            enumValues?: Array<{ name: string }> | null;
                        }>;
                    };
                };
            };
            return snapshot.data.__schema.types;
        }

        /**
         * Reduces an introspected type reference to `{ kind, name, ofType }` and nothing else, recursively.
         *
         * Required because the two sides carry different extra members — the snapshot's entries were produced
         * by a full introspection query and the runtime's by the narrower one above — so a raw deep-equality
         * would compare the query rather than the signature.
         */
        function normaliseTypeRef(reference: IntrospectedTypeRef | null | undefined): unknown {
            if (!reference) {
                return null;
            }
            return {
                kind: reference.kind,
                name: reference.name,
                ofType: normaliseTypeRef(reference.ofType),
            };
        }

        function normaliseField(field: IntrospectedField): unknown {
            return {
                name: field.name,
                args: field.args.map(argument => ({
                    name: argument.name,
                    defaultValue: argument.defaultValue,
                    type: normaliseTypeRef(argument.type),
                })),
                type: normaliseTypeRef(field.type),
            };
        }

        it('keeps activeOrder, adjustOrderLine, removeOrderLine and removeAllOrderLines byte-identical to the untouched snapshot', async () => {
            const snapshotTypes = await readShopSnapshotTypes();
            const runtimeQuery = await shopClient.query<IntrospectRootTypeQuery>(INTROSPECT_ROOT_TYPE, {
                typeName: 'Query',
            });
            const runtimeMutation = await shopClient.query<IntrospectRootTypeQuery>(INTROSPECT_ROOT_TYPE, {
                typeName: 'Mutation',
            });
            expect(runtimeQuery.__type).not.toBeNull();
            expect(runtimeMutation.__type).not.toBeNull();

            const comparisons: Array<{ rootType: 'Query' | 'Mutation'; fieldName: string }> = [
                // The single operation under test in this criterion.
                { rootType: 'Query', fieldName: 'activeOrder' },
                // The three published order operations whose names this story's own operations echo, which is
                // why a signature comparison is not optional here (STORY-001-01-03 §10).
                { rootType: 'Mutation', fieldName: 'adjustOrderLine' },
                { rootType: 'Mutation', fieldName: 'removeOrderLine' },
                { rootType: 'Mutation', fieldName: 'removeAllOrderLines' },
            ];

            for (const { rootType, fieldName } of comparisons) {
                const snapshotFields = snapshotTypes.find(type => type.name === rootType)?.fields ?? [];
                const runtimeFields =
                    (rootType === 'Query' ? runtimeQuery.__type?.fields : runtimeMutation.__type?.fields) ??
                    [];
                const snapshotField = snapshotFields.find(field => field.name === fieldName);
                const runtimeField = runtimeFields.find(field => field.name === fieldName);
                expect(snapshotField, `${fieldName} is absent from the checked-in snapshot`).toBeDefined();
                expect(runtimeField, `${fieldName} is absent from the running schema`).toBeDefined();
                expect(
                    normaliseField(runtimeField as IntrospectedField),
                    `${rootType}.${fieldName} changed signature`,
                ).toEqual(normaliseField(snapshotField as IntrospectedField));
            }

            // No order mutation gained a `customFields` argument, because this story declares no custom field
            // on any core entity — EPIC-001 ruling R1. Stated separately from the comparison above so the
            // failure names the cause rather than only the difference.
            for (const fieldName of ['addItemToOrder', 'adjustOrderLine', 'removeOrderLine']) {
                const runtimeField = runtimeMutation.__type?.fields.find(field => field.name === fieldName);
                expect(runtimeField?.args.map(argument => argument.name)).not.toContain('customFields');
            }
        });

        it('publishes the additive-only B1 transition on every width it touches, including the zero delta', async () => {
            const snapshotTypes = await readShopSnapshotTypes();
            const runtimeQuery = await shopClient.query<IntrospectRootTypeQuery>(INTROSPECT_ROOT_TYPE, {
                typeName: 'Query',
            });
            const runtimeMutation = await shopClient.query<IntrospectRootTypeQuery>(INTROSPECT_ROOT_TYPE, {
                typeName: 'Mutation',
            });
            const runtimeErrorCode = await shopClient.query<IntrospectEnumQuery>(INTROSPECT_ENUM, {
                typeName: 'ErrorCode',
            });
            const runtimePermission = await shopClient.query<IntrospectEnumQuery>(INTROSPECT_ENUM, {
                typeName: 'Permission',
            });

            const snapshotQueryFields = snapshotTypes.find(type => type.name === 'Query')?.fields ?? [];
            const snapshotMutationFields = snapshotTypes.find(type => type.name === 'Mutation')?.fields ?? [];
            const snapshotErrorCodes =
                snapshotTypes.find(type => type.name === 'ErrorCode')?.enumValues ?? [];
            const snapshotPermissions =
                snapshotTypes.find(type => type.name === 'Permission')?.enumValues ?? [];

            // The transition is stated as a transition rather than as a single number, per EPIC-001 ruling
            // R15, and these are batch B1's widths — never the whole programme's.
            expect(snapshotQueryFields.length).toBe(19);
            expect(runtimeQuery.__type?.fields.length).toBe(21);
            expect(snapshotMutationFields.length).toBe(32);
            expect(runtimeMutation.__type?.fields.length).toBe(38);
            expect(snapshotErrorCodes.length).toBe(32);
            expect(runtimeErrorCode.__type?.enumValues.length).toBe(36);
            // THE ZERO DELTA IS ASSERTED RATHER THAN OMITTED: this story registers no custom permission
            // definition, so the published enum keeps exactly the members it had.
            expect(snapshotPermissions.length).toBe(97);
            expect(runtimePermission.__type?.enumValues.length).toBe(97);

            const runtimeQueryNames = (runtimeQuery.__type?.fields ?? []).map(field => field.name);
            for (const field of snapshotQueryFields) {
                expect(runtimeQueryNames).toContain(field.name);
            }
            const runtimeMutationNames = (runtimeMutation.__type?.fields ?? []).map(field => field.name);
            for (const field of snapshotMutationFields) {
                expect(runtimeMutationNames).toContain(field.name);
            }
            const runtimeErrorCodeNames = (runtimeErrorCode.__type?.enumValues ?? []).map(
                value => value.name,
            );
            for (const value of snapshotErrorCodes) {
                expect(runtimeErrorCodeNames).toContain(value.name);
            }
        });

        it('leaves the active order untouched after all four of this story\u2019s mutations have run', async () => {
            const seeded = await seedList(customers[0], 'Order isolation', [
                { productVariantId: 'T_1', quantity: 2 },
                { productVariantId: 'T_2', quantity: 3 },
            ]);
            const recordedTotalQuantity = await recordActiveOrderTotalQuantity('T_3');
            const orderBefore = await shopClient.query<GetActiveOrderQuery>(GET_ACTIVE_ORDER);
            expect(orderBefore.activeOrder?.totalQuantity).toBe(recordedTotalQuantity);

            capture.reset();
            await capture.capture(async () => {
                await shopClient.query<AdjustReorderListLineMutation, AdjustReorderListLineMutationVariables>(
                    ADJUST_REORDER_LIST_LINE,
                    { input: { reorderListId: seeded.listId, lineId: seeded.lineIds[0], quantity: 6 } },
                );
                await shopClient.query<RemoveReorderListLineMutation, RemoveReorderListLineMutationVariables>(
                    REMOVE_REORDER_LIST_LINE,
                    { input: { reorderListId: seeded.listId, lineId: seeded.lineIds[1] } },
                );
                await shopClient.query<UpdateReorderListMutation, UpdateReorderListMutationVariables>(
                    UPDATE_REORDER_LIST,
                    { input: { id: seeded.listId, name: 'Order isolation renamed' } },
                );
                await shopClient.query<DeleteReorderListMutation, DeleteReorderListMutationVariables>(
                    DELETE_REORDER_LIST,
                    { id: seeded.listId },
                );
            });

            expect(capture.count('order_line'), capture.format()).toBe(0);
            expect(capture.writesFor('order').length, capture.format()).toBe(0);

            const orderAfter = await shopClient.query<GetActiveOrderQuery>(GET_ACTIVE_ORDER);
            expect(orderAfter.activeOrder?.totalQuantity).toBe(recordedTotalQuantity);
            expect(orderAfter.activeOrder?.id).toBe(orderBefore.activeOrder?.id);
            expect(orderAfter.activeOrder?.lines).toEqual(orderBefore.activeOrder?.lines);
        });
    });

    // The two structural claims of this story, asserted rather than assumed (FEATURE-001-01 §2.11)
    //
    // The counted and predicate-shape assertions in this section are gated to the one engine on which
    // statement text and statement count are deterministic, and the fixture's own exported sentence saying
    // why titles the describe below verbatim rather than being paraphrased here. Every behavioural sibling
    // above runs on all four engine jobs. The capture helpers themselves resolve placeholders on every
    // engine, so these assertions would hold elsewhere too; they are gated only because each shares a
    // capture window with an exact count.

    describe(`Affected-row-count authority and the same-transaction decrement. ${STATEMENT_COUNT_ENGINE_REASON}`, () => {
        /** The correlated-`EXISTS` ownership requirement every statement that writes a LINE must carry. */
        function ownedLineScope() {
            return {
                table: 'reorder_list',
                correlation: { column: 'id', outerColumn: 'reorderListId' },
                predicates: [
                    { column: 'customerId', value: decodeId(customers[0].id) },
                    { column: 'channelId', value: decodeId(activeChannelId) },
                ],
            };
        }

        /** The three-conjunct requirement every statement that writes the LIST row must carry. */
        function ownedListScope(externalListId: ReorderApiId) {
            return [
                { column: 'id', value: decodeId(externalListId) },
                { column: 'customerId', value: decodeId(customers[0].id) },
                { column: 'channelId', value: decodeId(activeChannelId) },
            ];
        }

        it.skipIf(!isStatementCountEngine())(
            'adjustReorderListLine is one conditional statement carrying the line, its parent and the owner scope',
            async () => {
                const seeded = await seedList(customers[0], 'Adjust conditional statement', [
                    { productVariantId: 'T_1', quantity: 2 },
                ]);
                capture.reset();
                await capture.capture(() =>
                    shopClient.query<AdjustReorderListLineMutation, AdjustReorderListLineMutationVariables>(
                        ADJUST_REORDER_LIST_LINE,
                        { input: { reorderListId: seeded.listId, lineId: seeded.lineIds[0], quantity: 6 } },
                    ),
                );

                const [conditional, ...extraWrites] = capture.writesFor('reorder_list_line');
                expect(conditional, capture.format()).toBeDefined();
                expect(extraWrites.length, capture.format()).toBe(0);
                expect(conditional.kind, capture.format()).toBe('update');
                expect(whereMentionsColumns(conditional, ['id', 'reorderListId']), capture.format()).toBe(
                    true,
                );
                expect(
                    whereRequiresScopedPredicates(conditional, [
                        { column: 'id', value: decodeId(seeded.lineIds[0]) },
                        { column: 'reorderListId', value: decodeId(seeded.listId) },
                    ]),
                    capture.format(),
                ).toBe(true);
                // AND THE ACTING CUSTOMER AND THE ACTIVE CHANNEL ARE IN THIS SAME STATEMENT. A line row carries
                // neither column, so the only shape that can scope it is a correlated `EXISTS` over the parent
                // — verified here for its table, its correlation OUT to the row being written, and each scope
                // comparison bound to its expected value. A parameter scan or a name search would certify a
                // sub-query that scopes nothing.
                expect(
                    whereRequiresCorrelatedOwnership(conditional, ownedLineScope()),
                    capture.format(),
                ).toBe(true);
            },
        );

        it.skipIf(!isStatementCountEngine())(
            'removeReorderListLine is one conditional statement, and its counter decrement shares the transaction',
            async () => {
                const seeded = await seedList(customers[0], 'Remove conditional statement', [
                    { productVariantId: 'T_1', quantity: 2 },
                    { productVariantId: 'T_2', quantity: 3 },
                ]);
                capture.reset();
                await capture.capture(() =>
                    shopClient.query<RemoveReorderListLineMutation, RemoveReorderListLineMutationVariables>(
                        REMOVE_REORDER_LIST_LINE,
                        { input: { reorderListId: seeded.listId, lineId: seeded.lineIds[0] } },
                    ),
                );

                const [conditional, ...extraLineWrites] = capture.writesFor('reorder_list_line');
                expect(conditional, capture.format()).toBeDefined();
                expect(extraLineWrites.length, capture.format()).toBe(0);
                expect(conditional.kind, capture.format()).toBe('delete');
                expect(
                    whereRequiresScopedPredicates(conditional, [
                        { column: 'id', value: decodeId(seeded.lineIds[0]) },
                        { column: 'reorderListId', value: decodeId(seeded.listId) },
                    ]),
                    capture.format(),
                ).toBe(true);
                expect(
                    whereRequiresCorrelatedOwnership(conditional, ownedLineScope()),
                    capture.format(),
                ).toBe(true);

                const [decrement, ...extraListWrites] = capture.writesFor('reorder_list');
                expect(decrement, capture.format()).toBeDefined();
                expect(extraListWrites.length, capture.format()).toBe(0);
                expect(decrement.kind, capture.format()).toBe('update');
                expect(
                    whereRequiresScopedPredicates(decrement, ownedListScope(seeded.listId)),
                    capture.format(),
                ).toBe(true);

                // Both statements ran on ONE query runner, both inside a transaction, and NO transaction-control
                // statement separates them — so no observer can see the rows and the counter disagreeing. This
                // assertion fails if the decrement is moved outside the transaction, because a release or a
                // commit would then appear between the two.
                expect(decrement.runnerId, capture.format()).toBe(conditional.runnerId);
                expect(conditional.inTransaction, capture.format()).toBe(true);
                expect(decrement.inTransaction, capture.format()).toBe(true);
                const between = capture.statements.filter(
                    statement =>
                        statement.sequence > conditional.sequence && statement.sequence < decrement.sequence,
                );
                expect(
                    between.filter(statement => statement.kind === 'transaction').length,
                    capture.format(),
                ).toBe(0);

                const remaining = await readStoredLines(seeded.listId);
                expect(remaining.length).toBe(1);
                expect((await readStoredList(seeded.listId))?.lineCount).toBe(remaining.length);
            },
        );

        it.skipIf(!isStatementCountEngine())(
            'updateReorderList is one conditional statement carrying the row, the owner and the channel',
            async () => {
                const seeded = await seedList(customers[0], 'Rename conditional statement');
                capture.reset();
                await capture.capture(() =>
                    shopClient.query<UpdateReorderListMutation, UpdateReorderListMutationVariables>(
                        UPDATE_REORDER_LIST,
                        { input: { id: seeded.listId, name: 'Rename conditional statement applied' } },
                    ),
                );

                const [conditional, ...extraWrites] = capture.writesFor('reorder_list');
                expect(conditional, capture.format()).toBeDefined();
                expect(extraWrites.length, capture.format()).toBe(0);
                expect(conditional.kind, capture.format()).toBe('update');
                expect(
                    whereRequiresScopedPredicates(conditional, ownedListScope(seeded.listId)),
                    capture.format(),
                ).toBe(true);
            },
        );

        it.skipIf(!isStatementCountEngine())(
            'deleteReorderList is one conditional statement carrying the row, the owner and the channel',
            async () => {
                const seeded = await seedList(customers[0], 'Delete conditional statement', [
                    { productVariantId: 'T_1', quantity: 2 },
                ]);
                capture.reset();
                await capture.capture(() =>
                    shopClient.query<DeleteReorderListMutation, DeleteReorderListMutationVariables>(
                        DELETE_REORDER_LIST,
                        { id: seeded.listId },
                    ),
                );

                const [conditional, ...extraWrites] = capture.writesFor('reorder_list');
                expect(conditional, capture.format()).toBeDefined();
                expect(extraWrites.length, capture.format()).toBe(0);
                expect(conditional.kind, capture.format()).toBe('delete');
                expect(
                    whereRequiresScopedPredicates(conditional, ownedListScope(seeded.listId)),
                    capture.format(),
                ).toBe(true);
            },
        );

        it.skipIf(!isStatementCountEngine())(
            'each of the four operations refuses an inaccessible list with one scoped read and no write at all',
            async () => {
                const theirs = await seedList(customers[1], 'Second customer refusal fixture', [
                    { productVariantId: 'T_1', quantity: 4 },
                ]);
                await authenticateAs(customers[0]);

                capture.reset();
                const adjusted = await capture.capture(() =>
                    shopClient.query<AdjustReorderListLineMutation, AdjustReorderListLineMutationVariables>(
                        ADJUST_REORDER_LIST_LINE,
                        { input: { reorderListId: theirs.listId, lineId: theirs.lineIds[0], quantity: 6 } },
                    ),
                );
                expect(adjusted.adjustReorderListLine.__typename).toBe('ReorderListNotFoundError');
                assertRefusedWriteReadOneScopedListRow(theirs.listId, customers[0].id);

                capture.reset();
                const removed = await capture.capture(() =>
                    shopClient.query<RemoveReorderListLineMutation, RemoveReorderListLineMutationVariables>(
                        REMOVE_REORDER_LIST_LINE,
                        { input: { reorderListId: theirs.listId, lineId: theirs.lineIds[0] } },
                    ),
                );
                expect(removed.removeReorderListLine.__typename).toBe('ReorderListNotFoundError');
                assertRefusedWriteReadOneScopedListRow(theirs.listId, customers[0].id);

                capture.reset();
                const renamed = await capture.capture(() =>
                    shopClient.query<UpdateReorderListMutation, UpdateReorderListMutationVariables>(
                        UPDATE_REORDER_LIST,
                        { input: { id: theirs.listId, name: 'Renamed by a stranger' } },
                    ),
                );
                expect(renamed.updateReorderList.__typename).toBe('ReorderListNotFoundError');
                assertRefusedWriteReadOneScopedListRow(theirs.listId, customers[0].id);

                capture.reset();
                const deleted = await capture.capture(() =>
                    shopClient.query<DeleteReorderListMutation, DeleteReorderListMutationVariables>(
                        DELETE_REORDER_LIST,
                        { id: theirs.listId },
                    ),
                );
                expect(deleted.deleteReorderList.__typename).toBe('ReorderListNotFoundError');
                assertRefusedWriteReadOneScopedListRow(theirs.listId, customers[0].id);

                const theirLines = await readStoredLines(theirs.listId);
                expect(theirLines.length).toBe(1);
                expect(theirLines[0].quantity).toBe(4);
                expect((await readStoredList(theirs.listId))?.name).toBe('Second customer refusal fixture');
            },
        );

        it('adjustReorderListLine is idempotent by construction, which is the published remedy for an at-least-once add', async () => {
            const seeded = await seedList(customers[0], 'Idempotent absolute set', [
                { productVariantId: 'T_1', quantity: 2 },
            ]);

            const first = await shopClient.query<
                AdjustReorderListLineMutation,
                AdjustReorderListLineMutationVariables
            >(ADJUST_REORDER_LIST_LINE, {
                input: { reorderListId: seeded.listId, lineId: seeded.lineIds[0], quantity: 6 },
            });
            const second = await shopClient.query<
                AdjustReorderListLineMutation,
                AdjustReorderListLineMutationVariables
            >(ADJUST_REORDER_LIST_LINE, {
                input: { reorderListId: seeded.listId, lineId: seeded.lineIds[0], quantity: 6 },
            });

            // REPEATING THE SAME ABSOLUTE SET LEAVES THE SAME VALUE. There is no idempotency key anywhere in
            // this feature, and none is needed for this operation: an absolute set is idempotent by
            // construction, which is exactly why it is the deterministic remedy for the at-least-once delivery
            // of an add that accumulates.
            expect(first.adjustReorderListLine.__typename).toBe('ReorderList');
            expect(second.adjustReorderListLine.__typename).toBe('ReorderList');
            if (
                first.adjustReorderListLine.__typename !== 'ReorderList' ||
                second.adjustReorderListLine.__typename !== 'ReorderList'
            ) {
                throw new Error('A repeated absolute set did not return a ReorderList');
            }
            expect(second.adjustReorderListLine.lines.items[0].quantity).toBe(6);
            expect(second.adjustReorderListLine.lineCount).toBe(1);
            expect(String(second.adjustReorderListLine.lines.items[0].id)).toBe(
                String(first.adjustReorderListLine.lines.items[0].id),
            );
            const storedLines = await readStoredLines(seeded.listId);
            expect(storedLines.length).toBe(1);
            expect(storedLines[0].quantity).toBe(6);
        });
    });

    // §7's fourth scenario — one request adjusts a line while another removes the same line
    //
    // BOTH interleavings are FORCED rather than awaited, on the three engine jobs that run a database
    // server two independent connections can be opened against: `e2e-mariadb`, `e2e-mysql` and
    // `e2e-postgres`. `Promise.all` alone does not satisfy the rule, which is why the barrier fixture — not
    // a bare pair of promises — is the instrument.

    describe(`§7 scenario 4: one request adjusts a line while another removes it (engine: ${resolveConfiguredEngine()})`, () => {
        /**
         * The request context an authenticated client's next request would arrive with, built through the
         * platform's OWN guard path.
         */
        async function shopContextFor(client: SimpleGraphQLClient): Promise<RequestContext> {
            const session = await server.app.get(SessionService).getSessionFromToken(client.getAuthToken());
            // A SCALAR, uniformly with every other session assertion in this package. This one asserts the
            // session EXISTS, so it can only fail with `undefined` as the actual and cannot render a
            // `CachedSession` today — but the direction of an assertion is one edit away from reversing, and
            // the value on the other side of it carries the session token. Comparing here removes the
            // question rather than answering it.
            expect(
                session !== undefined,
                'The client holds no session, so no authenticated context can be built',
            ).toBe(true);
            const channelTokenKey =
                server.app.get(ConfigService).apiOptions.channelTokenKey ?? 'vendure-token';
            const request = { query: {}, headers: { [channelTokenKey]: E2E_DEFAULT_CHANNEL_TOKEN } };
            const ctx = await server.app
                .get(RequestContextService)
                .fromRequest(request as never, undefined, [Permission.Owner], session);
            expect(ctx.authorizedAsOwnerOnly).toBe(true);
            expect(ctx.channel.token).toBe(E2E_DEFAULT_CHANNEL_TOKEN);
            expect(ctx.activeUserId).toBeDefined();
            // AND IT IDENTIFIES AS THE SHOP API, which a direct service call does not get for free: the
            // platform reads the api type off the resolver's `info` argument, which no direct call
            // has, so `fromRequest` alone yields `custom` and a race would then be exercising a
            // branch no buyer's request reaches. `asShopApiContext` self-checks both the result and
            // that this context is left unchanged.
            const shopCtx = asShopApiContext(ctx);
            expect(shopCtx.apiType).toBe('shop');
            return shopCtx;
        }

        /**
         * Which row, if any, a barrier participant holds before the rendezvous in order to make the OTHER
         * participant queue behind it. `'none'` is a follower.
         *
         * **There is deliberately no `'line'` member.** Both service paths admit through the PARENT row
         * before touching a line, so the parent is the row a follower reaches first in either pairing and is
         * therefore the only row a leader can order it on. A line lead would leave the follower holding the
         * parent while waiting for the line, and the leader holding the line while waiting for the parent —
         * a cycle rather than an ordering. See {@link takeLeadLock}.
         */
        type LeadLock = 'none' | 'list';

        /** One statement a real service operation issued on its own transaction, and what it affected. */
        interface CapturedServiceWrite {
            readonly statement: string;
            readonly affected: number | undefined;
        }

        /**
         * What a forced participant observed about its own EXECUTION, beyond the value it handed back.
         */
        interface ServiceObservation {
            /** Every statement the operation issued on this transaction, with its affected-row count. */
            readonly writes: CapturedServiceWrite[];
            /**
             * The line's stored quantity, read back INSIDE the operation's own transaction after its DML and
             * before it committed — so it is the value that operation left, not a later reading of it.
             */
            quantityInTransaction?: number;
            lineFoundInTransaction?: boolean;
        }

        function newObservation(): ServiceObservation {
            return { writes: [] };
        }

        /**
         * Records every statement this participant's transaction issues, together with the affected-row count
         * the driver returned for it.
         */
        function captureServiceWrites(
            runner: { query: (...args: never[]) => Promise<unknown> },
            into: CapturedServiceWrite[],
        ): void {
            const current = runner.query.bind(runner) as (
                statement: string,
                parameters?: unknown[],
                useStructuredResult?: boolean,
            ) => Promise<unknown>;
            const capturing = async (
                statement: string,
                parameters?: unknown[],
                useStructuredResult?: boolean,
            ): Promise<unknown> => {
                const result = await current(statement, parameters, useStructuredResult);
                into.push({ statement, affected: affectedCountOf(result) });
                return result;
            };
            (runner as unknown as { query: typeof capturing }).query = capturing;
        }

        /** The `affected` a structured driver result carries, or undefined when the result is not one. */
        function affectedCountOf(result: unknown): number | undefined {
            if (typeof result === 'object' && result !== null) {
                const affected = (result as { affected?: unknown }).affected;
                if (typeof affected === 'number') {
                    return affected;
                }
            }
            return undefined;
        }

        /**
         * The affected-row count of the ONE statement of `verb` this operation issued against the LINE table.
         */
        function affectedRowsOfLineStatement(
            observation: ServiceObservation,
            verb: 'UPDATE' | 'DELETE',
            label: string,
        ): number {
            const matched = observation.writes.filter(
                write =>
                    new RegExp(`^\\s*${verb}\\b`, 'i').test(write.statement) &&
                    /reorder_list_line/.test(write.statement),
            );
            expect(
                matched.length,
                `${label} did not issue exactly one ${verb} against the line table. Statements issued: ` +
                    observation.writes.map(write => write.statement).join(' ;; '),
            ).toBe(1);
            const affected = matched[0].affected;
            expect(
                typeof affected,
                `the driver reported no affected-row count for ${label}'s ${verb}, so the count the service ` +
                    'branches on cannot be evidenced here',
            ).toBe('number');
            return affected as number;
        }

        /**
         * THE REAL `adjustReorderListLine` OPERATION as a barrier participant, executed on this participant's
         * own connection inside its own held transaction.
         *
         * `leadLock` is what makes the ordering FORCED rather than observed. The participant that holds it
         * takes a pessimistic write lock on the row its sibling reaches first, in its PRECHECK, which
         * completes before either write begins; when the pair is released, that participant proceeds while
         * its sibling blocks on the lock, and the harness commits the holder as soon as its write returns, so
         * the sibling then runs against the holder's committed effect. Without it, which caller reaches the
         * row first is whatever the scheduler decided, and the pair could only assert a disjunction.
         */
        function serviceAdjust(
            label: string,
            sessionContext: RequestContext,
            listRowId: number,
            lineRowId: number,
            quantity: number,
            leadLock: LeadLock,
            observation: ServiceObservation,
        ): BarrierParticipantSpec<AdjustReorderListLineResult, LeadLock> {
            return {
                label,
                precheck: async ctx => {
                    await takeLeadLock(ctx.manager, leadLock, listRowId);
                    return leadLock;
                },
                write: async ctx => {
                    expect(ctx.precheckResult, `${label} precheck did not run`).toBe(leadLock);
                    const boundContext = transactionBinder.bind(sessionContext, ctx.manager);
                    expect(
                        transactionBinder.managerOf(boundContext),
                        `${label} is not bound to its own barrier transaction`,
                    ).toBe(ctx.manager);
                    captureServiceWrites(
                        ctx.queryRunner as unknown as { query: (...args: never[]) => Promise<unknown> },
                        observation.writes,
                    );
                    const applied = await reorderListService.adjustReorderListLine(boundContext, {
                        reorderListId: listRowId,
                        lineId: lineRowId,
                        quantity,
                    });
                    // READ BACK INSIDE THIS OPERATION'S OWN TRANSACTION — after its statement, before it
                    // commits. In the adjust-then-remove ordering this is the ONLY point at which the
                    // adjusted value is observable at all: the sibling removal deletes the row as soon as
                    // this transaction commits, so once the pair has settled there is nothing left to read
                    // and no stored-state assertion could tell an adjustment that set 6 from one that set
                    // nothing. In the opposite ordering the same read reports that the row was already gone.
                    const row = await ctx.manager
                        .getRepository(ReorderListLine)
                        .findOne({ where: { id: lineRowId } });
                    observation.lineFoundInTransaction = row !== null && row !== undefined;
                    observation.quantityInTransaction = row?.quantity;
                    return applied;
                },
            };
        }

        /** THE REAL `removeReorderListLine` OPERATION as a barrier participant. See {@link serviceAdjust}. */
        function serviceRemove(
            label: string,
            sessionContext: RequestContext,
            listRowId: number,
            lineRowId: number,
            leadLock: LeadLock,
            observation: ServiceObservation,
        ): BarrierParticipantSpec<RemoveReorderListLineResult, LeadLock> {
            return {
                label,
                precheck: async ctx => {
                    await takeLeadLock(ctx.manager, leadLock, listRowId);
                    return leadLock;
                },
                write: async ctx => {
                    expect(ctx.precheckResult, `${label} precheck did not run`).toBe(leadLock);
                    const boundContext = transactionBinder.bind(sessionContext, ctx.manager);
                    expect(
                        transactionBinder.managerOf(boundContext),
                        `${label} is not bound to its own barrier transaction`,
                    ).toBe(ctx.manager);
                    captureServiceWrites(
                        ctx.queryRunner as unknown as { query: (...args: never[]) => Promise<unknown> },
                        observation.writes,
                    );
                    return reorderListService.removeReorderListLine(boundContext, {
                        reorderListId: listRowId,
                        lineId: lineRowId,
                    });
                },
            };
        }

        /**
         *
         * Takes the pessimistic write lock that establishes a forced ordering, or none.
         *
         * ★ THE LEADER HOLDS THE PARENT LIST ROW, IN BOTH PAIRINGS, AND THAT FOLLOWS FROM THE PRODUCTION LOCK
         * ORDER RATHER THAN FROM A PREFERENCE. A leader can only order its sibling on the row that sibling
         * reaches FIRST, and both service paths reach the parent first:
         *
         *   - `removeReorderListLine` opens with a scoped admission read of the parent under a write lock
         *     (`findOwnedListForUpdate`) and only then deletes the line, so that its counter decrement shares
         *     the delete's transaction.
         *   - `adjustReorderListLine` opens with a scoped admission read of the SAME parent row under a lock
         *     too (`findOwnedListForShare`) — shared where the engine can share it safely, and EXCLUSIVE on the
         *     MySQL family, which `ENGINES_REQUIRING_EXCLUSIVE_PARENT_FOR_LINE_WRITES` names. Only then does its
         *     single conditional `UPDATE` address the line.
         *
         * So every transaction in the service that touches both rows takes the parent and then the child, and
         * `'list'` is the only lead lock that can order either pairing. The leader takes it EXCLUSIVELY, which
         * is what makes a following adjustment queue even on an engine whose own admission read would be
         * content with a shared lock.
         *
         * ‼ A LINE LEAD IS NOT OFFERED, BECAUSE IT WOULD MANUFACTURE A CYCLE THE PRODUCTION ORDER NO LONGER
         * CONTAINS. An earlier revision of this file had the leading removal hold the LINE, which was correct
         * against an earlier service in which the adjustment did not lock the parent at all and reached the
         * line first. Against the parent-first service it inverts: the following adjustment takes the parent
         * and then waits for the line the leader holds, while the leader waits for the parent the follower
         * holds. Measured on MariaDB 11.5 rather than reasoned about — InnoDB detected the cycle and rolled a
         * victim's whole transaction back, which discards its savepoints, so the platform's unwind then
         * reported `SAVEPOINT typeorm_1 does not exist` and both participants surfaced the plugin's generic
         * internal error: a symptom three layers from its cause, and a test that could never have evidenced
         * the ordering it claimed. That is why {@link LeadLock} has no `'line'` member to reach for.
         *
         * ✓ AND THE PRODUCTION INVERSION THAT WARNING USED TO DESCRIBE IS GONE. Two genuine concurrent
         * requests — one adjusting, one removing the same line, with no test lock anywhere — now take the two
         * rows in the SAME order, because the adjustment's admission read holds the parent before any line
         * statement is issued. Nothing in either path acquires the child before the parent, so the pair cannot
         * form a cycle at all; what it does instead is queue, which is what these two cases measure. The cost
         * of that choice is stated where it is made rather than here: on the MySQL family the exclusive parent
         * lock serialises two concurrent adjustments of one list, and the service records why that trade is
         * accepted.
         *
         * Only the three server engines run the forced orderings, and each of them honours
         * `pessimistic_write` — which is exactly why the sql.js job runs the sequential form instead.
         */
        async function takeLeadLock(
            manager: EntityManager,
            leadLock: LeadLock,
            listRowId: number,
        ): Promise<void> {
            if (leadLock === 'list') {
                await lockListRow(manager, listRowId);
            }
        }

        /**
         * Takes a pessimistic write lock on one parent list row, on the given transaction — the lock a leader
         * of either pairing needs, because the parent is the row both service paths reach first.
         */
        async function lockListRow(manager: EntityManager, listRowId: number): Promise<void> {
            const held = await manager
                .createQueryBuilder(ReorderList, 'list')
                .setLock('pessimistic_write')
                .where('list.id = :listId', { listId: listRowId })
                .getOne();
            expect(held?.id !== undefined, 'the parent list row to be held was not found').toBe(true);
        }

        /*
         * There is deliberately no line-locking counterpart to `lockListRow` above. It existed while a
         * removal led by holding the child row, and holding the child is precisely what forms the cycle
         * {@link takeLeadLock} records: against the parent-first service both pairings queue on the parent,
         * so a line lock is not merely unused here but unsafe, and leaving the helper in place would leave
         * the hazard one argument away.
         */

        /**
         * The conditional absolute set as a hand-written statement, used by the SEQUENTIAL form only.
         *
         * The sequential form makes no interleaving claim; what it evidences on every engine including sql.js
         * is that the affected-row count is the authority, which is read directly off the statement here. The
         * forced orderings above drive the real service operations instead, for the reason stated there.
         */
        function conditionalAdjust(
            listId: number,
            lineId: number,
            quantity: number,
            label: string,
        ): BarrierParticipantSpec<number> {
            return {
                label,
                write: async ctx => {
                    const result = await ctx.manager
                        .createQueryBuilder()
                        .update(ReorderListLine)
                        .set({ quantity })
                        .where('id = :lineId', { lineId })
                        .andWhere('reorderListId = :listId', { listId })
                        .execute();
                    return result.affected ?? 0;
                },
            };
        }

        /** The conditional delete as a hand-written statement, used by the SEQUENTIAL form only. */
        function conditionalRemove(
            listId: number,
            lineId: number,
            label: string,
        ): BarrierParticipantSpec<number> {
            return {
                label,
                write: async ctx => {
                    const result = await ctx.manager
                        .createQueryBuilder()
                        .delete()
                        .from(ReorderListLine)
                        .where('id = :lineId', { lineId })
                        .andWhere('reorderListId = :listId', { listId })
                        .execute();
                    return result.affected ?? 0;
                },
            };
        }

        // ★ ALL THREE READERS BELOW REPORT THROUGH THE SHARED DESCRIBER. Each is reached only when a
        // participant REJECTED, and a participant here writes straight through the repository — so the reason
        // is a TypeORM `QueryFailedError` carrying the statement, its bound values and the driver's own
        // fields. `String(reason)` and `reason.message` both published all of it into the failure these
        // helpers exist to explain. See `e2e/fixtures/diagnostic-redaction.ts`.

        /** Reads an outcome's affected count, failing loudly for a participant that did not fulfil. */
        function affectedRowsOf(outcome: { status: string; value?: number; reason?: unknown }): number {
            expect(outcome.status, describeSettledOutcomes([outcome])).toBe('fulfilled');
            return outcome.value as number;
        }

        /** Reads a participant's fulfilled value, failing loudly with the reason if it rejected instead. */
        function fulfilledValueOf<T>(outcome: {
            label: string;
            status: string;
            value?: T;
            reason?: unknown;
        }): T {
            expect(outcome.status, describeSettledOutcomes([outcome])).toBe('fulfilled');
            return outcome.value as T;
        }

        /** Both participants' rejection reasons, so a failed race names why rather than only that. */
        function describeOutcomeReasons(result: {
            a: { label: string; status: string; reason?: unknown };
            b: { label: string; status: string; reason?: unknown };
        }): string {
            return describeSettledOutcomes(
                [result.a, result.b].filter(outcome => outcome.status !== 'fulfilled'),
            );
        }

        /**
         * Asserts the published result the losing caller receives, by issuing the same adjustment through the
         * API once the row is gone — which is the very zero-affected condition the barrier produced.
         */
        async function assertLoserReceivesLineNotFound(seeded: SeededList): Promise<void> {
            const { adjustReorderListLine } = await shopClient.query<
                AdjustReorderListLineMutation,
                AdjustReorderListLineMutationVariables
            >(ADJUST_REORDER_LIST_LINE, {
                input: { reorderListId: seeded.listId, lineId: seeded.lineIds[0], quantity: 6 },
            });
            expect(adjustReorderListLine).toEqual({
                __typename: 'ReorderListLineNotFoundError',
                errorCode: 'REORDER_LIST_LINE_NOT_FOUND_ERROR',
                message: expect.any(String) as unknown as string,
            });
        }

        describe('Forced interleaving, which only a server engine can evidence', () => {
            // ★ THE GUARD THAT STOPS A GREEN ENGINE JOB MEANING NOTHING, and it is deliberately NOT skipped
            // on any engine.
            //
            // The two cases below are gated by `supportsForcedInterleaving()`, which reads the configured
            // engine at COLLECTION time. If that gate were ever wrong — an engine name spelled differently,
            // an environment variable read that returned nothing, a list that lost an entry — both cases
            // would SILENTLY SKIP and this file would still report green. A run of `e2e (mysql)` would then
            // prove nothing about forced interleaving on MySQL while looking exactly like one that did.
            //
            // So the gate is asserted against the RUNNING data source, which cannot be gated by itself: on a
            // server engine the pair must be enabled, and on a single-connection engine it must be disabled
            // for the stated reason rather than by accident. A green run on any of the three server engines
            // therefore establishes that the forced-interleaving pair actually executed there, which is the
            // property the three-engine evidence clause rests on and the one a reader cannot otherwise
            // confirm from the source alone.
            it('runs the forced pair on exactly the engines that can evidence it', () => {
                const configured = resolveConfiguredEngine();
                const running = dataSource.options.type;

                // ONE. The engine the gate read and the engine the suite is running against are the same.
                // A disagreement would take every engine-conditional branch in this file on the wrong engine.
                expect(
                    running,
                    'the running data source is not the engine this run was configured for, so every ' +
                        'engine-conditional gate in this file was decided against the wrong engine',
                ).toBe(configured);

                // TWO. The gate agrees with itself whether asked by name or handed the data source.
                expect(supportsForcedInterleaving(dataSource)).toBe(supportsForcedInterleaving());

                // THREE. And it says the right thing for this engine, read from the two published lists
                // rather than from a second copy of the rule.
                if (SINGLE_CONNECTION_ENGINES.indexOf(running) !== -1) {
                    expect(
                        supportsForcedInterleaving(),
                        `${running} keeps its whole database in one connection, so a barrier cannot hold ` +
                            `two transactions apart and the pair below is excluded: ${SQLJS_EXCLUSION_REASON}`,
                    ).toBe(false);
                    return;
                }
                expect(
                    FORCED_INTERLEAVING_ENGINES.indexOf(running) !== -1,
                    `${running} is neither a single-connection engine nor one this plugin has assessed ` +
                        'for barrier evidence, so the pair below would skip and no engine would carry the ' +
                        'forced-interleaving claim',
                ).toBe(true);
                expect(
                    supportsForcedInterleaving(),
                    `${running} can evidence forced interleaving, so the pair below MUST have run; a skip ` +
                        'here would make a green run on this engine vacuous',
                ).toBe(true);
            });

            it.skipIf(!supportsForcedInterleaving())(
                `forces adjust-then-remove on ${resolveConfiguredEngine()}: both real operations apply, and the parent counter reaches zero`,
                async () => {
                    const seeded = await seedList(customers[0], 'Barrier adjust then remove', [
                        { productVariantId: 'T_1', quantity: 2 },
                    ]);
                    // The collection-time gate and the running data source agree on the engine.
                    expect(supportsForcedInterleaving(dataSource)).toBe(true);
                    const listId = decodeId(seeded.listId);
                    const lineId = decodeId(seeded.lineIds[0]);
                    expect((await readStoredList(seeded.listId))?.lineCount).toBe(1);
                    const sessionContext = await shopContextFor(shopClient);

                    // THE ORDERING IS FORCED, not observed: the adjustment holds the PARENT row exclusively for
                    // the window, and the parent is the row `removeReorderListLine` reaches first — its scoped
                    // admission read is the transaction's opening statement — so the removal queues there and
                    // cannot touch the line until the adjustment has committed. The parent is the only row
                    // that can order this pair, because the adjustment reaches it first as well; see
                    // {@link takeLeadLock}.
                    const adjustObservation = newObservation();
                    const removeObservation = newObservation();
                    const result = await runBarrieredPair(dataSource, {
                        a: serviceAdjust(
                            'adjust',
                            sessionContext,
                            listId,
                            lineId,
                            6,
                            'list',
                            adjustObservation,
                        ),
                        b: serviceRemove('remove', sessionContext, listId, lineId, 'none', removeObservation),
                    });

                    // Both participants were provably held at the rendezvous and released together before either
                    // wrote, which is the property a race claim rests on.
                    expect(result.a.releasedBeforeWrite).toBe(true);
                    expect(result.b.releasedBeforeWrite).toBe(true);
                    expect(result.rejected.length, describeOutcomeReasons(result)).toBe(0);

                    // BOTH REAL RESPONSES. The adjustment applied — its conditional statement affected one
                    // row, which is what makes its result the list rather than a not-found — and the removal
                    // that followed it deleted the row it had just adjusted, likewise affecting one row and
                    // returning the list it had emptied.
                    const adjusted = fulfilledValueOf(result.a);
                    expect(adjusted).not.toBeInstanceOf(ReorderListLineNotFoundError);
                    expect(adjusted).toBeInstanceOf(ReorderList);
                    const removed = fulfilledValueOf(result.b);
                    expect(removed).not.toBeInstanceOf(ReorderListLineNotFoundError);
                    expect(removed).toBeInstanceOf(ReorderList);
                    expect((removed as ReorderList).lineCount).toBe(0);

                    // THE STATEMENT OUTCOMES, WHICH THE RESULT CLASSES ABOVE CANNOT CARRY. Both operations
                    // return the parent list on their applied path, and by the time this pair has settled the
                    // line is gone and the stored state is empty — which is exactly what an adjustment that
                    // matched NOTHING would also leave behind. So a no-op adjust that still returned a list
                    // satisfies every assertion above, and only the driver's own affected-row count separates
                    // it from one that applied. One each: the adjustment set its row, and the removal then
                    // deleted that same row.
                    expect(affectedRowsOfLineStatement(adjustObservation, 'UPDATE', 'the adjustment')).toBe(
                        1,
                    );
                    expect(affectedRowsOfLineStatement(removeObservation, 'DELETE', 'the removal')).toBe(1);

                    expect(
                        adjustObservation.lineFoundInTransaction,
                        'the adjustment could not see its own line inside its own transaction',
                    ).toBe(true);
                    expect(adjustObservation.quantityInTransaction).toBe(6);

                    expect(await readStoredLines(seeded.listId)).toHaveLength(0);
                    expect((await readStoredList(seeded.listId))?.lineCount).toBe(0);

                    await assertLoserReceivesLineNotFound(seeded);
                },
            );

            it.skipIf(!supportsForcedInterleaving())(
                `forces remove-then-adjust on ${resolveConfiguredEngine()}: the adjustment matches nothing and its caller is told so`,
                async () => {
                    const seeded = await seedList(customers[0], 'Barrier remove then adjust', [
                        { productVariantId: 'T_1', quantity: 2 },
                    ]);
                    expect(supportsForcedInterleaving(dataSource)).toBe(true);
                    const listId = decodeId(seeded.listId);
                    const lineId = decodeId(seeded.lineIds[0]);
                    expect((await readStoredList(seeded.listId))?.lineCount).toBe(1);
                    const sessionContext = await shopContextFor(shopClient);

                    // THE OPPOSITE ORDERING, forced on the SAME row and for the same reason: the removal holds
                    // the PARENT exclusively, so the adjustment queues on its own admission read of that
                    // parent and reaches the line only after the removal has committed — by which time the
                    // line is gone and its conditional statement matches nothing. Holding the LINE here
                    // instead would not order the pair, it would deadlock it: the adjustment would already
                    // hold the parent while waiting for the line. See {@link takeLeadLock}.
                    const removeObservation = newObservation();
                    const adjustObservation = newObservation();
                    const result = await runBarrieredPair(dataSource, {
                        a: serviceRemove('remove', sessionContext, listId, lineId, 'list', removeObservation),
                        b: serviceAdjust(
                            'adjust',
                            sessionContext,
                            listId,
                            lineId,
                            6,
                            'none',
                            adjustObservation,
                        ),
                    });

                    expect(result.a.releasedBeforeWrite).toBe(true);
                    expect(result.b.releasedBeforeWrite).toBe(true);
                    expect(result.rejected.length, describeOutcomeReasons(result)).toBe(0);

                    // BOTH REAL RESPONSES. The removal deleted its one row and returned the emptied list; the
                    // adjustment's conditional statement then affected ZERO rows, and the affected-row count
                    // being the authority is precisely what turns that into a not-found result rather than a
                    // success reported over a row the caller never touched — the defect a read-then-write
                    // would ship.
                    const removed = fulfilledValueOf(result.a);
                    expect(removed).toBeInstanceOf(ReorderList);
                    expect((removed as ReorderList).lineCount).toBe(0);
                    const adjusted = fulfilledValueOf(result.b);
                    expect(adjusted).toBeInstanceOf(ReorderListLineNotFoundError);
                    expect((adjusted as ReorderListLineNotFoundError).__typename).toBe(
                        'ReorderListLineNotFoundError',
                    );
                    expect((adjusted as ReorderListLineNotFoundError).errorCode).toBe(
                        'REORDER_LIST_LINE_NOT_FOUND_ERROR',
                    );

                    // THE STATEMENT OUTCOMES: one, then ZERO. The removal deleted its row, and the adjustment
                    // that followed it matched nothing — and that zero is the authority the service turns into
                    // the not-found result above, rather than a class chosen from a prior read. Asserting the
                    // count as well as the class is what distinguishes the published contract being honoured
                    // from it being reached by accident.
                    expect(affectedRowsOfLineStatement(removeObservation, 'DELETE', 'the removal')).toBe(1);
                    expect(affectedRowsOfLineStatement(adjustObservation, 'UPDATE', 'the adjustment')).toBe(
                        0,
                    );
                    // AND THE REFUSED ADJUSTMENT CHANGED NOTHING — whether or not its own snapshot could
                    // still see the row it failed to update.
                    //
                    // Which of those it sees is the ENGINE'S ISOLATION LEVEL talking rather than anything
                    // about the operation, so asserting a single visibility outcome here would encode one
                    // engine's snapshot rule as a contract: under the
                    // REPEATABLE READ default of the MySQL family, this transaction's snapshot predates the
                    // sibling's committed removal, so a plain SELECT still returns a row the transaction can
                    // no longer update, while PostgreSQL's READ COMMITTED default reports it already gone.
                    expect(
                        typeof adjustObservation.lineFoundInTransaction,
                        'the adjustment never performed its in-transaction read-back, so this proves nothing',
                    ).toBe('boolean');
                    if (adjustObservation.lineFoundInTransaction === true) {
                        expect(adjustObservation.quantityInTransaction).toBe(2);
                    } else {
                        expect(adjustObservation.quantityInTransaction).toBeUndefined();
                    }

                    expect(await readStoredLines(seeded.listId)).toHaveLength(0);
                    expect((await readStoredList(seeded.listId))?.lineCount).toBe(0);

                    await assertLoserReceivesLineNotFound(seeded);
                },
            );
        });

        // The sequential form, which EVERY engine runs — and the only concurrency-adjacent form the
        // in-process engine can honour. The exclusion is stated verbatim in this title rather than
        // paraphrased, so no two files in this package word it differently.
        describe(`Sequential form, run on every engine. ${SQLJS_EXCLUSION_REASON}`, () => {
            it('runs remove-then-adjust sequentially on every engine and reports the affected-row count of each conditional statement', async () => {
                // THE FUNCTIONAL HALF, which is what keeps the sql.js job meaningful rather than skipped. It
                // evidences single-connection correctness and the affected-row-count rule; it evidences NOTHING
                // about interleaving, because two participants run in series were never inside the same window.
                const seeded = await seedList(customers[0], 'Sequential remove then adjust', [
                    { productVariantId: 'T_1', quantity: 2 },
                ]);
                const listId = decodeId(seeded.listId);
                const lineId = decodeId(seeded.lineIds[0]);

                const result = await runSequentialPair(dataSource, {
                    a: conditionalRemove(listId, lineId, 'remove'),
                    b: conditionalAdjust(listId, lineId, 6, 'adjust'),
                });

                // There is no rendezvous in this mode, so neither participant was held at one and nothing here
                // claims otherwise.
                expect(result.a.releasedBeforeWrite).toBe(false);
                expect(result.b.releasedBeforeWrite).toBe(false);
                expect(result.a.settledOrder).toBe(0);
                expect(result.b.settledOrder).toBe(1);
                expect(affectedRowsOf(result.a)).toBe(1);
                expect(affectedRowsOf(result.b)).toBe(0);
                expect(await readStoredLines(seeded.listId)).toHaveLength(0);
                await assertLoserReceivesLineNotFound(seeded);
            });

            it('runs adjust-then-remove sequentially on every engine and applies both in order', async () => {
                const seeded = await seedList(customers[0], 'Sequential adjust then remove', [
                    { productVariantId: 'T_1', quantity: 2 },
                ]);
                const listId = decodeId(seeded.listId);
                const lineId = decodeId(seeded.lineIds[0]);

                const result = await runSequentialPair(dataSource, {
                    a: conditionalAdjust(listId, lineId, 6, 'adjust'),
                    b: conditionalRemove(listId, lineId, 'remove'),
                });

                expect(affectedRowsOf(result.a)).toBe(1);
                expect(affectedRowsOf(result.b)).toBe(1);
                expect(await readStoredLines(seeded.listId)).toHaveLength(0);
                const { removeReorderListLine } = await shopClient.query<
                    RemoveReorderListLineMutation,
                    RemoveReorderListLineMutationVariables
                >(REMOVE_REORDER_LIST_LINE, {
                    input: { reorderListId: seeded.listId, lineId: seeded.lineIds[0] },
                });
                expect(removeReorderListLine.__typename).toBe('ReorderListLineNotFoundError');
            });
        });
    });

    // §7's first three scenarios. The fourth — concurrent modification — is the describe above.
    //
    // TWO OF THE THREE REQUIRED CATEGORIES RESOLVE TO *PROCEED* RATHER THAN TO A BLOCK, and that is stated
    // honestly here rather than force-fitted into a failure these operations cannot have: a saved list
    // records INTENT rather than availability, so neither a disabled variant nor a changed price is a
    // precondition of amending a line.

    describe('§7 scenario 1: zero, null or empty collection — an empty list and two incomplete requests', () => {
        it('refuses a removal from a list holding no lines with ReorderListLineNotFoundError', async () => {
            const seeded = await seedList(customers[0], 'Empty list');
            const recordedName = (await readStoredList(seeded.listId))?.name;
            expect(recordedName).toBe('Empty list');
            expect((await readStoredLines(seeded.listId)).length).toBe(0);

            const { removeReorderListLine } = await shopClient.query<
                RemoveReorderListLineMutation,
                RemoveReorderListLineMutationVariables
            >(REMOVE_REORDER_LIST_LINE, {
                input: { reorderListId: seeded.listId, lineId: UNKNOWN_LINE_ID },
            });

            expect(removeReorderListLine.__typename).toBe('ReorderListLineNotFoundError');
            expect((await readStoredLines(seeded.listId)).length).toBe(0);
            expect((await readStoredList(seeded.listId))?.name).toBe(recordedName);
            expect((await readStoredList(seeded.listId))?.lineCount).toBe(0);
        });

        it('refuses an adjustment that omits the non-nullable quantity argument before any resolver executes', async () => {
            const seeded = await seedList(customers[0], 'Missing argument');
            const recordedName = (await readStoredList(seeded.listId))?.name;

            // `quantity` is declared non-nullable in the published input object, so a request that omits it
            // fails the executor's own input coercion. The variables are widened here deliberately: the
            // hand-written variables type models the PUBLISHED input, in which the field is required, so
            // sending an incomplete input is only expressible by saying so at the call site.
            const response = await expectTopLevelErrors(() =>
                shopClient.query<AdjustReorderListLineMutation, AdjustReorderListLineMutationVariables>(
                    ADJUST_REORDER_LIST_LINE,
                    {
                        input: { reorderListId: seeded.listId, lineId: UNKNOWN_LINE_ID },
                    } as unknown as AdjustReorderListLineMutationVariables,
                ),
            );

            expect(response.errors.length).toBe(1);
            expect(
                'data' in response,
                `Expected no data entry on a pre-execution rejection: ${JSON.stringify(response)}`,
            ).toBe(false);
            expect(response.errors[0].message).toContain('quantity');
            expect((await readStoredLines(seeded.listId)).length).toBe(0);
            expect((await readStoredList(seeded.listId))?.name).toBe(recordedName);
        });

        it('refuses a rename to a whitespace-only name and leaves the recorded name exactly as it was', async () => {
            const seeded = await seedList(customers[0], 'Whitespace rename target');
            const recordedName = (await readStoredList(seeded.listId))?.name;

            const response = await expectTopLevelErrors(() =>
                shopClient.query<UpdateReorderListMutation, UpdateReorderListMutationVariables>(
                    UPDATE_REORDER_LIST,
                    { input: { id: seeded.listId, name: '\u0020\u0020\t\n ' } },
                ),
            );

            expect(response.errors.length).toBe(1);
            expect(response.errors[0].extensions?.code).toBe('USER_INPUT_ERROR');
            expect(response.errors[0].message).toBe(NAME_EMPTY_MESSAGE);
            expect(response.data).toBeNull();
            expect((await readStoredList(seeded.listId))?.name).toBe(recordedName);
            expect((await readStoredLines(seeded.listId)).length).toBe(0);
        });
    });

    describe('§7 scenario 2: a variant disabled or soft-deleted since the line was added', () => {
        it('proceeds on both operations, because a saved list records intent rather than availability', async () => {
            const seeded = await seedList(customers[0], 'Catalogue moved underneath', [
                { productVariantId: 'T_1', quantity: 2 },
                { productVariantId: 'T_2', quantity: 3 },
            ]);
            await setVariantEnabled('T_1', false);
            await softDeleteVariant('T_2');

            const { adjustReorderListLine } = await shopClient.query<
                AdjustReorderListLineMutation,
                AdjustReorderListLineMutationVariables
            >(ADJUST_REORDER_LIST_LINE, {
                input: { reorderListId: seeded.listId, lineId: seeded.lineIds[0], quantity: 6 },
            });
            expect(adjustReorderListLine.__typename).toBe('ReorderList');
            if (adjustReorderListLine.__typename !== 'ReorderList') {
                throw new Error('adjustReorderListLine did not return a ReorderList');
            }
            const adjustedLine = adjustReorderListLine.lines.items.find(
                line => String(line.id) === seeded.lineIds[0],
            );
            expect(adjustedLine?.quantity).toBe(6);
            // A DISABLED variant is still resolvable in the active channel, so it arrives populated. Nulling it
            // would hide a variant the contract says to return.
            expect(adjustedLine?.productVariant).not.toBeNull();
            const staleLine = adjustReorderListLine.lines.items.find(
                line => String(line.id) === seeded.lineIds[1],
            );
            expect(staleLine?.productVariant).toBeNull();
            expect(String(staleLine?.productVariantId)).toBe('T_2');

            const { removeReorderListLine } = await shopClient.query<
                RemoveReorderListLineMutation,
                RemoveReorderListLineMutationVariables
            >(REMOVE_REORDER_LIST_LINE, {
                input: { reorderListId: seeded.listId, lineId: seeded.lineIds[1] },
            });
            expect(removeReorderListLine.__typename).toBe('ReorderList');
            if (removeReorderListLine.__typename !== 'ReorderList') {
                throw new Error('removeReorderListLine did not return a ReorderList');
            }
            expect(removeReorderListLine.lineCount).toBe(1);
            expect(removeReorderListLine.lines.totalItems).toBe(1);
            expect(String(removeReorderListLine.lines.items[0].id)).toBe(seeded.lineIds[0]);
            expect((await readStoredLines(seeded.listId)).length).toBe(1);
        });
    });

    describe('§7 scenario 3: the catalogue price of a variant behind a line has moved', () => {
        it('proceeds on both operations, there being no stored value for a price change to invalidate', async () => {
            const seeded = await seedList(customers[0], 'Price moved', [
                { productVariantId: 'T_1', quantity: 2 },
            ]);

            /*
             * THE PREMISE IS ESTABLISHED, NOT ASSUMED. This scenario is about a price that HAS moved, and the
             * two assertions it ends with — that neither operation refuses and that neither payload carries a
             * monetary field — are equally true of a catalogue whose price never moved at all. So a scenario
             * that took the price change on trust could not tell an implementation which ignores the price
             * from one which was simply never shown a changed price. Three things are therefore checked before
             * either reorder mutation is issued: the Admin mutation's own result, an INDEPENDENT re-read of the
             * variant, and that the re-read value differs from the one recorded first.
             */
            const readVariantPrice = async (): Promise<number> => {
                const { product } = await adminClient.query<{
                    product: { id: string; variants: Array<{ id: string; price: number }> } | null;
                }>(
                    gql`
                        query ReadVariantPriceForReorderMutate($id: ID!) {
                            product(id: $id) {
                                id
                                variants {
                                    id
                                    price
                                }
                            }
                        }
                    `,
                    { id: 'T_1' },
                );
                const variant = product?.variants.find(candidate => candidate.id === 'T_1');
                expect(variant, 'the variant behind the seeded line is not readable').toBeDefined();
                return variant?.price as number;
            };
            const recordedPrice = await readVariantPrice();

            const updateVariantPrice = async (price: number): Promise<void> => {
                const { updateProductVariants } = await adminClient.query<{
                    updateProductVariants: Array<{ id: string; price: number } | null>;
                }>(
                    gql`
                        mutation UpdateVariantPriceForReorderMutate($input: [UpdateProductVariantInput!]!) {
                            updateProductVariants(input: $input) {
                                id
                                price
                            }
                        }
                    `,
                    { input: [{ id: 'T_1', price }] },
                );
                expect(updateProductVariants.length, 'the price update returned no variant').toBe(1);
                expect(updateProductVariants[0]?.id, 'the price update returned another variant').toBe('T_1');
                expect(updateProductVariants[0]?.price, `the platform did not store the price ${price}`).toBe(
                    price,
                );
            };
            // The price lives in core rows this test did not create, so EVERY COLUMN of both of them — the
            // variant row and the `product_variant_price` rows belonging to it — is captured BEFORE the write
            // and queued for exact restoration, so the prior state goes back even if an assertion below
            // throws. Restoring by issuing the inverse Admin mutation would put the NUMBER back and advance
            // the `updatedAt` of both rows while doing so, leaving the next test reading rows that are not
            // the rows that were there.
            const pricedVariantDbId = decodeId('T_1');
            await captureCoreRows('product_variant', 'captured_row.id = :variantId', {
                variantId: pricedVariantDbId,
            });
            await captureCoreRows('product_variant_price', 'captured_row.variantId = :variantId', {
                variantId: pricedVariantDbId,
            });

            const changedPrice = recordedPrice + 5000;
            await updateVariantPrice(changedPrice);

            const currentPrice = await readVariantPrice();
            expect(currentPrice, 'the price read back is not the changed price').toBe(changedPrice);
            expect(
                currentPrice,
                'the catalogue price did not move, so this scenario has no changed price to be indifferent to',
            ).not.toBe(recordedPrice);

            await authenticateAs(customers[0]);

            const { adjustReorderListLine } = await shopClient.query<
                AdjustReorderListLineMutation,
                AdjustReorderListLineMutationVariables
            >(ADJUST_REORDER_LIST_LINE, {
                input: { reorderListId: seeded.listId, lineId: seeded.lineIds[0], quantity: 6 },
            });
            const { updateReorderList } = await shopClient.query<
                UpdateReorderListMutation,
                UpdateReorderListMutationVariables
            >(UPDATE_REORDER_LIST, { input: { id: seeded.listId, name: 'Price moved and renamed' } });

            expect(adjustReorderListLine.__typename).toBe('ReorderList');
            expect(updateReorderList.__typename).toBe('ReorderList');
            if (adjustReorderListLine.__typename !== 'ReorderList') {
                throw new Error('adjustReorderListLine did not return a ReorderList');
            }
            expect(adjustReorderListLine.lines.items[0].quantity).toBe(6);
            const responseKeys = new Set<string>();
            const collectKeys = (value: unknown): void => {
                if (Array.isArray(value)) {
                    value.forEach(collectKeys);
                    return;
                }
                if (value !== null && typeof value === 'object') {
                    for (const [key, nested] of Object.entries(value)) {
                        responseKeys.add(key);
                        collectKeys(nested);
                    }
                }
            };
            collectKeys(adjustReorderListLine);
            collectKeys(updateReorderList);
            expect([...responseKeys].filter(key => MONETARY_OR_STOCK_FIELD_NAME.test(key))).toEqual([]);
        });

        it('publishes no monetary, currency or stock field on any of the four operations\u2019 inputs or results', async () => {
            // The CURRENCY dimension of this story, discharged at the payload level and asserted against the
            // running schema for all four operations rather than for one (STORY-001-01-03 §10).
            const publishedTypes = [
                'ReorderList',
                'ReorderListLine',
                'ReorderListViewerAccess',
                'UpdateReorderListInput',
                'AdjustReorderListLineInput',
                'RemoveReorderListLineInput',
                'ReorderListNotFoundError',
                'ReorderListNameConflictError',
                'ReorderListLineNotFoundError',
            ];
            for (const typeName of publishedTypes) {
                const { __type } = await shopClient.query<IntrospectTypeFieldsQuery>(INTROSPECT_TYPE_FIELDS, {
                    typeName,
                });
                expect(__type, `${typeName} is absent from the running schema`).not.toBeNull();
                const fieldNames = [
                    ...(__type?.fields ?? []).map(field => field.name),
                    ...(__type?.inputFields ?? []).map(field => field.name),
                ];
                expect(fieldNames.length, `${typeName} published no field at all`).toBeGreaterThan(0);
                expect(
                    fieldNames.filter(name => MONETARY_OR_STOCK_FIELD_NAME.test(name)),
                    `${typeName} published a monetary, currency or stock field`,
                ).toEqual([]);
            }
            // And the add input still declares exactly three fields and no request-deduplication key, which is
            // the ruling this story consumes rather than restates.
            const { __type: addInput } = await shopClient.query<IntrospectTypeFieldsQuery>(
                INTROSPECT_TYPE_FIELDS,
                { typeName: 'AddItemToReorderListInput' },
            );
            expect((addInput?.inputFields ?? []).map(field => field.name).sort()).toEqual([
                'productVariantId',
                'quantity',
                'reorderListId',
            ]);
        });
    });

    // The empty-generation assertion this suite owns
    //
    // STORY-001-01-03 requires NO MIGRATION OF ITS OWN, and the absence is verified rather than asserted:
    // every table, column, index, constraint and on-delete action it relies on ships in the single additive
    // migration STORY-001-01-01 generates. A generated file appearing at this point is the signal that this
    // story has altered a mapping it does not own.

    describe('This story owns no migration', () => {
        it('emits no migration file against a schema the checked-in migration created', async () => {
            const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'reorder-mutate-migration-'));
            // Queued before the call, so the directory is removed even if the assertion below fails.
            temporaryDirectories.push(outputDir);
            const snapshotDir = await fs.mkdtemp(path.join(os.tmpdir(), 'reorder-mutate-schema-'));
            temporaryDirectories.push(snapshotDir);

            // WHAT THE GENERATOR IS POINTED AT IS THE MIGRATION'S OWN OUTPUT, and that is the whole point of
            // this assertion rather than a refinement of it. `generateMigration` forces `synchronize: false`
            // and `migrationsRun: false` on the connection it opens (`packages/core/src/migrate.ts`), so it
            // diffs the entity declarations against whatever schema is already in the database — and under
            // every initializer this suite can run, that schema was built by SYNCHRONISING those same
            // declarations. An empty result against it would therefore be reported whether the checked-in
            // migration is faithful, broken or absent. So the two plugin tables are dropped and recreated by
            // the artefact first, and the diff is taken against that.
            const schemaIsTheMigrations = await rebuildPluginSchemaFromCheckedInMigration();

            // WHAT THE ASSERTION RESTS ON, which differs by engine and is recorded rather than glossed. On the
            // generation engine the diff is taken against a schema the shipped artefact built, so an empty
            // result means the artefact and the entities agree. Elsewhere it is taken against the synchronised
            // schema, where an empty result means the entities carry no pending change — weaker, but still the
            // claim this story owns, which is that it adds no column and needs no migration of its own.
            expect(
                schemaIsTheMigrations,
                'the rebuild must run on exactly the engine the shipped artefact was generated against',
            ).toBe(committedMigrationApplies(String(dataSource.options.type)));

            // THE GENERATOR'S OWN DECISION INPUT, read from the running server's connection, because that is
            // where the diagnostic lives: `generateMigration` writes a file if and only if this log's
            // `upQueries` is non-empty, so naming the offending statements here turns a bare `undefined`
            // expectation into a failure a reader can act on.
            const log = await dataSource.driver.createSchemaBuilder().log();
            const namesPluginTable = (query: string) =>
                /reorder_list(_line)?/i.test(query.replace(/["`[\]]/g, ''));
            const offendingUpQueries = log.upQueries.map(query => query.query).filter(namesPluginTable);
            const offendingDownQueries = log.downQueries.map(query => query.query).filter(namesPluginTable);
            expect(
                offendingUpQueries,
                `the migration's output disagrees with the registered entities on ${resolveConfiguredEngine()}: ${offendingUpQueries.join(
                    ' | ',
                )}`,
            ).toHaveLength(0);
            expect(offendingDownQueries).toHaveLength(0);

            // AND THE PLATFORM ENTRY POINT ITSELF, against that same migration-created schema. It returns
            // `undefined` and writes no file; the platform logs "No changes in database schema were found -
            // cannot generate a migration." on this path.
            const generated = await generateMigration(
                await generatorConfigAgainstMigratedSchema(snapshotDir),
                {
                    name: 'storyOneOhOneOhThreeShouldEmitNothing',
                    outputDir,
                },
            );
            // The file's own contents are the diagnostic when it does write one, and reading them also
            // catches the way this assertion could otherwise go quietly wrong: a generator pointed at an
            // EMPTY database emits the entire schema rather than nothing, so a broken snapshot fails here
            // loudly instead of passing vacuously.
            expect(
                generated,
                `generateMigration emitted a migration against the migration-created schema: ${
                    generated ? await fs.readFile(generated, 'utf-8') : ''
                }`,
            ).toBeUndefined();
            expect(await fs.readdir(outputDir)).toEqual([]);

            // The output directory is a temporary one outside the repository, so nothing is ever written under
            // this package's own migrations directory and `git status --porcelain` is clean after a run
            // whatever this assertion finds.
            expect(path.isAbsolute(outputDir)).toBe(true);
            expect(outputDir.startsWith(path.join(__dirname, '..'))).toBe(false);

            // The running server is unaffected by the generation pass, which is asserted rather than assumed
            // because that pass loads and then resets the platform's module-level configuration. The two
            // tables are empty at this point, the rebuild having dropped and recreated them, so this also
            // proves the migration's own output accepts the writes this story makes.
            const stillWorking = await seedList(customers[0], 'After the generation pass', [
                { productVariantId: 'T_1', quantity: 2 },
            ]);
            expect((await readStoredLines(stillWorking.listId)).length).toBe(1);
        });
    });

    // The four mandatory authorisation cases, carried for EVERY ONE of this story's four mutations
    //
    // STORY-001-01-03 §10 requires the four authorisation cases as REAL API CALLS for each of the four
    // mutations — "each of which is a real API call asserting both the returned payload and the stored row
    // count rather than a unit test of a guard function, and the foreign-channel case sending a second real
    // channel token rather than mutating a variable" — which is four callers × four operations, sixteen
    // cells. §10 also states which four callers: a session holding no custom permission SUCCEEDS, a request
    // authenticated as a DIFFERENT CUSTOMER is refused, a request carrying a FOREIGN CHANNEL TOKEN reaches
    // nothing, and an UNAUTHENTICATED request writes nothing.

    describe('The four mandatory authorisation cases, per operation', () => {
        /** The normalised refusal every inaccessible-row call in this section must be indistinguishable from. */
        const INACCESSIBLE_LIST = {
            __typename: 'ReorderListNotFoundError',
            errorCode: 'REORDER_LIST_NOT_FOUND_ERROR',
            message: expect.any(String) as unknown as string,
        };

        /**
         * Runs one call under the SECOND, REAL channel's own token, restoring the default token unconditionally.
         */
        async function underSecondChannelToken<T>(run: () => Promise<T>): Promise<T> {
            shopClient.setChannelToken(SECOND_CHANNEL_TOKEN);
            try {
                return await run();
            } finally {
                shopClient.setChannelToken(E2E_DEFAULT_CHANNEL_TOKEN);
            }
        }

        /**
         * Asserts that the capture window just closed contains no write against either plugin table.
         *
         * Deliberately a WRITE count rather than a statement count: a refusal that had to read the addressed
         * row's absence issues statements legitimately, and the claim being made is that none of them changed
         * anything. Engine-independent, so this runs on all four engine jobs.
         */
        function expectNoPluginWrites() {
            expect(capture.writesFor('reorder_list').length, capture.format()).toBe(0);
            expect(capture.writesFor('reorder_list_line').length, capture.format()).toBe(0);
        }

        it('adjustReorderListLine · an unauthenticated request is refused with one FORBIDDEN entry and writes nothing', async () => {
            const seeded = await seedList(customers[0], 'Unauthenticated adjust probe', [
                { productVariantId: 'T_1', quantity: 2 },
            ]);
            await shopClient.asAnonymousUser();

            capture.reset();
            const response = await capture.capture(() =>
                expectTopLevelErrors(() =>
                    shopClient.query<AdjustReorderListLineMutation, AdjustReorderListLineMutationVariables>(
                        ADJUST_REORDER_LIST_LINE,
                        { input: { reorderListId: seeded.listId, lineId: seeded.lineIds[0], quantity: 6 } },
                    ),
                ),
            );

            expect(response.errors.length).toBe(1);
            expect(response.errors[0].extensions?.code).toBe('FORBIDDEN');
            expect(response.errors[0].message).toBe(FORBIDDEN_MESSAGE);
            expect(response.errors[0].path).toEqual(['adjustReorderListLine']);
            expect(response.data).toBeNull();
            expect(response.data?.adjustReorderListLine ?? null).toBeNull();
            expect(capture.count('reorder_list'), capture.format()).toBe(0);
            expect(capture.count('reorder_list_line'), capture.format()).toBe(0);

            await authenticateAs(customers[0]);
            const storedLines = await readStoredLines(seeded.listId);
            expect(storedLines.length).toBe(1);
            expect(storedLines[0].quantity).toBe(2);
            expect((await readStoredList(seeded.listId))?.lineCount).toBe(1);
        });

        it('removeReorderListLine · a request carrying a second real channel token reaches nothing', async () => {
            const seeded = await seedList(customers[0], 'Foreign channel remove probe', [
                { productVariantId: 'T_1', quantity: 2 },
            ]);

            capture.reset();
            const refused = await capture.capture(() =>
                underSecondChannelToken(() =>
                    shopClient.query<RemoveReorderListLineMutation, RemoveReorderListLineMutationVariables>(
                        REMOVE_REORDER_LIST_LINE,
                        { input: { reorderListId: seeded.listId, lineId: seeded.lineIds[0] } },
                    ),
                ),
            );
            expectNoPluginWrites();

            const unknown = await shopClient.query<
                RemoveReorderListLineMutation,
                RemoveReorderListLineMutationVariables
            >(REMOVE_REORDER_LIST_LINE, {
                input: { reorderListId: UNKNOWN_LIST_ID, lineId: UNKNOWN_LINE_ID },
            });
            expect(refused.removeReorderListLine).toEqual(INACCESSIBLE_LIST);
            expect(refused.removeReorderListLine).toEqual(unknown.removeReorderListLine);
            expect(Object.keys(refused.removeReorderListLine).sort()).toEqual(
                Object.keys(unknown.removeReorderListLine).sort(),
            );

            const storedLines = await readStoredLines(seeded.listId);
            expect(storedLines.length).toBe(1);
            expect(String(storedLines[0].id)).toBe(String(decodeId(seeded.lineIds[0])));
            expect(storedLines[0].quantity).toBe(2);
            expect((await readStoredList(seeded.listId))?.lineCount).toBe(1);
        });

        it('removeReorderListLine · a request authenticated as a different customer is refused', async () => {
            const theirs = await seedList(customers[1], 'Second customer remove fixture', [
                { productVariantId: 'T_1', quantity: 4 },
            ]);
            await authenticateAs(customers[0]);

            capture.reset();
            const refused = await capture.capture(() =>
                shopClient.query<RemoveReorderListLineMutation, RemoveReorderListLineMutationVariables>(
                    REMOVE_REORDER_LIST_LINE,
                    { input: { reorderListId: theirs.listId, lineId: theirs.lineIds[0] } },
                ),
            );
            expectNoPluginWrites();
            expect(refused.removeReorderListLine).toEqual(INACCESSIBLE_LIST);

            const theirLines = await readStoredLines(theirs.listId);
            expect(theirLines.length).toBe(1);
            expect(theirLines[0].quantity).toBe(4);
            expect((await readStoredList(theirs.listId))?.lineCount).toBe(1);
        });

        it('updateReorderList · a request carrying a second real channel token reaches nothing', async () => {
            const seeded = await seedList(customers[0], 'Foreign channel rename probe');

            capture.reset();
            const refused = await capture.capture(() =>
                underSecondChannelToken(() =>
                    shopClient.query<UpdateReorderListMutation, UpdateReorderListMutationVariables>(
                        UPDATE_REORDER_LIST,
                        { input: { id: seeded.listId, name: 'Renamed from another channel' } },
                    ),
                ),
            );
            expectNoPluginWrites();

            const unknown = await shopClient.query<
                UpdateReorderListMutation,
                UpdateReorderListMutationVariables
            >(UPDATE_REORDER_LIST, { input: { id: UNKNOWN_LIST_ID, name: 'Renamed from nowhere' } });
            expect(refused.updateReorderList).toEqual(INACCESSIBLE_LIST);
            expect(refused.updateReorderList).toEqual(unknown.updateReorderList);
            expect(Object.keys(refused.updateReorderList).sort()).toEqual(
                Object.keys(unknown.updateReorderList).sort(),
            );

            const stored = await readStoredList(seeded.listId);
            expect(stored?.name).toBe('Foreign channel rename probe');
            expect(stored?.nameKey).toBe('foreign channel rename probe');
        });

        it('updateReorderList · an unauthenticated request is refused with one FORBIDDEN entry and writes nothing', async () => {
            const seeded = await seedList(customers[0], 'Unauthenticated rename probe');
            await shopClient.asAnonymousUser();

            capture.reset();
            const response = await capture.capture(() =>
                expectTopLevelErrors(() =>
                    shopClient.query<UpdateReorderListMutation, UpdateReorderListMutationVariables>(
                        UPDATE_REORDER_LIST,
                        { input: { id: seeded.listId, name: 'Renamed by nobody' } },
                    ),
                ),
            );

            expect(response.errors.length).toBe(1);
            expect(response.errors[0].extensions?.code).toBe('FORBIDDEN');
            expect(response.errors[0].message).toBe(FORBIDDEN_MESSAGE);
            expect(response.errors[0].path).toEqual(['updateReorderList']);
            expect(response.data).toBeNull();
            expect(response.data?.updateReorderList ?? null).toBeNull();
            expect(capture.count('reorder_list'), capture.format()).toBe(0);
            expect(capture.count('reorder_list_line'), capture.format()).toBe(0);

            await authenticateAs(customers[0]);
            const stored = await readStoredList(seeded.listId);
            expect(stored?.name).toBe('Unauthenticated rename probe');
            expect(stored?.nameKey).toBe('unauthenticated rename probe');
        });

        it('updateReorderList · a request authenticated as a different customer is refused', async () => {
            const theirs = await seedList(customers[1], 'Second customer rename fixture');
            await authenticateAs(customers[0]);

            capture.reset();
            const refused = await capture.capture(() =>
                shopClient.query<UpdateReorderListMutation, UpdateReorderListMutationVariables>(
                    UPDATE_REORDER_LIST,
                    { input: { id: theirs.listId, name: 'Renamed by a stranger' } },
                ),
            );
            expectNoPluginWrites();
            expect(refused.updateReorderList).toEqual(INACCESSIBLE_LIST);

            expect((await readStoredList(theirs.listId))?.name).toBe('Second customer rename fixture');
        });

        it('deleteReorderList · a request carrying a second real channel token deletes nothing', async () => {
            const seeded = await seedList(customers[0], 'Foreign channel delete probe', [
                { productVariantId: 'T_1', quantity: 2 },
            ]);

            capture.reset();
            const refused = await capture.capture(() =>
                underSecondChannelToken(() =>
                    shopClient.query<DeleteReorderListMutation, DeleteReorderListMutationVariables>(
                        DELETE_REORDER_LIST,
                        { id: seeded.listId },
                    ),
                ),
            );
            expectNoPluginWrites();

            const unknown = await shopClient.query<
                DeleteReorderListMutation,
                DeleteReorderListMutationVariables
            >(DELETE_REORDER_LIST, { id: UNKNOWN_LIST_ID });
            expect(refused.deleteReorderList).toEqual(INACCESSIBLE_LIST);
            expect(refused.deleteReorderList).toEqual(unknown.deleteReorderList);
            expect(Object.keys(refused.deleteReorderList).sort()).toEqual(
                Object.keys(unknown.deleteReorderList).sort(),
            );

            // THE LIST AND ITS LINE ARE BOTH STILL THERE, and the owner still holds exactly one list in the
            // channel the row belongs to — so no cascade fired either.
            expect((await readStoredList(seeded.listId))?.name).toBe('Foreign channel delete probe');
            expect((await readStoredLines(seeded.listId)).length).toBe(1);
            expect(await countStoredLists(customers[0].id, activeChannelId)).toBe(1);
        });

        it('deleteReorderList · an unauthenticated request is refused with one FORBIDDEN entry and deletes nothing', async () => {
            const seeded = await seedList(customers[0], 'Unauthenticated delete probe', [
                { productVariantId: 'T_1', quantity: 2 },
            ]);
            await shopClient.asAnonymousUser();

            capture.reset();
            const response = await capture.capture(() =>
                expectTopLevelErrors(() =>
                    shopClient.query<DeleteReorderListMutation, DeleteReorderListMutationVariables>(
                        DELETE_REORDER_LIST,
                        { id: seeded.listId },
                    ),
                ),
            );

            expect(response.errors.length).toBe(1);
            expect(response.errors[0].extensions?.code).toBe('FORBIDDEN');
            expect(response.errors[0].message).toBe(FORBIDDEN_MESSAGE);
            expect(response.errors[0].path).toEqual(['deleteReorderList']);
            expect(response.data).toBeNull();
            expect(response.data?.deleteReorderList ?? null).toBeNull();
            expect(capture.count('reorder_list'), capture.format()).toBe(0);
            expect(capture.count('reorder_list_line'), capture.format()).toBe(0);

            await authenticateAs(customers[0]);
            expect((await readStoredList(seeded.listId))?.name).toBe('Unauthenticated delete probe');
            expect((await readStoredLines(seeded.listId)).length).toBe(1);
            expect(await countStoredLists(customers[0].id, activeChannelId)).toBe(1);
        });

        it('deleteReorderList · a request authenticated as a different customer deletes nothing', async () => {
            const theirs = await seedList(customers[1], 'Second customer delete fixture', [
                { productVariantId: 'T_1', quantity: 4 },
            ]);
            await authenticateAs(customers[0]);

            capture.reset();
            const refused = await capture.capture(() =>
                shopClient.query<DeleteReorderListMutation, DeleteReorderListMutationVariables>(
                    DELETE_REORDER_LIST,
                    { id: theirs.listId },
                ),
            );
            expectNoPluginWrites();
            expect(refused.deleteReorderList).toEqual(INACCESSIBLE_LIST);

            expect((await readStoredList(theirs.listId))?.name).toBe('Second customer delete fixture');
            expect((await readStoredLines(theirs.listId)).length).toBe(1);
            expect(await countStoredLists(customers[1].id, activeChannelId)).toBe(1);
        });
    });
});

// The correlated-ownership verifier this file's line-write claims are decided by
//
// ★ WHY THESE CASES ARE HERE. Every assertion above that a `reorder_list_line` write is scoped to its owner
// is decided by {@link whereRequiresCorrelatedOwnership}: a line row stores its parent's identifier, a
// variant reference and a quantity, so the acting customer and the active channel can only reach the
// statement through a sub-query over the parent table (FEATURE-001-01 §2.11). If that parser certifies a
// statement which does not really scope the row, the claims above pass while the write reaches rows nobody
// owns — and they pass silently, because nothing else in this file is looking. A verifier is therefore only
// worth what its own negative cases prove, and those cases have to be COMMITTED to prove anything twice: a
// check performed once by hand cannot fail when a later edit weakens the parser.
/** The decoded identifiers a fixture would hold, standing in for rows it created. */
const VERIFIER_CUSTOMER_ID = 5;
const VERIFIER_CHANNEL_ID = 1;
const VERIFIER_LIST_ID = 100;
const VERIFIER_LINE_ID = 200;

/**
 * The ownership claim a line write must satisfy, built fresh per assertion so that no test can observe a
 * requirement another one mutated.
 */
function verifierLineScope(): CorrelatedOwnershipRequirement {
    return {
        table: 'reorder_list',
        correlation: { column: 'id', outerColumn: 'reorderListId' },
        predicates: [
            { column: 'customerId', value: VERIFIER_CUSTOMER_ID },
            { column: 'channelId', value: VERIFIER_CHANNEL_ID },
        ],
    };
}

/**
 * Captures one statement the way a real run does: through the logger's own TypeORM hook, with a query
 * runner whose connection reports the engine.
 */
function captureVerifierStatement(query: string, parameters: unknown[], engine: string): CapturedStatement {
    // Its own instrument, deliberately not the file-level `capture` the suite above installs on the server:
    // these cases feed the logger by hand and must not add to, or read from, a window that suite is counting.
    const verifierCapture = new QueryCaptureLogger();
    verifierCapture.enable();
    const runner = {
        connection: { options: { type: engine } },
        isTransactionActive: true,
    } as unknown as QueryRunner;
    verifierCapture.logQuery(query, parameters, runner);
    const [statement] = verifierCapture.statements;
    expect(statement).toBeDefined();
    expect(statement.dialect).toBe(engine);
    return statement;
}

/** The correlated `EXISTS` PostgreSQL receives, with its identifiers double-quoted and its values bound. */
const POSTGRES_EXISTS =
    'EXISTS (SELECT 1 FROM "reorder_list" "owned_list_scope" ' +
    'WHERE "owned_list_scope"."id" = "reorderListId" ' +
    'AND "owned_list_scope"."customerId" = $4 AND "owned_list_scope"."channelId" = $5)';

/** The same clause as the MySQL family receives it: backticks, and positional placeholders. */
const MYSQL_EXISTS =
    'EXISTS (SELECT 1 FROM `reorder_list` `owned_list_scope` ' +
    'WHERE `owned_list_scope`.`id` = `reorderListId` ' +
    'AND `owned_list_scope`.`customerId` = ? AND `owned_list_scope`.`channelId` = ?)';

/** The same clause as sql.js receives it: double-quoted identifiers, and the values written inline. */
const SQLJS_EXISTS =
    'EXISTS (SELECT 1 FROM "reorder_list" "owned_list_scope" ' +
    'WHERE "owned_list_scope"."id" = "reorderListId" ' +
    `AND "owned_list_scope"."customerId" = ${VERIFIER_CUSTOMER_ID} ` +
    `AND "owned_list_scope"."channelId" = ${VERIFIER_CHANNEL_ID})`;

/** A PostgreSQL adjust whose `EXISTS` clause is supplied, so one shape can be varied at a time. */
function postgresVerifierAdjust(existsClause: string): CapturedStatement {
    return captureVerifierStatement(
        'UPDATE "reorder_list_line" SET "quantity" = $1 ' +
            `WHERE "id" = $2 AND "reorderListId" = $3 AND ${existsClause}`,
        [7, VERIFIER_LINE_ID, VERIFIER_LIST_ID, VERIFIER_CUSTOMER_ID, VERIFIER_CHANNEL_ID],
        'postgres',
    );
}

describe('whereRequiresCorrelatedOwnership', () => {
    describe('certifies the ownership sub-query the service writes', () => {
        it('certifies the PostgreSQL adjust, resolving both bound values through their placeholders', () => {
            const statement = postgresVerifierAdjust(POSTGRES_EXISTS);

            expect(whereRequiresCorrelatedOwnership(statement, verifierLineScope())).toBe(true);
        });

        it('certifies the MySQL accumulate, whose placeholders are positional', () => {
            // The `SET` clause binds ahead of the predicate, so the customer and channel are the fourth and
            // fifth parameters of the statement rather than the first two of the sub-query. Resolving them
            // requires the offset arithmetic the parser performs; a verifier that numbered the sub-query's
            // own placeholders from zero would read the quantity and the line id as the tenant.
            const statement = captureVerifierStatement(
                'UPDATE `reorder_list_line` SET `quantity` = `quantity` + ? ' +
                    `WHERE \`id\` = ? AND \`reorderListId\` = ? AND ${MYSQL_EXISTS}`,
                [3, VERIFIER_LINE_ID, VERIFIER_LIST_ID, VERIFIER_CUSTOMER_ID, VERIFIER_CHANNEL_ID],
                'mysql',
            );

            expect(whereRequiresCorrelatedOwnership(statement, verifierLineScope())).toBe(true);
        });

        it('certifies the MariaDB remove, which is a delete rather than an update', () => {
            const statement = captureVerifierStatement(
                `DELETE FROM \`reorder_list_line\` WHERE \`id\` = ? AND \`reorderListId\` = ? AND ${MYSQL_EXISTS}`,
                [VERIFIER_LINE_ID, VERIFIER_LIST_ID, VERIFIER_CUSTOMER_ID, VERIFIER_CHANNEL_ID],
                'mariadb',
            );

            expect(whereRequiresCorrelatedOwnership(statement, verifierLineScope())).toBe(true);
        });

        it('certifies the sql.js adjust, whose values are inline literals rather than parameters', () => {
            const statement = captureVerifierStatement(
                `UPDATE "reorder_list_line" SET "quantity" = 7 WHERE "id" = ${VERIFIER_LINE_ID} ` +
                    `AND "reorderListId" = ${VERIFIER_LIST_ID} AND ${SQLJS_EXISTS}`,
                [],
                'sqljs',
            );

            expect(whereRequiresCorrelatedOwnership(statement, verifierLineScope())).toBe(true);
        });

        it('accepts a caller that names the alias and the outer relation exactly', () => {
            const statement = postgresVerifierAdjust(POSTGRES_EXISTS);
            const requirement = verifierLineScope();
            requirement.correlation.outerRelation = undefined;
            requirement.predicates[0].relation = 'owned_list_scope';
            requirement.predicates[1].relation = 'owned_list_scope';

            expect(whereRequiresCorrelatedOwnership(statement, requirement)).toBe(true);
        });

        it('refuses a caller that names an alias the sub-query did not use', () => {
            const statement = postgresVerifierAdjust(POSTGRES_EXISTS);
            const requirement = verifierLineScope();
            requirement.predicates[0].relation = 'reorder_list_line';

            expect(whereRequiresCorrelatedOwnership(statement, requirement)).toBe(false);
        });

        it('reads a raw statement string, resolving inline literals only', () => {
            const raw =
                `UPDATE "reorder_list_line" SET "quantity" = 7 WHERE "id" = ${VERIFIER_LINE_ID} ` +
                `AND "reorderListId" = ${VERIFIER_LIST_ID} AND ${SQLJS_EXISTS}`;

            expect(whereRequiresCorrelatedOwnership(raw, verifierLineScope(), 'sqljs')).toBe(true);
        });
    });

    describe('refuses a requirement whose scope values it cannot decide', () => {
        it('refuses a scope predicate with no expected value, rather than checking the column alone', () => {
            // The type forbids this, which is the first line of defence; the cast is the point of the test.
            // A suite compiled against an earlier shape, a plain-JavaScript caller, or a fixture identifier
            // that was never assigned can all present a predicate with no value — and the general predicate
            // helper reads an absent value as "require only that this column is compared", which certifies a
            // sub-query whose tenant parameters are bound the wrong way round.
            const requirement = {
                table: 'reorder_list',
                correlation: { column: 'id', outerColumn: 'reorderListId' },
                predicates: [{ column: 'customerId' }, { column: 'channelId', value: VERIFIER_CHANNEL_ID }],
            } as unknown as CorrelatedOwnershipRequirement;

            expect(
                whereRequiresCorrelatedOwnership(postgresVerifierAdjust(POSTGRES_EXISTS), requirement),
            ).toBe(false);
        });

        it('refuses a scope predicate whose expected value is explicitly undefined', () => {
            const requirement = {
                table: 'reorder_list',
                correlation: { column: 'id', outerColumn: 'reorderListId' },
                predicates: [
                    { column: 'customerId', value: undefined },
                    { column: 'channelId', value: VERIFIER_CHANNEL_ID },
                ],
            } as unknown as CorrelatedOwnershipRequirement;

            expect(
                whereRequiresCorrelatedOwnership(postgresVerifierAdjust(POSTGRES_EXISTS), requirement),
            ).toBe(false);
        });

        it('refuses the swapped tenant binding, which has the right shape and the wrong owner', () => {
            const requirement = verifierLineScope();
            requirement.predicates[0].value = VERIFIER_CHANNEL_ID;
            requirement.predicates[1].value = VERIFIER_CUSTOMER_ID;

            expect(
                whereRequiresCorrelatedOwnership(postgresVerifierAdjust(POSTGRES_EXISTS), requirement),
            ).toBe(false);
        });

        it('refuses a value no parameter carries, so a stale fixture identifier fails loudly', () => {
            const requirement = verifierLineScope();
            requirement.predicates[0].value = VERIFIER_CUSTOMER_ID + 1;

            expect(
                whereRequiresCorrelatedOwnership(postgresVerifierAdjust(POSTGRES_EXISTS), requirement),
            ).toBe(false);
        });

        it('refuses an empty predicates list, because a correlation alone proves existence not ownership', () => {
            const requirement = verifierLineScope();
            requirement.predicates = [];

            expect(
                whereRequiresCorrelatedOwnership(postgresVerifierAdjust(POSTGRES_EXISTS), requirement),
            ).toBe(false);
        });

        it('refuses a malformed requirement instead of throwing', () => {
            const statement = postgresVerifierAdjust(POSTGRES_EXISTS);

            expect(
                whereRequiresCorrelatedOwnership(
                    statement,
                    undefined as unknown as CorrelatedOwnershipRequirement,
                ),
            ).toBe(false);
            expect(
                whereRequiresCorrelatedOwnership(statement, {
                    table: '',
                    correlation: { column: 'id', outerColumn: 'reorderListId' },
                    predicates: [{ column: 'customerId', value: VERIFIER_CUSTOMER_ID }],
                }),
            ).toBe(false);
        });
    });

    describe('refuses a sub-query whose row count does not follow its predicate', () => {
        it('refuses an ungrouped aggregate projection, which is satisfied for every row', () => {
            // Every other part of the requirement is met: the right table, a real correlation, and both
            // scope comparisons bound to the right values. `COUNT(*)` without a `GROUP BY` still returns one
            // row — `0` — when nothing matched, so the `EXISTS` is true for a line nobody owns and the write
            // it guards reaches the whole table.
            const statement = postgresVerifierAdjust(POSTGRES_EXISTS.replace('SELECT 1', 'SELECT COUNT(*)'));

            expect(whereRequiresCorrelatedOwnership(statement, verifierLineScope())).toBe(false);
        });

        it('refuses an empty grouping set, which synthesises a row from no rows', () => {
            const statement = postgresVerifierAdjust(
                POSTGRES_EXISTS.replace(/\)$/, ' GROUP BY GROUPING SETS (()))'),
            );

            expect(whereRequiresCorrelatedOwnership(statement, verifierLineScope())).toBe(false);
        });

        it('refuses a HAVING clause, whose group is not a row of the relation', () => {
            const statement = postgresVerifierAdjust(
                POSTGRES_EXISTS.replace(/\)$/, ' HAVING COUNT(*) >= 0)'),
            );

            expect(whereRequiresCorrelatedOwnership(statement, verifierLineScope())).toBe(false);
        });

        it('refuses a row-limiting tail, which decouples the result in the other direction', () => {
            const statement = postgresVerifierAdjust(POSTGRES_EXISTS.replace(/\)$/, ' LIMIT 0)'));

            expect(whereRequiresCorrelatedOwnership(statement, verifierLineScope())).toBe(false);
        });

        it('refuses a projection this parser has not modelled, rather than reading through it', () => {
            for (const projection of ['SELECT *', 'SELECT DISTINCT 1', 'SELECT 1, 1', 'SELECT ol.id']) {
                const statement = postgresVerifierAdjust(POSTGRES_EXISTS.replace('SELECT 1', projection));

                expect(whereRequiresCorrelatedOwnership(statement, verifierLineScope())).toBe(false);
            }
        });

        it('refuses a set operator inside the sub-query, which answers for rows it never read', () => {
            const statement = postgresVerifierAdjust(POSTGRES_EXISTS.replace(/\)$/, ' UNION SELECT 1)'));

            expect(whereRequiresCorrelatedOwnership(statement, verifierLineScope())).toBe(false);
        });
    });

    describe('refuses a sub-query that scopes something other than the addressed row', () => {
        it('refuses a sub-query over the wrong table', () => {
            const statement = postgresVerifierAdjust(
                POSTGRES_EXISTS.replace('"reorder_list" "owned_list_scope"', '"customer" "owned_list_scope"'),
            );

            expect(whereRequiresCorrelatedOwnership(statement, verifierLineScope())).toBe(false);
        });

        it('refuses a second relation, which lets the correlation and the scope address different rows', () => {
            const statement = postgresVerifierAdjust(
                POSTGRES_EXISTS.replace(
                    '"reorder_list" "owned_list_scope"',
                    '"reorder_list" "owned_list_scope", "reorder_list" "other"',
                ),
            );

            expect(whereRequiresCorrelatedOwnership(statement, verifierLineScope())).toBe(false);
        });

        it('refuses a sub-query with no correlation, which any owned list satisfies', () => {
            const statement = postgresVerifierAdjust(
                'EXISTS (SELECT 1 FROM "reorder_list" "owned_list_scope" ' +
                    'WHERE "owned_list_scope"."customerId" = $4 AND "owned_list_scope"."channelId" = $5)',
            );

            expect(whereRequiresCorrelatedOwnership(statement, verifierLineScope())).toBe(false);
        });

        it('refuses a correlation compared to a bound parameter rather than to the outer column', () => {
            const statement = postgresVerifierAdjust(
                POSTGRES_EXISTS.replace(
                    '"owned_list_scope"."id" = "reorderListId"',
                    '"owned_list_scope"."id" = $3',
                ),
            );

            expect(whereRequiresCorrelatedOwnership(statement, verifierLineScope())).toBe(false);
        });

        it('refuses a correlation qualified by the sub-query own alias, which compares a row to itself', () => {
            const statement = postgresVerifierAdjust(
                POSTGRES_EXISTS.replace(
                    '"owned_list_scope"."id" = "reorderListId"',
                    '"owned_list_scope"."id" = "owned_list_scope"."reorderListId"',
                ),
            );

            expect(whereRequiresCorrelatedOwnership(statement, verifierLineScope())).toBe(false);
        });

        it('refuses a scope comparison that is only a disjunct of the sub-query predicate', () => {
            const statement = postgresVerifierAdjust(
                POSTGRES_EXISTS.replace(
                    'AND "owned_list_scope"."channelId" = $5',
                    'AND ("owned_list_scope"."channelId" = $5 OR "owned_list_scope"."id" = $3)',
                ),
            );

            expect(whereRequiresCorrelatedOwnership(statement, verifierLineScope())).toBe(false);
        });
    });

    describe('refuses an EXISTS that the outer predicate does not require', () => {
        it('refuses an EXISTS under a disjunction', () => {
            const statement = captureVerifierStatement(
                `UPDATE "reorder_list_line" SET "quantity" = $1 WHERE "id" = $2 OR ${POSTGRES_EXISTS}`,
                [7, VERIFIER_LINE_ID, VERIFIER_LIST_ID, VERIFIER_CUSTOMER_ID, VERIFIER_CHANNEL_ID],
                'postgres',
            );

            expect(whereRequiresCorrelatedOwnership(statement, verifierLineScope())).toBe(false);
        });

        it('refuses a negated EXISTS, which requires the row NOT to be owned', () => {
            const statement = postgresVerifierAdjust(`NOT ${POSTGRES_EXISTS}`);

            expect(whereRequiresCorrelatedOwnership(statement, verifierLineScope())).toBe(false);
        });

        it('refuses an EXISTS that is only part of its leaf', () => {
            const statement = postgresVerifierAdjust(`${POSTGRES_EXISTS} IS NOT NULL`);

            expect(whereRequiresCorrelatedOwnership(statement, verifierLineScope())).toBe(false);
        });

        it('refuses a perfect sub-query standing beside an always-true disjunct', () => {
            const statement = captureVerifierStatement(
                'UPDATE "reorder_list_line" SET "quantity" = $1 ' +
                    `WHERE "id" = $2 AND (1 = 1 OR ${POSTGRES_EXISTS})`,
                [7, VERIFIER_LINE_ID, VERIFIER_LIST_ID, VERIFIER_CUSTOMER_ID, VERIFIER_CHANNEL_ID],
                'postgres',
            );

            expect(whereRequiresCorrelatedOwnership(statement, verifierLineScope())).toBe(false);
        });

        it('refuses a statement carrying no EXISTS at all', () => {
            const statement = captureVerifierStatement(
                'UPDATE "reorder_list_line" SET "quantity" = $1 WHERE "id" = $2 AND "reorderListId" = $3',
                [7, VERIFIER_LINE_ID, VERIFIER_LIST_ID],
                'postgres',
            );

            expect(whereRequiresCorrelatedOwnership(statement, verifierLineScope())).toBe(false);
        });
    });

    describe('complements the other two predicate helpers rather than duplicating them', () => {
        it('is the only one of the three that can read the sub-query', () => {
            const statement = postgresVerifierAdjust(POSTGRES_EXISTS);

            // Both of the others refuse the sub-query, deliberately and correctly for what each claims: one
            // recognises only `column <op> operand` as a comparison, and the other blanks any parenthesised
            // SELECT before it looks for a column name. Neither can state the claim a line write makes, which
            // is why the correlated helper exists — and why a suite must not fall back to them.
            expect(
                whereRequiresScopedPredicates(statement, [
                    { column: 'customerId', value: VERIFIER_CUSTOMER_ID },
                    { column: 'channelId', value: VERIFIER_CHANNEL_ID },
                ]),
            ).toBe(false);
            expect(whereMentionsColumns(statement, ['customerId'])).toBe(false);

            expect(whereMentionsColumns(statement, ['id', 'reorderListId'])).toBe(true);
            expect(whereRequiresCorrelatedOwnership(statement, verifierLineScope())).toBe(true);
        });
    });
});
