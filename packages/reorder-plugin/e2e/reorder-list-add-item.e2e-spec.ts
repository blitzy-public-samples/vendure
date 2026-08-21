/*
 * End-to-end specification for `addItemToReorderList` — STORY-001-01-02.
 */
/* eslint-disable @typescript-eslint/no-non-null-assertion */
import {
    ConfigService,
    generateMigration,
    mergeConfig,
    Order,
    OrderLine,
    Permission,
    ProductVariantService,
    RequestContext,
    RequestContextService,
    Session,
    SessionService,
    StockLevelService,
    TransactionalConnection,
    VendureConfig,
} from '@vendure/core';
import { createTestEnvironment, SimpleGraphQLClient } from '@vendure/testing';
import fs from 'fs';
import gql from 'graphql-tag';
import os from 'os';
import path from 'path';
import { DataSource, EntityManager, QueryRunner } from 'typeorm';
import type { SqljsConnectionOptions } from 'typeorm/driver/sqljs/SqljsConnectionOptions';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { initialData } from '../../../e2e-common/e2e-initial-data';
import { TEST_SETUP_TIMEOUT_MS, testConfig } from '../../../e2e-common/test-config';
import { ReorderList, ReorderListLine, ReorderPlugin } from '../index';
import { AddReorderLists1786838400000 } from '../src/migrations/1786838400000-add-reorder-lists';
import {
    AddItemToReorderListResult,
    ReorderListLimitError,
    ReorderListService,
} from '../src/service/reorder-list.service';

import {
    asShopApiContext,
    BarrierParticipantContext,
    BarrierParticipantSpec,
    canonicaliseCell,
    ConcurrencyBarrier,
    createPreWriteRendezvous,
    createTransactionBinder,
    describeRowDifferences,
    describeSettledOutcomes,
    describeTeardownStage,
    EXCLUSIVE_PARENT_FOR_LINE_WRITE_ENGINES,
    NO_ROW_DIFFERENCE,
    PreWriteRendezvous,
    redactTeardownDiagnostic,
    rethrowRedacted,
    runAllTeardownStages,
    runBarrieredPair,
    runSequentialPair,
    SQLJS_EXCLUSION_REASON,
    supportsForcedInterleaving,
    TransactionBinder,
} from './fixtures/concurrency-barrier';
import {
    CapturedStatement,
    committedMigrationApplies,
    isStatementCountEngine,
    queryCaptureConfig,
    QueryCaptureLogger,
    resolveConfiguredEngine,
    STATEMENT_COUNT_ENGINE_REASON,
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
    GET_ACTIVE_CUSTOMER_REORDER_LIST,
    GetActiveCustomerReorderListQuery,
    GetActiveCustomerReorderListQueryVariables,
    ReorderApiId,
    ReorderListSuccessShape,
} from './graphql/reorder-definitions';

// The configured deployment. Configuring a value for a test deployment is NOT choosing a product default: the
// shipped defaults — 200 lines per list and 999 units per line — are the plugin's own, and
// `src/reorder.plugin.spec.ts` asserts them. Only the LINE bound below is reduced, to 2, so that a third
// distinct variant breaches it inside one test exactly as AC-6's Given clause requires. The quantity bound
// keeps the supplied 999 and its result boundary is reached arithmetically instead.

/** AC-6's configured line bound. Small enough that a third distinct variant breaches it. */
const MAX_LINES_PER_LIST = 2;

/**
 * The configured quantity bound: the value AAP §0.1.2.4 supplies for `maxQuantityPerLine`.
 */
const MAX_QUANTITY_PER_LINE = 999;

/**
 * AC-6's resulting-quantity pair, derived from the configured maximum rather than written as literals.
 *
 * The increment is legal on its own and so is the quantity it lands on; their sum is exactly one above the
 * maximum. That is the shape of the criterion — the bound applies to the result, not to the increment — and
 * deriving both figures keeps it true if the configured maximum ever changes.
 */
const OVER_MAXIMUM_INCREMENT = 5;
const SEEDED_BEFORE_OVER_MAXIMUM = MAX_QUANTITY_PER_LINE + 1 - OVER_MAXIMUM_INCREMENT;

/**
 * The per-request quantity both race scenarios use, which is the ticket's own figure of 6.
 *
 * The insert race reconciles two of them to 12, "being the sum of both requested quantities"; the update race
 * adds two of them to a line already holding one, leaving 18 where a read-compute-save implementation leaves
 * 12. Both totals need a configured maximum above 10 to be storable at all.
 */
const RACE_ADD_QUANTITY = 6;

const MAX_LISTS_PER_CUSTOMER = 25;

const DEFAULT_LISTS_PAGE_SIZE = 25;
const DEFAULT_LINES_PAGE_SIZE = 50;

const SEEDED_CUSTOMER_PASSWORD = 'test';

/** The resolved English text of the two quantity message keys, per `packages/reorder-plugin/i18n/en.json`. */
const QUANTITY_MUST_BE_POSITIVE_MESSAGE = 'The quantity for a reorder list line must be a positive integer';
const QUANTITY_ABOVE_MAXIMUM_MESSAGE = `The resulting quantity for this reorder list line would exceed the maximum of ${MAX_QUANTITY_PER_LINE}`;

/** The two raw message keys, so a key passthrough can be asserted against rather than merely hoped away. */
const QUANTITY_MUST_BE_POSITIVE_KEY = 'error.reorder-list-line-quantity-must-be-positive';
const QUANTITY_ABOVE_MAXIMUM_KEY = 'error.reorder-list-line-quantity-above-maximum';
const VARIANT_NOT_FOUND_KEY = 'error.reorder-list-variant-not-found';

/**
 * The shape a resolved `error.reorder-list-variant-not-found` takes.
 *
 * The interpolated identifier is matched rather than spelled, because the platform decodes an `ID`
 * argument before the service sees it, so what reaches the message is the decoded form. What the pattern
 * pins is the part that matters: the message is the registered English sentence and not the raw key.
 */
const VARIANT_NOT_FOUND_MESSAGE_PATTERN =
    /^No ProductVariant with the id "[^"]*" could be found in the active Channel$/;

/**
 * Field names that must appear on no plugin payload, no plugin input and no plugin column.
 *
 * A reorder list line stores a variant reference and an integer quantity. It holds no monetary value, so
 * a price change has nothing to invalidate, and it holds no availability value, because a saved list
 * records intent rather than availability.
 */
const FORBIDDEN_PAYLOAD_FIELD_PATTERN = /price|currenc|money|amount|tax|stock|saleable|availab/i;

const ABSENT_LIST_ID = 'T_9999999';

const ABSENT_VARIANT_ID = 'T_9999999';

/** Reads the seeded customers' e-mail addresses. The seed's addresses are generated, so they are read. */
const GET_CUSTOMER_LIST = gql`
    query GetCustomerListForReorder {
        customers(options: { take: 5, sort: { id: ASC } }) {
            totalItems
            items {
                id
                emailAddress
            }
        }
    }
`;

/** Reads the zones `initialData` created, so a second channel can name a tax and a shipping zone. */
const GET_ZONE_LIST = gql`
    query GetZoneListForReorder {
        zones(options: { take: 1 }) {
            items {
                id
                name
            }
        }
    }
`;

/** Creates the second real channel AC-7's foreign-token half needs. Never a mutated token variable. */
const CREATE_CHANNEL = gql`
    mutation CreateChannelForReorder($input: CreateChannelInput!) {
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

const GET_PRODUCT_VARIANT_LIST = gql`
    query GetProductVariantListForReorder {
        productVariants(options: { take: 10, sort: { sku: ASC } }) {
            totalItems
            items {
                id
                sku
                name
                enabled
                trackInventory
                stockOnHand
                stockAllocated
                stockLevels {
                    id
                    stockLocationId
                    stockOnHand
                    stockAllocated
                }
            }
        }
    }
`;

const UPDATE_PRODUCT_VARIANTS = gql`
    mutation UpdateProductVariantsForReorder($input: [UpdateProductVariantInput!]!) {
        updateProductVariants(input: $input) {
            id
            sku
            enabled
            trackInventory
            stockOnHand
            stockAllocated
            price
            stockLevels {
                id
                stockLocationId
                stockOnHand
                stockAllocated
            }
        }
    }
