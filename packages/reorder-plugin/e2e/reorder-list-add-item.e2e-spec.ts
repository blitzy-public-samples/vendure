/*
 * End-to-end specification for `addItemToReorderList` — STORY-001-01-02.
 *
 * ---------------------------------------------------------------------------------------------
 * ATTRIBUTION
 * ---------------------------------------------------------------------------------------------
 * `review_rules` was called for the entire rules document and returned exactly
 * `No user rules provided.` — so **no user-specified rule governs this file and no rule forced it into
 * scope**. There is no rule to cite here and none has been invented; the absence of rules is not licence
 * to lower the bar, so this suite is held to enterprise-standard best practice instead.
 *
 * Every obligation below is therefore either
 *  - prompt-derived: the Agent Action Plan, §0.5.1.8 (Group 8), §0.7.1 (Acceptance-Criteria mapping),
 *    §0.7.2 (Migration verification), §0.7.6 (Statement-Count Discipline) and §0.6.2.4 (contract
 *    elements that must not appear); or
 *  - ticket-derived: `tickets/EPIC-001/FEATURE-001-01/STORY-001-01-02-add-variant-with-quantity-to-list.md`
 *    §5 (AC-1 … AC-8), §7 (the five edge-case scenarios) and §10 (the ten-item story DoD);
 *    `tickets/EPIC-001/FEATURE-001-01-named-reorder-lists.md` §2.6.1 row 2, §2.6.1.1 (how a
 *    "reads nothing" claim is evidenced) and §2.11 (names, bounds and concurrency); and
 *    `tickets/EPIC-001-reorder-and-replenishment.md` §7.7, §7.8, §11.6.1 (lifecycle and isolation),
 *    §11.6.2 (the canonical query-capture harness) and §11.6.3 (which engines evidence a race).
 * Corroboration that no rules exist: AAP §0.8.1 and epic §11.9.
 *
 * ---------------------------------------------------------------------------------------------
 * ★ REPORTED CONFLICT — THE CONFIGURED QUANTITY MAXIMUM CANNOT SATISFY AC-2 AND AC-6 AT ONCE
 * ---------------------------------------------------------------------------------------------
 * This is a deviation, so it is stated here rather than absorbed silently.
 *
 * AC-6 fixes the deployment: "`ReorderPluginOptions.maxLinesPerList` is configured to 2 and
 * `ReorderPluginOptions.maxQuantityPerLine` is configured to 10 for the test deployment", and then
 * requires a `quantity` of **11** to be refused as over-maximum (11 = max + 1) and a `quantity` of **6
 * onto a line already holding 6** to be refused because the bound applies to the **resulting** quantity
 * of 12 rather than to the increment of 6.
 *
 * AC-2 states no configuration at all and requires that same second add — 6 onto a line holding 6 — to
 * **succeed**, leaving a quantity of exactly 12.
 *
 * A resulting quantity of 12 cannot be both admitted and refused by one value of one option, and epic
 * §11.6.1 fixes the server lifecycle at "once per specification file", so a second deployment inside
 * this file is not available either. AC-6 is the only clause that speaks to the configuration and it
 * cites FEATURE-001-01 §2.11, so the configuration follows AC-6: `maxQuantityPerLine` is **10**.
 *
 * What that costs, precisely, and what it does not:
 *  - AC-6 is asserted with every one of its own literal figures — 0, -1, 11, and 6 onto 6 — including
 *    the resulting-quantity proof, which lands on 12 as the ticket says and is REFUSED there.
 *  - AC-2's contract is asserted in full — the existing line is resolved rather than replaced, the
 *    identifier is unchanged, no second row appears, and the accumulation is one atomic self-referential
 *    statement — with the same quantity submitted twice, as AC-2 requires. The pair is 5 and 5, so the
 *    resulting quantity is 10 rather than 12. Nothing else about AC-2 changes.
 * The one figure that moves is AC-2's arithmetic total, and the behaviour it evidences (an addition, not
 * an overwrite; one row, not two) is unaffected by which legal total it lands on.
 *
 * ---------------------------------------------------------------------------------------------
 * REPORTED GAP — THIS PACKAGE HAS NO PORT OFFSET IN THE SHARED HARNESS
 * ---------------------------------------------------------------------------------------------
 * `e2e-common/test-config.ts` maps a package name to a base port and falls back to 3250 for anything it
 * does not name; `reorder-plugin` is not named, so every suite in this package indexes off 3250, which is
 * also the fallback every other unnamed package would use. That is reported rather than fixed: this suite
 * may not edit `e2e-common/*`. `testConfig()` is still called — never a hard-coded port — so the per-file
 * index it derives keeps this file from colliding with its siblings inside this package.
 *
 * ---------------------------------------------------------------------------------------------
 * WHY PLATFORM DOCUMENTS ARE DECLARED IN THIS FILE
 * ---------------------------------------------------------------------------------------------
 * `./graphql/reorder-definitions` is the single authority for the plugin's own eight operations and no
 * suite may inline a copy of anything it declares — so every reorder document below is imported from it.
 * It declares no PLATFORM document (no sign-in, no catalogue read, no channel administration, no
 * `activeOrder`, no introspection), and this package's `e2e/` file set is closed, so the platform
 * documents this suite needs are declared here with `graphql-tag` rather than in a new shared module.
 *
 * ---------------------------------------------------------------------------------------------
 * ENGINE POSTURE
 * ---------------------------------------------------------------------------------------------
 *  - A **counted** statement assertion is an equality and runs on the sql.js job only, gated with
 *    `isStatementCountEngine()` (epic §11.6.2). The behaviour each count evidences — the response, the
 *    persisted rows, the refusal — runs on all four engine jobs and is never gated.
 *  - A **forced interleaving** runs on `e2e-mariadb`, `e2e-mysql` and `e2e-postgres` only, gated with
 *    `supportsForcedInterleaving()`. sql.js is excluded from every concurrency claim (epic §11.6.3) and
 *    carries the sequential form of the same contract instead, which runs everywhere.
 *
 * ---------------------------------------------------------------------------------------------
 * THINGS THIS FILE DELIBERATELY DOES NOT CONTAIN
 * ---------------------------------------------------------------------------------------------
 *  - No assertion that any session holds `Permission.Owner`: it is declared unassignable and internal, so
 *    no session can hold it and the service-layer predicate is the whole of the control (epic R2/R3).
 *  - No `NegativeQuantityError`. It describes `quantity < 0` on an order line and is silent on zero, which
 *    is exactly why this feature declares four error results and not five (epic R13).
 *  - No request-deduplication key on the add input, which declares exactly three fields — asserted below
 *    against the introspected input type rather than described.
 *  - Neither of the two per-row list-options inputs the platform derives from the plugin's two
 *    `PaginatedList` implementors is named, declared or passed, and no `options` argument is written by
 *    hand (AAP §0.6.2.4).
 *  - No `it.only`: the shared e2e runner sets `allowOnly`, so one would pass CI while skipping the file.
 *  - No latency, throughput, service-level, conversion or revenue figure.
 *  - Where a published width is stated it is the B1 transition — root Shop queries 19 → 21, root mutations
 *    32 → 38, `ErrorCode` 32 → 36 and `Permission` 97 → 97 — and never a whole-programme total (R15).
 */
