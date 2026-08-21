/*
 * End-to-end specification for `addItemToReorderList` — STORY-001-01-02.
 *
 * The AAP settles it. §0.1.2.4 supplies `maxQuantityPerLine = 999` as a value the ticket set is forbidden
 * from inventing, directs that the supplied values "be used as the declared defaults without substitution",
 * and names this operation and `adjustReorderListLine` as its enforcement points, applied to the RESULTING
 * quantity. The AAP is the frozen authority over a story-level test-deployment figure, exactly as it is for
 * the two page-size keys in its own conflict C-C, so this suite deploys **999**.
 *
 * `e2e-common/test-config.ts` maps a package name to a base port and falls back to 3250 for anything it
 * does not name; `reorder-plugin` is not named, so every suite in this package indexes off that shared
 * fallback. `testConfig()` is therefore called rather than a port being hard-coded — the per-file index it
 * derives is what keeps this file from colliding with its siblings inside this package.
 *
 * `./graphql/reorder-definitions` is the single authority for the plugin's own eight operations and no
 * suite may inline a copy of anything it declares — so every reorder document below is imported from it.
 * It declares no PLATFORM document (no sign-in, no catalogue read, no channel administration, no
 * `activeOrder`, no introspection), and this package's `e2e/` file set is closed, so the platform
 * documents this suite needs are declared here with `graphql-tag` rather than in a new shared module.
 *
 *  - A **counted** statement assertion is an equality and runs on the sql.js job only, gated with
 *    `isStatementCountEngine()` (epic §11.6.2). The behaviour each count evidences — the response, the
 *    persisted rows, the refusal — runs on all four engine jobs and is never gated.
 *  - A **forced interleaving** runs on `e2e-mariadb`, `e2e-mysql` and `e2e-postgres` only, gated with
 *    `supportsForcedInterleaving()`. sql.js is excluded from every concurrency claim (epic §11.6.3) and
 *    carries the sequential form of the same contract instead, which runs everywhere.
 */