`;

/** The existing Shop mutation whose name this story's operation is most likely to be confused with. */
const ADD_ITEM_TO_ORDER = gql`
    mutation AddItemToOrderForReorder($productVariantId: ID!, $quantity: Int!) {
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

/** The existing Shop query AC-8 puts under test. Its declared signature takes no arguments. */
const GET_ACTIVE_ORDER = gql`
    query GetActiveOrderForReorder {
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

/**
 * The add mutation with the non-null `quantity` field **omitted from the document text**.
 *
 * It is a separate document rather than a variable set to `undefined`, because the refusal this exercises
 * happens during document validation — before any resolver executes — and only a document that does not
 * mention the field at all can reach it.
 */
const ADD_ITEM_TO_REORDER_LIST_OMITTING_QUANTITY = gql`
    mutation AddItemToReorderListOmittingQuantity($reorderListId: ID!, $productVariantId: ID!) {
        addItemToReorderList(input: { reorderListId: $reorderListId, productVariantId: $productVariantId }) {
            __typename
        }
    }
`;

/** The same mutation passing an explicit literal `null` for the non-null `quantity`. A different request. */
const ADD_ITEM_TO_REORDER_LIST_WITH_NULL_QUANTITY = gql`
    mutation AddItemToReorderListWithNullQuantity($reorderListId: ID!, $productVariantId: ID!) {
        addItemToReorderList(
            input: { reorderListId: $reorderListId, productVariantId: $productVariantId, quantity: null }
        ) {
            __typename
        }
    }
`;

/** Introspects one input type, for the exactly-three-fields assertion. */
const INTROSPECT_INPUT_TYPE = gql`
    query IntrospectInputTypeForReorder($name: String!) {
        __type(name: $name) {
            name
            kind
            inputFields {
                name
                type {
                    kind
                    name
                    ofType {
                        kind
                        name
                    }
                }
            }
        }
    }
`;

/** Introspects one object type's field names, for the no-monetary-and-no-availability-field assertion. */
const INTROSPECT_OBJECT_TYPE = gql`
    query IntrospectObjectTypeForReorder($name: String!) {
        __type(name: $name) {
            name
            kind
            fields {
                name
            }
        }
    }
`;

/**
 * Introspects one union's members, for the four-error-results-not-five assertion.
 *
 * A union's members are `possibleTypes`; `fields` is null on a union, so this cannot share the object-type
 * document above.
 */
const INTROSPECT_UNION_TYPE = gql`
    query IntrospectUnionTypeForReorder($name: String!) {
        __type(name: $name) {
            name
            kind
            possibleTypes {
                name
            }
        }
    }
`;

/**
 * Signs in over the Shop API selecting the permissions the resulting session actually holds.
 *
 * The harness's own sign-in helper does not select them, and AC-7 needs the POSITIVE assertion that an
 * ordinary customer session — holding the single permission the Customer Role is created with and no
 * plugin-registered permission of any name — reaches the operation and succeeds.
 */
const SHOP_LOGIN = gql`
    mutation ShopLoginForReorder($username: String!, $password: String!) {
        login(username: $username, password: $password) {
            __typename
            ... on CurrentUser {
                id
                identifier
                channels {
                    id
                    token
                    permissions
                }
            }
            ... on ErrorResult {
                errorCode
                message
            }
        }
    }
`;

const INTROSPECT_ENUM_TYPE = gql`
    query IntrospectEnumTypeForReorder($name: String!) {
        __type(name: $name) {
            name
            kind
            enumValues {
                name
            }
        }
    }
`;

/**
 * Introspects the root `Query` and `Mutation` field signatures.
 *
 * Four levels of `ofType` are unwrapped, which covers every wrapper the Shop root types use — a
 * non-null list of non-null object types is three.
 */
const INTROSPECT_ROOT_FIELDS = gql`
    query IntrospectRootFieldsForReorder {
        __schema {
            queryType {
                name
                fields {
                    name
                    args {
                        name
                        defaultValue
                        type {
                            ...TypeRefDepth
                        }
                    }
                    type {
                        ...TypeRefDepth
                    }
                }
            }
            mutationType {
                name
                fields {
                    name
                    args {
                        name
                        defaultValue
                        type {
                            ...TypeRefDepth
                        }
                    }
                    type {
                        ...TypeRefDepth
                    }
                }
            }
        }
    }
    fragment TypeRefDepth on __Type {
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

interface SeededCustomer {
    id: ReorderApiId;
    emailAddress: string;
}

interface AdminStockLevel {
    id: ReorderApiId;
    stockLocationId: ReorderApiId;
    stockOnHand: number;
    stockAllocated: number;
}

interface AdminProductVariant {
    id: ReorderApiId;
    sku: string;
    name: string;
    enabled: boolean;
    trackInventory: 'INHERIT' | 'TRUE' | 'FALSE';
    stockOnHand: number;
    stockAllocated: number;
    stockLevels: AdminStockLevel[];
}

interface IntrospectedTypeRef {
    kind: string;
    name: string | null;
    ofType?: IntrospectedTypeRef | null;
}

interface IntrospectedRootField {
    name: string;
    args: Array<{ name: string; defaultValue: string | null; type: IntrospectedTypeRef }>;
    type: IntrospectedTypeRef;
}

interface IntrospectRootFieldsQuery {
    __schema: {
        queryType: { name: string; fields: IntrospectedRootField[] };
        mutationType: { name: string; fields: IntrospectedRootField[] } | null;
    };
}

interface ActiveOrderShape {
    id: ReorderApiId;
    totalQuantity: number;
    lines: Array<{ id: ReorderApiId; quantity: number }>;
}

/**
 * One order a fixture in this file created, together with the exact child rows it brought with it.
 *
 * Both halves are recorded because teardown must remove them in that order — children by identifier, then
 * the parent — rather than letting a parent cascade decide what disappears.
 */
interface TrackedFixtureOrder {
    readonly orderId: number;
    lineIds: number[];
}

// THE SQL.JS SNAPSHOT DIRECTORY, CREATED IDEMPOTENTLY AND AT MODULE SCOPE, FOR TWO SEPARATE REASONS. The first
// is a race. The platform's own initializer creates it with a bare, non-recursive `mkdirSync` guarded by a
// preceding `existsSync` (`packages/testing/src/initializers/sqljs-initializer.ts` L31-L35), which is a
// check-then-act race: this package's e2e suites start together, so when the directory is absent — as it is on
// a fresh checkout, and after the operational reset a schema change requires — two of them can both observe it
// missing and the loser fails its `beforeAll` with `EEXIST`.
fs.mkdirSync(path.join(__dirname, '__data__'), { recursive: true });

describe('ReorderPlugin addItemToReorderList (STORY-001-01-02)', () => {
    /**
     * The query-capture instrument, installed once for the life of the server and reset in `beforeEach`.
     *
     * It is a class INSTANCE and is merged in through {@link queryCaptureConfig}, because `mergeConfig`
     * assigns a class instance by reference while it deep-merges a plain object literal onto a fresh
     * target — so only the instance form keeps `capture.reset()` reaching the object TypeORM holds.
     */
    const capture = new QueryCaptureLogger();

    /**
     * `testConfig()` is called in THIS file, never in a fixture module: it derives the server's port from
     * the calling file's own index within its own directory listing, so a call made from `e2e/fixtures/`
     * would index against that directory and could collide two suites on one port. No port is hard-coded.
     */
    const baseConfig = testConfig();

    /**
     * The configuration the server under test boots from, held in a constant rather than inlined because the
     * empty-generation assertion at the end of this file has to hand the platform generator the very same
     * options the running server was built from.
     */
    const suiteConfig = mergeConfig(baseConfig, {
        plugins: [
            ReorderPlugin.init({
                maxListsPerCustomer: MAX_LISTS_PER_CUSTOMER,
                maxLinesPerList: MAX_LINES_PER_LIST,
                maxQuantityPerLine: MAX_QUANTITY_PER_LINE,
                defaultReorderListsPageSize: DEFAULT_LISTS_PAGE_SIZE,
                defaultReorderListLinesPageSize: DEFAULT_LINES_PAGE_SIZE,
            }),
        ],
        importExportOptions: {
            importAssetsDir: path.join(__dirname, '../../core/e2e/fixtures/assets'),
        },
        ...queryCaptureConfig(capture),
    });

    const { server, adminClient, shopClient } = createTestEnvironment(suiteConfig);

    /** The running server's own data source. Obtained once the server has booted, never constructed here. */
    let dataSource: DataSource;

    /**
     * The running server's own service instance, resolved from the injector rather than constructed.
     */
    let reorderListService: ReorderListService;

    /** The identifiers of every order this file's own fixture created, removed in `afterEach`. */
    const ordersToRemove: TrackedFixtureOrder[] = [];

    /**
     * The verified binding that puts a real service operation on a barrier participant's own transaction.
     *
     * Built once, and `createTransactionBinder` proves the platform honours it before returning — so a
     * mechanism that stopped working fails here, loudly, rather than leaving every race silently unbound.
     */
    let transactionBinder: TransactionBinder;

    /** The seeded customers, read through the Admin API because the seed generates their addresses. */
    let seededCustomers: SeededCustomer[];

    let seededVariants: AdminProductVariant[];

    let defaultChannelToken: string;

    /** A second REAL channel token, created through the Admin API. Never a mutated variable. */
    let secondChannelToken: string;

    /**
     * The teardown ledger: the decoded identifier of every list this file created, in creation order.
     *
     * It is deliberately NOT a fixture variable — no assertion reads it. Epic §11.6.1 forbids a sibling
     * test's identifiers being shared through file scope, and this holds nothing but the rows `afterEach`
     * has to remove. Each test keeps the identifiers it asserts on in its own local scope.
     */
    const listIdsToDelete: number[] = [];

    /** Restorations for core rows a test mutated but did not create, run in reverse order in `afterEach`. */
    const coreRowRestorations: Array<() => Promise<void>> = [];

    /** Temporary directories a test created, removed in `afterEach` so the working tree stays clean. */
    const temporaryDirectories: string[] = [];

    beforeAll(async () => {
        await server.init({
            initialData,
            productsCsvPath: path.join(__dirname, '../../core/e2e/fixtures/e2e-products-minimal.csv'),
            customerCount: 2,
        });

        dataSource = server.app.get(TransactionalConnection).rawConnection;
        reorderListService = server.app.get(ReorderListService);
        transactionBinder = await createTransactionBinder(server.app.get(TransactionalConnection));
        const configuredChannelToken = baseConfig.defaultChannelToken;
        expect(typeof configuredChannelToken).toBe('string');
        defaultChannelToken = configuredChannelToken ?? '';
        expect(defaultChannelToken.length).toBeGreaterThan(0);

        await adminClient.asSuperAdmin();

        const { customers } = await adminClient.query<{
            customers: { totalItems: number; items: SeededCustomer[] };
        }>(GET_CUSTOMER_LIST);
        seededCustomers = customers.items;
        expect(seededCustomers.length).toBeGreaterThanOrEqual(2);

        const { productVariants } = await adminClient.query<{
            productVariants: { totalItems: number; items: AdminProductVariant[] };
        }>(GET_PRODUCT_VARIANT_LIST);
        seededVariants = productVariants.items.filter(variant => variant.enabled);
        expect(seededVariants.length).toBeGreaterThanOrEqual(4);

        const { zones } = await adminClient.query<{ zones: { items: Array<{ id: ReorderApiId }> } }>(
            GET_ZONE_LIST,
        );
        expect(zones.items.length).toBeGreaterThanOrEqual(1);
        const zoneId = zones.items[0].id;

        const { createChannel } = await adminClient.query<{
            createChannel: { __typename: string; id?: ReorderApiId; token?: string; message?: string };
        }>(CREATE_CHANNEL, {
            input: {
                code: 'reorder-second-channel',
                token: 'reorder-second-channel-token',
                defaultLanguageCode: 'en',
                pricesIncludeTax: false,
                defaultCurrencyCode: 'USD',
                defaultTaxZoneId: zoneId,
                defaultShippingZoneId: zoneId,
            },
        });
        expect(createChannel.__typename).toBe('Channel');
        expect(createChannel.token).toBeDefined();
        secondChannelToken = createChannel.token!;
    }, TEST_SETUP_TIMEOUT_MS);

    /*
     * Unconditional, per epic §11.6.1: a specification that destroys the server only on its success path
     * leaks a listening port into the next file.
     */
    afterAll(async () => {
        await server.destroy();
    });

    beforeEach(() => {
        // Epic §11.6.2: the captured array is emptied per test, so a count is scoped to one test and never to a
        // file. Capture itself stays disabled until a test enables it around one operation.
        capture.disable();
        capture.reset();
    });

    afterEach(async () => {
        /*
         * EVERY STAGE RUNS, whatever any of them does, and the failures are reported once at the end. A linear
         * teardown stops at the first failure and strands the rest, which is how one broken test leaves the next
         * running against state it never established.
         */
        const queued = coreRowRestorations.splice(0, coreRowRestorations.length).reverse();
        const directories = temporaryDirectories.splice(0, temporaryDirectories.length);
        await runAllTeardownStages([
            { what: 'plugin rows', run: deleteTrackedPluginRows },
            { what: 'fixture orders', run: removeTrackedOrders },
            ...queued.map((restore, index) => ({
                what: `core row restoration ${String(queued.length - index)}`,
                run: restore,
            })),
            // An index, never the path. `stage.what` is reproduced VERBATIM by the teardown aggregator —
            // deliberately, because the stage name is this file's own text and identifies the step that failed
            // — so anything interpolated into it is published as-is. An absolute temporary directory discloses
            // the layout of whatever machine ran the suite, and nothing about the assertion needs it: the path
            // stays in the closure below, where the removal uses it and no log reads it.
            ...directories.map((directory, index) => ({
                what: `temporary directory ${String(index + 1)} of ${String(directories.length)}`,
                run: () => {
                    if (fs.existsSync(directory)) {
                        fs.rmSync(directory, { recursive: true, force: true });
                    }
                    return Promise.resolve();
                },
            })),
            {
                what: 'client and capture reset',
                run: () => {
                    shopClient.setChannelToken(defaultChannelToken);
                    capture.disable();
                    capture.reset();
                    return Promise.resolve();
                },
            },
        ]);
    });

    /**
     * Decodes an API identifier to the primary key the database stores.
     *
     * The shared harness configures the testing entity-id strategy, which encodes an auto-increment key
     * as `T_<n>` and decodes it by stripping that prefix, so the decoded form is what a predicate
     * assertion has to compare a bound parameter against.
     */
    function decodeId(id: ReorderApiId): number {
        const decoded = parseInt(String(id).replace('T_', ''), 10);
        expect(Number.isNaN(decoded)).toBe(false);
        return decoded;
    }

    async function signInAsCustomer(index: number): Promise<SeededCustomer> {
        const customer = seededCustomers[index];
        expect(customer).toBeDefined();
        await shopClient.asUserWithCredentials(customer.emailAddress, SEEDED_CUSTOMER_PASSWORD);
        // `asUserWithCredentials` adopts the token of the single channel the login result reports, so the
        // channel this suite means to act in is set explicitly afterwards rather than assumed.
        shopClient.setChannelToken(defaultChannelToken);
        return customer;
    }

    /**
     * Runs a fixture step that may commit `reorder_list` rows, and registers every row it committed.
     */
    async function trackListsCommittedBy<T>(run: () => Promise<T>): Promise<T> {
        const before = (await dataSource.getRepository(ReorderList).find({ select: { id: true } })).map(row =>
            Number(row.id),
        );
        try {
            return await run();
        } finally {
            const after = await dataSource.getRepository(ReorderList).find({ select: { id: true } });
            for (const row of after) {
                const id = Number(row.id);
                if (!before.includes(id) && !listIdsToDelete.includes(id)) {
                    listIdsToDelete.push(id);
                }
            }
        }
    }

    /** Creates one list for the currently authenticated customer and registers it for teardown. */
    async function createList(name: string): Promise<ReorderListSuccessShape> {
        const { createReorderList } = await trackListsCommittedBy(() =>
            shopClient.query<CreateReorderListMutation, CreateReorderListMutationVariables>(
                CREATE_REORDER_LIST,
                { input: { name } },
            ),
        );
        expect(createReorderList.__typename).toBe('ReorderList');
        return createReorderList as ReorderListSuccessShape;
    }

    function addItem(
        reorderListId: ReorderApiId,
        productVariantId: ReorderApiId,
        quantity: number,
    ): Promise<AddItemToReorderListMutation> {
        return shopClient.query<AddItemToReorderListMutation, AddItemToReorderListMutationVariables>(
            ADD_ITEM_TO_REORDER_LIST,
            { input: { reorderListId, productVariantId, quantity } },
        );
    }

    function addItemCaptured(
        reorderListId: ReorderApiId,
        productVariantId: ReorderApiId,
        quantity: number,
    ): Promise<AddItemToReorderListMutation> {
        return capture.capture(() => addItem(reorderListId, productVariantId, quantity));
    }

    function readLineRows(listId: number): Promise<ReorderListLine[]> {
        return dataSource.getRepository(ReorderListLine).find({
            where: { reorderListId: listId },
            order: { id: 'ASC' },
        });
    }

    function readListRow(listId: number): Promise<ReorderList | null> {
        return dataSource.getRepository(ReorderList).findOne({ where: { id: listId } });
    }

    function countAllLineRows(): Promise<number> {
        return dataSource.getRepository(ReorderListLine).count();
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
     * Runs a fixture step that may commit an order, and registers every order it committed — whatever the step, or
     * anything the caller does with its response, then does.
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
     */
    async function removeTrackedOrders(): Promise<void> {
        const tracked = ordersToRemove.splice(0, ordersToRemove.length);
        const failures: string[] = [];
        for (const entry of tracked) {
            try {
                await removeOneTrackedOrder(entry);
            } catch (err: unknown) {
                // Measured, not reproduced. Removing an order writes across `order`, `order_line` and the
                // buyer's `session` rows, so a driver failure here is a `QueryFailedError` carrying the
                // statement and its bound values — and this aggregate is thrown and printed by the runner. The
                // order identifier is kept, on the same footing as a row id: it is what locates the entry that
                // would not go, and it describes nobody.
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

    // Exact restoration of the core rows a test changes. A core row this suite touches is put back COLUMN FOR
    // COLUMN and the restoration is then ASSERTED against what was captured, and a restoration naming only the
    // column it is undoing satisfies neither of the two mechanisms that make that strict: the compensating
    // write goes through the RAW TABLE rather than the entity manager, so restoring a captured value cannot
    // itself move an entity-managed audit column, and it covers an inserted row and a deleted row alike by
    // deleting or re-inserting as the capture requires.

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
            // THE ONE DIAGNOSTIC SINK THAT REDACTING AT THE CALLER CANNOT CLOSE, WHICH IS WHY IT IS CLOSED
            // HERE. Every statement this helper runs binds CAPTURED CELLS: the values a restoration is putting
            // back, which on the soft-delete path are a live buyer's `customer`, `user` and `session` rows — an
            // address, a password hash, an authentication token.
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
        coreRowRestorations.push(async () => {
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
            // AND THE UPDATE-DATE COLUMN IS ALWAYS RE-STATED, even when it did not move.
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

    /** Deletes exactly the plugin rows this test created, child table before parent. */
    async function deleteTrackedPluginRows(): Promise<void> {
        if (listIdsToDelete.length === 0) {
            return;
        }
        const ids = [...listIdsToDelete];
        listIdsToDelete.length = 0;
        await dataSource
            .createQueryBuilder()
            .delete()
            .from(ReorderListLine)
            .where('reorderListId IN (:...ids)', { ids })
            .execute();
        await dataSource
            .createQueryBuilder()
            .delete()
            .from(ReorderList)
            .where('id IN (:...ids)', { ids })
            .execute();
    }

    /**
     * Replaces the two plugin tables with THE CHECKED-IN MIGRATION'S OWN OUTPUT, on the live connection.
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
     * The configuration the platform generator runs against, resolved so that the plugin tables in the database it
     * opens are the ones the checked-in migration created.
     */
    async function generatorConfigAgainstMigratedSchema(
        scratchDirectory: string,
    ): Promise<Partial<VendureConfig>> {
        if (dataSource.options.type !== 'sqljs') {
            return suiteConfig;
        }
        const snapshot = path.join(scratchDirectory, 'migrated-schema.sqlite');
        await dataSource.sqljsManager.saveDatabase(snapshot);
        return {
            ...suiteConfig,
            dbConnectionOptions: {
                ...(suiteConfig.dbConnectionOptions as SqljsConnectionOptions),
                location: snapshot,
                autoSave: false,
            },
        };
    }

    /** One entry of a refused response's top-level `errors` array. */
    interface TopLevelErrorEntry {
        message: string;
        extensions?: { code?: string };
    }

    /**
     * A refused request's response envelope, exactly as the server sent it.
     *
     * `data` is typed to admit all three envelopes a refusal can produce — an object, `null`, and absent —
     * because they are materially different responses and each assertion names the one it requires. It is
     * deliberately NOT collapsed to a single form.
     */
    interface TopLevelRefusal {
        errors: TopLevelErrorEntry[];
        data?: { addItemToReorderList?: unknown } | null;
    }

    /**
     * The unmodified envelope of a request the server refused.
     */
    async function expectRefusal(run: () => Promise<unknown>): Promise<TopLevelRefusal> {
        try {
            await run();
        } catch (err: unknown) {
            const response = (err as { response?: TopLevelRefusal }).response;
            expect(response, 'The refusal carried no response envelope').toBeDefined();
            expect(
                Array.isArray(response?.errors),
                `The refusal carried no errors array: ${JSON.stringify(response)}`,
            ).toBe(true);
            return response as TopLevelRefusal;
        }
        throw new Error('Expected the request to be refused with a top-level error, but it succeeded.');
    }

    /**
     * Asserts one top-level `USER_INPUT_ERROR` carrying exactly the given resolved message, on an envelope whose
     * `data` is exactly null.
     */
    function expectSingleUserInputError(
        refusal: TopLevelRefusal,
        expectedMessage: string,
        rawKey: string,
    ): void {
        expect(refusal.errors.length).toBe(1);
        expect(refusal.errors[0].extensions?.code).toBe('USER_INPUT_ERROR');
        expect(refusal.errors[0].message).toBe(expectedMessage);
        expect(refusal.errors[0].message).not.toBe(rawKey);
        expect(
            refusal.data,
            `Expected the envelope to carry data exactly null: ${JSON.stringify(refusal.data)}`,
        ).toBeNull();
    }

    /** Renders an introspected type reference in SDL form, so two signatures compare as one string. */
    function renderTypeRef(ref: IntrospectedTypeRef | null | undefined): string {
        if (!ref) {
            return '';
        }
        if (ref.kind === 'NON_NULL') {
            return `${renderTypeRef(ref.ofType)}!`;
        }
        if (ref.kind === 'LIST') {
            return `[${renderTypeRef(ref.ofType)}]`;
        }
        return ref.name ?? '';
    }

    function renderFieldSignature(field: IntrospectedRootField): string {
        const args = (field.args ?? [])
            .map(arg => {
                const defaultValue = arg.defaultValue === null ? '' : ` = ${arg.defaultValue}`;
                return `${arg.name}: ${renderTypeRef(arg.type)}${defaultValue}`;
            })
            .join(', ');
        return `${field.name}(${args}): ${renderTypeRef(field.type)}`;
    }

    /** The checked-in Shop introspection snapshot, read only — never edited and never regenerated. */
    function readShopSchemaSnapshot(): {
        queryFields: IntrospectedRootField[];
        mutationFields: IntrospectedRootField[];
        errorCodes: string[];
        permissions: string[];
    } {
        const snapshotPath = path.join(__dirname, '../../../schema-shop.json');
        const parsed = JSON.parse(fs.readFileSync(snapshotPath, 'utf-8'));
        const types: Array<Record<string, any>> = parsed.data.__schema.types;
        const findType = (name: string) => types.find(type => type.name === name);
        return {
            queryFields: findType('Query')?.fields ?? [],
            mutationFields: findType('Mutation')?.fields ?? [],
            errorCodes: (findType('ErrorCode')?.enumValues ?? []).map((value: any) => value.name as string),
            permissions: (findType('Permission')?.enumValues ?? []).map((value: any) => value.name as string),
        };
    }

    /** Strips every engine's identifier quoting, so one statement-shape pattern reads on all four. */
    function unquoteIdentifiers(query: string): string {
        return query.replace(/[`"[\]]/g, '');
    }

    /**
     * True when the statement adds to the stored quantity **in SQL** rather than assigning a value the
     * caller computed.
     */
    function addsToStoredQuantity(statement: CapturedStatement): boolean {
        return /\bquantity\s*=\s*quantity\s*\+/i.test(unquoteIdentifiers(statement.query));
    }

    describe('AC-1: a variant is added to an empty list at the requested integer quantity', () => {
        it('stores one line at the requested quantity and returns the affected list', async () => {
            await signInAsCustomer(0);
            const list = await createList('AC-1 weekly grocery restock');
            const listId = decodeId(list.id);
            const variant = seededVariants[0];
            expect(variant.enabled).toBe(true);

            expect(list.lineCount).toBe(0);
            expect(list.lines.totalItems).toBe(0);
            expect(await readLineRows(listId)).toHaveLength(0);

            const { addItemToReorderList } = await addItem(list.id, variant.id, 6);

            expect(addItemToReorderList.__typename).toBe('ReorderList');
            const updated = addItemToReorderList as ReorderListSuccessShape;
            expect(updated.id).toBe(list.id);
            expect(updated.lineCount).toBe(1);
            expect(updated.lines.totalItems).toBe(1);
            expect(updated.lines.items).toHaveLength(1);
            expect(updated.lines.items[0].productVariantId).toBe(variant.id);
            expect(updated.lines.items[0].quantity).toBe(6);

            const rows = await readLineRows(listId);
            expect(rows).toHaveLength(1);
            expect(decodeId(rows[0].reorderListId)).toBe(listId);
            expect(decodeId(rows[0].productVariantId)).toBe(decodeId(variant.id));
            expect(rows[0].quantity).toBe(6);
        });

        it('stores no monetary column on the line: the table carries exactly six columns', () => {
            const columns = dataSource
                .getMetadata(ReorderListLine)
                .columns.map(column => column.databaseName)
                .sort();

            expect(columns).toEqual(
                ['createdAt', 'id', 'productVariantId', 'quantity', 'reorderListId', 'updatedAt'].sort(),
            );
            for (const column of columns) {
                expect(FORBIDDEN_PAYLOAD_FIELD_PATTERN.test(column)).toBe(false);
            }
        });

        it('returns the same line under a second languageCode, because a quantity is not translated', async () => {
            await signInAsCustomer(0);
            const list = await createList('AC-1 language invariance');
            const variant = seededVariants[0];
            await addItem(list.id, variant.id, 6);

            const readInEnglish = await shopClient.query<
                GetActiveCustomerReorderListQuery,
                GetActiveCustomerReorderListQueryVariables
            >(GET_ACTIVE_CUSTOMER_REORDER_LIST, { id: list.id }, { languageCode: 'en' });
            const readInGerman = await shopClient.query<
                GetActiveCustomerReorderListQuery,
                GetActiveCustomerReorderListQueryVariables
            >(GET_ACTIVE_CUSTOMER_REORDER_LIST, { id: list.id }, { languageCode: 'de' });

            expect(readInEnglish.activeCustomerReorderList).not.toBeNull();
            expect(readInGerman.activeCustomerReorderList).not.toBeNull();
            const english = readInEnglish.activeCustomerReorderList!;
            const german = readInGerman.activeCustomerReorderList!;

            expect(german.lineCount).toBe(english.lineCount);
            expect(german.lines.totalItems).toBe(english.lines.totalItems);
            expect(german.lines.items).toHaveLength(1);
            expect(german.lines.items[0].id).toBe(english.lines.items[0].id);
            expect(german.lines.items[0].quantity).toBe(english.lines.items[0].quantity);
            expect(german.lines.items[0].productVariantId).toBe(english.lines.items[0].productVariantId);
            expect(german.lines.items[0].productVariant).not.toBeNull();
            expect(typeof german.lines.items[0].productVariant!.name).toBe('string');
        });

        it('publishes no monetary, currency or availability field on any payload it returns', async () => {
            for (const typeName of [
                'ReorderList',
                'ReorderListLine',
                'ReorderListViewerAccess',
                'ReorderListList',
                'ReorderListLineList',
            ]) {
                const { __type } = await shopClient.query<{
                    __type: { name: string; kind: string; fields: Array<{ name: string }> } | null;
                }>(INTROSPECT_OBJECT_TYPE, { name: typeName });
                expect(__type).not.toBeNull();
                expect(__type!.fields.length).toBeGreaterThan(0);
                for (const field of __type!.fields) {
                    expect(
                        FORBIDDEN_PAYLOAD_FIELD_PATTERN.test(field.name),
                        `${typeName}.${field.name} must not exist: this feature stores and returns no ` +
                            'monetary, currency or availability value',
                    ).toBe(false);
                }
            }
        });

        it('writes no OrderLine row: adding to a list is not adding to a cart', async () => {
            await signInAsCustomer(0);
            const list = await createList('AC-1 no order line');
            const variant = seededVariants[0];
            const orderLinesBefore = await dataSource.getRepository(OrderLine).count();

            await addItem(list.id, variant.id, 6);

            expect(await dataSource.getRepository(OrderLine).count()).toBe(orderLinesBefore);
        });
    });

    describe('AC-2: a second add for the same variant resolves to the existing line and accumulates', () => {
        const FIRST_ADD_QUANTITY = 6;
        const SECOND_ADD_QUANTITY = 6;
        const ACCUMULATED_QUANTITY = FIRST_ADD_QUANTITY + SECOND_ADD_QUANTITY;

        it('leaves one line whose quantity is the sum and whose identifier is unchanged', async () => {
            await signInAsCustomer(0);
            const list = await createList('AC-2 accumulate on duplicate');
            const listId = decodeId(list.id);
            const variant = seededVariants[0];

            const first = await addItem(list.id, variant.id, FIRST_ADD_QUANTITY);
            expect(first.addItemToReorderList.__typename).toBe('ReorderList');
            const afterFirst = first.addItemToReorderList as ReorderListSuccessShape;
            expect(afterFirst.lines.items).toHaveLength(1);
            expect(afterFirst.lines.items[0].quantity).toBe(FIRST_ADD_QUANTITY);
            const firstLineId = afterFirst.lines.items[0].id;

            const second = await addItem(list.id, variant.id, SECOND_ADD_QUANTITY);

            expect(second.addItemToReorderList.__typename).toBe('ReorderList');
            const afterSecond = second.addItemToReorderList as ReorderListSuccessShape;
            expect(afterSecond.lineCount).toBe(1);
            expect(afterSecond.lines.totalItems).toBe(1);
            expect(afterSecond.lines.items).toHaveLength(1);
            expect(afterSecond.lines.items[0].quantity).toBe(ACCUMULATED_QUANTITY);
            expect(afterSecond.lines.items[0].id).toBe(firstLineId);
            expect(afterSecond.lines.items[0].productVariantId).toBe(variant.id);

            const rows = await readLineRows(listId);
            expect(rows).toHaveLength(1);
            expect(String(rows[0].id)).toBe(String(decodeId(firstLineId)));
            expect(rows[0].quantity).toBe(ACCUMULATED_QUANTITY);
        });

        it('adds to the stored quantity in SQL, never a read followed by a save', async () => {
            await signInAsCustomer(0);
            const list = await createList('AC-2 atomic increment shape');
            const variant = seededVariants[0];
            await addItem(list.id, variant.id, FIRST_ADD_QUANTITY);

            const result = await addItemCaptured(list.id, variant.id, SECOND_ADD_QUANTITY);

            // Behavioural half, on all four engine jobs: the stored quantity is the sum.
            expect(result.addItemToReorderList.__typename).toBe('ReorderList');
            const accumulated = result.addItemToReorderList as ReorderListSuccessShape;
            expect(accumulated.lines.items[0].quantity).toBe(ACCUMULATED_QUANTITY);

            /*
             * Shape half, also on all four engine jobs, and it opens with the POSITIVE requirement because without
             * one the whole assertion is vacuous.
             */
            const lineWrites = capture.writesFor('reorder_list_line');
            expect(
                lineWrites.filter(statement => statement.kind === 'update' && addsToStoredQuantity(statement))
                    .length,
                `Expected exactly one self-referential increment, filtered to reorder_list_line:\n${capture.format()}`,
            ).toBe(1);
            // COUNTS, NEVER THE ARRAYS. `CapturedStatement` carries its raw bound `parameters` by design —
            // that is what makes the predicate assertions in this file possible — so handing one of these
            // arrays to a matcher makes a count regression print those parameters into a build log.
            // `capture.format()` is the redacted rendering and is what the messages here carry.
            expect(
                lineWrites.filter(
                    statement => statement.kind === 'update' && !addsToStoredQuantity(statement),
                ).length,
            ).toBe(0);
            expect(lineWrites.filter(statement => statement.kind === 'insert').length).toBe(0);
            expect(lineWrites.filter(statement => statement.kind === 'delete').length).toBe(0);
        });

        it.skipIf(!isStatementCountEngine())(
            `issues exactly one scoped statement against reorder_list_line — ${STATEMENT_COUNT_ENGINE_REASON}`,
            async () => {
                const customer = await signInAsCustomer(0);
                const list = await createList('AC-2 counted atomic increment');
                const variant = seededVariants[0];
                await addItem(list.id, variant.id, FIRST_ADD_QUANTITY);

                await addItemCaptured(list.id, variant.id, SECOND_ADD_QUANTITY);

                // Plugin-statement boundary, filtered to `reorder_list_line` by name and asserted as an
                // equality — the only boundary at which this suite states an exact number.
                const lineWrites = capture.writesFor('reorder_list_line');
                expect(lineWrites.length).toBe(1);
                const increment = lineWrites[0];
                expect(increment.kind).toBe('update');
                expect(addsToStoredQuantity(increment)).toBe(true);

                const listRow = await readListRow(decodeId(list.id));
                expect(listRow).not.toBeNull();

                /*
                 * The row is addressed by its own identifier beside its parent's, and the acting customer
                 * and the active channel reach the same statement through a correlated sub-query over the
                 * parent table — a line row holds neither, so this is the only shape that can carry them.
                 */
                expect(
                    whereRequiresCorrelatedOwnership(increment, {
                        table: 'reorder_list',
                        correlation: { column: 'id', outerColumn: 'reorderListId' },
                        predicates: [
                            { column: 'customerId', value: decodeId(customer.id) },
                            { column: 'channelId', value: decodeId(listRow!.channelId) },
                        ],
                    }),
                ).toBe(true);
                expect(whereMentionsColumns(increment, ['id', 'reorderListId'])).toBe(true);
            },
        );

        it('returns no error result on the duplicate path: a duplicate add is a defined outcome', async () => {
            await signInAsCustomer(0);
            const list = await createList('AC-2 duplicate is not an error');
            const variant = seededVariants[0];
            await addItem(list.id, variant.id, FIRST_ADD_QUANTITY);

            const { addItemToReorderList } = await addItem(list.id, variant.id, SECOND_ADD_QUANTITY);

            expect(addItemToReorderList.__typename).toBe('ReorderList');
            expect(addItemToReorderList).not.toHaveProperty('errorCode');
            expect(addItemToReorderList).not.toHaveProperty('maxItems');
        });
    });

    describe("AC-3: an unknown list and another customer's list both return ReorderListNotFoundError", () => {
        it('returns responses indistinguishable in errorCode and in every field, and writes nothing', async () => {
            const secondCustomer = await signInAsCustomer(1);
            const foreignList = await createList('AC-3 second customer list');
            const foreignListId = decodeId(foreignList.id);
            await addItem(foreignList.id, seededVariants[0].id, 1);
            const foreignLineCountBefore = (await readLineRows(foreignListId)).length;
            expect(foreignLineCountBefore).toBe(1);
            expect(secondCustomer.id).not.toBe(seededCustomers[0].id);

            await signInAsCustomer(0);
            const totalLineRowsBefore = await countAllLineRows();

            const absent = await addItem(ABSENT_LIST_ID, seededVariants[1].id, 6);
            const foreign = await addItem(foreignList.id, seededVariants[1].id, 6);

            expect(absent.addItemToReorderList.__typename).toBe('ReorderListNotFoundError');
            expect(foreign.addItemToReorderList.__typename).toBe('ReorderListNotFoundError');

            const absentError = absent.addItemToReorderList as { errorCode: string; message: string };
            const foreignError = foreign.addItemToReorderList as { errorCode: string; message: string };
            expect(absentError.errorCode).toBe('REORDER_LIST_NOT_FOUND_ERROR');
            expect(typeof absentError.message).toBe('string');
            expect(absentError.message.length).toBeGreaterThan(0);

            expect(Object.keys(absent.addItemToReorderList).sort()).toEqual(
                Object.keys(foreign.addItemToReorderList).sort(),
            );
            expect(absent.addItemToReorderList).toEqual(foreign.addItemToReorderList);
            expect(foreignError.errorCode).toBe(absentError.errorCode);
            expect(foreignError.message).toBe(absentError.message);

            expect(await countAllLineRows()).toBe(totalLineRowsBefore);
            expect(await readLineRows(foreignListId)).toHaveLength(foreignLineCountBefore);
            const foreignRow = await readListRow(foreignListId);
            expect(foreignRow).not.toBeNull();
            expect(foreignRow!.lineCount).toBe(foreignLineCountBefore);
        });

        it.skipIf(!isStatementCountEngine())(
            `refuses the write after exactly one scoped read — ${STATEMENT_COUNT_ENGINE_REASON}`,
            async () => {
                const customer = await signInAsCustomer(0);
                const ownList = await createList('AC-3 refused write statement contract');
                const ownRow = await readListRow(decodeId(ownList.id));
                expect(ownRow).not.toBeNull();

                const result = await addItemCaptured(ABSENT_LIST_ID, seededVariants[0].id, 6);
                expect(result.addItemToReorderList.__typename).toBe('ReorderListNotFoundError');

                /*
                 * FEATURE-001-01 §2.6.1.1, asserted rather than paraphrased: exactly one scoped statement against
                 * the addressed plugin table, its `WHERE` carrying the acting customer and the active channel as
                 * conjuncts beside the row's own identifier, and no INSERT, UPDATE or DELETE at all.
                 */
                const listStatements = capture.forTables('reorder_list');
                expect(listStatements.length).toBe(1);
                const scopedRead = listStatements[0];
                expect(scopedRead.kind).toBe('select');
                expect(
                    whereRequiresScopedPredicates(scopedRead, [
                        { column: 'id', value: decodeId(ABSENT_LIST_ID), relation: 'ReorderList' },
                        { column: 'customerId', value: decodeId(customer.id), relation: 'ReorderList' },
                        { column: 'channelId', value: decodeId(ownRow!.channelId), relation: 'ReorderList' },
                    ]),
                ).toBe(true);
                expect(capture.writesFor('reorder_list', 'reorder_list_line').length).toBe(0);
                expect(capture.forTables('reorder_list_line').length).toBe(0);
            },
        );
    });

    describe('AC-4: an unauthenticated request writes no line', () => {
        it('returns exactly one FORBIDDEN entry with a null payload and leaves the list empty', async () => {
            await signInAsCustomer(0);
            const list = await createList('AC-4 unauthenticated write');
            const listId = decodeId(list.id);
            const totalLineRowsBefore = await countAllLineRows();

            await shopClient.asAnonymousUser();
            shopClient.setChannelToken(defaultChannelToken);

            const refusal = await expectRefusal(() => addItem(list.id, seededVariants[0].id, 6));

            expect(refusal.errors).toHaveLength(1);
            /*
             * FORBIDDEN, never UNAUTHORIZED. The platform raises an unauthorized error where credentials do
             * not match; an absent session on a permission-gated operation is forbidden. The refusal comes
             * from the service's own session guard rather than from the `@Allow` gate, because that gate
             * admits a session which does not hold the permission it lists.
             */
            expect(refusal.errors[0].extensions?.code).toBe('FORBIDDEN');
            expect(refusal.errors[0].extensions?.code).not.toBe('UNAUTHORIZED');
            expect(
                refusal.data,
                `Expected the envelope to carry data exactly null: ${JSON.stringify(refusal.data)}`,
            ).toBeNull();

            expect(await countAllLineRows()).toBe(totalLineRowsBefore);
            expect(await readLineRows(listId)).toHaveLength(0);
            const row = await readListRow(listId);
            expect(row).not.toBeNull();
            expect(row!.lineCount).toBe(0);
        });

        it.skipIf(!isStatementCountEngine())(
            `touches neither plugin table — ${STATEMENT_COUNT_ENGINE_REASON}`,
            async () => {
                await signInAsCustomer(0);
                const list = await createList('AC-4 counted refusal');
                await shopClient.asAnonymousUser();
                shopClient.setChannelToken(defaultChannelToken);

                await expectRefusal(() => addItemCaptured(list.id, seededVariants[0].id, 6));

                expect(capture.forTables('reorder_list').length).toBe(0);
                expect(capture.forTables('reorder_list_line').length).toBe(0);
            },
        );
    });

    describe('AC-5: a list line is not a stock reservation', () => {
        /**
         * Puts one variant into the state AC-5 describes — tracked, four on hand, none allocated — and
         * registers the restoration of every column it changed, because the variant is a core row this test
         * did not create.
         */
        async function trackVariantWithFourOnHand(
            variant: AdminProductVariant,
        ): Promise<AdminProductVariant> {
            // EVERY COLUMN of every core row this change disturbs, captured before the write and queued for
            // exact restoration with the assertion that it happened.
            const variantDbId = decodeId(variant.id);
            await captureCoreRows('product_variant', 'captured_row.id = :variantId', {
                variantId: variantDbId,
            });
            await captureCoreRows('stock_level', 'captured_row.productVariantId = :variantId', {
                variantId: variantDbId,
            });
            await captureCoreRows('stock_movement', 'captured_row.productVariantId = :variantId', {
                variantId: variantDbId,
            });

            const { updateProductVariants } = await adminClient.query<{
                updateProductVariants: AdminProductVariant[];
            }>(UPDATE_PRODUCT_VARIANTS, {
                input: [{ id: variant.id, trackInventory: 'TRUE', stockOnHand: 4 }],
            });
            expect(updateProductVariants).toHaveLength(1);
            const tracked = updateProductVariants[0];
            expect(tracked.trackInventory).toBe('TRUE');
            expect(tracked.stockOnHand).toBe(4);
            expect(tracked.stockAllocated).toBe(0);
            return tracked;
        }

        async function readVariantStock(variantId: ReorderApiId): Promise<AdminProductVariant> {
            const { productVariants } = await adminClient.query<{
                productVariants: { items: AdminProductVariant[] };
            }>(GET_PRODUCT_VARIANT_LIST);
            const found = productVariants.items.find(item => item.id === variantId);
            expect(found).toBeDefined();
            return found!;
        }

        it('stores the line at the requested quantity and allocates no stock', async () => {
            await adminClient.asSuperAdmin();
            const tracked = await trackVariantWithFourOnHand(seededVariants[3]);

            await signInAsCustomer(0);
            const list = await createList('AC-5 intent is not a reservation');
            const listId = decodeId(list.id);

            const { addItemToReorderList } = await addItem(list.id, tracked.id, 6);

            expect(addItemToReorderList.__typename).toBe('ReorderList');
            const updated = addItemToReorderList as ReorderListSuccessShape;
            expect(updated.lines.items).toHaveLength(1);
            expect(updated.lines.items[0].quantity).toBe(6);
            expect(await readLineRows(listId)).toHaveLength(1);
            expect(addItemToReorderList).not.toHaveProperty('errorCode');
            expect(addItemToReorderList).not.toHaveProperty('quantityAvailable');

            await adminClient.asSuperAdmin();
            const after = await readVariantStock(tracked.id);
            expect(after.stockAllocated).toBe(0);
            expect(after.stockOnHand).toBe(4);
            for (const level of after.stockLevels) {
                expect(level.stockAllocated).toBe(0);
            }
        });

        /**
         * The tables an availability or order path cannot be walked without touching.
         */
        const FORBIDDEN_AVAILABILITY_TABLES: [string, ...string[]] = [
            'stock_level',
            'stock_location',
            'stock_movement',
            'order',
            'order_line',
        ];

        it('reaches no availability service at all, on every engine', async () => {
            await adminClient.asSuperAdmin();
            const tracked = await trackVariantWithFourOnHand(seededVariants[3]);

            await signInAsCustomer(0);
            const list = await createList('AC-5 availability service silence');

            /*
             * The SERVICE-CALL boundary, which is a different observation from a statement count and is therefore
             * asserted separately and on all four engines: the platform's own availability entry points are spied on
             * their singleton instances and the assertion is on CALLS, never on statements.
             */
            const productVariantService = server.app.get(ProductVariantService);
            const stockLevelService = server.app.get(StockLevelService);
            const spies = [
                vi.spyOn(productVariantService, 'getSaleableStockLevel'),
                vi.spyOn(productVariantService, 'getDisplayStockLevel'),
                vi.spyOn(stockLevelService, 'getAvailableStock'),
            ];
            const spyNames = [
                'ProductVariantService.getSaleableStockLevel',
                'ProductVariantService.getDisplayStockLevel',
                'StockLevelService.getAvailableStock',
            ];

            try {
                const { addItemToReorderList } = await addItem(list.id, tracked.id, 6);

                expect(addItemToReorderList.__typename).toBe('ReorderList');
                expect((addItemToReorderList as ReorderListSuccessShape).lines.items[0].quantity).toBe(6);

                spies.forEach((spy, index) => {
                    expect(
                        spy.mock.calls.length,
                        `${spyNames[index]} was called ${spy.mock.calls.length} time(s): ` +
                            `${JSON.stringify(spy.mock.calls.map(call => call.length))}`,
                    ).toBe(0);
                });
            } finally {
                spies.forEach(spy => spy.mockRestore());
            }
        });

        it.skipIf(!isStatementCountEngine())(
            `performs no availability read at all — ${STATEMENT_COUNT_ENGINE_REASON}`,
            async () => {
                await adminClient.asSuperAdmin();
                const tracked = await trackVariantWithFourOnHand(seededVariants[3]);

                await signInAsCustomer(0);
                const list = await createList('AC-5 counted availability silence');

                const result = await addItemCaptured(list.id, tracked.id, 6);
                expect(result.addItemToReorderList.__typename).toBe('ReorderList');

                for (const table of FORBIDDEN_AVAILABILITY_TABLES) {
                    expect(
                        capture.forTables(table).length,
                        `filtered to ${table} — ${STATEMENT_COUNT_ENGINE_REASON}\n${capture.format()}`,
                    ).toBe(0);
                }
            },
        );
    });

    describe('AC-6: a quantity outside its bounds is a request-level input error', () => {
        it('refuses a quantity of 0 with the positive-integer message and writes nothing', async () => {
            await signInAsCustomer(0);
            const list = await createList('AC-6 quantity zero');
            const listId = decodeId(list.id);
            const totalLineRowsBefore = await countAllLineRows();

            const refusal = await expectRefusal(() => addItem(list.id, seededVariants[0].id, 0));

            expectSingleUserInputError(
                refusal,
                QUANTITY_MUST_BE_POSITIVE_MESSAGE,
                QUANTITY_MUST_BE_POSITIVE_KEY,
            );
            expect(await countAllLineRows()).toBe(totalLineRowsBefore);
            expect(await readLineRows(listId)).toHaveLength(0);
        });

        it('refuses a quantity of -1 with the positive-integer message and writes nothing', async () => {
            await signInAsCustomer(0);
            const list = await createList('AC-6 quantity negative');
            const listId = decodeId(list.id);
            const totalLineRowsBefore = await countAllLineRows();

            const refusal = await expectRefusal(() => addItem(list.id, seededVariants[0].id, -1));

            expectSingleUserInputError(
                refusal,
                QUANTITY_MUST_BE_POSITIVE_MESSAGE,
                QUANTITY_MUST_BE_POSITIVE_KEY,
            );
            expect(await countAllLineRows()).toBe(totalLineRowsBefore);
            expect(await readLineRows(listId)).toHaveLength(0);
        });

        it(`refuses a quantity of ${MAX_QUANTITY_PER_LINE + 1} with the above-maximum message`, async () => {
            await signInAsCustomer(0);
            const list = await createList('AC-6 quantity above maximum');
            const listId = decodeId(list.id);
            const totalLineRowsBefore = await countAllLineRows();

            const refusal = await expectRefusal(() =>
                addItem(list.id, seededVariants[0].id, MAX_QUANTITY_PER_LINE + 1),
            );

            expectSingleUserInputError(refusal, QUANTITY_ABOVE_MAXIMUM_MESSAGE, QUANTITY_ABOVE_MAXIMUM_KEY);
            expect(await countAllLineRows()).toBe(totalLineRowsBefore);
            expect(await readLineRows(listId)).toHaveLength(0);
        });

        it(`applies the maximum to the resulting quantity of ${MAX_QUANTITY_PER_LINE + 1} rather than to the increment of ${OVER_MAXIMUM_INCREMENT}`, async () => {
            await signInAsCustomer(0);
            const list = await createList('AC-6 resulting quantity bound');
            const listId = decodeId(list.id);
            const variant = seededVariants[0];

            expect(SEEDED_BEFORE_OVER_MAXIMUM).toBeLessThanOrEqual(MAX_QUANTITY_PER_LINE);
            expect(OVER_MAXIMUM_INCREMENT).toBeLessThanOrEqual(MAX_QUANTITY_PER_LINE);
            expect(SEEDED_BEFORE_OVER_MAXIMUM + OVER_MAXIMUM_INCREMENT).toBe(MAX_QUANTITY_PER_LINE + 1);

            const first = await addItem(list.id, variant.id, SEEDED_BEFORE_OVER_MAXIMUM);
            expect(first.addItemToReorderList.__typename).toBe('ReorderList');
            const totalLineRowsBefore = await countAllLineRows();

            const refusal = await expectRefusal(() => addItem(list.id, variant.id, OVER_MAXIMUM_INCREMENT));

            expectSingleUserInputError(refusal, QUANTITY_ABOVE_MAXIMUM_MESSAGE, QUANTITY_ABOVE_MAXIMUM_KEY);
            expect(await countAllLineRows()).toBe(totalLineRowsBefore);
            const rows = await readLineRows(listId);
            expect(rows).toHaveLength(1);
            expect(rows[0].quantity).toBe(SEEDED_BEFORE_OVER_MAXIMUM);
        });

        it('admits a quantity of exactly 1, the smallest storable quantity', async () => {
            await signInAsCustomer(0);
            const list = await createList('AC-6 quantity one');
            const listId = decodeId(list.id);

            const { addItemToReorderList } = await addItem(list.id, seededVariants[0].id, 1);

            expect(addItemToReorderList.__typename).toBe('ReorderList');
            const updated = addItemToReorderList as ReorderListSuccessShape;
            expect(updated.lines.items).toHaveLength(1);
            expect(updated.lines.items[0].quantity).toBe(1);
            const rows = await readLineRows(listId);
            expect(rows).toHaveLength(1);
            expect(rows[0].quantity).toBe(1);
        });

        it(`admits a quantity of exactly ${MAX_QUANTITY_PER_LINE}, the configured maximum`, async () => {
            await signInAsCustomer(0);
            const list = await createList('AC-6 quantity at the maximum');
            const listId = decodeId(list.id);

            const { addItemToReorderList } = await addItem(
                list.id,
                seededVariants[0].id,
                MAX_QUANTITY_PER_LINE,
            );

            expect(addItemToReorderList.__typename).toBe('ReorderList');
            const updated = addItemToReorderList as ReorderListSuccessShape;
            expect(updated.lines.items[0].quantity).toBe(MAX_QUANTITY_PER_LINE);
            const rows = await readLineRows(listId);
            expect(rows[0].quantity).toBe(MAX_QUANTITY_PER_LINE);
        });

        it(`returns ReorderListLimitError with maxItems ${MAX_LINES_PER_LIST} for one line too many`, async () => {
            await signInAsCustomer(0);
            const list = await createList('AC-6 line bound');
            const listId = decodeId(list.id);

            for (let index = 0; index < MAX_LINES_PER_LIST; index++) {
                const filling = await addItem(list.id, seededVariants[index].id, 1);
                expect(filling.addItemToReorderList.__typename).toBe('ReorderList');
            }
            const rowsAtCapacity = await readLineRows(listId);
            expect(rowsAtCapacity).toHaveLength(MAX_LINES_PER_LIST);
            const totalLineRowsBefore = await countAllLineRows();

            const { addItemToReorderList } = await addItem(list.id, seededVariants[MAX_LINES_PER_LIST].id, 1);

            expect(addItemToReorderList.__typename).toBe('ReorderListLimitError');
            const limitError = addItemToReorderList as {
                errorCode: string;
                message: string;
                maxItems: number;
            };
            expect(limitError.errorCode).toBe('REORDER_LIST_LIMIT_ERROR');
            expect(limitError.maxItems).toBe(MAX_LINES_PER_LIST);
            expect(typeof limitError.message).toBe('string');
            expect(limitError.message.length).toBeGreaterThan(0);

            expect(await countAllLineRows()).toBe(totalLineRowsBefore);
            expect(await readLineRows(listId)).toHaveLength(MAX_LINES_PER_LIST);
            const row = await readListRow(listId);
            expect(row).not.toBeNull();
            expect(row!.lineCount).toBe(MAX_LINES_PER_LIST);
        });

        it('accumulates onto an existing line even when the list already holds its maximum lines', async () => {
            /*
             * §2.11's fixed ordering made observable: resolve the existing line, validate the resulting
             * quantity, and only THEN consult the line bound. An accumulation creates no line, so it
             * breaches no line bound — and a test that consulted the bound first would refuse this write.
             */
            await signInAsCustomer(0);
            const list = await createList('AC-6 duplicate add at capacity');
            const listId = decodeId(list.id);
            for (let index = 0; index < MAX_LINES_PER_LIST; index++) {
                await addItem(list.id, seededVariants[index].id, 1);
            }
            const row = await readListRow(listId);
            expect(row).not.toBeNull();
            expect(row!.lineCount).toBe(MAX_LINES_PER_LIST);

            const { addItemToReorderList } = await addItem(list.id, seededVariants[0].id, 1);

            expect(addItemToReorderList.__typename).toBe('ReorderList');
            const updated = addItemToReorderList as ReorderListSuccessShape;
            expect(updated.lineCount).toBe(MAX_LINES_PER_LIST);
            expect(updated.lines.totalItems).toBe(MAX_LINES_PER_LIST);
            const accumulated = updated.lines.items.find(
                item => item.productVariantId === seededVariants[0].id,
            );
            expect(accumulated).toBeDefined();
            expect(accumulated!.quantity).toBe(2);

            const rows = await readLineRows(listId);
            expect(rows).toHaveLength(MAX_LINES_PER_LIST);
            const rowAfter = await readListRow(listId);
            expect(rowAfter).not.toBeNull();
            expect(rowAfter!.lineCount).toBe(MAX_LINES_PER_LIST);
        });

        it('declares three union members, so a bad quantity can never be reported as an order-line error', async () => {
            const { __type } = await shopClient.query<{
                __type: { name: string; kind: string; possibleTypes: Array<{ name: string }> } | null;
            }>(INTROSPECT_UNION_TYPE, { name: 'AddItemToReorderListResult' });

            expect(__type).not.toBeNull();
            expect(__type!.kind).toBe('UNION');
            const members = __type!.possibleTypes.map(member => member.name).sort();
            expect(members).toEqual(
                ['ReorderList', 'ReorderListLimitError', 'ReorderListNotFoundError'].sort(),
            );
            expect(members).not.toContain('NegativeQuantityError');
        });
    });

    describe('AC-7: an ordinary customer session succeeds and a foreign channel token reaches nothing', () => {
        it('succeeds for a session holding only the permission the Customer Role carries', async () => {
            await shopClient.asAnonymousUser();
            shopClient.setChannelToken(defaultChannelToken);
            const customer = seededCustomers[1];

            const { login } = await shopClient.query<{
                login: {
                    __typename: string;
                    id?: ReorderApiId;
                    channels?: Array<{ id: ReorderApiId; token: string; permissions: string[] }>;
                };
            }>(SHOP_LOGIN, { username: customer.emailAddress, password: SEEDED_CUSTOMER_PASSWORD });

            expect(login.__typename).toBe('CurrentUser');
            expect(login.channels).toBeDefined();
            expect(login.channels!.length).toBeGreaterThanOrEqual(1);
            for (const channel of login.channels!) {
                expect(channel.permissions).toEqual(['Authenticated']);
                expect(channel.permissions).not.toContain('Owner');
            }
            shopClient.setChannelToken(defaultChannelToken);

            const list = await createList('AC-7 ordinary session');
            const listId = decodeId(list.id);

            const { addItemToReorderList } = await addItem(list.id, seededVariants[0].id, 6);

            expect(addItemToReorderList.__typename).toBe('ReorderList');
            const updated = addItemToReorderList as ReorderListSuccessShape;
            expect(updated.lines.items).toHaveLength(1);
            expect(updated.lines.items[0].quantity).toBe(6);

            const row = await readListRow(listId);
            expect(row).not.toBeNull();
            expect(decodeId(row!.customerId)).toBe(decodeId(customer.id));
        });

        it('returns ReorderListNotFoundError under a second real channel token and writes no row', async () => {
            await signInAsCustomer(1);
            const list = await createList('AC-7 foreign channel token');
            const listId = decodeId(list.id);
            const firstCall = await addItem(list.id, seededVariants[0].id, 6);
            expect(firstCall.addItemToReorderList.__typename).toBe('ReorderList');
            expect(await readLineRows(listId)).toHaveLength(1);
            const totalLineRowsBefore = await countAllLineRows();

            expect(secondChannelToken).not.toBe(defaultChannelToken);
            shopClient.setChannelToken(secondChannelToken);

            const { addItemToReorderList } = await addItem(list.id, seededVariants[0].id, 6);

            expect(addItemToReorderList.__typename).toBe('ReorderListNotFoundError');
            expect((addItemToReorderList as { errorCode: string }).errorCode).toBe(
                'REORDER_LIST_NOT_FOUND_ERROR',
            );
            expect(await countAllLineRows()).toBe(totalLineRowsBefore);
            const rows = await readLineRows(listId);
            expect(rows).toHaveLength(1);
            expect(rows[0].quantity).toBe(6);
        });
    });

    describe('AC-8: the existing order operations are unchanged and the active order is untouched', () => {
        it('leaves the active order total quantity exactly as it was and writes no OrderLine', async () => {
            await signInAsCustomer(0);

            const { addItemToOrder } = await trackOrdersCommittedBy(() =>
                shopClient.query<{
                    addItemToOrder: { __typename: string; id?: ReorderApiId; totalQuantity?: number };
                }>(ADD_ITEM_TO_ORDER, { productVariantId: seededVariants[0].id, quantity: 3 }),
            );
            expect(addItemToOrder.__typename).toBe('Order');
            expect(addItemToOrder.id, 'The fixture order has no identifier to track').toBeDefined();
            await trackOrderForRemoval(addItemToOrder.id as ReorderApiId);

            const before = await shopClient.query<{ activeOrder: ActiveOrderShape | null }>(GET_ACTIVE_ORDER);
            expect(before.activeOrder).not.toBeNull();
            const recordedTotalQuantity = before.activeOrder!.totalQuantity;
            expect(recordedTotalQuantity).toBe(3);
            const orderLinesBefore = await dataSource.getRepository(OrderLine).count();

            const list = await createList('AC-8 order untouched');
            const listAdd = await addItem(list.id, seededVariants[1].id, 6);
            expect(listAdd.addItemToReorderList.__typename).toBe('ReorderList');

            const after = await shopClient.query<{ activeOrder: ActiveOrderShape | null }>(GET_ACTIVE_ORDER);

            expect(after.activeOrder).not.toBeNull();
            expect(after.activeOrder!.totalQuantity).toBe(recordedTotalQuantity);
            expect(after.activeOrder!.id).toBe(before.activeOrder!.id);
            expect(after.activeOrder!.lines).toEqual(before.activeOrder!.lines);
            expect(await dataSource.getRepository(OrderLine).count()).toBe(orderLinesBefore);
        });

        it('leaves activeOrder byte-identical to its pre-plugin form in the checked-in snapshot', async () => {
            const snapshot = readShopSchemaSnapshot();
            const runtime = await shopClient.query<IntrospectRootFieldsQuery>(INTROSPECT_ROOT_FIELDS);

            const snapshotActiveOrder = snapshot.queryFields.find(field => field.name === 'activeOrder');
            const runtimeActiveOrder = runtime.__schema.queryType.fields.find(
                field => field.name === 'activeOrder',
            );
            expect(snapshotActiveOrder).toBeDefined();
            expect(runtimeActiveOrder).toBeDefined();

            expect(renderFieldSignature(runtimeActiveOrder!)).toBe(
                renderFieldSignature(snapshotActiveOrder!),
            );
            expect(renderFieldSignature(runtimeActiveOrder!)).toBe('activeOrder(): Order');
        });

        it('leaves every pre-existing root Shop signature byte-identical and grows both types only by addition', async () => {
            const snapshot = readShopSchemaSnapshot();
            const runtime = await shopClient.query<IntrospectRootFieldsQuery>(INTROSPECT_ROOT_FIELDS);
            expect(runtime.__schema.mutationType).not.toBeNull();

            const runtimeQueries = new Map(
                runtime.__schema.queryType.fields.map(field => [field.name, renderFieldSignature(field)]),
            );
            const runtimeMutations = new Map(
                runtime.__schema.mutationType!.fields.map(field => [field.name, renderFieldSignature(field)]),
            );

            for (const field of snapshot.queryFields) {
                expect(runtimeQueries.get(field.name), `root query ${field.name} must be unchanged`).toBe(
                    renderFieldSignature(field),
                );
            }
            for (const field of snapshot.mutationFields) {
                expect(
                    runtimeMutations.get(field.name),
                    `root mutation ${field.name} must be unchanged`,
                ).toBe(renderFieldSignature(field));
            }

            /*
             * The published widths, stated as the B1 transition the AAP records — root Shop queries 19 → 21
             * and root mutations 32 → 38 — and expressed as the set difference so the assertion names the
             * fields rather than only counting them. `addItemToOrder` and `adjustOrderLine` are covered by
             * the byte-identical loop above, which is what proves no argument appeared on either.
             */
            expect(snapshot.queryFields).toHaveLength(19);
            expect(snapshot.mutationFields).toHaveLength(32);
            const addedQueries = [...runtimeQueries.keys()]
                .filter(name => !snapshot.queryFields.some(field => field.name === name))
                .sort();
            const addedMutations = [...runtimeMutations.keys()]
                .filter(name => !snapshot.mutationFields.some(field => field.name === name))
                .sort();
            expect(addedQueries).toEqual(['activeCustomerReorderList', 'activeCustomerReorderLists']);
            expect(addedMutations).toEqual([
                'addItemToReorderList',
                'adjustReorderListLine',
                'createReorderList',
                'deleteReorderList',
                'removeReorderListLine',
                'updateReorderList',
            ]);
            expect(runtimeQueries.size).toBe(21);
            expect(runtimeMutations.size).toBe(38);
        });

        it('grows ErrorCode by exactly four members and Permission by none', async () => {
            const snapshot = readShopSchemaSnapshot();

            const errorCodeType = await shopClient.query<{
                __type: { enumValues: Array<{ name: string }> } | null;
            }>(INTROSPECT_ENUM_TYPE, { name: 'ErrorCode' });
            const permissionType = await shopClient.query<{
                __type: { enumValues: Array<{ name: string }> } | null;
            }>(INTROSPECT_ENUM_TYPE, { name: 'Permission' });
            expect(errorCodeType.__type).not.toBeNull();
            expect(permissionType.__type).not.toBeNull();

            const runtimeErrorCodes = errorCodeType.__type!.enumValues.map(value => value.name);
            const runtimePermissions = permissionType.__type!.enumValues.map(value => value.name);

            for (const member of snapshot.errorCodes) {
                expect(runtimeErrorCodes).toContain(member);
            }
            expect(snapshot.errorCodes).toHaveLength(32);
            expect(runtimeErrorCodes.filter(name => !snapshot.errorCodes.includes(name)).sort()).toEqual([
                'REORDER_LIST_LIMIT_ERROR',
                'REORDER_LIST_LINE_NOT_FOUND_ERROR',
                'REORDER_LIST_NAME_CONFLICT_ERROR',
                'REORDER_LIST_NOT_FOUND_ERROR',
            ]);
            expect(runtimeErrorCodes).toHaveLength(36);

            expect(snapshot.permissions).toHaveLength(97);
            expect(runtimePermissions.slice().sort()).toEqual(snapshot.permissions.slice().sort());
            expect(runtimePermissions).toHaveLength(97);
        });
    });

    describe('AddItemToReorderListInput declares exactly three fields', () => {
        it('publishes reorderListId, productVariantId and quantity, and nothing else', async () => {
            const { __type } = await shopClient.query<{
                __type: {
                    name: string;
                    kind: string;
                    inputFields: Array<{ name: string; type: IntrospectedTypeRef }>;
                } | null;
            }>(INTROSPECT_INPUT_TYPE, { name: 'AddItemToReorderListInput' });

            expect(__type).not.toBeNull();
            expect(__type!.kind).toBe('INPUT_OBJECT');
            const fields = __type!.inputFields
                .map(field => `${field.name}: ${renderTypeRef(field.type)}`)
                .sort();
            expect(fields).toEqual(['productVariantId: ID!', 'quantity: Int!', 'reorderListId: ID!'].sort());
            expect(__type!.inputFields).toHaveLength(3);

            /*
             * There is no fourth field and there is no request-deduplication key of any name. The delivery guarantee
             * this operation makes is at-least-once — two deliveries of one add accumulate, as the duplicated-
             * delivery scenario below asserts — and the deterministic remedy is `adjustReorderListLine`, which sets
             * an absolute quantity.
             */
            for (const field of __type!.inputFields) {
                expect(/idempot|dedup|fingerprint|requestid|clientid/i.test(field.name)).toBe(false);
                expect(FORBIDDEN_PAYLOAD_FIELD_PATTERN.test(field.name)).toBe(false);
            }
        });
    });

    describe('The plugin registers its message catalogue at bootstrap', () => {
        /*
         * Three of the four keys are reachable through `addItemToReorderList` and are asserted at their own
         * criteria: the positive-integer and above-maximum keys at AC-6, and the variant-not-found key in the
         * incomplete-request scenario below.
         */
        it('resolves the name-rejection key to English text, not to the key itself', async () => {
            await signInAsCustomer(0);

            const refusal = await expectRefusal(() =>
                shopClient.query<CreateReorderListMutation, CreateReorderListMutationVariables>(
                    CREATE_REORDER_LIST,
                    { input: { name: '   ' } },
                ),
            );

            expect(refusal.errors).toHaveLength(1);
            expect(refusal.errors[0].extensions?.code).toBe('USER_INPUT_ERROR');
            expect(refusal.errors[0].message).not.toBe('error.reorder-list-name-empty');
            expect(refusal.errors[0].message).toBe(
                'The reorder list name must be between 1 and 191 characters once surrounding whitespace ' +
                    'is removed and internal whitespace is collapsed, must contain no control character ' +
                    '(U+0000 to U+001F, U+007F to U+009F), no zero-width space (U+200B) and no byte order ' +
                    'mark (U+FEFF), and must still be within 191 characters once Unicode-normalised',
            );
        });
    });

    describe('Scenario: the target list holds zero lines and the request itself is incomplete', () => {
        it('refuses a request that omits the non-null quantity before any resolver executes', async () => {
            await signInAsCustomer(0);
            const list = await createList('Scenario omitted quantity');
            const listId = decodeId(list.id);
            const totalLineRowsBefore = await countAllLineRows();

            const refusal = await expectRefusal(() =>
                shopClient.query(ADD_ITEM_TO_REORDER_LIST_OMITTING_QUANTITY, {
                    reorderListId: list.id,
                    productVariantId: seededVariants[0].id,
                }),
            );

            expect(refusal.errors.length).toBeGreaterThanOrEqual(1);
            expect(
                'data' in refusal,
                `Expected no data entry on a pre-execution rejection: ${JSON.stringify(refusal)}`,
            ).toBe(false);
            expect(await countAllLineRows()).toBe(totalLineRowsBefore);
            expect(await readLineRows(listId)).toHaveLength(0);
        });

        it('refuses a request passing an explicit null for the non-null quantity', async () => {
            await signInAsCustomer(0);
            const list = await createList('Scenario null quantity');
            const listId = decodeId(list.id);
            const totalLineRowsBefore = await countAllLineRows();

            const refusal = await expectRefusal(() =>
                shopClient.query(ADD_ITEM_TO_REORDER_LIST_WITH_NULL_QUANTITY, {
                    reorderListId: list.id,
                    productVariantId: seededVariants[0].id,
                }),
            );

            expect(refusal.errors.length).toBeGreaterThanOrEqual(1);
            expect(
                'data' in refusal,
                `Expected no data entry on a pre-execution rejection: ${JSON.stringify(refusal)}`,
            ).toBe(false);
            expect(await countAllLineRows()).toBe(totalLineRowsBefore);
            expect(await readLineRows(listId)).toHaveLength(0);
        });

        it('refuses an empty productVariantId as a request-level input failure', async () => {
            await signInAsCustomer(0);
            const list = await createList('Scenario empty variant id');
            const listId = decodeId(list.id);
            const totalLineRowsBefore = await countAllLineRows();

            const refusal = await expectRefusal(() => addItem(list.id, '', 6));

            expect(refusal.errors).toHaveLength(1);
            expect(refusal.errors[0].extensions?.code).toBe('USER_INPUT_ERROR');
            expect(refusal.errors[0].message).toMatch(VARIANT_NOT_FOUND_MESSAGE_PATTERN);
            expect(refusal.errors[0].message).not.toBe(VARIANT_NOT_FOUND_KEY);
            expect(
                refusal.data,
                `Expected the envelope to carry data exactly null: ${JSON.stringify(refusal.data)}`,
            ).toBeNull();
            expect(await countAllLineRows()).toBe(totalLineRowsBefore);
            expect(await readLineRows(listId)).toHaveLength(0);
        });

        it('refuses a productVariantId that resolves to no variant in the active channel', async () => {
            await signInAsCustomer(0);
            const list = await createList('Scenario unresolvable variant');
            const listId = decodeId(list.id);
            const totalLineRowsBefore = await countAllLineRows();

            const refusal = await expectRefusal(() => addItem(list.id, ABSENT_VARIANT_ID, 6));

            expect(refusal.errors).toHaveLength(1);
            expect(refusal.errors[0].extensions?.code).toBe('USER_INPUT_ERROR');
            expect(refusal.errors[0].message).toMatch(VARIANT_NOT_FOUND_MESSAGE_PATTERN);
            expect(refusal.errors[0].message).not.toBe(VARIANT_NOT_FOUND_KEY);
            expect(
                refusal.data,
                `Expected the envelope to carry data exactly null: ${JSON.stringify(refusal.data)}`,
            ).toBeNull();
            expect(await countAllLineRows()).toBe(totalLineRowsBefore);
            expect(await readLineRows(listId)).toHaveLength(0);
        });
    });

    describe('Scenario: an item unavailable, deleted or disabled since the last purchase', () => {
        it('proceeds for a disabled variant, because a saved list records intent rather than availability', async () => {
            const variant = seededVariants[2];
            await adminClient.asSuperAdmin();
            await captureCoreRows('product_variant', 'captured_row.id = :variantId', {
                variantId: decodeId(variant.id),
            });
            const { updateProductVariants } = await adminClient.query<{
                updateProductVariants: AdminProductVariant[];
            }>(UPDATE_PRODUCT_VARIANTS, { input: [{ id: variant.id, enabled: false }] });
            expect(updateProductVariants[0].enabled).toBe(false);

            await signInAsCustomer(0);
            const list = await createList('Scenario disabled variant');
            const listId = decodeId(list.id);

            const { addItemToReorderList } = await addItem(list.id, variant.id, 6);

            // Proceed, with no warning and no audit record. The disabled state is surfaced at preview time and
            // resolved at commit time by later features; this feature neither blocks on it nor reports it, and
            // it does not null the variant either — a disabled variant is still resolvable.
            expect(addItemToReorderList.__typename).toBe('ReorderList');
            const updated = addItemToReorderList as ReorderListSuccessShape;
            expect(updated.lineCount).toBe(1);
            expect(updated.lines.items).toHaveLength(1);
            expect(updated.lines.items[0].quantity).toBe(6);
            expect(updated.lines.items[0].productVariantId).toBe(variant.id);
            expect(updated.lines.items[0].productVariant).not.toBeNull();
            const rows = await readLineRows(listId);
            expect(rows).toHaveLength(1);
            expect(rows[0].quantity).toBe(6);
        });
    });

    describe('Scenario: a price changed since the last purchase', () => {
        it('proceeds with no warning, because the line stores no price for a change to invalidate', async () => {
            const variant = seededVariants[1];
            await adminClient.asSuperAdmin();
            const priceVariantDbId = decodeId(variant.id);
            await captureCoreRows('product_variant', 'captured_row.id = :variantId', {
                variantId: priceVariantDbId,
            });
            await captureCoreRows('product_variant_price', 'captured_row.variantId = :variantId', {
                variantId: priceVariantDbId,
            });
            const beforeUpdate = await adminClient.query<{
                updateProductVariants: Array<AdminProductVariant & { price: number }>;
            }>(UPDATE_PRODUCT_VARIANTS, { input: [{ id: variant.id }] });
            const priorPrice = beforeUpdate.updateProductVariants[0].price;
            const afterUpdate = await adminClient.query<{
                updateProductVariants: Array<AdminProductVariant & { price: number }>;
            }>(UPDATE_PRODUCT_VARIANTS, { input: [{ id: variant.id, price: priorPrice + 12345 }] });
            expect(afterUpdate.updateProductVariants[0].price).toBe(priorPrice + 12345);

            await signInAsCustomer(0);
            const list = await createList('Scenario price changed');
            const listId = decodeId(list.id);

            const { addItemToReorderList } = await addItem(list.id, variant.id, 6);

            expect(addItemToReorderList.__typename).toBe('ReorderList');
            const updated = addItemToReorderList as ReorderListSuccessShape;
            expect(updated.lines.items).toHaveLength(1);
            expect(updated.lines.items[0].quantity).toBe(6);
            expect(updated.lines.items[0]).not.toHaveProperty('price');
            expect(updated.lines.items[0]).not.toHaveProperty('currencyCode');
            const rows = await readLineRows(listId);
            expect(rows).toHaveLength(1);
            expect(Object.keys(rows[0]).some(key => FORBIDDEN_PAYLOAD_FIELD_PATTERN.test(key))).toBe(false);
        });
    });

    describe('Scenario: the same add is delivered twice and this operation cannot tell the difference', () => {
        it('accumulates on the retry and offers the absolute set as the deterministic remedy', async () => {
            const PRE_EXISTING_QUANTITY = 6;
            const DELIVERED_QUANTITY = 6;
            const ACCUMULATED_AFTER_RETRY = PRE_EXISTING_QUANTITY + DELIVERED_QUANTITY * 2;
            const REMEDY_QUANTITY = PRE_EXISTING_QUANTITY + DELIVERED_QUANTITY;

            await signInAsCustomer(0);
            const list = await createList('Scenario duplicated delivery');
            const listId = decodeId(list.id);
            const variant = seededVariants[0];

            const seeded = await addItem(list.id, variant.id, PRE_EXISTING_QUANTITY);
            expect(seeded.addItemToReorderList.__typename).toBe('ReorderList');
            const lineId = (seeded.addItemToReorderList as ReorderListSuccessShape).lines.items[0].id;
            expect((seeded.addItemToReorderList as ReorderListSuccessShape).lines.items[0].quantity).toBe(
                PRE_EXISTING_QUANTITY,
            );

            const committed = await addItem(list.id, variant.id, DELIVERED_QUANTITY);
            expect(committed.addItemToReorderList.__typename).toBe('ReorderList');
            expect((committed.addItemToReorderList as ReorderListSuccessShape).lines.items[0].quantity).toBe(
                PRE_EXISTING_QUANTITY + DELIVERED_QUANTITY,
            );

            const retry = await addItem(list.id, variant.id, DELIVERED_QUANTITY);

            expect(retry.addItemToReorderList.__typename).toBe('ReorderList');
            const afterRetry = retry.addItemToReorderList as ReorderListSuccessShape;
            expect(afterRetry.lines.items).toHaveLength(1);
            expect(afterRetry.lines.items[0].quantity).toBe(ACCUMULATED_AFTER_RETRY);
            expect(afterRetry.lines.items[0].id).toBe(lineId);
            expect(await readLineRows(listId)).toHaveLength(1);

            const remedy = await shopClient.query<
                AdjustReorderListLineMutation,
                AdjustReorderListLineMutationVariables
            >(ADJUST_REORDER_LIST_LINE, {
                input: { reorderListId: list.id, lineId, quantity: REMEDY_QUANTITY },
            });
            expect(remedy.adjustReorderListLine.__typename).toBe('ReorderList');
            expect((remedy.adjustReorderListLine as ReorderListSuccessShape).lines.items[0].quantity).toBe(
                REMEDY_QUANTITY,
            );

            const repeated = await shopClient.query<
                AdjustReorderListLineMutation,
                AdjustReorderListLineMutationVariables
            >(ADJUST_REORDER_LIST_LINE, {
                input: { reorderListId: list.id, lineId, quantity: REMEDY_QUANTITY },
            });
            expect(repeated.adjustReorderListLine.__typename).toBe('ReorderList');
            expect((repeated.adjustReorderListLine as ReorderListSuccessShape).lines.items[0].quantity).toBe(
                REMEDY_QUANTITY,
            );
            const rows = await readLineRows(listId);
            expect(rows).toHaveLength(1);
            expect(rows[0].quantity).toBe(REMEDY_QUANTITY);
        });
    });

    describe('Scenario: two requests add to the same list at the same moment', () => {
        /** Escapes an identifier the way the configured driver does, so one statement reads on all four. */
        function escapeName(identifier: string): string {
            return dataSource.driver.escape(identifier);
        }

        /**
         * One side of a race, expressed as THE REAL `addItemToReorderList` SERVICE OPERATION executed on this
         * participant's own connection inside its own held transaction.
         */
        function addItemParticipant(
            label: string,
            sessionContext: RequestContext,
            listRowId: number,
            variantRowId: number,
            quantity: number,
            expectedLinesBeforeEitherWrite: number,
            preWrite: PreWriteRendezvous,
        ): BarrierParticipantSpec<AddItemToReorderListResult, number> {
            return {
                label,
                precheck: async () => {
                    // ON THE SHARED CONNECTION, NOT THIS PARTICIPANT'S TRANSACTION.
                    const rows: unknown[] = await dataSource.query(
                        `SELECT ${escapeName('id')} FROM ${escapeName('reorder_list_line')} ` +
                            `WHERE ${escapeName('reorderListId')} = ${listRowId}`,
                    );
                    return Array.isArray(rows) ? rows.length : 0;
                },
                write: async ctx => {
                    expect(
                        ctx.precheckResult,
                        `${label} did not observe ${expectedLinesBeforeEitherWrite} line(s) before either ` +
                            'participant wrote, so this run evidences no race',
                    ).toBe(expectedLinesBeforeEitherWrite);
                    const boundContext = transactionBinder.bind(sessionContext, ctx.manager);
                    expect(
                        transactionBinder.managerOf(boundContext),
                        `${label} is not bound to its own barrier transaction`,
                    ).toBe(ctx.manager);
                    // THE SECOND, INNER RENDEZVOUS, AND IT IS WHERE THIS RACE ACTUALLY LIVES.
                    const hold = preWrite.install(ctx);
                    try {
                        // INTERNAL identifiers, not the `T_n` forms a client sends.
                        return await reorderListService.addItemToReorderList(boundContext, {
                            reorderListId: listRowId,
                            productVariantId: variantRowId,
                            quantity,
                        });
                    } finally {
                        hold.restore();
                    }
                },
            };
        }

        /**
         * Whether this engine holds the parent list row EXCLUSIVELY for a line write, in which case the two inner-
         * rendezvous cases below cannot certify an interleaving and are skipped here.
         */
        function holdsParentExclusivelyForLineWrites(): boolean {
            return EXCLUSIVE_PARENT_FOR_LINE_WRITE_ENGINES.includes(resolveConfiguredEngine());
        }

        function createAddItemPreWriteRendezvous(): PreWriteRendezvous {
            return createPreWriteRendezvous({
                participants: 2,
                tables: ['reorder_list', 'reorder_list_line'],
            });
        }

        /**
         * Asserts the inner rendezvous did its job, which a race claim rests on entirely.
         */
        function expectHeldBeforeTheirOwnWrites(preWrite: PreWriteRendezvous): void {
            expect(
                preWrite.failureReason()?.message,
                'The pre-write rendezvous failed, so no interleaving was evidenced',
            ).toBeUndefined();
            expect(preWrite.installedCount(), 'Both participants should have been patched').toBe(2);
            expect(
                preWrite.arrivedCount(),
                'Both participants should have reached their own first write and waited there',
            ).toBe(2);
            expect(
                preWrite.releasedByArrival(),
                'The pre-write hold was not released by the complete arrival set, so the two operations were ' +
                    'not simultaneously inside the pre-write window',
            ).toBe(true);
            const holds = preWrite.holds();
            expect(holds).toHaveLength(2);
            holds.forEach((hold, index) => {
                expect(
                    hold.held(),
                    `Participant ${String(index)} issued no write against a plugin table`,
                ).toBe(true);
                expect(String(hold.heldBefore())).toMatch(/^\s*(?:insert|update|delete)\b/i);
                expect(
                    hold.releasedBy(),
                    `Participant ${String(index)} was not released by the complete arrival set, so it was ` +
                        'not inside the window at the same moment as its sibling',
                ).toBe('arrival');
            });
        }

        /**
         * The published type name of one service-returned union member.
         *
         * The success member is a `ReorderList` ENTITY, which carries no `__typename` of its own, so it is
         * named from its class rather than from a property it does not have.
         */
        function serviceResultTypename(result: AddItemToReorderListResult | undefined): string {
            if (result === undefined) {
                return 'unknown';
            }
            return result instanceof ReorderList ? 'ReorderList' : result.__typename;
        }

        /**
         * Every outcome of a pair rendered for a diagnostic, through the shared describer.
         */
        function describeOutcomes(
            outcomes: Array<{
                label: string;
                status: string;
                value?: AddItemToReorderListResult;
                reason?: unknown;
            }>,
        ): string {
            return describeSettledOutcomes(outcomes, outcome => serviceResultTypename(outcome.value));
        }

        /** The result each caller of a barriered pair actually received, sorted for a stable comparison. */
        function fulfilledServiceTypenames(
            outcomes: Array<{ status: string; value?: AddItemToReorderListResult }>,
        ): string[] {
            return outcomes
                .filter(outcome => outcome.status === 'fulfilled')
                .map(outcome => serviceResultTypename(outcome.value))
                .sort();
        }

        /**
         * One side of a SEQUENTIAL pair, expressed as the PUBLISHED mutation over HTTP.
         */
        function sequentialApiAddParticipant(
            label: string,
            listApiId: ReorderApiId,
            listRowId: number,
            variantApiId: ReorderApiId,
            quantity: number,
        ): BarrierParticipantSpec<AddItemToReorderListMutation, number> {
            return {
                label,
                precheck: async ctx => {
                    const rows: unknown[] = await ctx.queryRunner.query(
                        `SELECT ${escapeName('id')} FROM ${escapeName('reorder_list_line')} ` +
                            `WHERE ${escapeName('reorderListId')} = ${listRowId}`,
                    );
                    return Array.isArray(rows) ? rows.length : 0;
                },
                write: () => addItem(listApiId, variantApiId, quantity),
            };
        }

        /**
         * The request context an authenticated client's next request would arrive with, built through the
         * platform's OWN guard path.
         */
        async function shopContextFor(client: SimpleGraphQLClient): Promise<RequestContext> {
            const session = await server.app.get(SessionService).getSessionFromToken(client.getAuthToken());
            // A SCALAR, uniformly with every other session assertion in this package. This one asserts the
            // session EXISTS, so it can only fail with `undefined` as the actual and cannot render a
            // `CachedSession` today — but the direction of an assertion is one edit away from reversing, and
            // the value on the other side of it carries the session token. Comparing here removes the question
            // rather than answering it.
            expect(
                session !== undefined,
                'The client holds no session, so no authenticated context can be built',
            ).toBe(true);
            const channelTokenKey =
                server.app.get(ConfigService).apiOptions.channelTokenKey ?? 'vendure-token';
            const request = { query: {}, headers: { [channelTokenKey]: defaultChannelToken } };
            const ctx = await server.app
                .get(RequestContextService)
                .fromRequest(request as never, undefined, [Permission.Owner], session);
            expect(ctx.authorizedAsOwnerOnly).toBe(true);
            expect(ctx.channel.token).toBe(defaultChannelToken);
            expect(ctx.activeUserId).toBeDefined();
            // And it identifies as the SHOP API, which a direct service call does not get for free: the
            // platform reads the api type off the resolver's `info` argument, which no direct call has, so
            // `fromRequest` alone yields `custom` and a race would then exercise a branch no buyer's request
            // reaches. `asShopApiContext` self-checks both the result and that this context is left unchanged.
            const shopCtx = asShopApiContext(ctx);
            expect(shopCtx.apiType).toBe('shop');
            return shopCtx;
        }

        /** A duplicate line written straight through the repository, so no service pre-check can intercept it. */
        function repositoryInsertParticipant(
            label: string,
            listRowId: number,
            variantRowId: number,
            quantity: number,
        ): BarrierParticipantSpec<void> {
            return {
                label,
                write: async ctx => {
                    await ctx.manager.getRepository(ReorderListLine).insert({
                        reorderListId: listRowId,
                        productVariantId: variantRowId,
                        quantity,
                    });
                },
            };
        }

        /** The `__typename` of each fulfilled outcome, so a race asserts which result each caller received. */
        function fulfilledTypenames(
            outcomes: Array<{ status: string; value?: AddItemToReorderListMutation }>,
        ): string[] {
            return outcomes
                .filter(outcome => outcome.status === 'fulfilled')
                .map(outcome => outcome.value?.addItemToReorderList.__typename ?? 'unknown')
                .sort();
        }

        it.skipIf(!supportsForcedInterleaving() || holdsParentExclusivelyForLineWrites())(
            `reconciles two simultaneous first adds to one line of quantity ${RACE_ADD_QUANTITY * 2} on ${resolveConfiguredEngine()}`,
            async () => {
                // Excluded from sql.js. SQLJS_EXCLUSION_REASON, verbatim: two transactions there run in one
                // process against one in-memory database and cannot be held at a barrier and released
                // together, so a forced interleaving asserted there would prove serialisation rather than
                // atomicity. The sequential half of this same contract runs on every engine, below.
                expect(SQLJS_EXCLUSION_REASON.length).toBeGreaterThan(0);

                await signInAsCustomer(0);
                const list = await createList('Race insert reconciliation');
                const listId = decodeId(list.id);
                const variant = seededVariants[0];

                const sessionContext = await shopContextFor(shopClient);
                const preWrite = createAddItemPreWriteRendezvous();

                const result = await runBarrieredPair(dataSource, {
                    a: addItemParticipant(
                        'first-writer',
                        sessionContext,
                        listId,
                        decodeId(variant.id),
                        RACE_ADD_QUANTITY,
                        0,
                        preWrite,
                    ),
                    b: addItemParticipant(
                        'second-writer',
                        sessionContext,
                        listId,
                        decodeId(variant.id),
                        RACE_ADD_QUANTITY,
                        0,
                        preWrite,
                    ),
                });

                // Both were provably inside the pre-write window together — released together by the outer
                // barrier, then held together INSIDE their own operations until each had resolved the list, the
                // variant and the absent line and was about to issue its first write.
                expect(result.a.releasedBeforeWrite).toBe(true);
                expect(result.b.releasedBeforeWrite).toBe(true);
                expectHeldBeforeTheirOwnWrites(preWrite);
                expect(result.a.status, describeOutcomes([result.a, result.b])).toBe('fulfilled');
                expect(result.b.status, describeOutcomes([result.a, result.b])).toBe('fulfilled');

                /*
                 * Both callers succeed and one row survives: the loser's insert violates the per-variant
                 * uniqueness constraint, the platform unwinds its transaction, and the bounded retry
                 * accumulates onto the winner's row. The loser is RECONCILED rather than reported, so no
                 * error result reaches either caller.
                 */
                expect(fulfilledServiceTypenames([result.a, result.b])).toEqual([
                    'ReorderList',
                    'ReorderList',
                ]);
                const rows = await readLineRows(listId);
                expect(rows).toHaveLength(1);
                expect(rows[0].quantity).toBe(RACE_ADD_QUANTITY * 2);
                const row = await readListRow(listId);
                expect(row).not.toBeNull();
                expect(row!.lineCount).toBe(1);
            },
        );

        it.skipIf(!supportsForcedInterleaving() || holdsParentExclusivelyForLineWrites())(
            `loses no update when two simultaneous adds hit an existing line on ${resolveConfiguredEngine()}`,
            async () => {
                await signInAsCustomer(0);
                const list = await createList('Race lost update probe');
                const listId = decodeId(list.id);
                const variant = seededVariants[0];
                const seeded = await addItem(list.id, variant.id, RACE_ADD_QUANTITY);
                expect(seeded.addItemToReorderList.__typename).toBe('ReorderList');

                const sessionContext = await shopContextFor(shopClient);
                const preWrite = createAddItemPreWriteRendezvous();

                const result = await runBarrieredPair(dataSource, {
                    a: addItemParticipant(
                        'first-incrementer',
                        sessionContext,
                        listId,
                        decodeId(variant.id),
                        RACE_ADD_QUANTITY,
                        1,
                        preWrite,
                    ),
                    b: addItemParticipant(
                        'second-incrementer',
                        sessionContext,
                        listId,
                        decodeId(variant.id),
                        RACE_ADD_QUANTITY,
                        1,
                        preWrite,
                    ),
                });

                expect(result.a.releasedBeforeWrite).toBe(true);
                expect(result.b.releasedBeforeWrite).toBe(true);
                // Both callers had already read the line's current quantity when they were released, which is
                // the precondition a lost update needs and the reason 12 rather than 18 is a reachable wrong
                // answer here at all. Without this hold the two operations could run end to end and the second
                // would read the first's committed 12, reaching 18 by serialisation rather than by atomicity
                // and evidencing nothing.
                expectHeldBeforeTheirOwnWrites(preWrite);
                expect(
                    result.a.status === 'fulfilled' && result.a.value !== undefined,
                    describeOutcomes([result.a, result.b]),
                ).toBe(true);
                expect(
                    result.b.status === 'fulfilled' && result.b.value !== undefined,
                    describeOutcomes([result.a, result.b]),
                ).toBe(true);
                expect(fulfilledServiceTypenames([result.a, result.b])).toEqual([
                    'ReorderList',
                    'ReorderList',
                ]);

                const rows = await readLineRows(listId);
                expect(rows).toHaveLength(1);
                /*
                 * 6 + 6 + 6 = 18, which is the scenario's own discriminator: "two concurrent six-unit adds against a
                 * line already holding six leave eighteen and not twelve". A read-compute-save implementation leaves
                 * 12 — both requests read 6, both compute 12, both store 12, and one buyer's six units are gone.
                 */
                expect(rows[0].quantity).toBe(RACE_ADD_QUANTITY * 3);
            },
        );

        /**
         * How long two queued requests are given to reach a line write while the parent row is held.
         * A window this side of the request timeout, so the holder is still holding when it answers.
         */
        const QUEUED_BEFORE_WRITE_PROBE_MS = 900;

        /** How long the released requests are given to finish once the parent row is free. */
        const FORCED_ORDERING_BUDGET_MS = 20_000;

        /** What one forced-ordering run observed, so each case asserts the evidence rather than re-deriving it. */
        interface ForcedOrderingEvidence {
            /** Both real API results, in the order the two requests were issued. */
            readonly typenames: readonly string[];
            /** Whether NEITHER request had written a line row while the parent was held. */
            readonly neitherWroteALineWhileHeld: boolean;
            /** Whether NEITHER request had settled while the parent was held. */
            readonly neitherSettledWhileHeld: boolean;
            /** Line-table writes seen while the parent was held — asserted empty, and named when not. */
            readonly lineWritesWhileHeld: readonly string[];
            /** Parent-table statements seen while the parent was held: the queue itself, so it is asserted non-empty. */
            readonly parentStatementsWhileHeld: number;
            /** Line-table writes seen after the release, which is what proves the pair then ran for real. */
            readonly lineWritesAfterRelease: number;
        }

        /**
         * Two real `addItemToReorderList` requests whose order is FORCED by the engine.
         *
         * The MySQL family holds the parent row EXCLUSIVELY across a line write
         * ({@link EXCLUSIVE_PARENT_FOR_LINE_WRITE_ENGINES}), so two callers can never be simultaneously past
         * their reads and short of their writes there: whichever reaches the parent first excludes the other,
         * and a two-participant rendezvous placed at the write boundary could never be completed. The ordering
         * is therefore forced instead of simultaneous.
         *
         * Both callers are REAL SHOP API REQUESTS rather than service calls inside a harness transaction, and
         * that is a correctness requirement rather than a preference. `addItemToReorderList` reconciles a
         * concurrent insert by retrying, and each retry must open a real transaction at DEPTH ZERO — on this
         * family an InnoDB rollback discards the whole transaction and every savepoint in it, so a retry run as
         * a nested savepoint inside a caller-supplied transaction fails on the savepoint the platform then
         * tries to roll back to. A request is the only caller that gets depth zero.
         *
         * The ordering is imposed from OUTSIDE both requests, by holding their parent row exclusively on a
         * separate connection. Every step of the evidence is then positive: both requests are proved to have
         * issued statements against the parent and NO write against the line table while the row is held, the
         * hold is released, and both real results and the final row are asserted.
         */
        async function runForcedParentOrdering(args: {
            listApiId: ReorderApiId;
            listRowId: number;
            variantApiId: ReorderApiId;
            quantity: number;
        }): Promise<ForcedOrderingEvidence> {
            const holder = dataSource.createQueryRunner();
            let held = false;
            try {
                await holder.connect();
                await holder.startTransaction();
                held = true;
                // The parent row, exclusively, on a connection neither request owns. Both branches of the add
                // reach this row before they write a line — the accumulation takes it as its lock and the
                // insert writes it as its capacity claim — so this one statement queues either branch.
                await holder.query(
                    `SELECT ${escapeName('id')} FROM ${escapeName('reorder_list')} ` +
                        `WHERE ${escapeName('id')} = ${args.listRowId} FOR UPDATE`,
                );

                // The capture window is OPENED here, not merely reset: statements issued while it is closed
                // are not recorded at all, so a closed window would report every request as having issued
                // nothing and turn this evidence into a tautology.
                capture.reset();
                capture.enable();
                let settledCount = 0;
                function track<T>(request: Promise<T>): Promise<T> {
                    const tracked = request.then(
                        value => {
                            settledCount += 1;
                            return value;
                        },
                        (err: unknown) => {
                            settledCount += 1;
                            throw err;
                        },
                    );
                    // The rejection is re-read by the `await` below; this only stops a transient
                    // unhandled-rejection warning while the request is deliberately left in flight.
                    tracked.catch(() => undefined);
                    return tracked;
                }
                const first = track(addItem(args.listApiId, args.variantApiId, args.quantity));
                const second = track(addItem(args.listApiId, args.variantApiId, args.quantity));

                // Both requests are given a window to get as far as the engine will let them. What is asserted
                // afterwards is what they did NOT manage — no line write — beside what they DID: statements
                // against the parent row they are queued on.
                await new Promise<void>(resolve => {
                    setTimeout(resolve, QUEUED_BEFORE_WRITE_PROBE_MS).unref?.();
                });
                const lineWritesWhileHeld = capture
                    .forTables('reorder_list_line')
                    .filter(statement => statement.kind !== 'select')
                    .map(statement => statement.kind);
                const parentStatementsWhileHeld = capture.forTables('reorder_list').length;
                const neitherSettledWhileHeld = settledCount === 0;

                // Releases the queue. Whichever request the engine admits first writes its line and commits;
                // the other then runs for real against the state that left behind.
                await holder.commitTransaction();
                held = false;

                const settled = await Promise.race([
                    Promise.all([first, second]),
                    new Promise<never>((_resolve, reject) => {
                        setTimeout(
                            () => reject(new Error('The released add requests did not finish in budget')),
                            FORCED_ORDERING_BUDGET_MS,
                        ).unref?.();
                    }),
                ]);
                const lineWritesAfterRelease = capture
                    .forTables('reorder_list_line')
                    .filter(statement => statement.kind !== 'select').length;

                return {
                    typenames: settled.map(result => result.addItemToReorderList.__typename),
                    neitherWroteALineWhileHeld: lineWritesWhileHeld.length === 0,
                    neitherSettledWhileHeld,
                    lineWritesWhileHeld,
                    parentStatementsWhileHeld,
                    lineWritesAfterRelease,
                };
            } finally {
                capture.disable();
                // Attempted whatever happened above, and nested so the release is not conditional on the
                // rollback succeeding: a leaked runner holds a pool slot for the rest of the suite.
                try {
                    if (held) {
                        await holder.rollbackTransaction();
                    }
                } finally {
                    await holder.release();
                }
            }
        }

        /** The forced-ordering evidence every case of this shape asserts, so no case can assert less. */
        function expectForcedOrdering(evidence: ForcedOrderingEvidence): void {
            expect(
                evidence.parentStatementsWhileHeld,
                'Neither request issued a statement against the parent row while it was held, so nothing ' +
                    'was queued and this run evidences no forced ordering',
            ).toBeGreaterThan(0);
            expect(
                evidence.lineWritesWhileHeld,
                'A request wrote a line row while the parent was held exclusively on another connection, ' +
                    'so the parent is not taken before the line write on this engine',
            ).toEqual([]);
            expect(evidence.neitherWroteALineWhileHeld).toBe(true);
            expect(
                evidence.neitherSettledWhileHeld,
                'A request completed while the parent row was still held, so it was never ordered behind it',
            ).toBe(true);
            expect(
                evidence.lineWritesAfterRelease,
                'No line write followed the release, so the requests did not run for real once the parent ' +
                    'was free',
            ).toBeGreaterThan(0);
            // BOTH REAL RESULTS. Neither caller is refused: one writes the line, and the other either
            // accumulates onto it or has its own insert refused by the per-variant unique object and
            // reconciles onto it through the bounded retry. Both paths are a success carrying the list.
            expect(evidence.typenames).toEqual(['ReorderList', 'ReorderList']);
        }

        it.skipIf(!supportsForcedInterleaving() || !holdsParentExclusivelyForLineWrites())(
            `reconciles two forcibly ordered first adds to one line of quantity ${RACE_ADD_QUANTITY * 2} on ${resolveConfiguredEngine()}`,
            async () => {
                // The contract the simultaneous case above asserts on PostgreSQL, evidenced on the family that
                // cannot express a simultaneous rendezvous. Excluded from sql.js for SQLJS_EXCLUSION_REASON:
                // one process and one in-memory database, so an ordering asserted there would be
                // serialisation rather than evidence.
                expect(SQLJS_EXCLUSION_REASON.length).toBeGreaterThan(0);

                await signInAsCustomer(0);
                const list = await createList('Forced order insert reconciliation');
                const listId = decodeId(list.id);
                const variant = seededVariants[0];

                expectForcedOrdering(
                    await runForcedParentOrdering({
                        listApiId: list.id,
                        listRowId: listId,
                        variantApiId: variant.id,
                        quantity: RACE_ADD_QUANTITY,
                    }),
                );

                const rows = await readLineRows(listId);
                expect(rows).toHaveLength(1);
                expect(rows[0].quantity).toBe(RACE_ADD_QUANTITY * 2);
                const row = await readListRow(listId);
                expect(row).not.toBeNull();
                expect(row!.lineCount).toBe(1);
            },
        );

        it.skipIf(!supportsForcedInterleaving() || !holdsParentExclusivelyForLineWrites())(
            `loses no update when two forcibly ordered adds hit an existing line on ${resolveConfiguredEngine()}`,
            async () => {
                await signInAsCustomer(0);
                const list = await createList('Forced order lost update probe');
                const listId = decodeId(list.id);
                const variant = seededVariants[0];
                const seeded = await addItem(list.id, variant.id, RACE_ADD_QUANTITY);
                expect(seeded.addItemToReorderList.__typename).toBe('ReorderList');

                expectForcedOrdering(
                    await runForcedParentOrdering({
                        listApiId: list.id,
                        listRowId: listId,
                        variantApiId: variant.id,
                        quantity: RACE_ADD_QUANTITY,
                    }),
                );

                const rows = await readLineRows(listId);
                expect(rows).toHaveLength(1);
                /*
                 * 6 + 6 + 6 = 18, the scenario's own discriminator. A read-compute-save implementation leaves
                 * 12 even under a forced ordering: the queued caller resumes holding the 6 it read before it
                 * was queued, computes 12, stores 12, and one buyer's six units are gone. Only an increment
                 * addressed by line id — `quantity = quantity + :delta` — reaches 18 here.
                 */
                expect(rows[0].quantity).toBe(RACE_ADD_QUANTITY * 3);
                const row = await readListRow(listId);
                expect(row).not.toBeNull();
                expect(row!.lineCount).toBe(1);
            },
        );

        it.skipIf(!supportsForcedInterleaving())(
            `admits exactly one of two simultaneous adds at the line bound on ${resolveConfiguredEngine()}`,
            async () => {
                await signInAsCustomer(0);
                const list = await createList('Race line bound');
                const listId = decodeId(list.id);
                await addItem(list.id, seededVariants[0].id, 1);
                expect(await readLineRows(listId)).toHaveLength(MAX_LINES_PER_LIST - 1);

                const sessionContext = await shopContextFor(shopClient);
                const preWrite = createAddItemPreWriteRendezvous();

                const result = await runBarrieredPair(dataSource, {
                    a: addItemParticipant(
                        'variant-two',
                        sessionContext,
                        listId,
                        decodeId(seededVariants[1].id),
                        1,
                        MAX_LINES_PER_LIST - 1,
                        preWrite,
                    ),
                    b: addItemParticipant(
                        'variant-three',
                        sessionContext,
                        listId,
                        decodeId(seededVariants[2].id),
                        1,
                        MAX_LINES_PER_LIST - 1,
                        preWrite,
                    ),
                });

                expect(result.a.releasedBeforeWrite).toBe(true);
                expect(result.b.releasedBeforeWrite).toBe(true);
                expectHeldBeforeTheirOwnWrites(preWrite);

                expect(
                    fulfilledServiceTypenames([result.a, result.b]),
                    describeOutcomes([result.a, result.b]),
                ).toEqual(['ReorderList', 'ReorderListLimitError']);
                const limitError = [result.a, result.b]
                    .map(outcome => (outcome.status === 'fulfilled' ? outcome.value : undefined))
                    .find((value): value is ReorderListLimitError => value instanceof ReorderListLimitError);
                expect(limitError, 'Neither caller received a ReorderListLimitError').toBeDefined();
                expect(limitError!.__typename).toBe('ReorderListLimitError');
                expect(limitError!.errorCode).toBe('REORDER_LIST_LIMIT_ERROR');
                expect(limitError!.maxItems).toBe(MAX_LINES_PER_LIST);
                expect(limitError!.message.length).toBeGreaterThan(0);

                const rows = await readLineRows(listId);
                expect(rows).toHaveLength(MAX_LINES_PER_LIST);
                const row = await readListRow(listId);
                expect(row).not.toBeNull();
                expect(row!.lineCount).toBe(MAX_LINES_PER_LIST);
            },
        );

        it(`reconciles two sequential identical adds to one line of quantity ${RACE_ADD_QUANTITY * 2} on ${resolveConfiguredEngine()}`, async () => {
            /*
             * The functional half of the same contract, run on EVERY engine including sql.js. A skipped job
             * is not evidence; a sequential run is. What it evidences is the accumulation arithmetic and the
             * single surviving row — never an interleaving, which two participants run in series were never
             * inside the same window for.
             */
            await signInAsCustomer(0);
            const list = await createList('Sequential accumulate reconciliation');
            const listId = decodeId(list.id);
            const variant = seededVariants[0];

            const result = await runSequentialPair(dataSource, {
                a: sequentialApiAddParticipant(
                    'first-writer',
                    list.id,
                    listId,
                    variant.id,
                    RACE_ADD_QUANTITY,
                ),
                b: sequentialApiAddParticipant(
                    'second-writer',
                    list.id,
                    listId,
                    variant.id,
                    RACE_ADD_QUANTITY,
                ),
            });

            expect(result.a.settledOrder).toBe(0);
            expect(result.b.settledOrder).toBe(1);
            expect(result.a.arrived).toBe(false);
            expect(result.b.arrived).toBe(false);
            expect(fulfilledTypenames([result.a, result.b])).toEqual(['ReorderList', 'ReorderList']);

            const rows = await readLineRows(listId);
            expect(rows).toHaveLength(1);
            expect(rows[0].quantity).toBe(RACE_ADD_QUANTITY * 2);
        });

        it(`refuses a duplicate written straight through the repository on ${resolveConfiguredEngine()}`, async () => {
            await signInAsCustomer(0);
            const list = await createList('Sequential repository duplicate');
            const listId = decodeId(list.id);
            const variantRowId = decodeId(seededVariants[0].id);

            const result = await runSequentialPair(dataSource, {
                a: repositoryInsertParticipant('first-insert', listId, variantRowId, 1),
                b: repositoryInsertParticipant('duplicate-insert', listId, variantRowId, 1),
            });

            expect(result.fulfilled.length, describeSettledOutcomes([result.a, result.b])).toBe(1);
            expect(result.rejected.length, describeSettledOutcomes([result.a, result.b])).toBe(1);
            expect(result.loser?.label).toBe('duplicate-insert');
            const rejection: unknown = (result.rejected[0] as { reason?: unknown }).reason;
            const reason = String(rejection instanceof Error ? (rejection.message ?? '') : (rejection ?? ''));
            // Every one of the four drivers names the offending relation in its own message, whether it reports
            // a constraint or the unique index the MySQL family stores under the same name. The predicate reads
            // the raw message; the assertion does not. `expect(reason).toContain(...)` would make the driver's
            // own text the matcher ACTUAL, which Vitest prints on failure — and on MySQL that text is
            // `Duplicate entry '<the value>' for key '<the name>'`. The boolean says the same thing, and the
            // redacted description beside it names the relation.
            expect(
                reason.toLowerCase().includes('reorder_list_line'),
                `the refusal named no plugin relation: ${redactTeardownDiagnostic(rejection)}`,
            ).toBe(true);

            expect(await readLineRows(listId)).toHaveLength(1);
        });
    });

    /** The plugin's own migrations directory, whose contents this suite must leave untouched. */
    const pluginMigrationsDirectory = path.join(__dirname, '../src/migrations');

    /** Its contents as they stood before any test in this file ran. */
    const pluginMigrationsAtCollection = fs.existsSync(pluginMigrationsDirectory)
        ? fs.readdirSync(pluginMigrationsDirectory).sort()
        : [];

    describe('This story generates no migration', () => {
        /*
         * HOW THIS IS EVIDENCED, AND WHAT MAKES THE EMPTY RESULT MEAN SOMETHING.
         */
        it('leaves the platform generator with nothing to emit against the migration-created schema', async () => {
            const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'reorder-add-item-generated-'));
            temporaryDirectories.push(outputDirectory);
            const snapshotDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'reorder-add-item-schema-'));
            temporaryDirectories.push(snapshotDirectory);

            const schemaIsTheMigrations = await rebuildPluginSchemaFromCheckedInMigration();

            // WHAT THE ASSERTION RESTS ON, which differs by engine and is recorded rather than glossed. On the
            // generation engine the diff is taken against a schema the shipped artefact built, so an empty
            // result means the artefact and the entities agree.
            expect(
                schemaIsTheMigrations,
                'the rebuild must run on exactly the engine the shipped artefact was generated against',
            ).toBe(committedMigrationApplies(String(dataSource.options.type)));

            const log = await dataSource.driver.createSchemaBuilder().log();
            const namesPluginTable = (query: string) =>
                /reorder_list(_line)?/i.test(unquoteIdentifiers(query));
            const offendingUpQueries = log.upQueries.map(query => query.query).filter(namesPluginTable);
            const offendingDownQueries = log.downQueries.map(query => query.query).filter(namesPluginTable);

            expect(
                offendingUpQueries,
                `generateMigration would emit a file for these statements: ${offendingUpQueries.join(' | ')}`,
            ).toHaveLength(0);
            expect(offendingDownQueries).toHaveLength(0);

            const generated = await generateMigration(
                await generatorConfigAgainstMigratedSchema(snapshotDirectory),
                { name: 'storyOneOhOneOhTwoShouldEmitNothing', outputDir: outputDirectory },
            );
            expect(
                generated,
                `generateMigration emitted a migration against the migration-created schema: ${
                    generated ? fs.readFileSync(generated, 'utf-8') : ''
                }`,
            ).toBeUndefined();
            expect(fs.readdirSync(outputDirectory)).toEqual([]);

            const stillWorking = await createList('After the generation pass');
            const added = await addItem(stillWorking.id, seededVariants[0].id, 3);
            expect(added.addItemToReorderList.__typename).toBe('ReorderList');
            expect((await readLineRows(decodeId(stillWorking.id))).length).toBe(1);
        });

        it('writes no migration file into a generator output directory and leaves the package untouched', () => {
            const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'reorder-plugin-migration-'));
            temporaryDirectories.push(outputDirectory);

            expect(fs.readdirSync(outputDirectory)).toHaveLength(0);

            /*
             * And the package's own migrations directory is byte-for-byte the listing it had before this file
             * ran. Nothing in this suite may write there — that directory belongs to STORY-001-01-01's single
             * additive migration — so this is the regression guard against a future edit that starts driving
             * the generator from here.
             */
            const now = fs.existsSync(pluginMigrationsDirectory)
                ? fs.readdirSync(pluginMigrationsDirectory).sort()
                : [];
            expect(now).toEqual(pluginMigrationsAtCollection);
        });
    });

    // Corrupt persisted state is not compounded — the portable half of conflict C-E, exercised live.
    // `CHK_reorder_list_line_count_non_negative` and `CHK_reorder_list_line_quantity_positive` are declared on
    // the entities and do materialise on PostgreSQL and the SQLite family, but TypeORM 0.3.28 discards them on
    // MySQL and MariaDB, so on those two engines a row violating either invariant is storable by anything
    // writing outside this service.
    describe('corrupt persisted state is refused rather than compounded', () => {
        /**
         * True when a caught failure is a CHECK violation **naming the constraint the caller expected**.
         */
        function isRefusalByCheckConstraint(err: unknown, constraintName: string): boolean {
            const layers = [err, (err as { driverError?: unknown })?.driverError];
            return layers.some(layer => {
                if (layer === null || typeof layer !== 'object') {
                    return false;
                }
                const shape = layer as {
                    code?: unknown;
                    errno?: unknown;
                    constraint?: unknown;
                    message?: unknown;
                };
                const code = typeof shape.code === 'string' ? shape.code : '';
                const errno = typeof shape.errno === 'number' ? shape.errno : 0;
                const named = typeof shape.constraint === 'string' ? shape.constraint : '';
                const message = typeof shape.message === 'string' ? shape.message : '';
                const isCheckViolation =
                    code === '23514' ||
                    errno === 3819 ||
                    errno === 4025 ||
                    /CHECK constraint failed/i.test(message);
                return isCheckViolation && (named === constraintName || message.includes(constraintName));
            });
        }

        /**
         * Attempts one invariant-violating write and says which of exactly two things happened.
         */
        async function seedInvariantViolation(
            sql: string,
            parameters: Record<string, unknown>,
            expectedCheckConstraint: string,
        ): Promise<'accepted' | 'refused-by-expected-check'> {
            const [query, bound] = dataSource.driver.escapeQueryWithParameters(sql, parameters, {});
            try {
                await dataSource.query(query, bound);
                return 'accepted';
            } catch (err: unknown) {
                if (isRefusalByCheckConstraint(err, expectedCheckConstraint)) {
                    return 'refused-by-expected-check';
                }
                // Not the refusal this seed was written to provoke, so it is a broken test rather than evidence
                // of anything. It travels through the redactor because the raw failure carries the statement
                // and every bound value on its own enumerable properties.
                rethrowRedacted('an invariant-violation seed statement', err);
            }
        }

        it('does not grant line capacity on the strength of a negative stored counter', async () => {
            await signInAsCustomer(0);
            const list = await createList('C-E negative counter');
            const listRowId = decodeId(list.id);
            await addItem(list.id, seededVariants[0].id, 1);
            expect(await readListRow(listRowId)).toMatchObject({ lineCount: 1 });

            const seeded = await seedInvariantViolation(
                `UPDATE ${quotedIdentifier('reorder_list')} SET ${quotedIdentifier('lineCount')} = -1 ` +
                    `WHERE ${quotedIdentifier('id')} = :listRowId`,
                { listRowId },
                'CHK_reorder_list_line_count_non_negative',
            );
            if (seeded === 'refused-by-expected-check') {
                // That named constraint exists on this engine and refused the write — which is this case's
                // assertion here, reached only because the failure identified itself as a violation of that
                // exact object. The counter therefore still reads as the service left it, and there is nothing
                // for the service-level floor to defend against on this engine.
                expect(await readListRow(listRowId)).toMatchObject({ lineCount: 1 });
                return;
            }

            const linesBefore = await countAllLineRows();
            await expectRefusal(() => addItem(list.id, seededVariants[1].id, 1));

            expect(await countAllLineRows()).toBe(linesBefore);
            expect(await readLineRows(listRowId)).toHaveLength(1);
        });

        it('does not add to a stored quantity the column may not hold', async () => {
            await signInAsCustomer(0);
            const list = await createList('C-E non-positive quantity');
            const listRowId = decodeId(list.id);
            const variant = seededVariants[0];
            await addItem(list.id, variant.id, 5);

            // Zero is the sharper violation than a negative, because the total the request would produce is
            // legal arithmetic (0 + 2 = 2): request validation passes, so only the statement's own floor stands
            // between a row the column may not hold and a total computed from it.
            const seeded = await seedInvariantViolation(
                `UPDATE ${quotedIdentifier('reorder_list_line')} SET ${quotedIdentifier('quantity')} = 0 ` +
                    `WHERE ${quotedIdentifier('reorderListId')} = :listRowId`,
                { listRowId },
                'CHK_reorder_list_line_quantity_positive',
            );
            if (seeded === 'refused-by-expected-check') {
                expect(await readLineRows(listRowId)).toMatchObject([{ quantity: 5 }]);
                return;
            }

            await expectRefusal(() => addItem(list.id, variant.id, 2));

            expect(await readLineRows(listRowId)).toMatchObject([{ quantity: 0 }]);
        });

        // The seeder itself is fail-closed, asserted rather than assumed. The two cases above branch on what
        // the seeder returns, so the seeder IS part of the evidence: if it reported "the check refused it" for
        // any failure other than that exact check, a green run would certify a guard that was never exercised —
        // on the very engines where the constraint is absent. Each case below fails for a DIFFERENT reason that
        // is not the expected check.
        describe('the invariant seeder admits only the refusal it was asked about', () => {
            it('rethrows a syntactically broken statement instead of calling it a check refusal', async () => {
                await expect(
                    seedInvariantViolation(
                        `UPDATE ${quotedIdentifier('reorder_list')} SET SET SET`,
                        {},
                        'CHK_reorder_list_line_count_non_negative',
                    ),
                ).rejects.toThrow();
            });

            it('rethrows a statement against a table that does not exist', async () => {
                await expect(
                    seedInvariantViolation(
                        `UPDATE ${quotedIdentifier('reorder_list_no_such_table')} ` +
                            `SET ${quotedIdentifier('lineCount')} = -1`,
                        {},
                        'CHK_reorder_list_line_count_non_negative',
                    ),
                ).rejects.toThrow();
            });

            it('rethrows a violation of a different named constraint', async () => {
                await signInAsCustomer(0);
                const list = await createList('C-E seeder rejects a foreign constraint');
                const listRowId = decodeId(list.id);
                const variant = seededVariants[0];
                await addItem(list.id, variant.id, 1);
                const [line] = await readLineRows(listRowId);

                await expect(
                    seedInvariantViolation(
                        `INSERT INTO ${quotedIdentifier('reorder_list_line')} ` +
                            `(${quotedIdentifier('createdAt')}, ${quotedIdentifier('updatedAt')}, ` +
                            `${quotedIdentifier('reorderListId')}, ${quotedIdentifier('productVariantId')}, ` +
                            `${quotedIdentifier('quantity')}) VALUES ` +
                            `(:now, :now, :listRowId, :variantRowId, 1)`,
                        {
                            now: new Date(),
                            listRowId,
                            variantRowId: decodeId(line.productVariantId),
                        },
                        'CHK_reorder_list_line_quantity_positive',
                    ),
                ).rejects.toThrow();
            });

            it('reports the accepted case as accepted rather than as a refusal', async () => {
                await signInAsCustomer(0);
                const list = await createList('C-E seeder accepts a legal write');
                const listRowId = decodeId(list.id);

                const outcome = await seedInvariantViolation(
                    `UPDATE ${quotedIdentifier('reorder_list')} SET ${quotedIdentifier('lineCount')} = 0 ` +
                        `WHERE ${quotedIdentifier('id')} = :listRowId`,
                    { listRowId },
                    'CHK_reorder_list_line_count_non_negative',
                );

                expect(outcome).toBe('accepted');
            });
        });
    });
});

// THE PRE-WRITE RENDEZVOUS, CERTIFIED AGAINST ITS OWN FALSE-PASS.
//
// The three races above rest entirely on one claim: that both callers were between their own reads and their
// own writes at the same moment. The instrument that makes that claim has a failure mode that would certify
// the exact serialisation it exists to detect, and it is not hypothetical — it is what happens when one
// caller is blocked on a lock the other holds:
//
// 1. A reaches its hold and waits.
// 2. B cannot reach its hold at all, because it is blocked in the database.
// 3. A's wait ends.
// 4. B unblocks, reads A's committed state, and reaches its hold.
//
// If step 3 RELEASED A's write, then by step 4 every aggregate reads perfectly — two installs, two arrivals,
// a release "by arrival" — while the two callers never overlapped, and a read-compute-save accumulation would
// leave the correct total purely by serialisation. So step 3 must FAIL the rendezvous instead, and that
// behaviour is asserted here rather than assumed of the fixture.

describe('the pre-write rendezvous refuses to certify a sequential run', () => {
    /** A write against a plugin table, which is what the rendezvous is told to intercept. */
    const TARGETED_WRITE = 'UPDATE `reorder_list_line` SET `quantity` = `quantity` + 6 WHERE `id` = 1';
    /** A statement the rendezvous must ignore: a read, and against a table it was not given. */
    const UNTARGETED_READ = 'SELECT `id` FROM `customer` WHERE `id` = 1';

    /**
     * A fabricated participant: enough of the context for the rendezvous, and a `query` that records.
     */
    function fabricateParticipant(
        label: string,
        options: { alreadyCancelled?: boolean } = {},
    ): {
        ctx: BarrierParticipantContext;
        executed: string[];
        cancel: () => void;
    } {
        const executed: string[] = [];
        const cancelListeners: Array<() => void> = [];
        const runner = {
            query: (statement: string) => {
                executed.push(statement);
                return Promise.resolve([]);
            },
        };
        const ctx = {
            label,
            queryRunner: runner,
            manager: runner,
            cancelled: () => options.alreadyCancelled === true,
            onCancelled: (listener: () => void) => {
                if (options.alreadyCancelled === true) {
                    listener();
                    return;
                }
                cancelListeners.push(listener);
            },
        } as unknown as BarrierParticipantContext;
        return {
            ctx,
            executed,
            cancel: () => cancelListeners.forEach(listener => listener()),
        };
    }

    /** A rendezvous with a short bound, so the timeout path costs milliseconds. */
    function fabricateRendezvous(participants: number): PreWriteRendezvous {
        return createPreWriteRendezvous({
            participants,
            tables: ['reorder_list', 'reorder_list_line'],
            timeoutMs: 150,
        });
    }

    it('releases both holds by arrival and delegates both writes when the two overlap', async () => {
        const rendezvous = fabricateRendezvous(2);
        const first = fabricateParticipant('first');
        const second = fabricateParticipant('second');
        const firstHold = rendezvous.install(first.ctx);
        const secondHold = rendezvous.install(second.ctx);

        await Promise.all([
            first.ctx.queryRunner.query(TARGETED_WRITE),
            second.ctx.queryRunner.query(TARGETED_WRITE),
        ]);

        expect(rendezvous.failureReason()).toBeUndefined();
        expect(rendezvous.arrivedCount()).toBe(2);
        expect(rendezvous.releasedByArrival()).toBe(true);
        expect(firstHold.releasedBy()).toBe('arrival');
        expect(secondHold.releasedBy()).toBe('arrival');
        // AND THE STATEMENTS RAN — after the release, which is what makes the hold pre-write rather than a
        // statement the harness swallowed.
        expect(first.executed).toEqual([TARGETED_WRITE]);
        expect(second.executed).toEqual([TARGETED_WRITE]);
        firstHold.restore();
        secondHold.restore();
    });

    it('clears the bounded timer its own wait installed when an arrival answers the wait first', async () => {
        const rendezvous = fabricateRendezvous(2);
        const first = fabricateParticipant('first');
        const second = fabricateParticipant('second');
        const firstHold = rendezvous.install(first.ctx);
        const secondHold = rendezvous.install(second.ctx);

        // A wait installs two escapes and exactly one of them fires. Here the ARRIVAL fires, so the bounded
        // timer never does — and the defect this guards against is that timer being left pending for the rest
        // of its bound afterwards, holding the wait's closure and the rendezvous state it captures reachable,
        // then elapsing inside whichever later test is running by then.
        const realSetTimeout = globalThis.setTimeout;
        const realClearTimeout = globalThis.clearTimeout;
        const mutableGlobal = globalThis as unknown as {
            setTimeout: typeof globalThis.setTimeout;
            clearTimeout: typeof globalThis.clearTimeout;
        };
        const installed: Array<ReturnType<typeof setTimeout>> = [];
        const cleared: unknown[] = [];
        mutableGlobal.clearTimeout = ((handle: ReturnType<typeof setTimeout>): void => {
            cleared.push(handle);
            realClearTimeout(handle);
        }) as unknown as typeof globalThis.clearTimeout;
        try {
            mutableGlobal.setTimeout = ((handler: () => void, ms?: number) => {
                const handle = realSetTimeout(handler, ms);
                installed.push(handle);
                return handle;
            }) as unknown as typeof globalThis.setTimeout;
            const wait = rendezvous.waitForArrivals(2, 60_000);
            mutableGlobal.setTimeout = realSetTimeout;
            expect(installed.length, 'the wait did not install exactly one bounded timer').toBe(1);

            await Promise.all([
                first.ctx.queryRunner.query(TARGETED_WRITE),
                second.ctx.queryRunner.query(TARGETED_WRITE),
            ]);
            expect(await wait, 'the wait was not answered by the two arrivals').toBe(true);

            expect(
                cleared,
                'the wait was answered by arrival but never cleared the bounded timer it had installed, so ' +
                    'that timer and its closure stay live for the remainder of the bound and fire during a ' +
                    'later test',
            ).toContain(installed[0]);
            // And nothing is left holding the rendezvous either, so a further arrival has no stale observer to
            // notify and no hold is still parked in the waiting set.
            expect(rendezvous.waitingCount(), 'a released hold was left in the waiting set').toBe(0);
        } finally {
            mutableGlobal.setTimeout = realSetTimeout;
            mutableGlobal.clearTimeout = realClearTimeout;
        }
        firstHold.restore();
        secondHold.restore();
    });

    it('fails permanently on a timeout, never delegating the held write', async () => {
        const rendezvous = fabricateRendezvous(2);
        const lonely = fabricateParticipant('lonely');
        const hold = rendezvous.install(lonely.ctx);

        // THE STEP-3 BEHAVIOUR. The wait ends without the sibling arriving, and the intercepted statement is
        // refused rather than run.
        await expect(lonely.ctx.queryRunner.query(TARGETED_WRITE)).rejects.toThrow(
            /waited 150ms without every participant arriving/,
        );
        expect(hold.held()).toBe(true);
        expect(hold.releasedBy()).toBeUndefined();
        expect(lonely.executed, 'The held write was delegated despite the hold never being released').toEqual(
            [],
        );
        expect(rendezvous.failureReason()?.message).toMatch(/failed rather than released/);
        expect(rendezvous.releasedByArrival()).toBe(false);
        expect(rendezvous.waitingCount(), 'a refused hold was left in the waiting set').toBe(0);
        hold.restore();
    });

    it('does not let a later arrival relabel a failed rendezvous as an arrival release', async () => {
        const rendezvous = fabricateRendezvous(2);
        const early = fabricateParticipant('early');
        const late = fabricateParticipant('late');
        const earlyHold = rendezvous.install(early.ctx);
        const lateHold = rendezvous.install(late.ctx);

        await expect(early.ctx.queryRunner.query(TARGETED_WRITE)).rejects.toThrow(
            /without every participant/,
        );

        await expect(late.ctx.queryRunner.query(TARGETED_WRITE)).rejects.toThrow(
            /failed rather than released/,
        );
        expect(rendezvous.arrivedCount()).toBe(1);
        expect(rendezvous.releasedByArrival()).toBe(false);
        expect(earlyHold.releasedBy()).toBeUndefined();
        expect(lateHold.releasedBy()).toBeUndefined();
        expect(early.executed).toEqual([]);
        expect(late.executed).toEqual([]);
        expect(() => rendezvous.arriveExternally()).toThrow(/failed rather than released/);
        earlyHold.restore();
        lateHold.restore();
    });

    it('fails on pair cancellation rather than releasing the held write', async () => {
        const rendezvous = fabricateRendezvous(2);
        const abandoned = fabricateParticipant('abandoned');
        const hold = rendezvous.install(abandoned.ctx);

        const attempt = abandoned.ctx.queryRunner.query(TARGETED_WRITE);
        // WAITED ON A RENDEZVOUS EVENT, NOT ON A TIMER. Yielding a fixed number of event-loop turns and
        // ASSUMING the interceptor has registered by then is not an observation, and it would let this case
        // pass on a build where the hold was never registered at all. The arrival is the event that says the
        // hold exists, so it is the thing waited on.
        expect(
            await rendezvous.waitForArrivals(1),
            'the participant never reached its write, so there was no hold to cancel',
        ).toBe(true);
        expect(rendezvous.waitingCount()).toBe(1);
        abandoned.cancel();

        await expect(attempt).rejects.toThrow(/pair was abandoned/);
        expect(abandoned.executed).toEqual([]);
        expect(rendezvous.releasedByArrival()).toBe(false);
        expect(rendezvous.waitingCount(), 'a cancelled hold was left in the waiting set').toBe(0);
        hold.restore();
    });

    it('refuses a hold whose pair was already abandoned before it reached its write', async () => {
        // THE HARDEST PATH, AND THE ONE THAT ACTUALLY STRANDED A PARTICIPANT. The real context invokes a
        // cancellation listener synchronously when the pair is already abandoned, so the failure happens DURING
        // the hold's own registration.
        const rendezvous = fabricateRendezvous(2);
        const preCancelled = fabricateParticipant('pre-cancelled', { alreadyCancelled: true });
        const hold = rendezvous.install(preCancelled.ctx);

        await expect(preCancelled.ctx.queryRunner.query(TARGETED_WRITE)).rejects.toThrow(
            /pair was abandoned/,
        );
        expect(hold.held()).toBe(true);
        expect(hold.releasedBy()).toBeUndefined();
        expect(preCancelled.executed, 'the held write was delegated to an abandoned participant').toEqual([]);
        expect(rendezvous.releasedByArrival()).toBe(false);
        expect(rendezvous.waitingCount(), 'the refused hold was left in the waiting set').toBe(0);
        hold.restore();
    });

    it('ignores a read and a write against a table it was not given', async () => {
        const rendezvous = fabricateRendezvous(2);
        const participant = fabricateParticipant('unrelated');
        const hold = rendezvous.install(participant.ctx);

        // Neither trips the hold, so neither can make a race look interleaved: the read is not a write, and
        // `customer` is not one of the tables this rendezvous watches.
        await participant.ctx.queryRunner.query(UNTARGETED_READ);
        await participant.ctx.queryRunner.query('UPDATE `customer` SET `title` = NULL WHERE `id` = 1');

        expect(hold.held()).toBe(false);
        expect(rendezvous.arrivedCount()).toBe(0);
        expect(participant.executed).toHaveLength(2);
        hold.restore();
    });

    it('restores the runner it patched, so later statements are untouched', async () => {
        const rendezvous = fabricateRendezvous(1);
        const participant = fabricateParticipant('restored');
        const hold = rendezvous.install(participant.ctx);

        // A one-participant rendezvous is complete on the first arrival, so this delegates immediately and is
        // still certified as released by arrival.
        await participant.ctx.queryRunner.query(TARGETED_WRITE);
        expect(hold.releasedBy()).toBe('arrival');
        hold.restore();

        await participant.ctx.queryRunner.query(TARGETED_WRITE);
        expect(rendezvous.arrivedCount()).toBe(1);
        expect(participant.executed).toEqual([TARGETED_WRITE, TARGETED_WRITE]);
    });
});

// The two-connection harness's own contract.
//
// The concurrency evidence in this suite is only worth what the barrier that produces it is worth: a harness
// that silently releases a connection early, or reports a foreign failure verbatim, turns a race proof into a
// coincidence. These cases drive the barrier directly, with fake runners, so they need no server.

/**
 * The two-connection harness's TEARDOWN CONTRACT, tested where it is hardest to reach: on a query runner whose own
 * state accessors misbehave.
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
     */
    flagFailsAfter?: 'connect' | 'startTransaction' | 'commitTransaction';
    /**
     * The runner arrives already inside a transaction at depth 1, as one drawn from a caller's outer
     * transaction does. This is a SUPPORTED situation for {@link runSequentialPair}, and it is what makes
     * the harness's `ownsRunner` false — so it is how the "genuinely foreign" branch is reached.
     */
    initiallyInTransaction?: boolean;
    releaseFailsWith?: unknown;
}

/**
 * A query runner that records what was done to it, with the two state accessors optionally throwing.
 */
function createFakeRunner(
    journal: RunnerJournal,
    faults: FakeRunnerFaults = {},
): QueryRunner & { readonly journal: RunnerJournal } {
    let transactionActive = faults.initiallyInTransaction === true;
    let depth = faults.initiallyInTransaction === true ? 1 : 0;
    let released = false;
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
        manager: {} as EntityManager,
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
            // Closing a NESTED level leaves the outer transaction open, which is what TypeORM's own runners do:
            // they release a savepoint and decrement while the depth is still above zero, and only the
            // outermost close clears the flag. The fake has to agree, or a runner that arrived inside somebody
            // else's transaction would appear to lose it here.
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
            if ('releaseFailsWith' in faults) {
                return Promise.reject(faults.releaseFailsWith);
            }
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

        // It RAISES, and it raises as the HARNESS rather than as the accessor. An unguarded getter's error
        // would escape `runParticipantChain` before its `try` was entered, so no cleanup ownership would exist,
        // no diagnostic would be produced and the runner would simply be dropped.
        expect(failure).toBeInstanceOf(Error);
        const message = (failure as Error).message;
        expect(message).toContain('The concurrency harness cannot certify this run');

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

        expect(result.fulfilled).toHaveLength(2);
        expect(result.rejected).toHaveLength(0);

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
     * WHY THIS GROUP IS SEPARATE FROM THE ONE ABOVE, AND WHY IT IS THE DANGEROUS HALF.
     */

    it('reports and holds a genuinely foreign connection whose flag dies after connect', async () => {
        const journal: RunnerJournal = { calls: [] };
        // Observed active at depth 1 when the participant begins — a real outer transaction, so ownership is
        // genuinely somebody else's — and then unreadable from `connect()` onwards.
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

        expect(failure).toBeInstanceOf(Error);
        const message = (failure as Error).message;
        expect(message).toContain('cannot certify this run');
        expect(message).toContain('foreign-then-blind-a');
        expect(message).toContain('arrived inside a transaction this harness did not open');
        expect(message).toContain('this harness only lost sight of it');

        expect(message).toContain("'foreign-then-blind-a' rejected with");
        expect(message).toContain('could not complete its transaction');

        // And the foreign work is left intact. Rule 6 still governs what is DONE about it: releasing would
        // publish a live foreign transaction and its locks to the next borrower, and destroying the pool would
        // end an outer run this harness never started. So it does neither — the diagnostic is the action.
        expect(journal.calls).toContain('connect');
        expect(journal.calls).not.toContain('release');
        expect(journal.calls).not.toContain('dataSource.destroy');
        expect(first.isReleased).toBe(false);
        expect(second.isReleased).toBe(false);
    });

    it('quarantines a connection the harness borrowed itself whose flag dies after the commit', async () => {
        const journal: RunnerJournal = { calls: [] };
        // A fresh runner, so the baseline is observed INACTIVE and the connection is genuinely this harness's.
        // The flag survives the whole transaction and dies once the commit has returned, which is the latest
        // moment it can still matter: the certification that gates `release()` comes next.
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

        expect(journal.calls).toContain('commitTransaction');
        expect(journal.calls).toContain('dataSource.destroy');
        expect(journal.calls).not.toContain('release');
        expect(first.isReleased).toBe(false);

        // AND THE FAIL-CLOSED UNWIND TERMINATES, which is the property that makes the substitution safe to
        // hold rather than merely correct in direction.
        expect(message).toContain('within 8 closes');
        expect(journal.calls.filter(call => call === 'commitTransaction').length).toBeLessThanOrEqual(18);

        // WHICH OF THESE TWO CASES FALSIFIES WHICH CHANGE.
        // The foreign case above is the one that fails without the certainty check, because
        // there a substituted value produced a positive certification. Here the baseline was inactive, so
        // the value comparison already disagreed and the runner was already quarantined; what this case
        // pins down is the OWNERSHIP SPLIT — that the same unreadable state disposes of a borrowed
        // connection by quarantine and a foreign one by report alone, and that the borrowed one is never
        // released on the way.
    });
});

describe('the two-connection harness, when a teardown failure has to be reported', () => {
    /**
     * A rejection shaped exactly as TypeORM raises one, driver fields and all.
     */
    function driverRejection(email: string): Error {
        return Object.assign(
            new Error(`Duplicate entry '${email}' for key 'UQ_reorder_list_line_list_variant'`),
            {
                name: 'QueryFailedError',
                code: 'ER_DUP_ENTRY',
                errno: 1062,
                query: 'INSERT INTO `customer` (`emailAddress`) VALUES (?)',
                parameters: [email],
                driverError: { sqlMessage: `Duplicate entry '${email}'`, sqlState: '23000' },
            },
        );
    }

    it('measures the failure rather than reproducing it, and still names what a reader needs', async () => {
        // WHY THIS CASE MATTERS HERE RATHER THAN ONLY IN THE REDACTION FIXTURE'S OWN SPEC. A participant of
        // this harness writes STRAIGHT THROUGH THE REPOSITORY, so a rejection it produces is the most sensitive
        // error object this package ever holds. The harness raises its teardown diagnostic as an ordinary
        // error, the runner prints it, and a build log is readable by everyone who can see the build. This
        // asserts the delegation to the shared redactor, not the redactor itself.
        const email = 'someone.real@example.invalid';
        const journal: RunnerJournal = { calls: [] };
        const faults: FakeRunnerFaults = { releaseFailsWith: driverRejection(email) };
        const dataSource = createFakeDataSource(
            [createFakeRunner(journal, faults), createFakeRunner(journal, faults)],
            journal,
        );

        const failure = await runSequentialPair(dataSource, {
            a: inertParticipant('writes-first'),
            b: inertParticipant('writes-second'),
        }).then(
            () => undefined,
            (reason: unknown) => reason,
        );

        expect(failure).toBeInstanceOf(Error);
        const message = (failure as Error).message;

        // What a reader needs: which participant's connection would not go back, the error class, the
        // enumerated driver code and errno, and how the failure classifies.
        expect(message).toContain('writes-first');
        expect(message).toContain('QueryFailedError/ER_DUP_ENTRY#1062');
        expect(message).toContain('[unique-violation]');

        // WHAT IT MUST NOT CARRY: the statement, its bound values, the driver's own sentence, the SQLSTATE.
        for (const secret of [email, 'INSERT', 'VALUES', '23000', 'Duplicate']) {
            expect(message.includes(secret), `the harness diagnostic disclosed "${secret.slice(0, 3)}"`).toBe(
                false,
            );
        }
    });

    it('refuses a participant label that carries a value', async () => {
        const email = 'someone.real@example.invalid';
        const journal: RunnerJournal = { calls: [] };
        const faults: FakeRunnerFaults = { releaseFailsWith: new Error('the pool refused it') };
        const dataSource = createFakeDataSource(
            [createFakeRunner(journal, faults), createFakeRunner(journal, faults)],
            journal,
        );

        const failure = await runSequentialPair(dataSource, {
            a: inertParticipant(`writes-for-${email}`),
            b: inertParticipant('writes-second'),
        }).then(
            () => undefined,
            (reason: unknown) => reason,
        );

        expect((failure as Error).message.includes(email)).toBe(false);
    });
});

describe('the exported barrier primitive, driven directly rather than through a pair driver', () => {
    // WHY THE PRIMITIVE NEEDS ITS OWN CASES. `runBarrieredPair` and `runSequentialPair` resolve their labels
    // before they ever reach this class, so every guard exercised through them is the DRIVER's. A suite may
    // construct `ConcurrencyBarrier` itself — it is exported — and then this class's own constructor,
    // `arrive()` and `dispose()` are the only boundary a caller's label or failure crosses.

    const EMAIL = 'someone.real@example.invalid';
    const TOKEN = ['s3cr3t', 'session', 'token', '4f2c81b9'].join('-');
    const HOST_PATH = '/var/folders/T/reorder-plugin-a1b2c3/migrations';
    const CONTROL = 'writes\u0007\u200b\nfake-log-line: OK';

    /** A rejection shaped exactly as TypeORM raises one: driver fields as enumerable own properties. */
    function driverRejection(): Error {
        return Object.assign(
            new Error(`Duplicate entry '${EMAIL}' for key 'UQ_reorder_list_line_list_variant'`),
            {
                name: 'QueryFailedError',
                code: 'ER_DUP_ENTRY',
                errno: 1062,
                query: 'INSERT INTO `customer` (`emailAddress`) VALUES (?)',
                parameters: [EMAIL],
                driverError: { sqlMessage: `Duplicate entry '${EMAIL}'`, sqlState: '23000' },
            },
        );
    }

    /** Fails naming which value leaked, without putting the value itself in the message. */
    function expectNoValueIn(text: string, values: readonly string[]): void {
        for (const value of values) {
            expect(text.includes(value), `the diagnostic disclosed "${value.slice(0, 3)}"`).toBe(false);
        }
    }

    it('publishes no part of a value-bearing label through the timeout diagnostic', async () => {
        // The timeout message is the one a hung rendezvous produces and therefore the one most likely to be
        // read in a build log. It names who arrived and who did not, from BOTH the arrival list and
        // `expectedLabels` — so both are asserted here.
        const barrier = new ConcurrencyBarrier(2, {
            timeoutMs: 20,
            expectedLabels: [`expects-${EMAIL}`, `expects-${HOST_PATH}`],
        });

        const failure = await barrier.arrive(`writes-for-${EMAIL}`).then(
            () => undefined,
            (reason: unknown) => reason,
        );

        expect(failure).toBeInstanceOf(Error);
        const message = (failure as Error).message;
        expect(message).toContain('Concurrency barrier timed out');
        expectNoValueIn(message, [EMAIL, HOST_PATH]);
    });

    it('publishes no part of a control-character label, so a log line cannot be forged', async () => {
        const barrier = new ConcurrencyBarrier(2, { timeoutMs: 20, expectedLabels: [CONTROL] });

        const failure = await barrier.arrive(CONTROL).then(
            () => undefined,
            (reason: unknown) => reason,
        );

        const message = (failure as Error).message;
        expect(message.includes('fake-log-line')).toBe(false);
        expect(message.includes('\u0007')).toBe(false);
        expect(message.includes('\u200b')).toBe(false);
    });

    it('converts a foreign disposal reason before storing it or rejecting anyone with it', async () => {
        // The sink with three outlets. Whatever `dispose()` stores is handed to every waiting participant and
        // has its `.message` replayed by every later arrival, and a driver error carries the statement and its
        // bound parameters as enumerable own properties — so an unconverted reason would publish them from all
        // three.
        const barrier = new ConcurrencyBarrier(2, { timeoutMs: 5_000 });
        const waiting = barrier.arrive('writes-first').then(
            () => undefined,
            (reason: unknown) => reason,
        );

        barrier.dispose(driverRejection());

        const rejected = await waiting;
        expect(rejected).toBeInstanceOf(Error);
        const rejectedMessage = (rejected as Error).message;
        expect(rejectedMessage).toContain('QueryFailedError/ER_DUP_ENTRY#1062');
        expect(rejectedMessage).toContain('[unique-violation]');
        expectNoValueIn(rejectedMessage, [EMAIL, 'INSERT', 'VALUES', '23000', 'Duplicate']);
        expect(JSON.stringify(rejected)).toBe('{}');
        expect((rejected as { cause?: unknown }).cause).toBeUndefined();

        const late = await barrier.arrive('arrives-late').then(
            () => undefined,
            (reason: unknown) => reason,
        );
        const lateMessage = (late as Error).message;
        expect(lateMessage).toContain('no longer');
        expectNoValueIn(lateMessage, [EMAIL, 'INSERT', 'VALUES', '23000', 'Duplicate']);
    });

    it('refuses a token-bearing disposal reason that is not an Error at all', async () => {
        const barrier = new ConcurrencyBarrier(2, { timeoutMs: 5_000 });
        const waiting = barrier.arrive('writes-first').then(
            () => undefined,
            (reason: unknown) => reason,
        );

        barrier.dispose([TOKEN, EMAIL]);

        expectNoValueIn(((await waiting) as Error).message, [TOKEN, EMAIL]);
    });

    it('keeps two refused labels DISTINCT, so refusing one cannot turn a leak into a hang', async () => {
        // The hazard the ordinal exists for. A label is also the identity a repeat arrival is deduplicated by,
        // so replacing every refused label with one shared constant would merge two participants, hold the
        // distinct-arrival count below the release threshold and hang the rendezvous. Both labels here are
        // refused and the barrier must still release on the second arrival.
        const barrier = new ConcurrencyBarrier(2, { timeoutMs: 5_000 });
        const first = barrier.arrive(`writes-for-${EMAIL}`);
        const second = barrier.arrive(`writes-for-${HOST_PATH}`);

        await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
        expect(barrier.released, 'two refused labels were merged into one participant').toBe(true);
        expect(new Set(barrier.arrivedLabels).size).toBe(2);
        expectNoValueIn(barrier.arrivedLabels.join(' '), [EMAIL, HOST_PATH]);
    });

    it('still counts a REPEAT arrival of the same refused label exactly once', async () => {
        // The other half of the same property: stable per raw label. Arriving twice with one refused label must
        // not satisfy a two-participant barrier, or a test would read a rendezvous that never happened as
        // evidence of an interleaving.
        const barrier = new ConcurrencyBarrier(2, { timeoutMs: 40 });
        const firstArrival = barrier.arrive(`writes-for-${EMAIL}`).then(
            () => undefined,
            () => undefined,
        );
        const failure = await barrier.arrive(`writes-for-${EMAIL}`).then(
            () => undefined,
            (reason: unknown) => reason,
        );

        expect(failure, 'a repeated refused label was counted as two participants').toBeInstanceOf(Error);
        expect((failure as Error).message).toContain('Concurrency barrier timed out');
        expect(new Set(barrier.arrivedLabels).size).toBe(1);
        await firstArrival;
    });

    it('keeps a safe label intact, because the diagnostic has to stay readable', async () => {
        const barrier = new ConcurrencyBarrier(2, { timeoutMs: 20, expectedLabels: ['adjust', 'remove'] });

        const failure = await barrier.arrive('adjust').then(
            () => undefined,
            (reason: unknown) => reason,
        );

        const message = (failure as Error).message;
        expect(message).toContain('Arrived: adjust');
        expect(message).toContain('Did not arrive: remove');
    });

    // RENDERED-IDENTITY OWNERSHIP. The ordinal that makes a refused label safe is itself a string a caller
    // could pass, so the substitute and the accepted set overlap — and the identity a barrier deduplicates by
    // is exactly what the release threshold counts. Two participants sharing one identity therefore do not leak
    // anything; they HANG, which is a worse failure than the one the guard prevents.
    describe('the identity a barrier deduplicates by is never shared by two participants', () => {
        it('keeps them distinct when the REFUSED label arrives first and claims the ordinal', async () => {
            const barrier = new ConcurrencyBarrier(2, { timeoutMs: 5_000 });
            const refused = barrier.arrive(`writes-for-${EMAIL}`);
            const collides = barrier.arrive('<participant-1>');

            await expect(Promise.all([refused, collides])).resolves.toEqual([undefined, undefined]);
            expect(barrier.released, 'two participants were merged into one identity').toBe(true);
            expect(new Set(barrier.arrivedLabels).size).toBe(2);
            expect(barrier.arrivedLabels.join(' ').includes(EMAIL)).toBe(false);
        });

        it('keeps them distinct when the ORDINAL-SHAPED label arrives first', async () => {
            const barrier = new ConcurrencyBarrier(2, { timeoutMs: 5_000 });
            const accepted = barrier.arrive('<participant-1>');
            const refused = barrier.arrive(`writes-for-${EMAIL}`);

            await expect(Promise.all([accepted, refused])).resolves.toEqual([undefined, undefined]);
            expect(barrier.released).toBe(true);
            expect(new Set(barrier.arrivedLabels).size).toBe(2);
        });

        it('keeps them distinct when the ordinal-shaped label came from expectedLabels', async () => {
            const barrier = new ConcurrencyBarrier(2, {
                timeoutMs: 5_000,
                expectedLabels: ['<participant-1>', '<participant-2>'],
            });
            const first = barrier.arrive(`writes-for-${EMAIL}`);
            const second = barrier.arrive(`reads-for-${EMAIL}`);

            await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
            expect(barrier.released).toBe(true);
            expect(new Set(barrier.arrivedLabels).size).toBe(2);
            expect(barrier.arrivedLabels.join(' ').includes(EMAIL)).toBe(false);
        });

        it('still counts a repeat arrival once when its identity was ordinalised twice over', async () => {
            // Stability has to survive the ownership stepping: the same raw label must resolve to the same
            // identity on its second arrival even though reaching that identity took two attempts.
            const barrier = new ConcurrencyBarrier(3, { timeoutMs: 60, expectedLabels: ['<participant-1>'] });
            const first = barrier.arrive(`writes-for-${EMAIL}`).then(
                () => undefined,
                () => undefined,
            );
            const repeat = await barrier.arrive(`writes-for-${EMAIL}`).then(
                () => undefined,
                (reason: unknown) => reason,
            );

            expect(repeat, 'a repeated label was counted twice').toBeInstanceOf(Error);
            expect(new Set(barrier.arrivedLabels).size).toBe(1);
            await first;
        });

        it('lets a pair driver run when the REFUSED label is A and the ordinal-shaped one is B', async () => {
            const journal: RunnerJournal = { calls: [] };
            const dataSource = createFakeDataSource(
                [createFakeRunner(journal), createFakeRunner(journal)],
                journal,
            );

            const result = await runSequentialPair(dataSource, {
                a: inertParticipant(`writes-for-${EMAIL}`),
                b: inertParticipant('<participant-1>'),
            });

            expect(result.a.status).toBe('fulfilled');
            expect(result.b.status).toBe('fulfilled');
            expect(result.a.label).not.toBe(result.b.label);
            expect(`${String(result.a.label)} ${String(result.b.label)}`.includes(EMAIL)).toBe(false);
        });

        it('still refuses a pair the caller named IDENTICALLY, which is a different question', async () => {
            const journal: RunnerJournal = { calls: [] };
            const dataSource = createFakeDataSource(
                [createFakeRunner(journal), createFakeRunner(journal)],
                journal,
            );

            await expect(
                runSequentialPair(dataSource, {
                    a: inertParticipant('writes-twice'),
                    b: inertParticipant('writes-twice'),
                }),
            ).rejects.toThrow(/must be distinguishable/);
        });

        it('refuses an identically-named pair even when both labels were themselves refused', async () => {
            // The same rule under redaction: two equal refused labels are still one caller mistake, and the
            // refusal must fire on the raw equality rather than be hidden by both rendering to an ordinal.
            const journal: RunnerJournal = { calls: [] };
            const dataSource = createFakeDataSource(
                [createFakeRunner(journal), createFakeRunner(journal)],
                journal,
            );

            const attempt = runSequentialPair(dataSource, {
                a: inertParticipant(`writes-for-${EMAIL}`),
                b: inertParticipant(`writes-for-${EMAIL}`),
            });

            await expect(attempt).rejects.toThrow(/must be distinguishable/);
            await expect(attempt).rejects.not.toThrow(new RegExp(EMAIL.replace('.', '\\.')));
        });

        it('lets a pair driver run when one label is ordinal-shaped and the other is refused', async () => {
            const journal: RunnerJournal = { calls: [] };
            const dataSource = createFakeDataSource(
                [createFakeRunner(journal), createFakeRunner(journal)],
                journal,
            );

            const result = await runSequentialPair(dataSource, {
                a: inertParticipant('<participant-2>'),
                b: inertParticipant(`writes-for-${EMAIL}`),
            });

            expect(result.a.status).toBe('fulfilled');
            expect(result.b.status).toBe('fulfilled');
            expect(result.a.label).not.toBe(result.b.label);
            expect(`${String(result.a.label)} ${String(result.b.label)}`.includes(EMAIL)).toBe(false);
        });
    });
});

// The diagnostic-secrecy contract of the redaction every suite in this package shares.
//
// A redaction that stops redacting still produces a string, so the failure mode is silent: the first
// divergence would surface as a session token, a bound parameter or a filesystem path in a build log. These
// cases measure it directly.

/**
 * The DIAGNOSTIC-SECRECY CONTRACT of `concurrency-barrier.ts`, tested where the real thing is tested: against the
 * actual driver and runtime messages it will be handed.
 */
describe('the diagnostic redaction every e2e suite shares', () => {
    const TOKEN = ['s3cr3t', 'session', 'token', '4f2c81b9'].join('-');
    const EMAIL = 'someone.real@example.invalid';
    /** A constraint name a driver would quote back at the caller, beside the value it refused. */
    const DUPLICATE_KEY_NAME = 'customer.UQ_email';
    const SECRETS = [TOKEN, EMAIL, 'Hayden', 'Zieme'];

    /**
     * A rejection shaped exactly as TypeORM raises one, driver fields and all.
     */
    function driverRejection(): Error {
        return Object.assign(
            new Error(`Duplicate entry '${EMAIL}' for key 'UQ_reorder_list_line_list_variant'`),
            {
                name: 'QueryFailedError',
                code: 'ER_DUP_ENTRY',
                errno: 1062,
                query: 'INSERT INTO `reorder_list_line` (`reorderListId`, `productVariantId`) VALUES (?, ?)',
                parameters: [7, 300],
                driverError: { sqlMessage: `Duplicate entry '${EMAIL}'`, sqlState: '23000' },
            },
        );
    }

    /** Fails naming which secret leaked, without putting the secret itself in the message. */
    function expectNoSecretIn(text: string): void {
        for (const secret of SECRETS) {
            expect(
                text.includes(secret),
                `the diagnostic disclosed a value beginning "${secret.slice(0, 3)}"`,
            ).toBe(false);
        }
    }

    // The teardown diagnostic cases. Each is a REAL driver or runtime message, and each is one that a rule
    // redacting quoted runs and letting the rest through would have published verbatim. What is asserted is not
    // "the value was replaced" but "no part of the message was reproduced at all": the output is built from
    // three fixed lists and a length, so the message text has nowhere to appear.
    it('reproduces no part of a MySQL failure that quoted the value it refused', () => {
        const redacted = redactTeardownDiagnostic(
            new Error(`Duplicate entry '${EMAIL}' for key '${DUPLICATE_KEY_NAME}'`),
        );

        expect(redacted).toContain('[unique-violation]');
        expect(redacted).toContain('mentioning customer');
        expect(redacted).toContain('message withheld');
        expectNoSecretIn(redacted);
        expect(redacted).not.toContain('Duplicate');
    });

    it('reproduces no part of a PostgreSQL detail, whose value is in PARENTHESES and never quoted', () => {
        // The case a quote-based rule cannot catch: there is no quoted run to find, so such a rule would
        // publish the buyer's address unchanged.
        const redacted = redactTeardownDiagnostic(
            new Error(
                'duplicate key value violates unique constraint "customer_email_key" ' +
                    `Key (emailAddress)=(${EMAIL}) already exists.`,
            ),
        );

        expect(redacted).toContain('[unique-violation]');
        expectNoSecretIn(redacted);
        expect(redacted).not.toContain('@');
        expect(redacted).not.toContain('emailAddress');
    });

    it('reproduces no part of an unquoted, undelimited token', () => {
        // THE SECOND CASE THAT DEFEATED IT: nothing to quote, nothing to parenthesise, and the token is simply
        // a word in a sentence.
        const redacted = redactTeardownDiagnostic(new Error(`failed to invalidate session token ${TOKEN}`));

        expectNoSecretIn(redacted);
        expect(redacted).toContain('mentioning session');
        expect(redacted).toContain('message withheld');
    });

    it('reproduces no part of an absolute filesystem path', () => {
        // THE THIRD: a path is a disclosure about the host, and it carries no delimiter either.
        const redacted = redactTeardownDiagnostic(
            new Error("ENOENT: no such file or directory, open '/home/runner/work/secrets/db.sqlite'"),
        );

        expect(redacted).toContain('[filesystem]');
        expect(redacted).not.toContain('/');
        expect(redacted).not.toContain('runner');
        expect(redacted).not.toContain('secrets');
    });

    it('names the driver code, because it is an enumerated constant rather than a value', () => {
        const err = Object.assign(new Error(`Duplicate entry '${EMAIL}' for key 'x'`), {
            name: 'QueryFailedError',
            code: 'ER_DUP_ENTRY',
        });

        const redacted = redactTeardownDiagnostic(err);

        expect(redacted).toContain('QueryFailedError/ER_DUP_ENTRY');
        expectNoSecretIn(redacted);
    });

    it('refuses a driver code that is not one of the three enumerated shapes', () => {
        // A `code` carrying anything other than an ER_/SQLITE_ constant or a five-character SQLSTATE is not a
        // code as far as this helper is concerned, so it is dropped rather than printed.
        const err = Object.assign(new Error('failed'), { code: TOKEN });

        const redacted = redactTeardownDiagnostic(err);

        expect(redacted).not.toContain(TOKEN);
        expect(redacted).toContain('Error [unclassified]');
    });

    it('does not name an error class it does not recognise', () => {
        const err = Object.assign(new Error('failed'), { name: `LeakedFrom-${TOKEN}` });

        const redacted = redactTeardownDiagnostic(err);

        expect(redacted).toContain('<unrecognised-error-class>');
        expectNoSecretIn(redacted);
    });

    it('fails CLOSED on a phrasing nobody anticipated, reporting it by length alone', () => {
        // THE PROPERTY THE WHOLE DESIGN RESTS ON. An engine, a library or a future platform version phrases a
        // failure in a way none of the three lists knows, and the result is not a message that slipped through
        // unredacted — it is a length.
        const opaque = 'q7vn41xk';
        const message = `an engine nobody has written a pattern for refused ${opaque}`;

        const redacted = redactTeardownDiagnostic(new Error(message));

        expect(redacted).toBe(
            `Error [unclassified] mentioning nothing recognised (message withheld, ${String(
                message.length,
            )} chars)`,
        );
        expect(redacted).not.toContain(opaque);
    });

    it('renders a rejection that is not an Error, and reproduces none of it either', () => {
        const redacted = redactTeardownDiagnostic(`failed on '${TOKEN}'`);

        expect(redacted).toContain('string [unclassified]');
        expectNoSecretIn(redacted);
    });

    it('keeps an ordinary stage label verbatim, because that is what identifies the step', () => {
        expect(describeTeardownStage('plugin rows')).toBe('plugin rows');
        expect(describeTeardownStage('core row restoration 3')).toBe('core row restoration 3');
        expect(describeTeardownStage('temporary directory 1 of 2')).toBe('temporary directory 1 of 2');
    });

    it('refuses a label carrying a filesystem path, forward or back slashed', () => {
        expect(describeTeardownStage('temporary directory /tmp/reorder-abc123')).toBe(
            '<unrenderable-stage-label>',
        );
        expect(describeTeardownStage('temporary directory C:\\Users\\runner\\reorder')).toBe(
            '<unrenderable-stage-label>',
        );
        expect(describeTeardownStage('/home/runner/work/secrets')).not.toContain('runner');
    });

    it('refuses a label carrying an address', () => {
        expect(describeTeardownStage(`restore ${EMAIL}`)).toBe('<unrenderable-stage-label>');
        expectNoSecretIn(describeTeardownStage(`restore ${EMAIL}`));
    });

    it('refuses a label that is merely too long, since every real one here is a few words', () => {
        const overBudget = `restore ${'x'.repeat(90)}`;

        expect(describeTeardownStage(overBudget)).toBe('<unrenderable-stage-label>');
    });

    it('refuses a label carrying a control character, so a log record cannot be forged', () => {
        // CWE-117. A newline or carriage return SPLITS ONE LOG RECORD INTO TWO, and the second half can be
        // spelled to read like a step that passed — so a label is a log-injection vector and not only a
        // disclosure one. A path-and-address rule catches none of it: a newline is not a path separator, not an
        // `@`, and costs one character against the budget.
        const forged = 'writes\nfake-log-line: every teardown stage passed';
        const bell = 'writes\u0007then';
        const carriageReturn = 'writes\rthen';

        expect(describeTeardownStage(forged)).toBe('<unrenderable-stage-label>');
        expect(describeTeardownStage(bell)).toBe('<unrenderable-stage-label>');
        expect(describeTeardownStage(carriageReturn)).toBe('<unrenderable-stage-label>');
        expect(describeTeardownStage(forged).includes('fake-log-line')).toBe(false);
    });

    it('refuses a label carrying an invisible or non-ASCII character', () => {
        expect(describeTeardownStage('writes\u200bthen')).toBe('<unrenderable-stage-label>');
        expect(describeTeardownStage('writes\u202ethen')).toBe('<unrenderable-stage-label>');
        expect(describeTeardownStage('restore Café')).toBe('<unrenderable-stage-label>');
    });

    it('accepts both substitute forms, so a guarded label cannot be guarded twice into a different one', () => {
        expect(describeTeardownStage('<unrenderable-stage-label>')).toBe('<unrenderable-stage-label>');
        expect(describeTeardownStage('<participant-1>')).toBe('<participant-1>');
        expect(describeTeardownStage('<participant-12>')).toBe('<participant-12>');
    });

    /**
     * THE END-TO-END PROPERTY, ASSERTED THROUGH THE AGGREGATOR RATHER THAN THROUGH ITS PARTS.
     */
    it('routes both the label and the failure through their guards when it aggregates', async () => {
        const hostPath = '/tmp/reorder-abc123';
        let aggregated = '';

        try {
            await runAllTeardownStages([
                {
                    what: `temporary directory ${hostPath}`,
                    run: () => Promise.reject(new Error(`ENOENT, no such file or directory '${hostPath}'`)),
                },
            ]);
        } catch (err: unknown) {
            aggregated = err instanceof Error ? err.message : String(err);
        }

        expect(aggregated).toContain('Teardown did not complete cleanly');
        expect(aggregated).toContain('<unrenderable-stage-label>');
        expect(aggregated).toContain('[filesystem]');
        expect(aggregated).toContain('message withheld');
        // And not one path character survived. Asserting the separator rather than the path is the stronger
        // statement: it holds for a path this test never thought of.
        expect(aggregated).not.toContain(hostPath);
        expect(aggregated).not.toContain('/');
    });

    it('is bounded by construction, so no budget has to cut a literal in half', () => {
        const redacted = redactTeardownDiagnostic(new Error(`${'padding '.repeat(600)}${TOKEN}`));

        expect(redacted.length).toBeLessThan(200);
        expect(redacted).not.toContain('<truncated>');
        expectNoSecretIn(redacted);
    });

    // The shapes a real driver failure carries beside its message. `JSON.stringify` of an ordinary `Error`
    // yields `{}` because its own properties are non-enumerable, which is what makes serialising a rejected
    // outcome LOOK safe. A TypeORM `QueryFailedError` is not an ordinary Error: it copies the driver's error
    // onto itself, so `query`, `parameters` and the driver's own fields are ENUMERABLE OWN PROPERTIES and a
    // serialisation publishes every one of them. These two cases pin that this module reads only the message,
    // the class and an enumerated code.
    it('reads nothing but the message, class and code from a driver error carrying query and parameters', () => {
        const driverFailure = Object.assign(
            new Error(`Duplicate entry '${EMAIL}' for key '${DUPLICATE_KEY_NAME}'`),
            {
                name: 'QueryFailedError',
                code: 'ER_DUP_ENTRY',
                query: 'INSERT INTO `customer` (`emailAddress`, `phoneNumber`) VALUES (?, ?)',
                parameters: [EMAIL, '+44 7700 900000'],
                driverError: { sqlMessage: `Duplicate entry '${EMAIL}'`, sqlState: '23000' },
            },
        );

        const redacted = redactTeardownDiagnostic(driverFailure);

        expect(redacted).toContain('QueryFailedError/ER_DUP_ENTRY');
        expect(redacted).toContain('[unique-violation]');
        expectNoSecretIn(redacted);
        expect(redacted).not.toContain('INSERT');
        expect(redacted).not.toContain('VALUES');
        expect(redacted).not.toContain('phoneNumber');
        expect(redacted).not.toContain('7700');
        expect(redacted).not.toContain('23000');
    });

    it('reproduces no part of a statement fragment, even one with no value in it at all', () => {
        // A statement is a disclosure in its own right — it names columns and the shape of a write — and the
        // message is where a driver puts it.
        const redacted = redactTeardownDiagnostic(
            new Error(
                'error: syntax error at or near "SELCT" — ' +
                    'SELECT "id", "emailAddress", "passwordHash" FROM "user" WHERE "identifier" = $1',
            ),
        );

        expect(redacted).toContain('[syntax]');
        expect(redacted).not.toContain('SELECT');
        expect(redacted).not.toContain('passwordHash');
        expect(redacted).not.toContain('$1');
        expect(redacted).toContain('mentioning user');
    });

    it('reproduces no part of a bound parameter that arrived as the whole rejection', () => {
        const redacted = redactTeardownDiagnostic([TOKEN, EMAIL]);

        expect(redacted).toContain('object [unclassified]');
        expectNoSecretIn(redacted);
    });
    // THE OUTCOME DESCRIBER, WHICH IS THE HELPER THE RACE CASES REACH FOR. Every barriered pair in this
    // package reports through it, and a participant of one writes straight through the repository — so the
    // reason it carries is the most sensitive error object the package ever holds.
    describe('the settled-outcome describer the race cases report through', () => {
        it('describes a rejected participant by class, code and errno and reproduces none of its message', () => {
            const described = describeSettledOutcomes([
                { label: 'writes-first', status: 'fulfilled' },
                { label: 'writes-the-duplicate', status: 'rejected', reason: driverRejection() },
            ]);

            expect(described).toContain('writes-first=fulfilled');
            expect(described).toContain('writes-the-duplicate REJECTED:');
            expect(described).toContain('QueryFailedError/ER_DUP_ENTRY#1062');
            expect(described).toContain('[unique-violation]');
            expect(described).toContain('UQ_reorder_list_line_list_variant');
            expectNoSecretIn(described);
            expect(described).not.toContain('INSERT');
            expect(described).not.toContain('VALUES');
            expect(described).not.toContain('23000');
            expect(described).not.toContain('Duplicate');
        });

        it("describes a fulfilled participant through the caller's own value describer", () => {
            const described = describeSettledOutcomes(
                [
                    { label: 'a', status: 'fulfilled', value: 'ReorderList' },
                    { label: 'b', status: 'rejected', reason: driverRejection() },
                ],
                outcome => String((outcome as { value?: unknown }).value ?? 'unknown'),
            );

            expect(described).toContain('a=ReorderList');
            expect(described).toContain('b REJECTED:');
            expectNoSecretIn(described);
        });

        it('refuses a participant label that carries a value', () => {
            const described = describeSettledOutcomes([
                { label: `restores ${EMAIL}`, status: 'rejected', reason: new Error('failed') },
            ]);

            expect(described).toContain('<unrenderable-stage-label>');
            expectNoSecretIn(described);
        });

        it('describes a participant with no label at all', () => {
            const described = describeSettledOutcomes([{ status: 'rejected', reason: driverRejection() }]);

            expect(described.startsWith('REJECTED:')).toBe(true);
            expectNoSecretIn(described);
        });

        it('reports a numeric driver errno and refuses one outside the enumerated range', () => {
            const inRange = redactTeardownDiagnostic(Object.assign(new Error('lock'), { errno: 3572 }));
            const outOfRange = redactTeardownDiagnostic(
                Object.assign(new Error('lock'), { errno: 1_700_000_000_000 }),
            );

            expect(inRange).toContain('#3572');
            expect(outOfRange).not.toContain('1700000000000');
            expect(outOfRange).not.toContain('#');
        });
    });

    // THE THROWING BOUNDARY. `runAllTeardownStages` covers a QUEUED restoration; what it cannot cover is a
    // restoration driven directly from a test body so the functional half can be asserted while the server is
    // still up.
    describe('the redacting rethrow every raw restoration statement passes through', () => {
        it('raises a failure that reproduces no part of the statement, its parameters or its message', () => {
            let thrown: unknown;
            try {
                rethrowRedacted('a captured-row restoration statement', driverRejection());
            } catch (err: unknown) {
                thrown = err;
            }

            expect(thrown).toBeInstanceOf(Error);
            const message = (thrown as Error).message;
            // What a reader NEEDS: which step, which error class, which enumerated driver code and errno, how
            // the failure classifies, and which schema object the driver named.
            expect(message).toContain('a captured-row restoration statement failed');
            expect(message).toContain('QueryFailedError/ER_DUP_ENTRY#1062');
            expect(message).toContain('[unique-violation]');
            // What it must NOT carry: the statement, the bound values, the driver's sentence, the SQLSTATE.
            expect(message).not.toContain('INSERT');
            expect(message).not.toContain('reorder_list_line` (`reorderListId');
            expect(message).not.toContain('VALUES');
            expect(message).not.toContain('23000');
            expect(message).not.toContain('Duplicate');
            expectNoSecretIn(message);
        });

        it('does not chain the original, because a cause is walked and printed by the runner', () => {
            let thrown: unknown;
            try {
                rethrowRedacted('a captured-row restoration statement', driverRejection());
            } catch (err: unknown) {
                thrown = err;
            }

            expect((thrown as { cause?: unknown }).cause).toBeUndefined();
            expect(JSON.stringify(thrown)).toBe('{}');
        });

        it('refuses a step label that carries a value, so the boundary cannot be talked into leaking one', () => {
            let thrown: unknown;
            try {
                rethrowRedacted(`restoring ${EMAIL}`, new Error('nope'));
            } catch (err: unknown) {
                thrown = err;
            }

            expectNoSecretIn((thrown as Error).message);
        });

        it('measures a rejection that is a bare bound value rather than an Error', () => {
            let thrown: unknown;
            try {
                rethrowRedacted('a captured-row restoration statement', [TOKEN, EMAIL]);
            } catch (err: unknown) {
                thrown = err;
            }

            expectNoSecretIn((thrown as Error).message);
        });
    });

    describe('the row-difference description the restoration assertions report', () => {
        it('names the row and the column of a moved cell, and neither of its values', () => {
            const captured = [
                { id: 7, token: TOKEN, invalidated: false, expires: new Date(1_700_000_000_000) },
            ];
            const now = [{ id: 7, token: `${TOKEN}xx`, invalidated: true, expires: null }];

            const described = describeRowDifferences(captured, now);

            expect(described).toContain(
                `row 7.token moved (string(${String(TOKEN.length)}) -> string(${String(TOKEN.length + 2)}))`,
            );
            // Numbers, booleans and nulls are the identifiers and flags a reader needs, and none of them can
            // carry a credential, so those are rendered as themselves.
            expect(described).toContain('row 7.invalidated moved (false -> true)');
            expect(described).toContain('row 7.expires moved (date -> null)');
            expectNoSecretIn(described);
        });

        it('still detects a change the shape alone cannot distinguish', () => {
            const captured = [{ id: 5, emailAddress: EMAIL }];
            const now = [{ id: 5, emailAddress: 'X'.repeat(EMAIL.length) }];

            expect(describeRowDifferences(captured, now)).toBe(
                `row 5.emailAddress moved (string(${String(EMAIL.length)}) -> string(${String(EMAIL.length)}))`,
            );
        });

        it('reports a vanished row and an arrived row by identifier alone', () => {
            const described = describeRowDifferences([{ id: 7, token: TOKEN }], [{ id: 9, token: TOKEN }]);

            expect(described).toContain('row 7 is missing');
            expect(described).toContain('row 9 was added');
            expectNoSecretIn(described);
        });

        it('says nothing when every cell matches, which is what the restoration assertion requires', () => {
            const captured = [{ id: 7, token: TOKEN, expires: new Date(1_700_000_000_000) }];

            expect(describeRowDifferences(captured, [{ ...captured[0] }])).toBe(NO_ROW_DIFFERENCE);
        });

        it('compares through the same canonicalisation two drivers are folded onto', () => {
            // A boolean column arrives as `true` from PostgreSQL and as `1` from the MySQL family, and the same
            // stored value read twice must not read as a difference. This is what keeps a cross-engine
            // restoration assertion from failing on the driver rather than on the data.
            expect(canonicaliseCell(true)).toBe(canonicaliseCell(1));
            expect(canonicaliseCell(false)).toBe(canonicaliseCell(0));
            expect(describeRowDifferences([{ id: 1, enabled: true }], [{ id: 1, enabled: 1 }])).toBe(
                NO_ROW_DIFFERENCE,
            );
        });
    });
});