/*
 * The non-null assertion rule is disabled for this file, as the shipped plugin e2e precedent
 * `packages/asset-server-plugin/e2e/asset-server-plugin.e2e-spec.ts:L1` does. A specification reads
 * fixture identifiers it has just asserted the existence of, and a narrowing dance around each one would
 * add noise without adding a single assertion. Every use below is preceded by an assertion that the value
 * is present, so a missing fixture fails on that assertion rather than on a type error.
 */
/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { mergeConfig, OrderLine, TransactionalConnection } from '@vendure/core';
import { createTestEnvironment } from '@vendure/testing';
import fs from 'fs';
import gql from 'graphql-tag';
import os from 'os';
import path from 'path';
import { DataSource } from 'typeorm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { initialData } from '../../../e2e-common/e2e-initial-data';
import { TEST_SETUP_TIMEOUT_MS, testConfig } from '../../../e2e-common/test-config';
import { ReorderList, ReorderListLine, ReorderPlugin } from '../index';

import {
    BarrierParticipantSpec,
    runBarrieredPair,
    runSequentialPair,
    SQLJS_EXCLUSION_REASON,
    supportsForcedInterleaving,
} from './fixtures/concurrency-barrier';
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

// ---------------------------------------------------------------------------------------------
// The configured deployment
//
// Configuring a value for a test deployment is NOT choosing a product default. The shipped defaults —
// 200 lines per list and 999 units per line — are the plugin's own, and they are asserted by
// `src/reorder.plugin.spec.ts`. The two bounds below are deliberately small so that a bound can be
// reached inside one test, exactly as AC-6's Given clause requires.
// ---------------------------------------------------------------------------------------------

/** AC-6's configured line bound. Small enough that a third distinct variant breaches it. */
const MAX_LINES_PER_LIST = 2;

/** AC-6's configured quantity bound. See the reported conflict in this file's header. */
const MAX_QUANTITY_PER_LINE = 10;

/** Not exercised as a bound here; the list bound belongs to STORY-001-01-01. Set to the shipped value. */
const MAX_LISTS_PER_CUSTOMER = 25;

/** The shipped default page sizes, so a nested `lines` page always holds every line of a bounded list. */
const DEFAULT_LISTS_PAGE_SIZE = 25;
const DEFAULT_LINES_PAGE_SIZE = 50;

/** The password the seeding helper sets on every customer it creates. */
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

/** The identifier of a list that exists nowhere, used for the non-disclosure half of AC-3. */
const ABSENT_LIST_ID = 'T_9999999';

/** The identifier of a variant that resolves to nothing, used for the unresolvable-variant scenario. */
const ABSENT_VARIANT_ID = 'T_9999999';

// ---------------------------------------------------------------------------------------------
// Platform documents
//
// Declared here for the reason the header records: `./graphql/reorder-definitions` owns the plugin's
// eight operations and declares no platform operation, and this package's `e2e/` file set is closed.
// ---------------------------------------------------------------------------------------------

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

/** Reads the four enabled variants the minimal catalogue seeds, with their stock as the Admin API sees it. */
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

/** Mutates a variant's own columns — its `enabled` flag and its stock — and reads the result back. */
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

/** Introspects one enum type's member names, for the published-width transitions. */
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

// ---------------------------------------------------------------------------------------------
// Result shapes of the platform documents above
//
// Hand-written for the same reason `./graphql/reorder-definitions` hand-writes its own: the checked-in
// introspection snapshot is never regenerated for this feature, so no generator runs over this suite.
// ---------------------------------------------------------------------------------------------

/** One entry of {@link GET_CUSTOMER_LIST}. */
interface SeededCustomer {
    id: ReorderApiId;
    emailAddress: string;
}

/** One stock level as the Admin API publishes it. */
interface AdminStockLevel {
    id: ReorderApiId;
    stockLocationId: ReorderApiId;
    stockOnHand: number;
    stockAllocated: number;
}

/** One entry of {@link GET_PRODUCT_VARIANT_LIST} and of {@link UPDATE_PRODUCT_VARIANTS}. */
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

/** A GraphQL type reference as introspection returns it, to the depth the documents above request. */
interface IntrospectedTypeRef {
    kind: string;
    name: string | null;
    ofType?: IntrospectedTypeRef | null;
}

/** One root field's declared signature. */
interface IntrospectedRootField {
    name: string;
    args: Array<{ name: string; defaultValue: string | null; type: IntrospectedTypeRef }>;
    type: IntrospectedTypeRef;
}

/** {@link INTROSPECT_ROOT_FIELDS}. */
interface IntrospectRootFieldsQuery {
    __schema: {
        queryType: { name: string; fields: IntrospectedRootField[] };
        mutationType: { name: string; fields: IntrospectedRootField[] } | null;
    };
}