/*
 * The non-null assertion rule is disabled for this file, as the shipped plugin e2e precedent
 * `packages/asset-server-plugin/e2e/asset-server-plugin.e2e-spec.ts:L1` does. A specification reads
 * fixture identifiers it has just asserted the existence of, and a narrowing dance around each one would
 * add noise without adding a single assertion. Every use below is preceded by an assertion that the value
 * is present, so a missing fixture fails on that assertion rather than on a type error.
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
import { DataSource } from 'typeorm';
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
    createPreWriteRendezvous,
    createTransactionBinder,
    EXCLUSIVE_PARENT_FOR_LINE_WRITE_ENGINES,
    PreWriteRendezvous,
    runBarrieredPair,
    runSequentialPair,
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

// The configured deployment
//
// Configuring a value for a test deployment is NOT choosing a product default. The shipped defaults —
// 200 lines per list and 999 units per line — are the plugin's own, and they are asserted by
// `src/reorder.plugin.spec.ts`. Only the LINE bound below is reduced — to 2, so that a third distinct
// variant breaches it inside one test, exactly as AC-6's Given clause requires. The quantity bound keeps
// the supplied 999, and its result boundary is reached arithmetically instead: an increment onto a line
// already holding enough that the SUM crosses the maximum while each figure alone is legal.

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

// Platform documents
//
// Declared here for the reason the header records: `./graphql/reorder-definitions` owns the plugin's
// eight operations and declares no platform operation, and this package's `e2e/` file set is closed.

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

// Result shapes of the platform documents above
//
// Hand-written for the same reason `./graphql/reorder-definitions` hand-writes its own: the checked-in
// introspection snapshot is never regenerated for this feature, so no generator runs over this suite.

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
        /*
         * The shared harness points this at `<package>/e2e/fixtures/assets`, which this package does
         * not have. The shipped cross-package precedent is `packages/dashboard/e2e/global-setup.ts`,
         * which borrows core's own fixture assets for exactly this reason.
         */
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
            /*
             * The minimal catalogue seeds one product with FOUR distinct enabled variants, which is what
             * the three-distinct-variant line-bound case needs. The path is the shipped cross-package
             * precedent's (`packages/dashboard/e2e/global-setup.ts`).
             */
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
        // Epic §11.6.2: the captured array is emptied per test, so a count is scoped to one test and
        // never to a file. Capture itself stays disabled until a test enables it around one operation.
        capture.disable();
        capture.reset();
    });

    afterEach(async () => {
        /*
         * EVERY STAGE RUNS, whatever any of them does, and the failures are reported once at the end. A linear
         * teardown stops at the first failure and strands the rest, which is how one broken test leaves the
         * next running against state it never established.
         *
         * Plugin-owned rows go first, child table before parent and each named explicitly, so a foreign key is
         * never what fails the cleanup. The harness's wholesale table clear is never used between tests: it
         * synchronises the schema and drops the populated catalogue every later test reads. Then the orders
         * this file's own fixture created; then the core rows a test mutated but did not create, newest first;
         * then the temporary directories; then the client's own session and channel token, so no test inherits
         * a sibling's.
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
            // ★ AN INDEX, NEVER THE PATH. `stage.what` is reproduced VERBATIM by the teardown aggregator —
            // that is deliberate, because the stage name is this file's own text and is what identifies the
            // step that failed — so anything interpolated into it is published as-is. An absolute temporary
            // directory discloses the layout of whatever machine ran the suite, developer or CI worker, and
            // nothing about the assertion needs it: the path stays in the closure below, where the removal
            // uses it and no log reads it.
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
     *
     * The same window the order ledger closes, closed for the plugin's own rows: `createReorderList` COMMITS
     * before its response is read, so an assertion on `__typename` or a decode of the identifier standing
     * between the commit and the ledger would lose a row that exists. `afterEach` in this file deletes by
     * identifier rather than emptying the table, so a lost identifier is a row that outlives the test and
     * shifts the counts a later test asserts. Discovery is a DELTA taken in a `finally`.
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
     * Runs a fixture step that may commit an order, and registers every order it committed — whatever the
     * step, or anything the caller does with its response, then does.
     *
     * THE WINDOW THIS CLOSES. A Shop mutation COMMITS before its response is read, so every step between the
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
        // THE EXACT CHILD ROWS, READ BACK RATHER THAN INFERRED. The order was created by the call
        // immediately above, so every line on it now is one this fixture caused; reading them through the
        // declared `lines` relation records their real identifiers instead of trusting a cascade to find
        // them later. The count is asserted, because a capture that silently recorded nothing would let a
        // teardown that deletes nothing report success.
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
        const tracked = ordersToRemove.splice(0, ordersToRemove.length);
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
    // against what was captured. Two mechanisms make that stricter than it first sounds, and a restoration
    // that names only the column it is undoing satisfies neither: the compensating write goes through the
    // RAW TABLE rather than the entity manager, so restoring a captured value cannot itself move an
    // entity-managed audit column, and it covers an inserted row and a deleted row alike by deleting or
    // re-inserting as the capture requires. The restoration is then read back and compared for equality, so
    // a column the compensating write missed fails the test rather than leaking into the next.

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
     *
     * **It is available on the generation engine alone**, because the shipped artefact is the migration
     * generator's PostgreSQL output and an emitted migration is bound to the engine it was generated against
     * ({@link committedMigrationApplies} carries the reasoning and the citations). Elsewhere the rebuild is
     * skipped and the caller says what its assertion then rests on, which is what the case below asserts
     * rather than assumes. Where a migration-created schema IS exercised on every engine is
     * `e2e/reorder-list-migration.e2e-spec.ts`: it applies the checked-in artefact where the dialect matches
     * and this engine's own lifecycle emission otherwise, and runs its whole data-bearing cycle against that.
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
     * Asserts one top-level `USER_INPUT_ERROR` carrying exactly the given resolved message, on an envelope
     * whose `data` is exactly null.
     *
     * `data` is asserted to be exactly `null` rather than "either `data` or its union member", because the
     * published field is `addItemToReorderList(...): AddItemToReorderListResult!`: a thrown error nullifies
     * that non-null field and propagates to the root, so `null` is the only envelope a genuine refusal can
     * produce. Accepting `data: { addItemToReorderList: null }` would additionally admit a resolver that
     * executed and returned null — a different outcome wearing the same assertion.
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

            // The precondition this test built itself: the list holds exactly zero lines.
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

            // Three inherited from the base entity, three declared by this feature, and nothing else.
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
        /*
         * AC-2's own literal arithmetic: the same quantity of 6 submitted twice, leaving exactly 12. The
         * criterion and the story's runnable demonstration both name 12, and the configured maximum of 999
         * admits it — see the reported deviation in this file's header for why the maximum is not AC-6's
         * stated 10, under which this total was not storable at all.
         */
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
             * Shape half, also on all four engine jobs, and it opens with the POSITIVE requirement because
             * without one the whole assertion is vacuous. Counting only the shapes the contract refuses — a
             * computed-value UPDATE, an INSERT, a DELETE — and requiring each to be none is satisfied by an
             * implementation that writes NOTHING AT ALL, and equally by a capture window that never saw the
             * write. So the accumulating statement itself is required to be present, exactly once, on every
             * dialect: the accumulation is a single self-referential UPDATE and this path has no concurrency
             * for the service's retry to double it.
             */
            const lineWrites = capture.writesFor('reorder_list_line');
            expect(
                lineWrites.filter(statement => statement.kind === 'update' && addsToStoredQuantity(statement))
                    .length,
                `Expected exactly one self-referential increment, filtered to reorder_list_line:\n${capture.format()}`,
            ).toBe(1);
            // ★ COUNTS, NEVER THE ARRAYS. `CapturedStatement` carries its raw bound `parameters` by design
            // — that is what makes the predicate assertions in this file possible — so handing one of these
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
                 * FEATURE-001-01 §2.6.1.1, asserted rather than paraphrased: exactly one scoped statement
                 * against the addressed plugin table, its `WHERE` carrying the acting customer and the
                 * active channel as conjuncts beside the row's own identifier, and no INSERT, UPDATE or
                 * DELETE at all. Never "zero statements" for a lookup — a correct implementation has to
                 * ask the database, and this asserts that it asked exactly once.
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
            // exact restoration with the assertion that it happened. Three tables move, and the third is the
            // one an inverse Admin mutation cannot undo: setting a `stockOnHand` INSERTS a `stock_movement`
            // [packages/core/src/service/services/stock-movement.service.ts:L113-L119], so restoring by
            // issuing the inverse mutation would put the numbers back, advance three `updatedAt` values and
            // leave a SECOND movement row behind. The capture over `stock_movement` removes whatever the
            // window inserted and leaves whatever was there before it.
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
             * The SERVICE-CALL boundary, which is a different observation from a statement count and is
             * therefore asserted separately and on all four engines: the platform's own availability entry
             * points are spied on their singleton instances and the assertion is on CALLS, never on
             * statements. A statement count cannot see a call that was answered from a cache, from an
             * already-loaded relation, or by a method that computed its answer without querying — and a
             * discarded availability read is still an availability read, which is exactly what this criterion
             * forbids. The spies call through, so the operation under test runs unaltered.
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

                /*
                 * The filters are named in the assertion, and all five are named rather than one. Zero is
                 * claimed because this write reaches no availability path at all, which is the one condition
                 * under which a zero count is an honest claim. Asserting the unchanged columns instead would
                 * hold just as firmly for an implementation that read the saleable level, discarded it and
                 * wrote the line anyway — a discarded read is still a read, and it is the thing this
                 * criterion says is not done.
                 */
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

            /*
             * Both figures are legal ON THEIR OWN, which is what makes this criterion falsifiable: the seeded
             * quantity is below the configured maximum and so is the increment. Only their SUM exceeds it, by
             * exactly one. An implementation that bounds the increment admits this second add; one that bounds
             * the result refuses it.
             */
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
            /*
             * The platform's negative-quantity error result describes setting a negative quantity on an
             * ORDER line and is silent on zero, so reporting a malformed list-line quantity with it would be
             * reporting one condition under another condition's name. It is not a member here, which is
             * precisely why this feature declares four error results rather than five.
             */
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
                /*
                 * The POSITIVE assertion this criterion exists for: the session holds the single permission
                 * the Customer Role is created with and no plugin-registered permission of any name. It is
                 * never asserted to hold `Permission.Owner` — that is declared unassignable and internal, so
                 * no session can be in that state; admission comes from the request context being marked
                 * owner-only, and the service-layer predicate is the whole of the control.
                 */
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

            /*
             * The zero delta is ASSERTED rather than omitted: this feature registers no permission
             * definition, so the published enum stays at 97 members — 97 → 97.
             */
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
             * There is no fourth field and there is no request-deduplication key of any name. The delivery
             * guarantee this operation makes is at-least-once — two deliveries of one add accumulate, as the
             * duplicated-delivery scenario below asserts — and the deterministic remedy is
             * `adjustReorderListLine`, which sets an absolute quantity. The forbidden name is described
             * rather than spelled so that a search for it over this file returns nothing.
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
         * incomplete-request scenario below. The fourth belongs to the name-canonicalisation path, which this
         * story's operation cannot reach — so it is exercised here through the list-creation helper this
         * suite already uses for its own fixtures. The claim is about the CATALOGUE, not about that
         * operation's behaviour, which STORY-001-01-01 and STORY-001-01-03 own.
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
                    'is removed, and must not contain control or zero-width characters',
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

            // Proceed, with no warning and no audit record. The disabled state is surfaced at preview time
            // and resolved at commit time by later features; this feature neither blocks on it nor reports
            // it, and it does not null the variant either — a disabled variant is still resolvable.
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
            // CAPTURED FIRST, before anything is written — including the no-op update below, which reads the
            // current price and, being a save, advances the variant's `updatedAt` on its way past. Two tables
            // hold this state: the variant row, and the `product_variant_price` rows that are where a price
            // actually lives. Both go back column for column, so restoring does not itself re-timestamp the
            // rows it restores.
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
            /*
             * The ticket's own figures, now that the configured maximum admits them: a line already holding 6,
             * a call of 6 that the server committed before the client's transport timed out, and an identical
             * retry of 6 leaving exactly 18 — not 12, because nothing replays and no claim is stored. The
             * remedy is the absolute set that brings it to the buyer's intended 12, and repeating that set
             * leaves 12: a set is idempotent where an add is not.
             */
            const PRE_EXISTING_QUANTITY = 6;
            const DELIVERED_QUANTITY = 6;
            const ACCUMULATED_AFTER_RETRY = PRE_EXISTING_QUANTITY + DELIVERED_QUANTITY * 2;
            const REMEDY_QUANTITY = PRE_EXISTING_QUANTITY + DELIVERED_QUANTITY;

            await signInAsCustomer(0);
            const list = await createList('Scenario duplicated delivery');
            const listId = decodeId(list.id);
            const variant = seededVariants[0];

            // The Given: the list already holds one line for this variant at a quantity of 6.
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
         *
         * WHY THE WRITE IS NOT THE HTTP CALL. An HTTP request opens a transaction of the server's own choosing
         * on a connection this barrier has never touched, so the rendezvous would sit entirely outside the
         * operation under test: the two requests could be serialised end to end and the run would still look
         * green. That is exactly the run in which a read-compute-save accumulation, or a count-then-insert
         * capacity check, survives a race test — each request sees the other's committed effect because they
         * never overlapped. Binding the context puts the whole operation on the held connection, so the
         * accumulation, the deduplication constraint and the conditional counter update are all exercised
         * inside the window the assertion claims.
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
                    // ON THE SHARED CONNECTION, NOT THIS PARTICIPANT'S TRANSACTION. Under the MySQL family's
                    // default REPEATABLE READ a transaction's snapshot is fixed by its first CONSISTENT read,
                    // so a precheck issued inside the participant's own transaction would fix it before the
                    // service ran and every read the service then took would answer from a snapshot older
                    // than its sibling's commit — the harness manufacturing the lost update it set out to
                    // detect. The observation is of the same shared state at the same moment either way.
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
                    // THE SECOND, INNER RENDEZVOUS, AND IT IS WHERE THIS RACE ACTUALLY LIVES. The outer
                    // barrier releases both participants together, which starts both service calls at the
                    // same moment and is not the same thing as overlapping their writes: this operation
                    // resolves the list, resolves the variant and looks up the existing line before it writes
                    // anything, so two callers released together can still run one wholly after the other and
                    // the second would then observe the first's committed effect. This hold fires immediately
                    // before this caller's FIRST statement against a plugin table and waits for its sibling,
                    // so both callers are provably past their own reads and short of their own writes when
                    // they are let go — which is the window the accumulation, the deduplication constraint
                    // and the conditional counter update all exist to survive.
                    const hold = preWrite.install(ctx);
                    try {
                        // INTERNAL identifiers, not the `T_n` forms a client sends. The platform decodes
                        // every `id` argument in an interceptor above the resolver
                        // (`packages/core/src/api/middleware/id-interceptor.ts`), so a service invoked
                        // directly is below that layer and receives decoded values — passing an external
                        // identifier here would reach the database as a non-numeric literal.
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
         * Whether this engine holds the parent list row EXCLUSIVELY for a line write, in which case the two
         * inner-rendezvous cases below cannot certify an interleaving and are skipped here.
         *
         * On the MySQL family a transaction that will write only a line takes the parent exclusively, because
         * two transactions holding it shared were measured to deadlock at the line row once that row is removed
         * beneath them — and an InnoDB deadlock inside a mutation's savepoint scope surfaces as an
         * unrecoverable savepoint error rather than as the retriable deadlock it is. Two accumulations against
         * ONE list therefore serialise at the parent by design, which is exactly what an inner rendezvous
         * requiring both participants to arrive at their own first write cannot observe: the second participant
         * is still waiting for the parent when the hold's budget expires. That is the design being honoured,
         * not a defect being hidden.
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
         *
         * A rejected participant here is a service call over a real connection, so its reason is a TypeORM
         * `QueryFailedError` carrying the statement and its bound values. The shared describer names the error
         * class, the driver code and the failure classification without reproducing any of it; the FULFILLED
         * side is this suite's own domain object, so this file decides what about it is worth saying.
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
            // the value on the other side of it carries the session token. Comparing here removes the
            // question rather than answering it.
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
            // AND IT IDENTIFIES AS THE SHOP API, which a direct service call does not get for free: the
            // platform reads the api type off the resolver's `info` argument, which no direct call
            // has, so `fromRequest` alone yields `custom` and a race would then be exercising a
            // branch no buyer's request reaches. `asShopApiContext` self-checks both the result and
            // that this context is left unchanged.
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
                // barrier, and then held together INSIDE their own operations until each had resolved the
                // list, the variant and the absent line and was about to issue its first write.
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
                // BOTH CALLERS HAD ALREADY READ THE LINE'S CURRENT QUANTITY WHEN THEY WERE RELEASED, which is
                // the precondition a lost update needs and the reason 12 rather than 18 is a reachable wrong
                // answer here at all. Without this hold the two operations could run end to end and the
                // second would read the first's committed 12, reaching 18 by serialisation rather than by
                // atomicity and evidencing nothing.
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
                 * 6 + 6 + 6 = 18, which is the scenario's own discriminator: "two concurrent six-unit adds
                 * against a line already holding six leave eighteen and not twelve". A read-compute-save
                 * implementation leaves 12 — both requests read 6, both compute 12, both store 12, and one
                 * buyer's six units are gone. Only an increment evaluated by the engine against the row's
                 * current value reaches 18.
                 */
                expect(rows[0].quantity).toBe(RACE_ADD_QUANTITY * 3);
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
                // Both callers reached their capacity claim before either had made one, so both were about to
                // write against a list holding one below the bound. That is the state a count-then-insert
                // check answers wrongly for both, and the state the conditional counter update has to settle.
                expectHeldBeforeTheirOwnWrites(preWrite);

                /*
                 * Exactly one returns the list and the other returns the limit error — the assertion that
                 * fails against a count-then-insert check, and the one the conditional counter update exists
                 * to satisfy. Both callers are FULFILLED because a limit error is a payload rather than a
                 * request failure, so the outcome each received is read off its value.
                 */
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

            // COUNTS, not the outcome arrays: each entry carries its raw rejection reason.
            expect(result.fulfilled.length, describeSettledOutcomes([result.a, result.b])).toBe(1);
            expect(result.rejected.length, describeSettledOutcomes([result.a, result.b])).toBe(1);
            expect(result.loser?.label).toBe('duplicate-insert');
            const rejection: unknown = (result.rejected[0] as { reason?: unknown }).reason;
            const reason = String(rejection instanceof Error ? (rejection.message ?? '') : (rejection ?? ''));
            // Every one of the four drivers names the offending relation in its own message, whether it
            // reports a constraint or the unique index the MySQL family stores under the same name.
            //
            // THE PREDICATE READS THE RAW MESSAGE; THE ASSERTION DOES NOT. `expect(reason).toContain(...)`
            // would make the driver's own text the matcher ACTUAL, which Vitest prints on failure — and on
            // MySQL that text is `Duplicate entry '<the value>' for key '<the name>'`. The boolean says the
            // same thing, and the redacted description beside it names the relation the driver mentioned.
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
         * ★ HOW THIS IS EVIDENCED, AND WHAT MAKES THE EMPTY RESULT MEAN SOMETHING.
         *
         * `generateMigration` decides between writing a file and logging
         * "No changes in database schema were found - cannot generate a migration." from exactly one input:
         * the schema builder's own log, `connection.driver.createSchemaBuilder().log()`. It writes a file if
         * and only if that log's `upQueries` is non-empty, and returns `undefined` otherwise. It forces
         * `synchronize: false` and `migrationsRun: false` on the connection it opens, so the schema it diffs
         * is whatever is already in the database (`packages/core/src/migrate.ts`).
         */
        it('leaves the platform generator with nothing to emit against the migration-created schema', async () => {
            const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'reorder-add-item-generated-'));
            // Queued BEFORE the call, so the directory is removed even if an assertion below fails.
            temporaryDirectories.push(outputDirectory);
            const snapshotDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'reorder-add-item-schema-'));
            temporaryDirectories.push(snapshotDirectory);

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

            // SECOND HALF — the platform entry point, against that same migration-created schema.
            const generated = await generateMigration(
                await generatorConfigAgainstMigratedSchema(snapshotDirectory),
                { name: 'storyOneOhOneOhTwoShouldEmitNothing', outputDir: outputDirectory },
            );
            // The file's own contents are the diagnostic when it does write one, and reading them also
            // catches the way this assertion could otherwise go quietly wrong: a generator pointed at an
            // EMPTY database emits the entire schema rather than nothing, so a broken snapshot fails here
            // loudly instead of passing vacuously.
            expect(
                generated,
                `generateMigration emitted a migration against the migration-created schema: ${
                    generated ? fs.readFileSync(generated, 'utf-8') : ''
                }`,
            ).toBeUndefined();
            expect(fs.readdirSync(outputDirectory)).toEqual([]);

            // The running server is unaffected by the generation pass, which is asserted rather than assumed
            // because that pass loads and then RESETS the platform's module-level configuration. The two
            // tables are empty at this point — the rebuild dropped and recreated them — so this also proves
            // the migration's own output accepts the writes this story makes.
            const stillWorking = await createList('After the generation pass');
            const added = await addItem(stillWorking.id, seededVariants[0].id, 3);
            expect(added.addItemToReorderList.__typename).toBe('ReorderList');
            expect((await readLineRows(decodeId(stillWorking.id))).length).toBe(1);
        });

        it('writes no migration file into a generator output directory and leaves the package untouched', () => {
            // A real directory, created here and removed in `afterEach`, so "nothing was written to it" is
            // an observation rather than a figure of speech.
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

    // ─────────────────────────────────────────────────────────────────────────────────────────────────────
    // CORRUPT PERSISTED STATE IS NOT COMPOUNDED — the portable half of conflict C-E, exercised live.
    //
    // `CHK_reorder_list_line_count_non_negative` and `CHK_reorder_list_line_quantity_positive` are declared
    // on the entities and do materialise on PostgreSQL and the SQLite family, but TypeORM 0.3.28 discards
    // them on MySQL and MariaDB. On those two engines a row violating either invariant is therefore storable
    // by anything writing outside this service — a repair script, a second application sharing the schema,
    // direct SQL. That much this plugin cannot prevent. What must not follow is this service COMPOUNDING the
    // violation: handing out capacity that a negative counter merely appears to permit, or adding to a
    // quantity the column may not hold and storing the result.
    //
    // Each case below seeds the violation through raw SQL exactly as such a writer would, then drives the
    // published mutation. The seeding is expected to SUCCEED where the constraint is absent and to be
    // REFUSED where it is present, so one case is meaningful on all four engines: it evidences the database
    // constraint on the engines that have it, and the service-level floor on the engines that do not.
    describe('corrupt persisted state is refused rather than compounded', () => {
        /**
         * True when a caught failure is a CHECK violation **naming the constraint the caller expected**.
         *
         * BOTH halves are required, and requiring only one is the bug this replaced. The engine's own code
         * establishes the CLASS of failure; the constraint name establishes that it was THIS invariant and
         * not another. A unique-constraint violation, a syntax error, a missing table, a denied privilege and
         * a dropped connection all fail the first half; a violation of some other check fails the second.
         *
         * The codes are the engines' own and were measured rather than assumed: PostgreSQL raises SQLSTATE
         * `23514` and puts the name in `constraint`; the SQLite family renders `CHECK constraint failed:
         * <name>`; MySQL 8 raises errno 3819 and MariaDB 4025, which this predicate accepts for completeness
         * even though neither engine creates these constraints in the first place. TypeORM copies the driver
         * error onto its own `QueryFailedError`, but a driver that nests it instead is read through
         * `driverError` so the predicate does not depend on which.
         *
         * Nothing read here is ever emitted. The message is tested, never printed — the caller either turns
         * this into a discriminated outcome or hands the failure to the redactor.
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
         *
         * **It is fail-closed, and that is the entire design.** An earlier version returned a boolean and
         * treated every failure as "the check refused it", so a syntax error, a missing column, a denied
         * privilege, a dropped connection or a violation of some OTHER constraint would all have been read as
         * proof that a security invariant exists — a broken test certifying an absent guard. Worse, it
         * classified AFTER {@link executeRawStatement}, which has already replaced the driver error with a
         * redacted one, so the evidence needed to classify correctly was gone by the time it looked.
         *
         * So the classification happens HERE, at the raw boundary, before anything is redacted, and only a
         * CHECK violation naming {@link expectedCheckConstraint} is admitted. Everything else goes to the
         * redactor and fails the test, which is the only safe direction for a helper whose output is read as
         * evidence.
         *
         * @param expectedCheckConstraint - The exact named object whose refusal is the only acceptable
         * failure. Passing a name the statement cannot violate makes every refusal rethrow, which is
         * deliberate: this parameter is the assertion.
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
                // Not the refusal this seed was written to provoke, so it is a broken test rather than
                // evidence of anything. It travels through the redactor because the raw failure carries the
                // statement and every bound value on its own enumerable properties.
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
                // exact object. The counter therefore still reads as the service left it, and there is
                // nothing for the service-level floor to defend against on this engine.
                expect(await readListRow(listRowId)).toMatchObject({ lineCount: 1 });
                return;
            }

            // The constraint is absent, the row is now invalid, and this is the state the exploit needs.
            const linesBefore = await countAllLineRows();
            await expectRefusal(() => addItem(list.id, seededVariants[1].id, 1));

            // NOTHING WAS BUILT ON IT. Without the claim's floor the counter would have satisfied
            // `< maxLinesPerList`, the claim would have been granted and a line would exist here.
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
            // legal arithmetic (0 + 2 = 2): request validation passes, so only the statement's own floor
            // stands between a row the column may not hold and a total computed from it.
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

            // THE VIOLATION WAS NOT COMPOUNDED. Without the accumulate floor this row would now read 2 — a
            // quantity computed from a base the column forbids, and indistinguishable thereafter from one the
            // buyer actually asked for.
            expect(await readLineRows(listRowId)).toMatchObject([{ quantity: 0 }]);
        });

        // ─────────────────────────────────────────────────────────────────────────────────────────────────
        // THE SEEDER ITSELF IS FAIL-CLOSED, asserted rather than assumed.
        //
        // The two cases above branch on what the seeder returns, so the seeder IS part of the evidence: if it
        // reported "the check refused it" for any failure other than that exact check, a green run would
        // certify a guard that was never exercised — on the very engines where the constraint is absent. Each
        // case below fails for a DIFFERENT reason that is not the expected check, and each must rethrow
        // rather than return the refusal outcome.
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
                // A genuine constraint violation, but of the per-variant uniqueness object rather than either
                // check. This is the case a class-only test would wave through, and the reason the constraint
                // NAME is required alongside the failure class.
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
                // The positive control. Without it the three cases above would also pass against a seeder
                // that rethrew unconditionally and could never return either outcome.
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
//   1. A reaches its hold and waits.
//   2. B cannot reach its hold at all, because it is blocked in the database.
//   3. A's wait ends.
//   4. B unblocks, reads A's committed state, and reaches its hold.
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

        // A WAIT INSTALLS TWO ESCAPES AND EXACTLY ONE OF THEM FIRES. Here the ARRIVAL fires, so the bounded
        // timer never does — and the defect this guards against is that timer being left pending for the rest
        // of its bound afterwards, holding the wait's closure and the rendezvous state it captures reachable,
        // and then elapsing inside whichever LATER test is running by then.
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
            // Observed across the SYNCHRONOUS call only, so the single timer captured is the wait's own
            // rather than a per-hold timer or anything the runtime installs elsewhere.
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
            // And nothing is left holding the rendezvous either, so a further arrival has no stale observer
            // to notify and no hold is still parked in the waiting set.
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
        // Nothing retained: the refused hold left the waiting set and its timer was cleared with it, so no
        // timer outlives the test that created it.
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

        // STEP 4, AND THE LATCH. The sibling now arrives, completing the count — the run the aggregates could
        // not tell apart from a genuine overlap. It is refused, and the release cause stays false.
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
        // cancellation listener synchronously when the pair is already abandoned, so the failure happens
        // DURING the hold's own registration. A rendezvous that registered before joining its waiting set
        // would fail over an empty set and then add this hold to a set nothing revisits: the intercepted
        // statement would never settle, and the suite would hang in teardown instead of reporting a failure.
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

        // A one-participant rendezvous is complete on the first arrival, so this delegates immediately and
        // is still certified as released by arrival.
        await participant.ctx.queryRunner.query(TARGETED_WRITE);
        expect(hold.releasedBy()).toBe('arrival');
        hold.restore();

        // After restoration a second targeted write is not intercepted at all — no second arrival is counted.
        await participant.ctx.queryRunner.query(TARGETED_WRITE);
        expect(rendezvous.arrivedCount()).toBe(1);
        expect(participant.executed).toEqual([TARGETED_WRITE, TARGETED_WRITE]);
    });
});