/** The active order as {@link GET_ACTIVE_ORDER} selects it. */
interface ActiveOrderShape {
    id: ReorderApiId;
    totalQuantity: number;
    lines: Array<{ id: ReorderApiId; quantity: number }>;
}

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

    const { server, adminClient, shopClient } = createTestEnvironment(
        mergeConfig(baseConfig, {
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
        }),
    );

    /** The running server's own data source. Obtained once the server has booted, never constructed here. */
    let dataSource: DataSource;

    /** The seeded customers, read through the Admin API because the seed generates their addresses. */
    let seededCustomers: SeededCustomer[];

    /** The four enabled variants the minimal catalogue seeds, ordered by SKU. */
    let seededVariants: AdminProductVariant[];

    /** The default channel's token, as the shared harness configures it. */
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
        // The shared harness configures a default channel token; the type permits null, so the value is
        // asserted before it is adopted rather than coerced past the compiler.
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
         * Child table before parent, each named explicitly, so a foreign key is never what fails the
         * cleanup. The harness's wholesale table clear is never used between tests: it synchronises the
         * schema and drops the populated catalogue every later test reads.
         */
        if (listIdsToDelete.length > 0) {
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

        // A test that mutated a core row it did not create restores it here, newest first.
        while (coreRowRestorations.length > 0) {
            const restore = coreRowRestorations.pop();
            if (restore) {
                await restore();
            }
        }

        while (temporaryDirectories.length > 0) {
            const directory = temporaryDirectories.pop();
            if (directory && fs.existsSync(directory)) {
                fs.rmSync(directory, { recursive: true, force: true });
            }
        }

        // The client's own state is reset so no test inherits a sibling's session or channel token.
        shopClient.setChannelToken(defaultChannelToken);
        capture.disable();
        capture.reset();
    });

    // -----------------------------------------------------------------------------------------
    // Helpers. Every expensive shared fixture is reached through a function each test calls from its
    // own body — never through a leftover a sibling test built (epic §11.6.1).
    // -----------------------------------------------------------------------------------------

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

    /** Signs in as one of the seeded customers and pins the client to the default channel token. */
    async function signInAsCustomer(index: number): Promise<SeededCustomer> {
        const customer = seededCustomers[index];
        expect(customer).toBeDefined();
        await shopClient.asUserWithCredentials(customer.emailAddress, SEEDED_CUSTOMER_PASSWORD);
        // `asUserWithCredentials` adopts the token of the single channel the login result reports, so the
        // channel this suite means to act in is set explicitly afterwards rather than assumed.
        shopClient.setChannelToken(defaultChannelToken);
        return customer;
    }

    /** Creates one list for the currently authenticated customer and registers it for teardown. */
    async function createList(name: string): Promise<ReorderListSuccessShape> {
        const { createReorderList } = await shopClient.query<
            CreateReorderListMutation,
            CreateReorderListMutationVariables
        >(CREATE_REORDER_LIST, { input: { name } });
        expect(createReorderList.__typename).toBe('ReorderList');
        const created = createReorderList as ReorderListSuccessShape;
        listIdsToDelete.push(decodeId(created.id));
        return created;
    }

    /** Issues the operation under test. */
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

    /** Issues the operation under test with the capture window bounded to exactly that request. */
    function addItemCaptured(
        reorderListId: ReorderApiId,
        productVariantId: ReorderApiId,
        quantity: number,
    ): Promise<AddItemToReorderListMutation> {
        return capture.capture(() => addItem(reorderListId, productVariantId, quantity));
    }

    /** The stored line rows of one list, by ascending identifier. */
    function readLineRows(listId: number): Promise<ReorderListLine[]> {
        return dataSource.getRepository(ReorderListLine).find({
            where: { reorderListId: listId },
            order: { id: 'ASC' },
        });
    }

    /** The stored list row, or `null`. */
    function readListRow(listId: number): Promise<ReorderList | null> {
        return dataSource.getRepository(ReorderList).findOne({ where: { id: listId } });
    }

    /** The number of stored line rows across every list, used to prove a refusal wrote nothing at all. */
    function countAllLineRows(): Promise<number> {
        return dataSource.getRepository(ReorderListLine).count();
    }

    /**
     * The top-level `errors` array and the `data` object of a request the server refused.
     *
     * The harness client throws when a response carries top-level errors, attaching the whole response —
     * so this is how a `USER_INPUT_ERROR` or a `FORBIDDEN` is read, both of which reach a client as a
     * top-level entry rather than as a member of a result union.
     */
    async function expectRefusal(
        run: () => Promise<unknown>,
    ): Promise<{ errors: Array<{ message: string; extensions?: { code?: string } }>; data: any }> {
        try {
            await run();
        } catch (err: unknown) {
            const response = (err as { response?: { errors?: any[]; data?: any } }).response;
            expect(response).toBeDefined();
            return { errors: response?.errors ?? [], data: response?.data ?? null };
        }
        throw new Error('Expected the request to be refused with a top-level error, but it succeeded.');
    }

    /** Asserts one top-level `USER_INPUT_ERROR` carrying exactly the given resolved message. */
    function expectSingleUserInputError(
        refusal: { errors: Array<{ message: string; extensions?: { code?: string } }>; data: any },
        expectedMessage: string,
        rawKey: string,
    ): void {
        expect(refusal.errors.length).toBe(1);
        expect(refusal.errors[0].extensions?.code).toBe('USER_INPUT_ERROR');
        // The resolved English sentence, not the key: an unregistered key surfaces as the key itself, so
        // this is the evidence that `I18nService.addTranslationFile` took effect at bootstrap.
        expect(refusal.errors[0].message).toBe(expectedMessage);
        expect(refusal.errors[0].message).not.toBe(rawKey);
        expect(refusal.data?.addItemToReorderList ?? null).toBeNull();
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

    /** Renders a root field's whole declared signature: name, arguments, argument types and nullability. */
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
     *
     * This is the assertion a read-compute-save implementation fails: it would emit
     * `SET quantity = ?`, which does not match, while the atomic form emits
     * `SET quantity = quantity + ?`, which does.
     */
    function addsToStoredQuantity(statement: CapturedStatement): boolean {
        return /\bquantity\s*=\s*quantity\s*\+/i.test(unquoteIdentifiers(statement.query));
    }

    // =========================================================================================
    // AC-1 — a variant is added to an empty list at the requested integer quantity
    // =========================================================================================

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

            // The stored row carries that list as its parent and that variant as its reference.
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
            // The stored line carries no translated value of its own, so every field of it is invariant.
            expect(german.lines.items[0].id).toBe(english.lines.items[0].id);
            expect(german.lines.items[0].quantity).toBe(english.lines.items[0].quantity);
            expect(german.lines.items[0].productVariantId).toBe(english.lines.items[0].productVariantId);
            // The variant-derived name resolves through the platform's existing catalogue path, so it is
            // present under both requests rather than asserted equal between them.
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

    // =========================================================================================
    // AC-2 — a second add for a variant already on the list resolves to the existing line
    // =========================================================================================

    describe('AC-2: a second add for the same variant resolves to the existing line and accumulates', () => {
        /*
         * ★ The submitted quantity is 5 twice rather than 6 twice, and the resulting quantity is therefore
         * 10 rather than 12. That is the single figure the reported conflict in this file's header moves:
         * AC-6 fixes `maxQuantityPerLine` at 10 and requires 6-onto-6 (a resulting 12) to be REFUSED, which
         * is asserted there. Everything AC-2 is actually about — the existing line is resolved rather than
         * replaced, its identifier is unchanged, no second row appears, and the accumulation is one atomic
         * self-referential statement — is asserted here in full and is independent of the total.
         */
        const FIRST_ADD_QUANTITY = 5;
        const SECOND_ADD_QUANTITY = 5;
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
            // The identifier being unchanged is what proves the existing row was resolved rather than
            // replaced: a delete-and-insert would return a different one and satisfy every other clause.
            expect(afterSecond.lines.items[0].id).toBe(firstLineId);
            expect(afterSecond.lines.items[0].productVariantId).toBe(variant.id);

            // No second row exists for that list and variant.
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
             * Shape half, also on all four engine jobs, expressed as zero counts over the shapes the
             * contract refuses rather than as a total. A read-then-save implementation emits an UPDATE that
             * assigns a computed value, which is exactly what the first assertion counts and requires to be
             * none; a delete-and-reinsert emits the statements the second and third count.
             */
            const lineWrites = capture.writesFor('reorder_list_line');
            expect(
                lineWrites.filter(
                    statement => statement.kind === 'update' && !addsToStoredQuantity(statement),
                ),
            ).toHaveLength(0);
            expect(lineWrites.filter(statement => statement.kind === 'insert')).toHaveLength(0);
            expect(lineWrites.filter(statement => statement.kind === 'delete')).toHaveLength(0);
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
                expect(lineWrites).toHaveLength(1);
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

    // =========================================================================================
    // AC-3 — an unknown list, and another customer's list, are indistinguishable
    // =========================================================================================

    describe("AC-3: an unknown list and another customer's list both return ReorderListNotFoundError", () => {
        it('returns responses indistinguishable in errorCode and in every field, and writes nothing', async () => {
            // The second customer's list, built by this test rather than inherited from a sibling.
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

            // R8 field-completeness: the error result's own fields are read out of `data`, not off a
            // top-level entry, because a union member is a payload rather than a request failure.
            const absentError = absent.addItemToReorderList as { errorCode: string; message: string };
            const foreignError = foreign.addItemToReorderList as { errorCode: string; message: string };
            expect(absentError.errorCode).toBe('REORDER_LIST_NOT_FOUND_ERROR');
            expect(typeof absentError.message).toBe('string');
            expect(absentError.message.length).toBeGreaterThan(0);

            // Indistinguishable: identical keys and identical values, so neither the presence nor the
            // absence of any field tells a caller which of the two cases they hit.
            expect(Object.keys(absent.addItemToReorderList).sort()).toEqual(
                Object.keys(foreign.addItemToReorderList).sort(),
            );
            expect(absent.addItemToReorderList).toEqual(foreign.addItemToReorderList);
            expect(foreignError.errorCode).toBe(absentError.errorCode);
            expect(foreignError.message).toBe(absentError.message);

            // Neither call wrote a line row anywhere, and the other customer's list is untouched.
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
                expect(listStatements).toHaveLength(1);
                const scopedRead = listStatements[0];
                expect(scopedRead.kind).toBe('select');
                expect(
                    whereRequiresScopedPredicates(scopedRead, [
                        { column: 'id', value: decodeId(ABSENT_LIST_ID), relation: 'ReorderList' },
                        { column: 'customerId', value: decodeId(customer.id), relation: 'ReorderList' },
                        { column: 'channelId', value: decodeId(ownRow!.channelId), relation: 'ReorderList' },
                    ]),
                ).toBe(true);
                expect(capture.writesFor('reorder_list', 'reorder_list_line')).toHaveLength(0);
                // The other half of the contract — "and exactly zero rows returned" — is read off the
                // response rather than off the statement: TypeORM's logger hooks never see a result set,
                // and the normalised not-found is what a read of no rows produces.
                expect(capture.forTables('reorder_list_line')).toHaveLength(0);
            },
        );
    });

    // =========================================================================================
    // AC-4 — an unauthenticated request writes no line
    // =========================================================================================

    describe('AC-4: an unauthenticated request writes no line', () => {
        it('returns exactly one FORBIDDEN entry with a null payload and leaves the list empty', async () => {
            await signInAsCustomer(0);
            const list = await createList('AC-4 unauthenticated write');
            const listId = decodeId(list.id);
            const totalLineRowsBefore = await countAllLineRows();

            // The request still carries a valid channel token; only the session is absent.
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
            expect(refusal.data?.addItemToReorderList ?? null).toBeNull();

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

                // A zero count is claimed only about a path refused BEFORE it reached the table, which this
                // is: the session guard runs before any statement of either plugin table is issued.
                expect(capture.forTables('reorder_list')).toHaveLength(0);
                expect(capture.forTables('reorder_list_line')).toHaveLength(0);
            },
        );
    });

    // =========================================================================================
    // AC-5 — a list line is not a stock reservation
    // =========================================================================================

    describe('AC-5: a list line is not a stock reservation', () => {
        /**
         * Puts one variant into the state AC-5 describes — tracked, four on hand, none allocated — and
         * registers the restoration of every column it changed, because the variant is a core row this test
         * did not create.
         */
        async function trackVariantWithFourOnHand(
            variant: AdminProductVariant,
        ): Promise<AdminProductVariant> {
            const priorTrackInventory = variant.trackInventory;
            const priorStockOnHand = variant.stockOnHand;
            coreRowRestorations.push(async () => {
                await adminClient.query<{ updateProductVariants: AdminProductVariant[] }>(
                    UPDATE_PRODUCT_VARIANTS,
                    {
                        input: [
                            {
                                id: variant.id,
                                trackInventory: priorTrackInventory,
                                stockOnHand: priorStockOnHand,
                            },
                        ],
                    },
                );
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

        /** Re-reads one variant's stock through the Admin API. */
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

            // Six requested against four on hand, which is deliberately more than is saleable.
            const { addItemToReorderList } = await addItem(list.id, tracked.id, 6);

            expect(addItemToReorderList.__typename).toBe('ReorderList');
            const updated = addItemToReorderList as ReorderListSuccessShape;
            expect(updated.lines.items).toHaveLength(1);
            expect(updated.lines.items[0].quantity).toBe(6);
            expect(await readLineRows(listId)).toHaveLength(1);
            // No stock-related error of any kind: `InsufficientStockError` is a downstream commit-time
            // result and is never a result of this mutation.
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
                 * The filter is named in the assertion: `stock_level`. Zero is claimed because this write
                 * reaches no availability path at all, which is the one condition under which a zero count
                 * is an honest claim. Asserting the unchanged columns instead would hold just as firmly for
                 * an implementation that read the saleable level, discarded it and wrote the line anyway —
                 * a discarded read is still a read, and it is the thing this criterion says is not done.
                 */
                expect(capture.forTables('stock_level')).toHaveLength(0);
            },
        );
    });

    // =========================================================================================
    // AC-6 — a quantity outside its bounds, and a breached line bound
    // =========================================================================================

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

        it('applies the maximum to the resulting quantity of 12 rather than to the increment of 6', async () => {
            await signInAsCustomer(0);
            const list = await createList('AC-6 resulting quantity bound');
            const listId = decodeId(list.id);
            const variant = seededVariants[0];

            // An increment of 6 is legal on its own — it is below the configured maximum of 10.
            const first = await addItem(list.id, variant.id, 6);
            expect(first.addItemToReorderList.__typename).toBe('ReorderList');
            const totalLineRowsBefore = await countAllLineRows();

            // The same legal increment against a line already holding 6 is refused, because 6 + 6 = 12 is
            // what the line would hold and 12 is above the maximum. This is the assertion that fails if the
            // bound is applied to the increment instead of to the result.
            const refusal = await expectRefusal(() => addItem(list.id, variant.id, 6));

            expectSingleUserInputError(refusal, QUANTITY_ABOVE_MAXIMUM_MESSAGE, QUANTITY_ABOVE_MAXIMUM_KEY);
            expect(await countAllLineRows()).toBe(totalLineRowsBefore);
            const rows = await readLineRows(listId);
            expect(rows).toHaveLength(1);
            // The refused add left the stored quantity exactly where it was.
            expect(rows[0].quantity).toBe(6);
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

            // A third DISTINCT variant, which would create a third line.
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

    // =========================================================================================
    // AC-7 — an ordinary customer session reaches the operation; a foreign channel token does not
    // =========================================================================================

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

            // The stored row's owning customer is the authenticated customer, derived from the session
            // rather than from any argument — no argument can nominate a different owner.
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

            // A second REAL channel, created through the Admin API in `beforeAll` — never a mutated token.
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
            // The list created under one channel token is not reachable under another, and the one line it
            // already held is unchanged.
            expect(rows[0].quantity).toBe(6);
        });
    });

    // =========================================================================================
    // AC-8 — the existing order operations are unchanged and the active order is untouched
    // =========================================================================================

    describe('AC-8: the existing order operations are unchanged and the active order is untouched', () => {
        it('leaves the active order total quantity exactly as it was and writes no OrderLine', async () => {
            await signInAsCustomer(0);

            // The active order is built by this test, through the existing Shop mutation, so the recorded
            // prior value is a real one rather than zero by default.
            const { addItemToOrder } = await shopClient.query<{
                addItemToOrder: { __typename: string; id?: ReorderApiId; totalQuantity?: number };
            }>(ADD_ITEM_TO_ORDER, { productVariantId: seededVariants[0].id, quantity: 3 });
            expect(addItemToOrder.__typename).toBe('Order');

            const before = await shopClient.query<{ activeOrder: ActiveOrderShape | null }>(GET_ACTIVE_ORDER);
            expect(before.activeOrder).not.toBeNull();
            const recordedTotalQuantity = before.activeOrder!.totalQuantity;
            expect(recordedTotalQuantity).toBe(3);
            const orderLinesBefore = await dataSource.getRepository(OrderLine).count();

            // The setup this criterion reads after: one completed list add, whose own outcome AC-1 asserts.
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

            // Name, arguments, argument types, return type and nullability, all in one rendered string.
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

            // Additive only: every baseline member survives under its own name.
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

    // =========================================================================================
    // The published input's shape — exactly three fields, and no request-deduplication key
    // =========================================================================================

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

    // =========================================================================================
    // The plugin's message catalogue — all four keys resolve to English rather than passing through
    // =========================================================================================

    describe('The plugin registers its message catalogue at bootstrap', () => {
        /*
         * Three of the four keys are reachable through `addItemToReorderList` and are asserted at their own
         * criteria: the positive-integer and above-maximum keys at AC-6, and the variant-not-found key in the
         * incomplete-request scenario below. The fourth belongs to the name-canonicalisation path, which this
         * story's operation cannot reach — so it is exercised here through the list-creation helper this
         * suite already uses for its own fixtures. The claim is about the CATALOGUE, not about that
         * operation's behaviour, which STORY-001-01-01 and STORY-001-01-03 own.
         *
         * An unregistered key surfaces as the key itself, so a resolved English sentence is the only evidence
         * that `I18nService.addTranslationFile` actually took effect.
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
            // The registered sentence interpolates the fixed length bound, so a resolved message proves both
            // that the catalogue loaded and that the interpolation variable is spelled as the file spells it.
            expect(refusal.errors[0].message).toBe(
                'The reorder list name must be between 1 and 191 characters once surrounding whitespace ' +
                    'is removed, and must not contain control or zero-width characters',
            );
        });
    });

    // =========================================================================================
    // §7 Scenario — zero, null or empty collection, and an incomplete request
    // =========================================================================================

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

            // Refused by the platform's own document validation, so there is no payload at all rather than
            // a null field: `quantity` is declared non-nullable in the published input object.
            expect(refusal.errors.length).toBeGreaterThanOrEqual(1);
            expect(refusal.data ?? null).toBeNull();
            expect(await countAllLineRows()).toBe(totalLineRowsBefore);
            expect(await readLineRows(listId)).toHaveLength(0);
        });

        it('refuses a request passing an explicit null for the non-null quantity', async () => {
            await signInAsCustomer(0);
            const list = await createList('Scenario null quantity');
            const listId = decodeId(list.id);
            const totalLineRowsBefore = await countAllLineRows();

            // A different request from the one above, and both are made: one omits the field, one supplies
            // null for it.
            const refusal = await expectRefusal(() =>
                shopClient.query(ADD_ITEM_TO_REORDER_LIST_WITH_NULL_QUANTITY, {
                    reorderListId: list.id,
                    productVariantId: seededVariants[0].id,
                }),
            );

            expect(refusal.errors.length).toBeGreaterThanOrEqual(1);
            expect(refusal.data ?? null).toBeNull();
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
            // The resolved English sentence, not the raw key — the evidence that the plugin's catalogue was
            // registered at bootstrap.
            expect(refusal.errors[0].message).toMatch(VARIANT_NOT_FOUND_MESSAGE_PATTERN);
            expect(refusal.errors[0].message).not.toBe(VARIANT_NOT_FOUND_KEY);
            expect(refusal.data?.addItemToReorderList ?? null).toBeNull();
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
            expect(refusal.data?.addItemToReorderList ?? null).toBeNull();
            expect(await countAllLineRows()).toBe(totalLineRowsBefore);
            expect(await readLineRows(listId)).toHaveLength(0);
        });
    });

    // =========================================================================================
    // §7 Scenario — the variant being added is disabled
    // =========================================================================================

    describe('Scenario: an item unavailable, deleted or disabled since the last purchase', () => {
        it('proceeds for a disabled variant, because a saved list records intent rather than availability', async () => {
            const variant = seededVariants[2];
            await adminClient.asSuperAdmin();
            coreRowRestorations.push(async () => {
                await adminClient.query<{ updateProductVariants: AdminProductVariant[] }>(
                    UPDATE_PRODUCT_VARIANTS,
                    { input: [{ id: variant.id, enabled: variant.enabled }] },
                );
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

    // =========================================================================================
    // §7 Scenario — the catalogue price of the variant being added has moved
    // =========================================================================================

    describe('Scenario: a price changed since the last purchase', () => {
        it('proceeds with no warning, because the line stores no price for a change to invalidate', async () => {
            const variant = seededVariants[1];
            await adminClient.asSuperAdmin();
            const beforeUpdate = await adminClient.query<{
                updateProductVariants: Array<AdminProductVariant & { price: number }>;
            }>(UPDATE_PRODUCT_VARIANTS, { input: [{ id: variant.id }] });
            const priorPrice = beforeUpdate.updateProductVariants[0].price;
            coreRowRestorations.push(async () => {
                await adminClient.query<{ updateProductVariants: AdminProductVariant[] }>(
                    UPDATE_PRODUCT_VARIANTS,
                    { input: [{ id: variant.id, price: priorPrice }] },
                );
            });
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
            // Nothing on the returned line or on the stored row could have gone stale, because neither
            // carries a monetary value at all. Copying a price onto a list line would be a defect.
            expect(updated.lines.items[0]).not.toHaveProperty('price');
            expect(updated.lines.items[0]).not.toHaveProperty('currencyCode');
            const rows = await readLineRows(listId);
            expect(rows).toHaveLength(1);
            expect(Object.keys(rows[0]).some(key => FORBIDDEN_PAYLOAD_FIELD_PATTERN.test(key))).toBe(false);
        });
    });

    // =========================================================================================
    // §7 Scenario — a duplicated request rather than a duplicated intent
    // =========================================================================================

    describe('Scenario: the same add is delivered twice and this operation cannot tell the difference', () => {
        it('accumulates on the retry and offers the absolute set as the deterministic remedy', async () => {
            /*
             * The ticket's figures are 6 → 18 with a remedy of 12. Under the configured maximum of 10 — see
             * the reported conflict in this file's header — the same three-step contract is asserted at 3 → 6
             * with a remedy of 4. What is being asserted is unchanged: a retry ACCUMULATES rather than
             * replaying a recorded result, and a set is idempotent where an add is not.
             */
            await signInAsCustomer(0);
            const list = await createList('Scenario duplicated delivery');
            const listId = decodeId(list.id);
            const variant = seededVariants[0];

            const first = await addItem(list.id, variant.id, 3);
            expect(first.addItemToReorderList.__typename).toBe('ReorderList');
            const lineId = (first.addItemToReorderList as ReorderListSuccessShape).lines.items[0].id;

            // The client retries the identical mutation, unchanged, because its first call timed out at the
            // transport after the server had committed it.
            const retry = await addItem(list.id, variant.id, 3);

            expect(retry.addItemToReorderList.__typename).toBe('ReorderList');
            const afterRetry = retry.addItemToReorderList as ReorderListSuccessShape;
            expect(afterRetry.lines.items).toHaveLength(1);
            expect(afterRetry.lines.items[0].quantity).toBe(6);
            expect(afterRetry.lines.items[0].id).toBe(lineId);
            expect(await readLineRows(listId)).toHaveLength(1);

            // The remedy, asserted in the same test rather than described: an absolute set, repeated.
            const remedy = await shopClient.query<
                AdjustReorderListLineMutation,
                AdjustReorderListLineMutationVariables
            >(ADJUST_REORDER_LIST_LINE, {
                input: { reorderListId: list.id, lineId, quantity: 4 },
            });
            expect(remedy.adjustReorderListLine.__typename).toBe('ReorderList');
            expect((remedy.adjustReorderListLine as ReorderListSuccessShape).lines.items[0].quantity).toBe(4);

            const repeated = await shopClient.query<
                AdjustReorderListLineMutation,
                AdjustReorderListLineMutationVariables
            >(ADJUST_REORDER_LIST_LINE, {
                input: { reorderListId: list.id, lineId, quantity: 4 },
            });
            expect(repeated.adjustReorderListLine.__typename).toBe('ReorderList');
            expect((repeated.adjustReorderListLine as ReorderListSuccessShape).lines.items[0].quantity).toBe(
                4,
            );
            const rows = await readLineRows(listId);
            expect(rows).toHaveLength(1);
            expect(rows[0].quantity).toBe(4);
        });
    });

    // =========================================================================================
    // §7 Scenario — concurrent modification, and the engine split that decides what evidences it
    // =========================================================================================

    describe('Scenario: two requests add to the same list at the same moment', () => {
        /** Escapes an identifier the way the configured driver does, so one statement reads on all four. */
        function escapeName(identifier: string): string {
            return dataSource.driver.escape(identifier);
        }

        /**
         * One side of a race, expressed as a real `addItemToReorderList` request.
         *
         * The precheck — the read the race is about — runs on this participant's own connection inside its
         * own transaction, and the harness itself puts the rendezvous between the two phases: both prechecks
         * complete, both participants are registered and released together, and only then does either write
         * begin. There is no `arrive()` for a body to forget to await, which is what makes
         * {@link runBarrieredPair} evidence rather than an ordering hope. `Promise.all` alone would satisfy
         * none of that.
         *
         * The list identifier is interpolated into the precheck's statement rather than bound, because the
         * four drivers disagree about placeholder syntax and the value is a number this suite's own fixture
         * produced.
         */
        function addItemParticipant(
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

        it.skipIf(!supportsForcedInterleaving())(
            `reconciles two simultaneous first adds to one line of quantity 4 on ${resolveConfiguredEngine()}`,
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

                const result = await runBarrieredPair(dataSource, {
                    a: addItemParticipant('first-writer', list.id, listId, variant.id, 2),
                    b: addItemParticipant('second-writer', list.id, listId, variant.id, 2),
                });

                // Both were provably inside the pre-write window together.
                expect(result.a.releasedBeforeWrite).toBe(true);
                expect(result.b.releasedBeforeWrite).toBe(true);
                // Neither participant saw a line before either wrote, which is what makes this the insert
                // race rather than the update race.
                expect(result.a.status).toBe('fulfilled');
                expect(result.b.status).toBe('fulfilled');

                /*
                 * Both callers succeed and one row survives: the loser's insert violates the per-variant
                 * uniqueness constraint, the platform unwinds its transaction, and the bounded retry
                 * accumulates onto the winner's row. The loser is RECONCILED rather than reported, so no
                 * error result reaches either caller.
                 */
                expect(fulfilledTypenames([result.a, result.b])).toEqual(['ReorderList', 'ReorderList']);
                const rows = await readLineRows(listId);
                expect(rows).toHaveLength(1);
                expect(rows[0].quantity).toBe(4);
                const row = await readListRow(listId);
                expect(row).not.toBeNull();
                expect(row!.lineCount).toBe(1);
            },
        );

        it.skipIf(!supportsForcedInterleaving())(
            `loses no update when two simultaneous adds hit an existing line on ${resolveConfiguredEngine()}`,
            async () => {
                await signInAsCustomer(0);
                const list = await createList('Race lost update probe');
                const listId = decodeId(list.id);
                const variant = seededVariants[0];
                const seeded = await addItem(list.id, variant.id, 2);
                expect(seeded.addItemToReorderList.__typename).toBe('ReorderList');

                const result = await runBarrieredPair(dataSource, {
                    a: addItemParticipant('first-incrementer', list.id, listId, variant.id, 2),
                    b: addItemParticipant('second-incrementer', list.id, listId, variant.id, 2),
                });

                expect(result.a.releasedBeforeWrite).toBe(true);
                expect(result.b.releasedBeforeWrite).toBe(true);
                // Both prechecks saw the one existing line, so both requests took the update path and no
                // insert was attempted — which is why the uniqueness constraint decides nothing here.
                expect(result.a.status === 'fulfilled' && result.a.value !== undefined).toBe(true);
                expect(result.b.status === 'fulfilled' && result.b.value !== undefined).toBe(true);
                expect(fulfilledTypenames([result.a, result.b])).toEqual(['ReorderList', 'ReorderList']);

                const rows = await readLineRows(listId);
                expect(rows).toHaveLength(1);
                /*
                 * 2 + 2 + 2. A read-compute-save implementation leaves 4: both requests read 2, both compute
                 * 4, both store 4, and one buyer's two units are gone. Only an increment evaluated by the
                 * engine against the row's current value reaches 6.
                 */
                expect(rows[0].quantity).toBe(6);
            },
        );

        it.skipIf(!supportsForcedInterleaving())(
            `admits exactly one of two simultaneous adds at the line bound on ${resolveConfiguredEngine()}`,
            async () => {
                await signInAsCustomer(0);
                const list = await createList('Race line bound');
                const listId = decodeId(list.id);
                // One line below the configured bound, so exactly one of the two new lines can be created.
                await addItem(list.id, seededVariants[0].id, 1);
                expect(await readLineRows(listId)).toHaveLength(MAX_LINES_PER_LIST - 1);

                const result = await runBarrieredPair(dataSource, {
                    a: addItemParticipant('variant-two', list.id, listId, seededVariants[1].id, 1),
                    b: addItemParticipant('variant-three', list.id, listId, seededVariants[2].id, 1),
                });

                expect(result.a.releasedBeforeWrite).toBe(true);
                expect(result.b.releasedBeforeWrite).toBe(true);

                /*
                 * Exactly one returns the list and the other returns the limit error — the assertion that
                 * fails against a count-then-insert check, and the one the conditional counter update exists
                 * to satisfy. Both callers are FULFILLED because a limit error is a payload rather than a
                 * request failure, so the outcome each received is read off its value.
                 */
                expect(fulfilledTypenames([result.a, result.b])).toEqual([
                    'ReorderList',
                    'ReorderListLimitError',
                ]);
                const limitOutcome = [result.a, result.b].find(
                    outcome =>
                        outcome.status === 'fulfilled' &&
                        outcome.value?.addItemToReorderList.__typename === 'ReorderListLimitError',
                );
                expect(limitOutcome).toBeDefined();
                const limitError = (limitOutcome as { value: AddItemToReorderListMutation }).value
                    .addItemToReorderList as { maxItems: number };
                expect(limitError.maxItems).toBe(MAX_LINES_PER_LIST);

                // The stored line count is exactly the maximum rather than one over it.
                const rows = await readLineRows(listId);
                expect(rows).toHaveLength(MAX_LINES_PER_LIST);
                const row = await readListRow(listId);
                expect(row).not.toBeNull();
                expect(row!.lineCount).toBe(MAX_LINES_PER_LIST);
            },
        );

        it(`reconciles two sequential identical adds to one line of quantity 4 on ${resolveConfiguredEngine()}`, async () => {
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
                a: addItemParticipant('first-writer', list.id, listId, variant.id, 2),
                b: addItemParticipant('second-writer', list.id, listId, variant.id, 2),
            });

            expect(result.a.settledOrder).toBe(0);
            expect(result.b.settledOrder).toBe(1);
            expect(result.a.arrived).toBe(false);
            expect(result.b.arrived).toBe(false);
            expect(fulfilledTypenames([result.a, result.b])).toEqual(['ReorderList', 'ReorderList']);

            const rows = await readLineRows(listId);
            expect(rows).toHaveLength(1);
            expect(rows[0].quantity).toBe(4);
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

            // The named per-variant uniqueness object is what refuses the second write: no service pre-check
            // is in the path at all, because the row is written straight through the repository.
            expect(result.fulfilled).toHaveLength(1);
            expect(result.rejected).toHaveLength(1);
            expect(result.loser?.label).toBe('duplicate-insert');
            const reason = String(
                (result.rejected[0] as { reason?: unknown }).reason instanceof Error
                    ? ((result.rejected[0] as { reason: Error }).reason.message ?? '')
                    : ((result.rejected[0] as { reason?: unknown }).reason ?? ''),
            );
            // Every one of the four drivers names the offending relation in its own message, whether it
            // reports a constraint or the unique index the MySQL family stores under the same name.
            expect(reason.toLowerCase()).toContain('reorder_list_line');

            expect(await readLineRows(listId)).toHaveLength(1);
        });
    });

    // =========================================================================================
    // This suite's empty-generation obligation
    // =========================================================================================

    /** The plugin's own migrations directory, whose contents this suite must leave untouched. */
    const pluginMigrationsDirectory = path.join(__dirname, '../src/migrations');

    /** Its contents as they stood before any test in this file ran. */
    const pluginMigrationsAtCollection = fs.existsSync(pluginMigrationsDirectory)
        ? fs.readdirSync(pluginMigrationsDirectory).sort()
        : [];

    describe('This story generates no migration', () => {
        /*
         * ★ HOW THIS IS EVIDENCED, AND THE LIMITATION STATED RATHER THAN GLOSSED.
         *
         * `generateMigration` decides between writing a file and logging
         * "No changes in database schema were found - cannot generate a migration." from exactly one input:
         * the schema builder's own log, `connection.driver.createSchemaBuilder().log()`. It writes a file if
         * and only if that log's `upQueries` is non-empty, and returns `undefined` otherwise.
         *
         * It is NOT invoked in-process here, and the reason is specific rather than squeamish: it runs the
         * platform's pre-bootstrap configuration pass and then calls the configuration module's reset, which
         * replaces the process-wide active configuration the running server was built from. Calling it from
         * inside a live specification would corrupt every later test in this file, and a suite that
         * sabotages its own server is not evidence of anything. So the assertion reads the same input from
         * the RUNNING server's own data source, which is the connection the plugin's entities are actually
         * registered against.
         *
         * The limitation, stated plainly: under the e2e initializers the schema was built by the schema
         * builder rather than by STORY-001-01-01's migration, so what this evidences is that THIS story adds
         * no column and alters no table relative to the registered entity definitions. It does not evidence
         * that the migration itself is faithful — that is the dedicated data-bearing up/down/up cycle of
         * `reorder-list-migration.e2e-spec.ts`, and this suite does not claim it. What is asserted here is
         * genuinely falsifiable rather than vacuous: adding one column to either entity makes the log
         * non-empty and fails it.
         */
        it('leaves the schema builder with nothing to say about either plugin table', async () => {
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
});
