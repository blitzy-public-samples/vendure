/*
 * STORY-001-01-04 — "Read reorder lists through the Shop API".
 */
import { generate } from '@graphql-codegen/cli';
import { LanguageCode, SortOrder } from '@vendure/common/lib/generated-shop-types';
import {
    generateMigration,
    mergeConfig,
    ProductVariant,
    TransactionalConnection,
    VendureConfig,
} from '@vendure/core';
import { createTestEnvironment, E2E_DEFAULT_CHANNEL_TOKEN, SimpleGraphQLClient } from '@vendure/testing';
import { execFileSync } from 'child_process';
import fs from 'fs-extra';
import { DocumentNode, getIntrospectionQuery, print } from 'graphql';
import gql from 'graphql-tag';
import os from 'os';
import path from 'path';
import { DataSource, QueryRunner } from 'typeorm';
import type { SqljsConnectionOptions } from 'typeorm/driver/sqljs/SqljsConnectionOptions';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { initialData } from '../../../e2e-common/e2e-initial-data';
import { TEST_SETUP_TIMEOUT_MS, testConfig } from '../../../e2e-common/test-config';
import { ReorderList, ReorderListLine, ReorderPlugin } from '../index';
import { shopApiExtensions } from '../src/api/api-extensions';
import { AddReorderLists1786838400000 } from '../src/migrations/1786838400000-add-reorder-lists';
import { ReorderListService } from '../src/service/reorder-list.service';

import {
    canonicaliseCell,
    describeRowDifferences,
    NO_ROW_DIFFERENCE,
    rethrowRedacted,
    runAllTeardownStages,
} from './fixtures/concurrency-barrier';
import {
    CapturedStatement,
    committedMigrationApplies,
    CorrelatedOwnershipRequirement,
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
    CREATE_REORDER_LIST,
    CreateReorderListMutation,
    CreateReorderListMutationVariables,
    GET_ACTIVE_CUSTOMER_REORDER_LIST,
    GET_ACTIVE_CUSTOMER_REORDER_LIST_INCLUDE_SHARED,
    GET_ACTIVE_CUSTOMER_REORDER_LIST_WITH_PAGED_LINES,
    GET_ACTIVE_CUSTOMER_REORDER_LISTS,
    GET_ACTIVE_CUSTOMER_REORDER_LISTS_INCLUDE_SHARED,
    GET_ACTIVE_CUSTOMER_REORDER_LISTS_PAGINATED,
    GET_ACTIVE_CUSTOMER_REORDER_LISTS_WITH_LINE_PAGES,
    GetActiveCustomerReorderListIncludeSharedQuery,
    GetActiveCustomerReorderListIncludeSharedQueryVariables,
    GetActiveCustomerReorderListQuery,
    GetActiveCustomerReorderListQueryVariables,
    GetActiveCustomerReorderListsIncludeSharedQuery,
    GetActiveCustomerReorderListsIncludeSharedQueryVariables,
    GetActiveCustomerReorderListsPaginatedQuery,
    GetActiveCustomerReorderListsPaginatedQueryVariables,
    GetActiveCustomerReorderListsQuery,
    GetActiveCustomerReorderListsWithLinePagesQuery,
    GetActiveCustomerReorderListsWithLinePagesQueryVariables,
    GetActiveCustomerReorderListWithPagedLinesQuery,
    GetActiveCustomerReorderListWithPagedLinesQueryVariables,
    REMOVE_REORDER_LIST_LINE,
    RemoveReorderListLineMutation,
    RemoveReorderListLineMutationVariables,
    ReorderApiId,
    ReorderListFieldsShape,
} from './graphql/reorder-definitions';

/**
 * `maxListsPerCustomer` for this TEST DEPLOYMENT.
 *
 * Thirty, because it has to EXCEED the collection read's default page size of 25: the omitted-`take` case
 * can only observe truncation if more lists exist than that default returns, and every one of them is
 * created through the published mutation rather than inserted, so the bound must admit them all.
 */
const MAX_LISTS_PER_CUSTOMER = 30;

const MAX_LINES_PER_LIST = 200;

const MAX_QUANTITY_PER_LINE = 999;

/**
 * The collection read's default page size, at its DECLARED default, because AC-3(b) asserts this exact
 * number as the page ceiling a caller reaches by supplying no page size at all.
 */
const DEFAULT_LISTS_PAGE_SIZE = 25;

const DEFAULT_LINES_PAGE_SIZE = 50;

/**
 * The platform's own Shop list-query maximum, at its shipped default
 * (`packages/core/src/config/default-config.ts`).
 */
const SHOP_LIST_QUERY_LIMIT = 100;

const LIST_TABLE = 'reorder_list';

/** The child table, addressed BEFORE {@link LIST_TABLE} in every cleanup. */
const LINE_TABLE = 'reorder_list_line';

/** Both plugin tables, child first, for the cleanup that runs after every test. */
const PLUGIN_TABLES_CHILD_FIRST = [LINE_TABLE, LIST_TABLE] as const;

/** The number of customers the seed creates. Two: AC-5 and AC-4 both need a second buyer to own a row. */
const SEEDED_CUSTOMER_COUNT = 2;

/** The password `populate-customers.ts` sets on every seeded customer. The only fixed credential here. */
const SEEDED_CUSTOMER_PASSWORD = 'test';

const SECOND_CHANNEL_CODE = 'reorder-read-second-channel';

/** Its token, which the channel-scope cases SEND rather than mutating a variable. */
const SECOND_CHANNEL_TOKEN = 'reorder-read-second-channel-token';

/** AC-1's first list, created FIRST and therefore expected SECOND under `createdAt` DESC, `id` DESC. */
const FIRST_LIST_NAME = 'Weekly Kitchen Restock';

/** AC-1's second list, created SECOND and therefore expected FIRST under the same total order. */
const SECOND_LIST_NAME = 'Monthly Cleaning';

/** The malformed identifier AC-4 sends. The `ID` scalar accepts it as a string, so it reaches the resolver. */
const MALFORMED_LIST_ID = 'not-an-id';

/** An identifier no row carries, for AC-4's first case. Well beyond anything this fixture creates. */
const UNKNOWN_LIST_ID = 'T_999999';

/** The four new `ErrorCode` members, in declaration order. Asserted by name, and none may be missing. */
const FEATURE_ERROR_CODES = [
    'REORDER_LIST_NOT_FOUND_ERROR',
    'REORDER_LIST_NAME_CONFLICT_ERROR',
    'REORDER_LIST_LIMIT_ERROR',
    'REORDER_LIST_LINE_NOT_FOUND_ERROR',
];

const FEATURE_ERROR_RESULTS = [
    'ReorderListLimitError',
    'ReorderListLineNotFoundError',
    'ReorderListNameConflictError',
    'ReorderListNotFoundError',
];

const FEATURE_ROOT_QUERIES = ['activeCustomerReorderList', 'activeCustomerReorderLists'];

const FEATURE_ROOT_MUTATIONS = [
    'addItemToReorderList',
    'adjustReorderListLine',
    'createReorderList',
    'deleteReorderList',
    'removeReorderListLine',
    'updateReorderList',
];

/** The published root-`Query` width of the untouched Shop API baseline, measured against `schema-shop.json`. */
const BASELINE_ROOT_QUERY_FIELD_COUNT = 19;

/** The published root-`Mutation` width of the same baseline. */
const BASELINE_ROOT_MUTATION_FIELD_COUNT = 32;

/** The published `ErrorCode` width of the same baseline. */
const BASELINE_ERROR_CODE_MEMBER_COUNT = 32;

/** The number of baseline types implementing `ErrorResult`. */
const BASELINE_ERROR_RESULT_IMPLEMENTOR_COUNT = 31;

/** The published `Permission` width of the same baseline, and of the runtime schema. A ZERO delta. */
const BASELINE_PERMISSION_MEMBER_COUNT = 97;

/** The two shipped order mutations AC-7 asserts gain no argument, this feature registering no custom field. */
const UNWIDENED_ORDER_MUTATIONS = ['addItemToOrder', 'adjustOrderLine'];

/**
 * The four input fields the platform's list-options generator puts on every options input it derives.
 *
 * Asserted as a SUBSET rather than as the whole membership: the generator also adds `filterOperator` when
 * the schema declares `LogicalOperator` (`packages/core/src/api/config/generate-list-options.ts`), and
 * pinning the exact set here would make a platform addition look like this plugin's defect.
 */
const GENERATED_LIST_OPTIONS_FIELDS = ['skip', 'take', 'sort', 'filter'];

const MONETARY_OR_STOCK_FIELD = /price|money|amount|currency|tax|stock|inventory|saleable/i;

/** The SKU prefix every bare catalogue variant this suite creates carries, so cleanup can find them all. */
const BARE_VARIANT_SKU_PREFIX = 'REORDER-READ-BARE-';

/** The repository-relative path of the compiler project asserted to FAIL, for AC-8. */
const EXHAUSTIVE_TSCONFIG = 'tsconfig.error-code-exhaustive.json';

const DEFAULTED_TSCONFIG = 'tsconfig.error-code-defaulted.json';

const EXHAUSTIVE_SCRIPT = 'typecheck:error-code-exhaustive';

const DEFAULTED_SCRIPT = 'typecheck:error-code-defaulted';

/** The TypeScript version the root manifest pins EXACTLY. AC-8 asserts the resolved compiler is this one. */
const PINNED_TYPESCRIPT_VERSION = '5.8.2';

/** A generous budget for one compiler invocation. A control value for the spawn, not a claim about timing. */
const COMPILER_INVOCATION_TIMEOUT_MS = 240_000;

/**
 * Where the plugin-aware types AC-8 generates are written: the package root, not this directory.
 */
const GENERATED_TYPES_DIRECTORY = path.join('..', '.generated');
const GENERATED_SHOP_TYPES_FILE = 'shop-error-codes.ts';

/** Where the live introspection AC-8 feeds to the generator is written. Also a build product of this run. */
const GENERATED_INTROSPECTION_FILE = 'shop-introspection.json';

/**
 * The baseline `ErrorCode` width, and this feature's own addition to it.
 *
 * Stated as a transition rather than as a post-plugin total (ruling R15). The baseline is not restated as a
 * literal anywhere it can be avoided — the schema-delta assertions read it off the untouched snapshot — but
 * AC-8 needs the arithmetic in one place to say what the generated enum must contain.
 */
const BASELINE_ERROR_CODE_COUNT = 32;

/**
 * The seeded customers, READ through the Admin API rather than assumed.
 *
 * The generated email addresses are mock data and must never be hard-coded; only the password is the fixed
 * value `populate-customers.ts` sets.
 */
const GET_SEEDED_CUSTOMERS = gql`
    query GetSeededCustomersForReorderRead {
        customers(options: { sort: { id: ASC } }) {
            totalItems
            items {
                id
                emailAddress
            }
        }
    }
`;

const GET_CHANNELS_FOR_REORDER_READ = gql`
    query GetChannelsForReorderRead {
        channels {
            totalItems
            items {
                id
                code
                token
                defaultLanguageCode
                defaultCurrencyCode
                availableCurrencyCodes
                pricesIncludeTax
                defaultTaxZone {
                    id
                }
                defaultShippingZone {
                    id
                }
            }
        }
    }
`;

const CREATE_CHANNEL_FOR_REORDER_READ = gql`
    mutation CreateChannelForReorderRead($input: CreateChannelInput!) {
        createChannel(input: $input) {
            __typename
            ... on Channel {
                id
                code
                token
            }
            ... on LanguageNotAvailableError {
                errorCode
                message
            }
        }
    }
`;

/**
 * The seeded catalogue variants, in identifier order. The minimal product source ships exactly four.
 *
 * `product { id }` is selected because a bare variant this suite creates for itself needs a REAL owning
 * product identifier — `ProductVariant.productId` is a foreign key to `product`, and a variant identifier is
 * not a product identifier even where the two numbering sequences happen to overlap.
 */
const GET_VARIANTS_FOR_REORDER_READ = gql`
    query GetVariantsForReorderRead {
        productVariants(options: { sort: { id: ASC } }) {
            totalItems
            items {
                id
                name
                sku
                enabled
                price
                product {
                    id
                }
            }
        }
    }
`;

/**
 * Updates variants: the `enabled` flag scenario 2 flips, the price scenario 3 changes, and the second-language
 * name scenario 5 needs.
 *
 * One document for all three, because `UpdateProductVariantInput` carries all three fields and a suite that
 * declared three near-identical mutations would invite them to drift.
 */
const UPDATE_VARIANTS_FOR_REORDER_READ = gql`
    mutation UpdateVariantsForReorderRead($input: [UpdateProductVariantInput!]!) {
        updateProductVariants(input: $input) {
            id
            enabled
            price
        }
    }
`;

/**
 * The two halves of the `viewerAccess` cost pair: the SAME collection read, selected once without the field
 * and once with it.
 */
const GET_LISTS_WITHOUT_VIEWER_ACCESS = gql`
    query GetListsWithoutViewerAccessForReorderRead {
        activeCustomerReorderLists {
            totalItems
            items {
                id
                name
                lineCount
            }
        }
    }
`;

const GET_LISTS_WITH_VIEWER_ACCESS = gql`
    query GetListsWithViewerAccessForReorderRead {
        activeCustomerReorderLists {
            totalItems
            items {
                id
                name
                lineCount
                viewerAccess {
                    access
                    grantedCapabilities
                }
            }
        }
    }
`;

/**
 * The shipped Shop read AC-7 asserts is unchanged.
 *
 * The selection is deliberately wide enough to show that the type neither gained nor lost a field a client
 * would notice, INCLUDING `customFields` — this feature registers zero custom fields on any core entity
 * (ruling R1), so that value must be exactly what it was before the plugin loaded.
 */
const GET_ACTIVE_CUSTOMER_FOR_REORDER_READ = gql`
    query GetActiveCustomerForReorderRead {
        activeCustomer {
            id
            createdAt
            updatedAt
            title
            firstName
            lastName
            phoneNumber
            emailAddress
            customFields
        }
    }
`;

/**
 * The introspection of the booted Shop API, shaped so that ONE code path can read both it and the untouched `schema-
 * shop.json` snapshot.
 */
const SHOP_SCHEMA_SHAPE = gql`
    query ReorderReadShopSchemaShape {
        __schema {
            queryType {
                name
            }
            mutationType {
                name
            }
            types {
                name
                kind
                fields(includeDeprecated: true) {
                    name
                    args {
                        name
                        defaultValue
                        type {
                            ...ReorderReadTypeRef
                        }
                    }
                    type {
                        ...ReorderReadTypeRef
                    }
                }
                inputFields {
                    name
                    defaultValue
                    type {
                        ...ReorderReadTypeRef
                    }
                }
                enumValues(includeDeprecated: true) {
                    name
                }
                interfaces {
                    name
                }
            }
        }
    }

    fragment ReorderReadTypeRef on __Type {
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
                    ofType {
                        kind
                        name
                    }
                }
            }
        }
    }
`;

interface SeededCustomer {
    id: ReorderApiId;
    emailAddress: string;
}

interface GetSeededCustomersQuery {
    customers: { totalItems: number; items: SeededCustomer[] };
}

interface AdminChannel {
    id: ReorderApiId;
    code: string;
    token: string;
    defaultLanguageCode: string;
    defaultCurrencyCode: string;
    availableCurrencyCodes: string[];
    pricesIncludeTax: boolean;
    defaultTaxZone: { id: ReorderApiId } | null;
    defaultShippingZone: { id: ReorderApiId } | null;
}

interface GetChannelsQuery {
    channels: { totalItems: number; items: AdminChannel[] };
}

interface CreateChannelMutation {
    createChannel: { __typename: string; id?: ReorderApiId; code?: string; token?: string };
}

interface AdminProductVariant {
    id: ReorderApiId;
    name: string;
    sku: string;
    enabled: boolean;
    price: number;
    product: { id: ReorderApiId };
}

interface GetVariantsQuery {
    productVariants: { totalItems: number; items: AdminProductVariant[] };
}

/**
 * The response shape both halves of the `viewerAccess` cost pair are read through.
 *
 * `viewerAccess` is optional because one half of the pair does not select it — and the assertion that it is
 * ABSENT from that half is part of the evidence that the two documents genuinely differ in the one field the
 * comparison attributes its delta to.
 */
interface ViewerAccessPairQuery {
    activeCustomerReorderLists: {
        totalItems: number;
        items: Array<{
            id: ReorderApiId;
            name: string;
            lineCount: number;
            viewerAccess?: { access: string; grantedCapabilities: string[] };
        }>;
    };
}

interface UpdateVariantsMutation {
    updateProductVariants: Array<{ id: ReorderApiId; enabled: boolean; price: number }>;
}

interface ActiveCustomerShape {
    id: ReorderApiId;
    createdAt: string;
    updatedAt: string;
    title: string | null;
    firstName: string;
    lastName: string;
    phoneNumber: string | null;
    emailAddress: string;
    customFields: Record<string, unknown> | null;
}

interface GetActiveCustomerQuery {
    activeCustomer: ActiveCustomerShape | null;
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
    args?: IntrospectedArg[] | null;
    type: IntrospectedTypeRef;
}

interface IntrospectedInputField {
    name: string;
    defaultValue: string | null;
    type: IntrospectedTypeRef;
}

interface IntrospectedType {
    name: string | null;
    kind: string;
    fields?: IntrospectedField[] | null;
    inputFields?: IntrospectedInputField[] | null;
    enumValues?: Array<{ name: string }> | null;
    interfaces?: Array<{ name: string | null }> | null;
}

interface IntrospectedSchema {
    queryType: { name: string };
    mutationType: { name: string } | null;
    types: IntrospectedType[];
}

interface ShopSchemaShapeQuery {
    __schema: IntrospectedSchema;
}

interface TopLevelErrorEntry {
    message: string;
    path?: readonly string[];
    extensions?: { code?: string };
}

/**
 * A whole GraphQL response envelope, as this suite reads it off the wire.
 *
 * AC-4 compares WHOLE ENVELOPES rather than the value of one field, which is why this type carries `errors`
 * and `extensions` as OPTIONAL members: a response that carries neither key must compare unequal to one that
 * carries either, and a type that declared them present-and-empty would erase exactly that difference.
 */
interface GraphQlEnvelope {
    data?: Record<string, unknown> | null;
    errors?: TopLevelErrorEntry[];
    extensions?: Record<string, unknown>;
}

interface SeededList {
    id: string;
    name: string;
    lineIds: string[];
}

// Introspection helpers
//
// Every one of them is a pure function over an {@link IntrospectedSchema}, so the SAME code reads the live
// schema and the checked-in snapshot. That is the whole reason they exist: a comparison written twice is two
// readings that can disagree about what "the same signature" means.

/**
 * Renders a type reference to its SDL spelling — `String!`, `[ReorderList!]!`, `ID`.
 */
function renderTypeRef(ref: IntrospectedTypeRef | null | undefined): string {
    if (!ref) {
        return '<absent>';
    }
    if (ref.kind === 'NON_NULL') {
        return `${renderTypeRef(ref.ofType)}!`;
    }
    if (ref.kind === 'LIST') {
        return `[${renderTypeRef(ref.ofType)}]`;
    }
    return ref.name ?? '<anonymous>';
}

/**
 * Renders one field to its full declared signature: name, ordered argument list with each argument's type and
 * default, and the return type.
 *
 * Arguments are rendered in DECLARATION order rather than sorted, because argument order is part of a
 * published signature for any consumer reading a generated SDL dump.
 */
function renderFieldSignature(field: IntrospectedField): string {
    const args = (field.args ?? [])
        .map(arg => {
            const suffix = arg.defaultValue == null ? '' : ` = ${arg.defaultValue}`;
            return `${arg.name}: ${renderTypeRef(arg.type)}${suffix}`;
        })
        .join(', ');
    return `${field.name}(${args}): ${renderTypeRef(field.type)}`;
}

function findType(schema: IntrospectedSchema, name: string): IntrospectedType | undefined {
    return schema.types.find(type => type.name === name);
}

/**
 * The named type, or a failed assertion naming it.
 *
 * A missing type would otherwise surface as a `TypeError` on a property of `undefined`, which names the
 * property rather than the type — and the type is what a reader needs.
 */
function requireType(schema: IntrospectedSchema, name: string): IntrospectedType {
    const type = findType(schema, name);
    expect(type, `The Shop schema declares no type named "${name}"`).toBeDefined();
    return type as IntrospectedType;
}

/** Every field of a named object type, keyed on field name, for a signature-by-signature comparison. */
function fieldSignaturesOf(schema: IntrospectedSchema, typeName: string): Map<string, string> {
    const signatures = new Map<string, string>();
    for (const field of requireType(schema, typeName).fields ?? []) {
        signatures.set(field.name, renderFieldSignature(field));
    }
    return signatures;
}

function findField(
    schema: IntrospectedSchema,
    typeName: string,
    fieldName: string,
): IntrospectedField | undefined {
    return (findType(schema, typeName)?.fields ?? []).find(field => field.name === fieldName);
}

/** The field names of a named object type, sorted so a membership comparison is order-independent. */
function sortedFieldNames(schema: IntrospectedSchema, typeName: string): string[] {
    return (requireType(schema, typeName).fields ?? []).map(field => field.name).sort();
}

function sortedInputFieldNames(schema: IntrospectedSchema, typeName: string): string[] {
    return (requireType(schema, typeName).inputFields ?? []).map(field => field.name).sort();
}

/** The member names of a named enum, sorted so membership is compared without depending on order. */
function sortedEnumValues(schema: IntrospectedSchema, typeName: string): string[] {
    return (requireType(schema, typeName).enumValues ?? []).map(value => value.name).sort();
}

/** Every type declaring the `ErrorResult` interface, sorted. The `ErrorCode` enum is generated from these. */
function sortedErrorResultImplementors(schema: IntrospectedSchema): string[] {
    return schema.types
        .filter(type => (type.interfaces ?? []).some(iface => iface.name === 'ErrorResult'))
        .map(type => type.name ?? '<anonymous>')
        .sort();
}

const capture = new QueryCaptureLogger();

// THE SQL.JS SNAPSHOT DIRECTORY, CREATED IDEMPOTENTLY AND AT MODULE SCOPE, FOR TWO SEPARATE REASONS. The first
// is a race. The platform's own initializer creates it with a bare, non-recursive `mkdirSync` guarded by a
// preceding `existsSync` (`packages/testing/src/initializers/sqljs-initializer.ts` L31-L35), which is a
// check-then-act race: this package's e2e suites start together, so when the directory is absent — as it is on
// a fresh checkout, and after the operational reset a schema change requires — two of them can both observe it
// missing and the loser fails its `beforeAll` with `EEXIST`.
fs.mkdirSync(path.join(__dirname, '__data__'), { recursive: true });

const serverConfig = mergeConfig(testConfig(), {
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

const { server, adminClient, shopClient } = createTestEnvironment(serverConfig);

/**
 * The Shop API URL, derived from the configuration the server was built from rather than restated.
 *
 * It exists so that AC-4 and AC-5 can read WHOLE RESPONSE ENVELOPES: the shipped client returns `data` alone
 * on success and throws on a response carrying `errors`, so neither "these six responses are identical in
 * every observable respect" nor "no error entry of any kind" is expressible through it.
 */
const shopApiUrl = `http://localhost:${serverConfig.apiOptions.port}/${
    serverConfig.apiOptions.shopApiPath ?? 'shop-api'
}`;

describe('STORY-001-01-04 reorder list reads (Shop API)', () => {
    /** The raw data source, for every stored-row read, direct write and metadata lookup. */
    let dataSource: DataSource;

    /** The alias TypeORM gives `reorder_list` in a repository read, taken from metadata rather than guessed. */
    let listAlias: string;

    /** The plugin's own service instance, for the SERVICE-CALL boundary's spies. */
    let reorderListService: ReorderListService;

    let seededCustomers: SeededCustomer[];

    let actingCustomer: SeededCustomer;

    /** The second customer, whose rows this caller must never be able to produce. */
    let otherCustomer: SeededCustomer;

    /** The acting customer's decoded database identifier, for every raw comparison and capture predicate. */
    let actingCustomerDbId: number;

    let otherCustomerDbId: number;

    let defaultChannelDbId: number;
    /**
     * The stored identifier of the second channel THIS SUITE created.
     */
    let secondChannelDbId: number;

    let catalogueVariants: AdminProductVariant[];

    let liveSchema: IntrospectedSchema;

    /** The untouched checked-in baseline. Read from disk, never edited and never regenerated. */
    let snapshotSchema: IntrospectedSchema;

    /**
     * A second real Shop client with its own session, for the cross-customer and stale-read cases.
     *
     * Two callers rather than one client whose state is mutated between calls: the staleness scenario needs
     * one session to hold a payload while ANOTHER session writes, which a single mutated client cannot
     * represent.
     */
    let secondShopClient: SimpleGraphQLClient;

    /**
     * Undo actions for core rows a test mutated but did not create, drained LIFO in `afterEach`.
     *
     * EPIC-001 section 11.6.1 requires such a row to be restored in the same hook, the catalogue being shared
     * by every test in the file. A queue rather than an ad-hoc `finally`, so a test that fails part-way
     * through still leaves the catalogue as it found it.
     */
    let restoreActions: Array<() => Promise<void>>;

    /** Temporary directories the empty-generation assertion writes into, removed in `afterEach`. */
    let temporaryDirectories: string[];

    /**
     * Decodes an API identifier to the value the database actually stores.
     *
     * The shared test configuration installs an id strategy that prefixes every identifier with `T_` on the
     * wire while the column holds an integer. Every raw comparison and every capture predicate below has to
     * compare the DECODED value; comparing `'T_5'` against `5` would silently fail an assertion that is true.
     */
    function decodeId(apiId: ReorderApiId): number {
        const decoded = Number.parseInt(String(apiId).replace(/^T_/, ''), 10);
        expect(Number.isInteger(decoded), `"${String(apiId)}" is not a decodable identifier`).toBe(true);
        return decoded;
    }

    async function authenticateAs(customer: SeededCustomer): Promise<void> {
        shopClient.setChannelToken(E2E_DEFAULT_CHANNEL_TOKEN);
        await shopClient.asUserWithCredentials(customer.emailAddress, SEEDED_CUSTOMER_PASSWORD);
        shopClient.setChannelToken(E2E_DEFAULT_CHANNEL_TOKEN);
    }

    /**
     * Issues one Shop request and returns its WHOLE response envelope.
     */
    async function rawShopRequest(
        document: DocumentNode,
        variables?: Record<string, unknown>,
    ): Promise<GraphQlEnvelope> {
        const response = await shopClient.fetch(shopApiUrl, {
            method: 'POST',
            body: JSON.stringify({ query: print(document), variables }),
        });
        return (await response.json()) as GraphQlEnvelope;
    }

    /**
     * Seeds one list, optionally with lines, through the PUBLISHED mutations, and returns its identifiers.
     */
    async function seedList(
        name: string,
        lines: Array<{ productVariantId: ReorderApiId; quantity: number }> = [],
    ): Promise<SeededList> {
        const { createReorderList } = await shopClient.query<
            CreateReorderListMutation,
            CreateReorderListMutationVariables
        >(CREATE_REORDER_LIST, { input: { name } });
        expect(createReorderList.__typename, JSON.stringify(createReorderList)).toBe('ReorderList');
        if (createReorderList.__typename !== 'ReorderList') {
            throw new Error(`Fixture could not create the list "${name}"`);
        }
        const id = String(createReorderList.id);
        const lineIds: string[] = [];
        for (const line of lines) {
            const { addItemToReorderList } = await shopClient.query<
                AddItemToReorderListMutation,
                AddItemToReorderListMutationVariables
            >(ADD_ITEM_TO_REORDER_LIST, {
                input: {
                    reorderListId: id,
                    productVariantId: line.productVariantId,
                    quantity: line.quantity,
                },
            });
            expect(addItemToReorderList.__typename, JSON.stringify(addItemToReorderList)).toBe('ReorderList');
            if (addItemToReorderList.__typename !== 'ReorderList') {
                throw new Error(`Fixture could not add ${String(line.productVariantId)} to "${name}"`);
            }
            const seeded = addItemToReorderList.lines.items.find(
                entry => String(entry.productVariantId) === String(line.productVariantId),
            );
            expect(
                seeded,
                `The add response carried no line for ${String(line.productVariantId)}`,
            ).toBeDefined();
            lineIds.push(String(seeded?.id));
        }
        return { id, name, lineIds };
    }

    async function seedLists(prefix: string, count: number, linesPerList = 0): Promise<SeededList[]> {
        const created: SeededList[] = [];
        for (let index = 0; index < count; index++) {
            const lines = catalogueVariants
                .slice(0, linesPerList)
                .map((variant, position) => ({ productVariantId: variant.id, quantity: position + 2 }));
            created.push(await seedList(`${prefix} ${index + 1}`, lines));
        }
        return created;
    }

    /**
     * Writes ONE identical `createdAt` onto the named lists, directly through the repository.
     */
    async function setEqualCreatedAt(listIds: string[], when: Date): Promise<void> {
        await dataSource
            .createQueryBuilder()
            .update(ReorderList)
            .set({ createdAt: when })
            .whereInIds(listIds.map(decodeId))
            .execute();
    }

    async function readStoredList(listId: ReorderApiId): Promise<ReorderList | null> {
        return dataSource
            .getRepository(ReorderList)
            .createQueryBuilder('list')
            .where('list.id = :id', { id: decodeId(listId) })
            .getOne();
    }

    /** Counts the stored lines of one list, which is the number a `lineCount` claim is measured against. */
    async function countStoredLines(listId: ReorderApiId): Promise<number> {
        return dataSource
            .getRepository(ReorderListLine)
            .createQueryBuilder('line')
            .where('line.reorderListId = :listId', { listId: decodeId(listId) })
            .getCount();
    }

    /** Overwrites one list's stored counter directly, so a read can be observed against a KNOWN stale value. */
    async function setStoredLineCount(listId: ReorderApiId, lineCount: number): Promise<void> {
        await dataSource
            .createQueryBuilder()
            .update(ReorderList)
            .set({ lineCount })
            .where('id = :id', { id: decodeId(listId) })
            .execute();
    }

    /** Empties both plugin tables, CHILD BEFORE PARENT so a foreign key is never what fails the cleanup. */
    async function deleteAllPluginRows(): Promise<void> {
        for (const table of PLUGIN_TABLES_CHILD_FIRST) {
            await dataSource.createQueryBuilder().delete().from(table).where('1 = 1').execute();
        }
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
     */
    async function captureVariantAvailability(externalVariantId: ReorderApiId): Promise<void> {
        const variantId = decodeId(externalVariantId);
        const captured = await captureCoreRows('product_variant', 'captured_row.id = :variantId', {
            variantId,
        });
        expect(captured.rows.length, `No product_variant row with id ${String(variantId)} to capture`).toBe(
            1,
        );
    }

    /** The table a variant's per-language name lives in, addressed directly because no entity is imported. */
    const VARIANT_TRANSLATION_TABLE = 'product_variant_translation';

    /**
     * Captures the exact `(baseId, languageCode)` translation row — or the fact that there is none — and queues its
     * exact restoration before the caller writes.
     */
    async function captureVariantTranslation(
        externalVariantId: ReorderApiId,
        languageCode: LanguageCode,
    ): Promise<{ readonly row: Record<string, unknown> | undefined }> {
        const variantId = Number(decodeId(externalVariantId));
        const captured = await captureCoreRows(
            VARIANT_TRANSLATION_TABLE,
            'captured_row.baseId = :variantId AND captured_row.languageCode = :languageCode',
            { variantId, languageCode },
        );
        expect(
            captured.rows.length,
            `${VARIANT_TRANSLATION_TABLE} holds ${captured.rows.length} rows for variant ` +
                `${String(variantId)} in ${languageCode}, and a capture of more than one could not be ` +
                'restored unambiguously',
        ).toBeLessThanOrEqual(1);
        return { row: captured.rows.length === 1 ? { ...captured.rows[0] } : undefined };
    }

    // Exact restoration of the core rows a test changes. A core row this suite touches is put back COLUMN FOR
    // COLUMN, and the restoration is then ASSERTED against what was captured. Two mechanisms make that stricter
    // than it first sounds: the compensating write goes through the RAW TABLE rather than the entity manager,
    // so restoring a captured value cannot itself move an entity-managed audit column, and it covers an
    // inserted row and a deleted row alike by deleting or re-inserting as the capture requires.

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
        restoreActions.push(async () => {
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

    /**
     * Creates one bare catalogue variant directly through the repository, and returns its stored identifier.
     */
    async function createBareVariant(index: number): Promise<number> {
        const owningProductId = decodeId(catalogueVariants[0].product.id);
        expect(
            Number.isInteger(owningProductId),
            'The catalogue read produced no owning product identifier for the bare variant to reference',
        ).toBe(true);

        const saved = await dataSource.getRepository(ProductVariant).save(
            new ProductVariant({
                enabled: true,
                sku: `${BARE_VARIANT_SKU_PREFIX}${index}`,
                productId: owningProductId,
                outOfStockThreshold: 0,
                useGlobalOutOfStockThreshold: true,
            }),
        );
        const storedId = Number(saved.id);
        expect(Number.isInteger(storedId), 'The bare variant was saved without a usable identifier').toBe(
            true,
        );
        expect(Number(saved.productId)).toBe(owningProductId);
        return storedId;
    }

    /** Hard-deletes one variant row, so the cascade removes the line rows pointing at it. */
    async function hardDeleteVariant(variantDbId: number): Promise<void> {
        await dataSource.getRepository(ProductVariant).delete({ id: variantDbId });
    }

    /** Removes every bare variant this suite created, cascading whatever line rows still point at them. */
    async function deleteBareVariants(): Promise<void> {
        await dataSource
            .createQueryBuilder()
            .delete()
            .from(ProductVariant)
            .where('sku LIKE :prefix', { prefix: `${BARE_VARIANT_SKU_PREFIX}%` })
            .execute();
    }

    /**
     * Inserts one `reorder_list_line` row directly, bypassing the service and therefore the counter.
     *
     * Used only where a fixture needs more lines on one list than there are resolvable variants, and by the
     * repair case, which needs a line the service never saw. The caller sets the stored counter itself, so
     * the fixture's starting state is stated rather than inferred.
     */
    async function insertLineDirectly(
        listId: ReorderApiId,
        variantDbId: number,
        quantity: number,
    ): Promise<void> {
        await dataSource
            .createQueryBuilder()
            .insert()
            .into(ReorderListLine)
            .values({
                reorderListId: decodeId(listId),
                productVariantId: variantDbId,
                quantity,
            })
            .execute();
    }

    /**
     * The failure message every COUNTED assertion carries: the gating reason, then the whole captured window.
     */
    function countedDiagnostic(): string {
        return `Counted assertions are scoped to one engine: ${STATEMENT_COUNT_ENGINE_REASON}\n${capture.format()}`;
    }

    /**
     * EVERY statement the captured window issued against the database, excluding transaction control.
     *
     * Transaction control is excluded because a `BEGIN` or a `COMMIT` names no table and its count is the
     * driver's business rather than the resolver's; including it would make the number depend on the engine.
     */
    function allDatabaseStatements(): CapturedStatement[] {
        return capture.statements.filter(entry => entry.kind !== 'transaction');
    }

    /**
     * A rendering of the current window for a WHOLE-REQUEST diagnostic: how many statements, and each one's
     * kind and tables. It names what grew, which a bare pair of numbers cannot.
     */
    function wholeRequestDiagnostic(label: string): string {
        const statements = allDatabaseStatements();
        const rendered = statements
            .map((entry, index) => `  #${index} ${entry.kind} [${entry.tables.join(', ')}]`)
            .join('\n');
        return `${label}: ${statements.length} non-transaction statement(s)\n${rendered}`;
    }

    async function introspectLiveSchema(): Promise<IntrospectedSchema> {
        const introspected = await shopClient.query<ShopSchemaShapeQuery>(SHOP_SCHEMA_SHAPE);
        return introspected.__schema;
    }

    /**
     * Generates plugin-aware Shop types from the LIVE schema of the server this file booted, and returns the
     * `ErrorCode` members the generator derived.
     */
    async function generatePluginAwareShopTypes(): Promise<{ members: string[]; modulePath: string }> {
        const directory = path.join(__dirname, GENERATED_TYPES_DIRECTORY);
        fs.mkdirpSync(directory);
        const introspectionPath = path.join(directory, GENERATED_INTROSPECTION_FILE);
        const modulePath = path.join(directory, GENERATED_SHOP_TYPES_FILE);

        const response = await shopClient.fetch(shopApiUrl, {
            method: 'POST',
            body: JSON.stringify({ query: getIntrospectionQuery({ inputValueDeprecation: true }) }),
        });
        const introspection = (await response.json()) as {
            data?: { __schema?: unknown };
            errors?: unknown[];
        };
        expect(
            introspection.errors,
            `The live introspection carried errors: ${JSON.stringify(introspection.errors)}`,
        ).toBeUndefined();
        expect(introspection.data?.__schema, 'The live introspection returned no __schema').toBeDefined();
        fs.writeFileSync(introspectionPath, JSON.stringify(introspection), 'utf-8');

        await generate(
            {
                overwrite: true,
                silent: true,
                generates: {
                    [modulePath]: {
                        schema: [introspectionPath],
                        plugins: [{ add: { content: '/* eslint-disable */' } }, 'typescript'],
                        config: {
                            namingConvention: { enumValues: 'keep' },
                            strict: true,
                            scalars: { Money: 'number', ID: 'string | number' },
                            maybeValue: 'T',
                        },
                    },
                },
            },
            true,
        );

        const generated = fs.readFileSync(modulePath, 'utf-8');
        const enumBody = /export enum ErrorCode \{([\s\S]*?)\n\}/.exec(generated);
        expect(enumBody, 'The generated module declares no ErrorCode enum').not.toBeNull();
        const members = (enumBody as RegExpExecArray)[1]
            .split('\n')
            .map(line => /^\s*([A-Za-z0-9_]+)\s*=/.exec(line))
            .filter((match): match is RegExpExecArray => match !== null)
            .map(match => match[1]);
        return { members, modulePath };
    }

    /** Removes the generated module and its introspection input. Both are build products of this run. */
    function removeGeneratedShopTypes(): void {
        fs.removeSync(path.join(__dirname, GENERATED_TYPES_DIRECTORY));
    }

    /**
     * Lifts the generated artefacts into memory and removes the directory, so that a test can put the driver
     * in front of a genuinely absent module — the state of a fresh clone — and then hand the live artefacts
     * back untouched to the criteria that were written against them.
     */
    function detachGeneratedShopTypes(): Array<{ name: string; contents: string }> {
        const directory = path.join(__dirname, GENERATED_TYPES_DIRECTORY);
        const detached = fs.readdirSync(directory).map(name => ({
            name,
            contents: fs.readFileSync(path.join(directory, name), 'utf-8'),
        }));
        expect(
            detached.map(entry => entry.name).sort(),
            'The generated directory did not hold the module and its introspection input',
        ).toEqual([GENERATED_INTROSPECTION_FILE, GENERATED_SHOP_TYPES_FILE].sort());
        fs.removeSync(directory);
        expect(
            fs.existsSync(directory),
            `the ${GENERATED_TYPES_DIRECTORY} directory survived being detached`,
        ).toBe(false);
        return detached;
    }

    /** Writes the detached artefacts back exactly as they were, and nothing else. */
    function reattachGeneratedShopTypes(detached: Array<{ name: string; contents: string }>): void {
        const directory = path.join(__dirname, GENERATED_TYPES_DIRECTORY);
        fs.removeSync(directory);
        fs.mkdirpSync(directory);
        for (const entry of detached) {
            fs.writeFileSync(path.join(directory, entry.name), entry.contents, 'utf-8');
        }
    }

    /**
     * The command one of this package's scripts declares, split into its tokens.
     *
     * Read out of the manifest rather than written here, so that the script IS the contract: a missing or
     * renamed script fails, and a changed command changes what runs.
     */
    function declaredScriptTokens(scriptName: string): string[] {
        const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8')) as {
            scripts?: Record<string, string>;
        };
        const declared = manifest.scripts?.[scriptName];
        expect(
            declared,
            `packages/reorder-plugin/package.json declares no "${scriptName}" script, so the compiler run ` +
                'this criterion requires has no invocation surface',
        ).toBeDefined();
        return String(declared).trim().split(/\s+/);
    }

    /**
     * Compiler output with every host path folded to a stable marker, so a diagnostic can be read in a build log
     * without describing the machine that produced it.
     */
    function withoutHostPaths(output: string): string {
        const packageDir = path.join(__dirname, '..');
        const repositoryRoot = path.join(packageDir, '..', '..');
        const replacements: Array<readonly [string, string]> = [
            [packageDir, '<package>'],
            [repositoryRoot, '<repository>'],
            [os.tmpdir(), '<tmp>'],
        ];
        return replacements.reduce(
            (text, [from, to]) => (from.length > 0 ? text.split(from).join(to) : text),
            output,
        );
    }

    function runDeclaredCompilerScript(scriptName: string): { status: number | null; output: string } {
        const tokens = declaredScriptTokens(scriptName);
        expect(tokens[0], `"${scriptName}" must invoke the pinned compiler through node`).toBe('node');
        const packageDir = path.join(__dirname, '..');
        try {
            const stdout = execFileSync(process.execPath, tokens.slice(1), {
                cwd: packageDir,
                encoding: 'utf-8',
                timeout: COMPILER_INVOCATION_TIMEOUT_MS,
            });
            return { status: 0, output: withoutHostPaths(stdout) };
        } catch (err: unknown) {
            const failure = err as {
                status?: number | null;
                stdout?: string | Buffer;
                stderr?: string | Buffer;
            };
            return {
                status: failure.status ?? null,
                output: withoutHostPaths(`${String(failure.stdout ?? '')}${String(failure.stderr ?? '')}`),
            };
        }
    }

    beforeAll(async () => {
        await server.init({
            initialData,
            productsCsvPath: path.join(__dirname, '../../core/e2e/fixtures/e2e-products-minimal.csv'),
            customerCount: SEEDED_CUSTOMER_COUNT,
        });

        dataSource = server.app.get(TransactionalConnection).rawConnection;
        reorderListService = server.app.get(ReorderListService);
        // Read from metadata rather than written out: a repository read's default alias is the entity
        // metadata's own name, and the capture predicates below must name the alias the statement actually
        // uses. Hard-coding it would make a rename of the entity class look like a scoping failure.
        listAlias = dataSource.getMetadata(ReorderList).name;

        await adminClient.asSuperAdmin();

        const { customers } = await adminClient.query<GetSeededCustomersQuery>(GET_SEEDED_CUSTOMERS);
        expect(
            customers.items.length,
            `The seed produced ${customers.items.length} customers; this suite needs ${SEEDED_CUSTOMER_COUNT}`,
        ).toBeGreaterThanOrEqual(SEEDED_CUSTOMER_COUNT);
        seededCustomers = customers.items;
        actingCustomer = seededCustomers[0];
        otherCustomer = seededCustomers[1];
        actingCustomerDbId = decodeId(actingCustomer.id);
        otherCustomerDbId = decodeId(otherCustomer.id);

        const { channels } = await adminClient.query<GetChannelsQuery>(GET_CHANNELS_FOR_REORDER_READ);
        const defaultChannel = channels.items.find(channel => channel.token === E2E_DEFAULT_CHANNEL_TOKEN);
        expect(
            defaultChannel,
            'The seeded default channel was not found by its configured token',
        ).toBeDefined();
        const resolvedDefaultChannel = defaultChannel as AdminChannel;
        defaultChannelDbId = decodeId(resolvedDefaultChannel.id);

        const taxZone = resolvedDefaultChannel.defaultTaxZone;
        const shippingZone = resolvedDefaultChannel.defaultShippingZone;
        expect(taxZone, 'The default channel declares no default tax zone').toBeDefined();
        expect(shippingZone, 'The default channel declares no default shipping zone').toBeDefined();
        const { createChannel } = await adminClient.query<CreateChannelMutation>(
            CREATE_CHANNEL_FOR_REORDER_READ,
            {
                input: {
                    code: SECOND_CHANNEL_CODE,
                    token: SECOND_CHANNEL_TOKEN,
                    defaultLanguageCode: resolvedDefaultChannel.defaultLanguageCode,
                    defaultCurrencyCode: resolvedDefaultChannel.defaultCurrencyCode,
                    availableCurrencyCodes: resolvedDefaultChannel.availableCurrencyCodes,
                    pricesIncludeTax: resolvedDefaultChannel.pricesIncludeTax,
                    defaultTaxZoneId: (taxZone as { id: ReorderApiId }).id,
                    defaultShippingZoneId: (shippingZone as { id: ReorderApiId }).id,
                },
            },
        );
        expect(createChannel.__typename, JSON.stringify(createChannel)).toBe('Channel');
        expect(createChannel.token, JSON.stringify(createChannel)).toBe(SECOND_CHANNEL_TOKEN);
        expect(createChannel.id, JSON.stringify(createChannel)).toBeDefined();
        secondChannelDbId = decodeId(createChannel.id as ReorderApiId);
        expect(secondChannelDbId).not.toBe(defaultChannelDbId);

        const { productVariants } = await adminClient.query<GetVariantsQuery>(GET_VARIANTS_FOR_REORDER_READ);
        expect(
            productVariants.items.length,
            'The seeded catalogue produced fewer than the four variants this suite draws its lines from',
        ).toBeGreaterThanOrEqual(4);
        catalogueVariants = productVariants.items;

        secondShopClient = new SimpleGraphQLClient(serverConfig, shopApiUrl);

        // Introspected ONCE, from the booted server carrying the plugin. Comparing a runtime schema against the
        // untouched snapshot is the only correct way to evidence the delta: the introspection that produces
        // `schema-shop.json` declares its own configuration and never reads a plugin's, so the snapshot cannot
        // move and must be neither edited nor regenerated (AAP §0.4.1.5).
        liveSchema = await introspectLiveSchema();

        const snapshotPath = path.join(__dirname, '../../../schema-shop.json');
        const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf-8')) as {
            data: ShopSchemaShapeQuery;
        };
        snapshotSchema = snapshot.data.__schema;
    }, TEST_SETUP_TIMEOUT_MS);

    afterAll(async () => {
        // Unconditionally, per EPIC-001 §11.6.1: a suite that destroys its server only on the success path
        // leaks a listening port into the next file.
        await server.destroy();
    });

    beforeEach(async () => {
        // Each test's own scope, established here and never inherited: the restore queue and the temporary
        // directory list start empty, the capture window starts closed and empty, both plugin tables start
        // empty, and the acting session is freshly authenticated on the default channel token.
        restoreActions = [];
        temporaryDirectories = [];
        capture.reset();
        capture.disable();
        await deleteAllPluginRows();
        await authenticateAs(actingCustomer);
    });

    afterEach(async () => {
        const queued = restoreActions.slice().reverse();
        restoreActions = [];
        const directories = temporaryDirectories.slice();
        temporaryDirectories = [];
        await runAllTeardownStages([
            ...queued.map((restore, index) => ({
                what: `restore action ${String(queued.length - index)}`,
                run: restore,
            })),
            { what: 'bare variants', run: deleteBareVariants },
            { what: 'plugin rows', run: deleteAllPluginRows },
            // An index, never the path. `stage.what` is reproduced VERBATIM by the teardown aggregator —
            // deliberately, because the stage name is this file's own text and is what identifies the step that
            // failed — so anything interpolated into it is published as-is. An absolute temporary directory
            // discloses the layout of whatever machine ran the suite, and nothing about the assertion needs it:
            // the path stays in the closure below, where the removal uses it and no log reads it.
            ...directories.map((directory, index) => ({
                what: `temporary directory ${String(index + 1)} of ${String(directories.length)}`,
                run: () => fs.remove(directory),
            })),
            {
                what: 'spies, capture and channel token',
                run: () => {
                    vi.restoreAllMocks();
                    capture.reset();
                    capture.disable();
                    shopClient.setChannelToken(E2E_DEFAULT_CHANNEL_TOKEN);
                    return Promise.resolve();
                },
            },
        ]);
    });

    /**
     * Seeds one list owned by the SECOND customer and leaves the acting session authenticated as before.
     *
     * Ownership is derived from the session and no argument can nominate a different owner, so the only way to
     * create a row this caller must not be able to see is to authenticate as its owner — and the only way for
     * the assertion that follows to be about the acting caller is to authenticate back.
     */
    async function seedListForOtherCustomer(name: string): Promise<SeededList> {
        await authenticateAs(otherCustomer);
        try {
            return await seedList(name);
        } finally {
            await authenticateAs(actingCustomer);
        }
    }

    describe('AC-1: activeCustomerReorderLists returns the caller\u2019s own lists, newest first', () => {
        it('returns both lists newest first, ordered by createdAt DESC then id DESC, and counts only its own', async () => {
            const first = await seedList(FIRST_LIST_NAME);
            const second = await seedList(SECOND_LIST_NAME);
            const foreign = await seedListForOtherCustomer('Another buyer\u2019s list');

            const { activeCustomerReorderLists } = await shopClient.query<GetActiveCustomerReorderListsQuery>(
                GET_ACTIVE_CUSTOMER_REORDER_LISTS,
            );

            // The call SUCCEEDS. The session holds only `Permission.Authenticated`; the gate marks the request
            // context and the service-layer ownership predicate is what actually scopes the answer.
            expect(activeCustomerReorderLists.totalItems).toBe(2);
            expect(activeCustomerReorderLists.items).toHaveLength(2);

            // The declared default sort is `createdAt` DESC and then `id` DESC, and the identifier half is
            // named here because it is what decides this very assertion: the two lists were created within one
            // clock second, and `createdAt` has one-second resolution on the SQLite family, so the timestamps
            // are equal and the appended `id DESC` tie-break is the whole of the ordering.
            expect(activeCustomerReorderLists.items[0].name).toBe(SECOND_LIST_NAME);
            expect(activeCustomerReorderLists.items[1].name).toBe(FIRST_LIST_NAME);
            expect(String(activeCustomerReorderLists.items[0].id)).toBe(second.id);
            expect(String(activeCustomerReorderLists.items[1].id)).toBe(first.id);
            expect(decodeId(activeCustomerReorderLists.items[0].id)).toBeGreaterThan(
                decodeId(activeCustomerReorderLists.items[1].id),
            );

            expect(activeCustomerReorderLists.items.map(entry => String(entry.id))).not.toContain(foreign.id);

            for (const entry of activeCustomerReorderLists.items) {
                expect(entry.viewerAccess.access).toBe('OWNED');
                expect(entry.viewerAccess.grantedCapabilities).toEqual([]);
                expect(entry.lineCount).toBe(0);
            }
        });

        it('returns each name exactly as stored and identically under a second languageCode', async () => {
            const hostileName = '<b>Tools</b> &amp; spares';
            const seeded = await seedList(hostileName);

            const inChannelDefault = await shopClient.query<GetActiveCustomerReorderListsQuery>(
                GET_ACTIVE_CUSTOMER_REORDER_LISTS,
            );
            const inSecondLanguage = await shopClient.query<GetActiveCustomerReorderListsQuery>(
                GET_ACTIVE_CUSTOMER_REORDER_LISTS,
                undefined,
                { languageCode: LanguageCode.de },
            );

            expect(inChannelDefault.activeCustomerReorderLists.items[0].name).toBe(hostileName);
            expect(inSecondLanguage.activeCustomerReorderLists.items[0].name).toBe(hostileName);
            expect((await readStoredList(seeded.id))?.name).toBe(hostileName);
            expect(inSecondLanguage.activeCustomerReorderLists.items[0].id).toEqual(
                inChannelDefault.activeCustomerReorderLists.items[0].id,
            );
            expect(inSecondLanguage.activeCustomerReorderLists.items[0].createdAt).toBe(
                inChannelDefault.activeCustomerReorderLists.items[0].createdAt,
            );
        });

        it('pages deterministically across a boundary when more rows than one page share a createdAt', async () => {
            // SIX rows carrying ONE timestamp, read in pages of FOUR — deliberately more equal-timestamp rows
            // than fit one page, because a tie-break can only be observed failing at a page boundary.
            const seeded = await seedLists('Equal timestamp', 6);
            const sharedTimestamp = new Date('2025-03-04T05:06:07.000Z');
            await setEqualCreatedAt(
                seeded.map(entry => entry.id),
                sharedTimestamp,
            );

            const pageOne = await shopClient.query<
                GetActiveCustomerReorderListsPaginatedQuery,
                GetActiveCustomerReorderListsPaginatedQueryVariables
            >(GET_ACTIVE_CUSTOMER_REORDER_LISTS_PAGINATED, {
                take: 4,
                skip: 0,
                createdAtSort: SortOrder.DESC,
                idSort: SortOrder.DESC,
            });
            const pageTwo = await shopClient.query<
                GetActiveCustomerReorderListsPaginatedQuery,
                GetActiveCustomerReorderListsPaginatedQueryVariables
            >(GET_ACTIVE_CUSTOMER_REORDER_LISTS_PAGINATED, {
                take: 4,
                skip: 4,
                createdAtSort: SortOrder.DESC,
                idSort: SortOrder.DESC,
            });

            expect(pageOne.activeCustomerReorderLists.totalItems).toBe(6);
            expect(pageTwo.activeCustomerReorderLists.totalItems).toBe(6);
            expect(pageOne.activeCustomerReorderLists.items).toHaveLength(4);
            expect(pageTwo.activeCustomerReorderLists.items).toHaveLength(2);

            const walked = [
                ...pageOne.activeCustomerReorderLists.items,
                ...pageTwo.activeCustomerReorderLists.items,
            ].map(entry => decodeId(entry.id));

            // Each row EXACTLY ONCE: no row repeated across the boundary and none missed, which is the failure
            // a partial order produces when equal-timestamp rows are re-ordered between two requests.
            expect(new Set(walked).size).toBe(6);
            expect(walked.slice().sort((a, b) => a - b)).toEqual(
                seeded.map(entry => decodeId(entry.id)).sort((a, b) => a - b),
            );
            // And strictly descending by identifier THROUGH the boundary, which is the tie-break doing the
            // ordering: every `createdAt` in this fixture is the same value.
            for (let index = 1; index < walked.length; index++) {
                expect(walked[index]).toBeLessThan(walked[index - 1]);
            }
            const storedTimestamps = await Promise.all(seeded.map(entry => readStoredList(entry.id)));
            for (const stored of storedTimestamps) {
                expect(stored?.createdAt.getTime()).toBe(sharedTimestamp.getTime());
            }
        });
    });

    describe('AC-2: activeCustomerReorderList returns one owned list with its nested lines page', () => {
        it('returns the list with lineCount 2 and both lines in ascending createdAt order with their quantities', async () => {
            const seeded = await seedList(FIRST_LIST_NAME, [
                { productVariantId: catalogueVariants[0].id, quantity: 2 },
                { productVariantId: catalogueVariants[1].id, quantity: 3 },
            ]);

            const { activeCustomerReorderList } = await shopClient.query<
                GetActiveCustomerReorderListQuery,
                GetActiveCustomerReorderListQueryVariables
            >(GET_ACTIVE_CUSTOMER_REORDER_LIST, { id: seeded.id });

            expect(activeCustomerReorderList).not.toBeNull();
            const list = activeCustomerReorderList as NonNullable<typeof activeCustomerReorderList>;
            expect(list.name).toBe(FIRST_LIST_NAME);
            expect(list.lineCount).toBe(2);
            expect(list.viewerAccess.access).toBe('OWNED');
            expect(list.viewerAccess.grantedCapabilities).toEqual([]);

            expect(list.lines.totalItems).toBe(2);
            expect(list.lines.items).toHaveLength(2);
            expect(list.lines.items.map(line => line.quantity)).toEqual([2, 3]);
            expect(decodeId(list.lines.items[1].id)).toBeGreaterThan(decodeId(list.lines.items[0].id));
            expect(list.lines.items.map(line => String(line.id))).toEqual(seeded.lineIds);

            expect(String(list.lines.items[0].productVariantId)).toBe(String(catalogueVariants[0].id));
            expect(String(list.lines.items[1].productVariantId)).toBe(String(catalogueVariants[1].id));
            expect(list.lines.items[0].productVariant?.name).toBe(catalogueVariants[0].name);
            expect(list.lines.items[1].productVariant?.name).toBe(catalogueVariants[1].name);
        });

        it('publishes no price, currency or stock field on any type this feature declares', () => {
            const pluginTypes = [
                'ReorderList',
                'ReorderListLine',
                'ReorderListViewerAccess',
                'ReorderListList',
                'ReorderListLineList',
                ...FEATURE_ERROR_RESULTS,
            ];
            for (const typeName of pluginTypes) {
                const names = sortedFieldNames(liveSchema, typeName);
                expect(names.length, `${typeName} published no field at all`).toBeGreaterThan(0);
                expect(
                    names.filter(name => MONETARY_OR_STOCK_FIELD.test(name)),
                    `${typeName} published a monetary, currency or stock field`,
                ).toEqual([]);
            }
            for (const inputName of [
                'CreateReorderListInput',
                'UpdateReorderListInput',
                'AddItemToReorderListInput',
                'AdjustReorderListLineInput',
                'RemoveReorderListLineInput',
            ]) {
                expect(
                    sortedInputFieldNames(liveSchema, inputName).filter(name =>
                        MONETARY_OR_STOCK_FIELD.test(name),
                    ),
                    `${inputName} declared a monetary, currency or stock field`,
                ).toEqual([]);
            }
            // And the two published object types carry exactly the members FEATURE-001-01 section 2.6 declares.
            expect(sortedFieldNames(liveSchema, 'ReorderList')).toEqual(
                ['id', 'createdAt', 'updatedAt', 'name', 'lineCount', 'lines', 'viewerAccess'].sort(),
            );
            expect(sortedFieldNames(liveSchema, 'ReorderListLine')).toEqual(
                ['id', 'createdAt', 'updatedAt', 'productVariant', 'productVariantId', 'quantity'].sort(),
            );
        });
    });

    describe('AC-3: the configured page bounds hold on both reads', () => {
        it('refuses a take one greater than the Shop limit with the platform\u2019s own input error, before any row is read', async () => {
            await seedLists('Over limit', 3);

            capture.reset();
            const envelope = await capture.capture(() =>
                rawShopRequest(GET_ACTIVE_CUSTOMER_REORDER_LISTS_PAGINATED, {
                    take: SHOP_LIST_QUERY_LIMIT + 1,
                }),
            );

            expect(envelope.errors, JSON.stringify(envelope)).toBeDefined();
            expect(envelope.errors).toHaveLength(1);
            expect(envelope.errors?.[0].extensions?.code).toBe('USER_INPUT_ERROR');
            expect(envelope.errors?.[0].message).toContain(String(SHOP_LIST_QUERY_LIMIT));
            expect(envelope.errors?.[0].path).toEqual(['activeCustomerReorderLists']);

            expect(envelope.data).toBeNull();

            if (isStatementCountEngine()) {
                // ZERO is REACHABLE here and is therefore asserted as a number, which is what "before any row
                // is read" means: the refusal happens while the query is being built, so no statement against
                // `reorder_list` is ever issued. This is not the inaccessible-single-read case, where a claim
                // of zero statements would be unpassable for a correct implementation — the filter is named at
                // the assertion site so the two cannot be confused. The gating reason is reported with every
                // counted failure through {@link countedDiagnostic}.
                expect(capture.count(LIST_TABLE), countedDiagnostic()).toBe(0);
                expect(capture.count(LINE_TABLE), countedDiagnostic()).toBe(0);
                expect(capture.writesFor(LIST_TABLE).length, countedDiagnostic()).toBe(0);
            }
        });

        it('applies the configured default page size of 25 where the caller supplies no options at all', async () => {
            const seeded = await seedLists('Default page', DEFAULT_LISTS_PAGE_SIZE + 1);
            expect(seeded).toHaveLength(DEFAULT_LISTS_PAGE_SIZE + 1);

            const { activeCustomerReorderLists } = await shopClient.query<GetActiveCustomerReorderListsQuery>(
                GET_ACTIVE_CUSTOMER_REORDER_LISTS,
            );

            expect(activeCustomerReorderLists.items.length).toBe(DEFAULT_LISTS_PAGE_SIZE);
            expect(activeCustomerReorderLists.items.length).toBeLessThanOrEqual(SHOP_LIST_QUERY_LIMIT);
            expect(activeCustomerReorderLists.totalItems).toBe(DEFAULT_LISTS_PAGE_SIZE + 1);
        });

        it('applies the configured default nested page size of 50 where the caller windows no lines', async () => {
            const seeded = await seedList('Default nested page');
            const lineTotal = DEFAULT_LINES_PAGE_SIZE + 1;
            for (let index = 0; index < lineTotal; index++) {
                const variantDbId = await createBareVariant(index);
                await insertLineDirectly(seeded.id, variantDbId, index + 1);
            }
            await setStoredLineCount(seeded.id, lineTotal);
            expect(await countStoredLines(seeded.id)).toBe(lineTotal);

            const { activeCustomerReorderList } = await shopClient.query<
                GetActiveCustomerReorderListQuery,
                GetActiveCustomerReorderListQueryVariables
            >(GET_ACTIVE_CUSTOMER_REORDER_LIST, { id: seeded.id });

            const list = activeCustomerReorderList as NonNullable<typeof activeCustomerReorderList>;
            expect(list.lines.items.length).toBe(DEFAULT_LINES_PAGE_SIZE);
            expect(list.lines.items.length).toBeLessThanOrEqual(SHOP_LIST_QUERY_LIMIT);
            expect(list.lines.totalItems).toBe(lineTotal);

            expect(list.lineCount).toBe(lineTotal);
            expect(list.lineCount).not.toBe(list.lines.items.length);
        });

        it('refuses an over-limit nested take with the same platform input error and no partial nested page', async () => {
            const seeded = await seedList('Nested over limit', [
                { productVariantId: catalogueVariants[0].id, quantity: 2 },
            ]);

            const envelope = await rawShopRequest(GET_ACTIVE_CUSTOMER_REORDER_LIST_WITH_PAGED_LINES, {
                id: seeded.id,
                linesTake: SHOP_LIST_QUERY_LIMIT + 1,
            });

            expect(envelope.errors, JSON.stringify(envelope)).toHaveLength(1);
            expect(envelope.errors?.[0].extensions?.code).toBe('USER_INPUT_ERROR');
            expect(envelope.errors?.[0].message).toContain(String(SHOP_LIST_QUERY_LIMIT));
            expect(envelope.errors?.[0].path).toEqual(['activeCustomerReorderList', 'lines']);
            expect(envelope.data?.activeCustomerReorderList).toBeNull();
        });
    });

    describe('AC-4: every inaccessible single-list read is one indistinguishable null', () => {
        it('answers all eight calls without disclosing which identifiers exist', async () => {
            const own = await seedList('Owned by the acting customer');
            const foreign = await seedListForOtherCustomer('Owned by the second customer');

            /** Issues the pair of calls AC-4 requires for one identifier: `includeShared` omitted, then true. */
            async function bothArgumentForms(id: ReorderApiId): Promise<GraphQlEnvelope[]> {
                const omitted = await rawShopRequest(GET_ACTIVE_CUSTOMER_REORDER_LIST, { id });
                const supplied = await rawShopRequest(GET_ACTIVE_CUSTOMER_REORDER_LIST_INCLUDE_SHARED, {
                    id,
                    includeShared: true,
                });
                return [omitted, supplied];
            }

            const unknown = await bothArgumentForms(UNKNOWN_LIST_ID);
            const otherCustomers = await bothArgumentForms(foreign.id);
            const malformed = await bothArgumentForms(MALFORMED_LIST_ID);

            // (iii) the caller's OWN list, read under the SECOND CHANNEL's real token.
            shopClient.setChannelToken(SECOND_CHANNEL_TOKEN);
            const otherChannel = await bothArgumentForms(own.id);
            shopClient.setChannelToken(E2E_DEFAULT_CHANNEL_TOKEN);

            const sixNulls = [...unknown, ...otherCustomers, ...otherChannel];
            const expectedEnvelope: GraphQlEnvelope = { data: { activeCustomerReorderList: null } };

            for (const envelope of sixNulls) {
                expect(envelope).toEqual(expectedEnvelope);
                expect(Object.keys(envelope).sort()).toEqual(['data']);
                expect(envelope.errors).toBeUndefined();
                expect(envelope.extensions).toBeUndefined();
            }
            for (const envelope of sixNulls) {
                expect(envelope).toEqual(sixNulls[0]);
                expect(envelope).toEqual(unknown[0]);
            }

            for (const envelope of malformed) {
                expect(envelope).toEqual(expectedEnvelope);
                expect(envelope.errors).toBeUndefined();
            }

            expect(unknown[1]).toEqual(unknown[0]);
            expect(otherCustomers[1]).toEqual(otherCustomers[0]);
            expect(otherChannel[1]).toEqual(otherChannel[0]);
            expect(malformed[1]).toEqual(malformed[0]);

            const accessible = await rawShopRequest(GET_ACTIVE_CUSTOMER_REORDER_LIST, { id: own.id });
            expect((accessible.data?.activeCustomerReorderList as { id: string } | null)?.id).toBe(own.id);
        });
    });

    // AC-5 — the unauthenticated and cross-customer collection reads. A READ answers with an empty collection
    // or a null and NEVER with an error (ruling R14, the shipped read convention). A WRITE is the opposite case
    // and propagates `FORBIDDEN`; that is asserted by the create, add-item and mutate suites, which own the six
    // mutations, and deliberately not here.

    describe('AC-5: a caller with no resolvable scope receives an empty page rather than an error', () => {
        it('returns totalItems 0 and an empty items collection with no error entry for an unauthenticated call', async () => {
            const owned = await seedList('Owned while authenticated');
            const ownerView = await rawShopRequest(GET_ACTIVE_CUSTOMER_REORDER_LIST, { id: owned.id });
            expect((ownerView.data?.activeCustomerReorderList as { id: string } | null)?.id).toBe(owned.id);

            await shopClient.asAnonymousUser();
            shopClient.setChannelToken(E2E_DEFAULT_CHANNEL_TOKEN);
            const envelope = await rawShopRequest(GET_ACTIVE_CUSTOMER_REORDER_LISTS);

            expect(envelope.errors, JSON.stringify(envelope)).toBeUndefined();
            expect(envelope.data).toEqual({ activeCustomerReorderLists: { totalItems: 0, items: [] } });

            /*
             * THE SINGLE-LIST READ ADDRESSES THE EXISTING, OWNED ROW — not an identifier nothing was ever stored
             * under.
             */
            const single = await rawShopRequest(GET_ACTIVE_CUSTOMER_REORDER_LIST, { id: owned.id });
            expect(single.errors, JSON.stringify(single)).toBeUndefined();
            expect(single.data).toEqual({ activeCustomerReorderList: null });

            // And the same convention holds for an identifier nothing was stored under, so the two cases are
            // INDISTINGUISHABLE to an anonymous caller — which is the point: the API discloses neither the
            // existence nor the absence of another party's row.
            const unknown = await rawShopRequest(GET_ACTIVE_CUSTOMER_REORDER_LIST, { id: UNKNOWN_LIST_ID });
            expect(unknown.errors).toBeUndefined();
            expect(unknown).toEqual(single);
        });

        it('returns totalItems 0 for the second customer and never an entry belonging to the first', async () => {
            const first = await seedList('First customer\u2019s list');
            const second = await seedList('First customer\u2019s second list');

            await authenticateAs(otherCustomer);
            const envelope = await rawShopRequest(GET_ACTIVE_CUSTOMER_REORDER_LISTS);

            expect(envelope.errors, JSON.stringify(envelope)).toBeUndefined();
            const page = envelope.data?.activeCustomerReorderLists as {
                totalItems: number;
                items: ReorderListFieldsShape[];
            };
            expect(page.totalItems).toBe(0);
            expect(page.items).toEqual([]);
            expect(page.items.map(entry => String(entry.id))).not.toContain(first.id);
            expect(page.items.map(entry => String(entry.id))).not.toContain(second.id);

            await authenticateAs(actingCustomer);
            const ownPage = await shopClient.query<GetActiveCustomerReorderListsQuery>(
                GET_ACTIVE_CUSTOMER_REORDER_LISTS,
            );
            expect(ownPage.activeCustomerReorderLists.totalItems).toBe(2);
        });
    });

    describe('AC-6: includeShared is accepted at both values and answers identically', () => {
        it('returns the same collection page under an omitted, a false and a true includeShared', async () => {
            await seedList(FIRST_LIST_NAME, [{ productVariantId: catalogueVariants[0].id, quantity: 2 }]);
            await seedList(SECOND_LIST_NAME, [{ productVariantId: catalogueVariants[1].id, quantity: 3 }]);

            const omitted = await shopClient.query<GetActiveCustomerReorderListsQuery>(
                GET_ACTIVE_CUSTOMER_REORDER_LISTS,
            );
            const explicitlyFalse = await shopClient.query<
                GetActiveCustomerReorderListsIncludeSharedQuery,
                GetActiveCustomerReorderListsIncludeSharedQueryVariables
            >(GET_ACTIVE_CUSTOMER_REORDER_LISTS_INCLUDE_SHARED, { includeShared: false });
            const explicitlyTrue = await shopClient.query<
                GetActiveCustomerReorderListsIncludeSharedQuery,
                GetActiveCustomerReorderListsIncludeSharedQueryVariables
            >(GET_ACTIVE_CUSTOMER_REORDER_LISTS_INCLUDE_SHARED, { includeShared: true });

            expect(explicitlyFalse.activeCustomerReorderLists).toEqual(omitted.activeCustomerReorderLists);
            expect(explicitlyTrue.activeCustomerReorderLists).toEqual(omitted.activeCustomerReorderLists);
            expect(explicitlyTrue.activeCustomerReorderLists.totalItems).toBe(2);
            expect(
                explicitlyTrue.activeCustomerReorderLists.items.map(entry => [String(entry.id), entry.name]),
            ).toEqual(omitted.activeCustomerReorderLists.items.map(entry => [String(entry.id), entry.name]));
            for (const entry of explicitlyTrue.activeCustomerReorderLists.items) {
                expect(entry.viewerAccess.access).toBe('OWNED');
                expect(entry.viewerAccess.grantedCapabilities).toEqual([]);
            }
        });

        it('returns the same single list under an omitted, a false and a true includeShared', async () => {
            const seeded = await seedList(FIRST_LIST_NAME, [
                { productVariantId: catalogueVariants[0].id, quantity: 2 },
                { productVariantId: catalogueVariants[1].id, quantity: 3 },
            ]);

            const omitted = await shopClient.query<
                GetActiveCustomerReorderListQuery,
                GetActiveCustomerReorderListQueryVariables
            >(GET_ACTIVE_CUSTOMER_REORDER_LIST, { id: seeded.id });
            const explicitlyFalse = await shopClient.query<
                GetActiveCustomerReorderListIncludeSharedQuery,
                GetActiveCustomerReorderListIncludeSharedQueryVariables
            >(GET_ACTIVE_CUSTOMER_REORDER_LIST_INCLUDE_SHARED, { id: seeded.id, includeShared: false });
            const explicitlyTrue = await shopClient.query<
                GetActiveCustomerReorderListIncludeSharedQuery,
                GetActiveCustomerReorderListIncludeSharedQueryVariables
            >(GET_ACTIVE_CUSTOMER_REORDER_LIST_INCLUDE_SHARED, { id: seeded.id, includeShared: true });

            expect(explicitlyFalse.activeCustomerReorderList).toEqual(omitted.activeCustomerReorderList);
            expect(explicitlyTrue.activeCustomerReorderList).toEqual(omitted.activeCustomerReorderList);
            expect(explicitlyTrue.activeCustomerReorderList).not.toBeNull();
            expect(explicitlyTrue.activeCustomerReorderList?.viewerAccess.access).toBe('OWNED');
            expect(explicitlyTrue.activeCustomerReorderList?.lines.totalItems).toBe(2);
        });
    });

    describe('AC-7: the existing Shop API is untouched by this plugin', () => {
        it('returns the same activeCustomer with the same fields and the same customFields value', async () => {
            const { activeCustomer } = await shopClient.query<GetActiveCustomerQuery>(
                GET_ACTIVE_CUSTOMER_FOR_REORDER_READ,
            );

            expect(activeCustomer).not.toBeNull();
            const customer = activeCustomer as ActiveCustomerShape;
            expect(String(customer.id)).toBe(String(actingCustomer.id));
            expect(
                customer.emailAddress === actingCustomer.emailAddress,
                "activeCustomer returned a different customer's identifying field",
            ).toBe(true);
            expect(Object.keys(customer).sort()).toEqual(
                [
                    'id',
                    'createdAt',
                    'updatedAt',
                    'title',
                    'firstName',
                    'lastName',
                    'phoneNumber',
                    'emailAddress',
                    'customFields',
                ].sort(),
            );
            /*
             * The one key the value does carry is the PLATFORM'S OWN and is not a custom field: the generated
             * custom-field resolver spreads the entity's `customFields` and then attaches `__entityId__` set to the
             * entity's identifier, so that a relation-typed custom field could be resolved from it
             * (`packages/core/src/api/config/generate-resolvers.ts`).
             */
            const unexpectedCustomFieldKeys = Object.keys(customer.customFields ?? {})
                .filter(key => key !== '__entityId__')
                .sort();
            expect(
                Object.keys(customer.customFields ?? {}).sort(),
                unexpectedCustomFieldKeys.length === 0
                    ? 'Customer.customFields did not carry the platform marker'
                    : `Customer.customFields carried ${String(unexpectedCustomFieldKeys.length)} ` +
                          `unexpected key(s): ${unexpectedCustomFieldKeys.join(', ')} — names only, ` +
                          'deliberately, because a registered custom field stores arbitrary customer data',
            ).toEqual(['__entityId__']);
            expect(Number((customer.customFields as Record<string, unknown>).__entityId__)).toBe(
                actingCustomerDbId,
            );

            expect(fieldSignaturesOf(liveSchema, 'Customer')).toEqual(
                fieldSignaturesOf(snapshotSchema, 'Customer'),
            );

            const liveSignature = renderFieldSignature(
                findField(liveSchema, liveSchema.queryType.name, 'activeCustomer') as IntrospectedField,
            );
            const snapshotSignature = renderFieldSignature(
                findField(
                    snapshotSchema,
                    snapshotSchema.queryType.name,
                    'activeCustomer',
                ) as IntrospectedField,
            );
            expect(liveSignature).toBe(snapshotSignature);
            expect(liveSignature).toBe('activeCustomer(): Customer');
        });
    });

    describe('AC-8: the four added ErrorCode members are evidenced by the pinned compiler', () => {
        let generatedErrorCodeMembers: string[];

        beforeAll(async () => {
            const generated = await generatePluginAwareShopTypes();
            generatedErrorCodeMembers = generated.members;
            expect(fs.existsSync(generated.modulePath)).toBe(true);
        }, COMPILER_INVOCATION_TIMEOUT_MS);

        afterAll(() => {
            removeGeneratedShopTypes();
        });

        it('generates the ErrorCode enum from the live schema, 32 baseline members widening to 36', () => {
            const baseline = sortedEnumValues(snapshotSchema, 'ErrorCode');
            expect(baseline.length).toBe(BASELINE_ERROR_CODE_COUNT);

            const generated = [...generatedErrorCodeMembers].sort();
            expect(generated.length, `The generated enum carried ${generated.join(', ')}`).toBe(
                BASELINE_ERROR_CODE_COUNT + FEATURE_ERROR_CODES.length,
            );
            for (const member of baseline) {
                expect(
                    generated,
                    `The baseline member ${member} is absent from the generated enum`,
                ).toContain(member);
            }
            for (const code of FEATURE_ERROR_CODES) {
                expect(generated, `The generated enum is missing ${code}`).toContain(code);
                expect(
                    baseline,
                    `${code} was already in the baseline, so it is not this feature's`,
                ).not.toContain(code);
            }
            expect(generated.filter(member => !baseline.includes(member))).toEqual(
                [...FEATURE_ERROR_CODES].sort(),
            );
        });

        it('declares each compiler project as its own package script, pinned and identical but for the project', () => {
            /*
             * THE INVOCATION SURFACE, ASSERTED RATHER THAN ASSUMED. STORY-001-01-04's AC-8 asks for two compiler
             * PROJECTS driven by two package SCRIPTS; a suite that shelled out to its own command line would satisfy
             * the compiler half while leaving the declared half absent, and nothing would say so.
             */
            const pinnedCompiler = path.join('..', '..', 'node_modules', 'typescript', 'bin', 'tsc');
            const blanked: string[][] = [];
            for (const declaration of [
                { script: EXHAUSTIVE_SCRIPT, project: EXHAUSTIVE_TSCONFIG },
                { script: DEFAULTED_SCRIPT, project: DEFAULTED_TSCONFIG },
            ]) {
                const tokens = declaredScriptTokens(declaration.script);
                expect(tokens[0], `"${declaration.script}" must invoke the compiler through node`).toBe(
                    'node',
                );
                expect(
                    path.normalize(String(tokens[1])),
                    `"${declaration.script}" must name the workspace-pinned compiler by path`,
                ).toBe(pinnedCompiler);
                expect(
                    fs.existsSync(path.join(__dirname, '..', String(tokens[1]))),
                    `"${declaration.script}" points at ${String(tokens[1])}, which does not exist`,
                ).toBe(true);
                const projectFlagAt = tokens.indexOf('-p');
                expect(
                    projectFlagAt,
                    `"${declaration.script}" declares no -p project selector`,
                ).toBeGreaterThan(0);
                const projectToken = String(tokens[projectFlagAt + 1]);
                expect(
                    path.normalize(projectToken),
                    `"${declaration.script}" must compile ${declaration.project} and nothing else`,
                ).toBe(path.join('e2e', declaration.project));
                expect(
                    fs.existsSync(path.join(__dirname, declaration.project)),
                    `${declaration.project} does not exist beside the fixtures`,
                ).toBe(true);
                expect(tokens, `"${declaration.script}" must compile with --noEmit`).toContain('--noEmit');
                expect(tokens, `"${declaration.script}" must not resolve anything through npx`).not.toContain(
                    'npx',
                );
                blanked.push(tokens.map(token => (token === projectToken ? '<project>' : token)));
            }
            expect(
                blanked[0],
                'the two scripts differ in more than the project they compile, so their opposite exit ' +
                    'statuses are not attributable to the projects',
            ).toEqual(blanked[1]);

            for (const declaration of [
                { project: EXHAUSTIVE_TSCONFIG, fixture: './error-code-exhaustive.fixture.ts' },
                { project: DEFAULTED_TSCONFIG, fixture: './error-code-defaulted.fixture.ts' },
            ]) {
                const declared = JSON.parse(
                    fs.readFileSync(path.join(__dirname, declaration.project), 'utf-8'),
                ) as { extends?: string; files?: string[]; include?: string[] };
                expect(
                    declared.extends,
                    `${declaration.project} must extend the repository root configuration`,
                ).toBe('../../../tsconfig.json');
                expect(
                    declared.include,
                    `${declaration.project} must not widen to a directory`,
                ).toBeUndefined();
                expect(declared.files, `${declaration.project} must name exactly one file`).toEqual([
                    declaration.fixture,
                ]);
                expect(
                    fs.existsSync(path.join(__dirname, declaration.fixture)),
                    `${declaration.project} names ${declaration.fixture}, which does not exist`,
                ).toBe(true);
            }
        });

        it(
            'resolves the workspace-pinned TypeScript compiler and not a floating one',
            () => {
                const compiler = path.join(__dirname, '../../../node_modules/typescript/bin/tsc');
                expect(
                    fs.existsSync(compiler),
                    'The workspace compiler is absent from node_modules/typescript/bin/tsc; run the ' +
                        'workspace install before this suite',
                ).toBe(true);
                const reported = execFileSync(process.execPath, [compiler, '--version'], {
                    encoding: 'utf-8',
                    timeout: COMPILER_INVOCATION_TIMEOUT_MS,
                }).trim();
                expect(reported).toBe(`Version ${PINNED_TYPESCRIPT_VERSION}`);
            },
            COMPILER_INVOCATION_TIMEOUT_MS,
        );

        it(
            'fails to compile the exhaustive switch, naming at least one of the four added members',
            () => {
                const { status, output } = runDeclaredCompilerScript(EXHAUSTIVE_SCRIPT);

                expect(status, `Expected a non-zero exit; output was:\n${output}`).not.toBe(0);
                expect(status).not.toBeNull();
                const named = FEATURE_ERROR_CODES.filter(code => output.includes(code));
                expect(
                    named.length,
                    `The diagnostic named none of the four added members:\n${output}`,
                ).toBeGreaterThan(0);
                expect(output, output).toContain('TS2322');
                expect(
                    output,
                    `The refusal was an unresolved module rather than exhaustiveness:\n${output}`,
                ).not.toContain('TS2307');
            },
            COMPILER_INVOCATION_TIMEOUT_MS,
        );

        it(
            'compiles the defaulted switch cleanly',
            () => {
                const { status, output } = runDeclaredCompilerScript(DEFAULTED_SCRIPT);

                expect(status, `Expected a zero exit; output was:\n${output}`).toBe(0);
                expect(output, output).not.toContain('error TS');
            },
            COMPILER_INVOCATION_TIMEOUT_MS,
        );

        it(
            'is checkable only inside the generation window, and proves it by failing with TS2307 outside it',
            () => {
                const directory = path.join(__dirname, GENERATED_TYPES_DIRECTORY);
                const detached = detachGeneratedShopTypes();
                try {
                    for (const script of [EXHAUSTIVE_SCRIPT, DEFAULTED_SCRIPT]) {
                        const { status, output } = runDeclaredCompilerScript(script);
                        expect(
                            status,
                            `"${script}" exited 0 with the generated module absent:\n${output}`,
                        ).not.toBe(0);
                        expect(
                            output,
                            `"${script}" failed for some reason other than the absent module:\n${output}`,
                        ).toContain('TS2307');
                        expect(
                            output,
                            `"${script}" did not name the generated module in its refusal:\n${output}`,
                        ).toContain(GENERATED_SHOP_TYPES_FILE.replace(/\.ts$/, ''));
                    }
                    expect(
                        fs.existsSync(directory),
                        `the ${GENERATED_TYPES_DIRECTORY} directory was recreated by a run that had no ` +
                            'module to compile against',
                    ).toBe(false);
                } finally {
                    reattachGeneratedShopTypes(detached);
                }
            },
            COMPILER_INVOCATION_TIMEOUT_MS,
        );
    });

    // The schema delta, by runtime introspection of the booted server (AAP section 0.7.3, ruling R15)
    //
    // The comparison is between the LIVE schema of a server carrying this plugin and the UNTOUCHED checked-in
    // snapshot, read from disk read-only. The snapshot is never edited and never regenerated, and it cannot
    // move: the introspection that produces it declares its own configuration with `plugins: [AdminUiPlugin]`
    // and never reads a plugin's. Every number below is therefore stated as a TRANSITION — the baseline and
    // this feature's own addition — and never as a bare post-plugin total.

    describe('the published Shop surface widens by exactly this feature\u2019s own additions', () => {
        it('transitions 19\u219221 queries, 32\u219238 mutations, 32\u219236 error codes, 31\u219235 implementors and 97\u219297 permissions', () => {
            const baselineQueries = sortedFieldNames(snapshotSchema, snapshotSchema.queryType.name);
            const baselineMutations = sortedFieldNames(
                snapshotSchema,
                (snapshotSchema.mutationType as { name: string }).name,
            );
            expect(baselineQueries).toHaveLength(BASELINE_ROOT_QUERY_FIELD_COUNT);
            expect(baselineMutations).toHaveLength(BASELINE_ROOT_MUTATION_FIELD_COUNT);
            expect(sortedEnumValues(snapshotSchema, 'ErrorCode')).toHaveLength(
                BASELINE_ERROR_CODE_MEMBER_COUNT,
            );
            expect(sortedErrorResultImplementors(snapshotSchema)).toHaveLength(
                BASELINE_ERROR_RESULT_IMPLEMENTOR_COUNT,
            );
            expect(sortedEnumValues(snapshotSchema, 'Permission')).toHaveLength(
                BASELINE_PERMISSION_MEMBER_COUNT,
            );

            // THE RUNTIME WIDTH, as baseline PLUS this feature's own additions. Ruling R15 admits only a
            // transition the asserting change actually owns, so every figure below is F-101's own. The
            // epic's ledger accumulates across all of its features, and its totals are deliberately not
            // restated here: quoting them alongside these assertions is precisely how a reader comes to
            // check this plugin against a width it never delivers.
            const liveQueries = sortedFieldNames(liveSchema, liveSchema.queryType.name);
            const liveMutations = sortedFieldNames(
                liveSchema,
                (liveSchema.mutationType as { name: string }).name,
            );
            expect(liveQueries).toHaveLength(BASELINE_ROOT_QUERY_FIELD_COUNT + FEATURE_ROOT_QUERIES.length);
            expect(liveQueries).toHaveLength(21);
            expect(liveMutations).toHaveLength(
                BASELINE_ROOT_MUTATION_FIELD_COUNT + FEATURE_ROOT_MUTATIONS.length,
            );
            expect(liveMutations).toHaveLength(38);
            expect(sortedEnumValues(liveSchema, 'ErrorCode')).toHaveLength(
                BASELINE_ERROR_CODE_MEMBER_COUNT + FEATURE_ERROR_CODES.length,
            );
            expect(sortedEnumValues(liveSchema, 'ErrorCode')).toHaveLength(36);
            expect(sortedErrorResultImplementors(liveSchema)).toHaveLength(
                BASELINE_ERROR_RESULT_IMPLEMENTOR_COUNT + FEATURE_ERROR_RESULTS.length,
            );
            expect(sortedErrorResultImplementors(liveSchema)).toHaveLength(35);

            expect(sortedEnumValues(liveSchema, 'Permission')).toHaveLength(BASELINE_PERMISSION_MEMBER_COUNT);
            expect(sortedEnumValues(liveSchema, 'Permission')).toEqual(
                sortedEnumValues(snapshotSchema, 'Permission'),
            );

            expect(liveQueries.filter(name => !baselineQueries.includes(name)).sort()).toEqual(
                [...FEATURE_ROOT_QUERIES].sort(),
            );
            expect(liveMutations.filter(name => !baselineMutations.includes(name)).sort()).toEqual(
                [...FEATURE_ROOT_MUTATIONS].sort(),
            );
        });

        it('leaves all 19 baseline root queries byte-identical in name, arguments, types and nullability', () => {
            const baseline = fieldSignaturesOf(snapshotSchema, snapshotSchema.queryType.name);
            const live = fieldSignaturesOf(liveSchema, liveSchema.queryType.name);
            expect(baseline.size).toBe(BASELINE_ROOT_QUERY_FIELD_COUNT);

            for (const [name, signature] of baseline) {
                expect(live.get(name), `The Shop schema no longer publishes the root query "${name}"`).toBe(
                    signature,
                );
            }
            for (const name of baseline.keys()) {
                expect(live.has(name)).toBe(true);
            }

            const baselineMutations = fieldSignaturesOf(
                snapshotSchema,
                (snapshotSchema.mutationType as { name: string }).name,
            );
            const liveMutations = fieldSignaturesOf(
                liveSchema,
                (liveSchema.mutationType as { name: string }).name,
            );
            for (const name of UNWIDENED_ORDER_MUTATIONS) {
                expect(liveMutations.get(name), `${name} changed signature`).toBe(
                    baselineMutations.get(name),
                );
            }
            for (const [name, signature] of baselineMutations) {
                expect(liveMutations.get(name), `The shipped mutation "${name}" changed signature`).toBe(
                    signature,
                );
            }
        });

        it('adds the four ErrorCode members by name and removes or renames none', () => {
            const baseline = sortedEnumValues(snapshotSchema, 'ErrorCode');
            const live = sortedEnumValues(liveSchema, 'ErrorCode');

            for (const code of FEATURE_ERROR_CODES) {
                expect(live, `The runtime ErrorCode enum is missing ${code}`).toContain(code);
                expect(
                    baseline,
                    `${code} was already in the baseline, so it is not this feature's`,
                ).not.toContain(code);
            }
            expect(live.filter(member => !baseline.includes(member))).toEqual(
                [...FEATURE_ERROR_CODES].sort(),
            );
            for (const member of baseline) {
                expect(live, `The baseline ErrorCode member ${member} disappeared`).toContain(member);
            }
            const liveImplementors = sortedErrorResultImplementors(liveSchema);
            for (const result of FEATURE_ERROR_RESULTS) {
                expect(liveImplementors).toContain(result);
                expect(sortedFieldNames(liveSchema, result)).toContain('errorCode');
                expect(sortedFieldNames(liveSchema, result)).toContain('message');
            }
            expect(sortedFieldNames(liveSchema, 'ReorderListNameConflictError')).toContain(
                'conflictingNameKey',
            );
            expect(sortedFieldNames(liveSchema, 'ReorderListLimitError')).toContain('maxItems');
        });

        it('leaves the two paginated options inputs to the generator, this plugin naming neither', () => {
            const rootField = findField(
                liveSchema,
                liveSchema.queryType.name,
                'activeCustomerReorderLists',
            ) as IntrospectedField;
            const rootOptions = (rootField.args ?? []).find(arg => arg.name === 'options');
            expect(
                rootOptions,
                'The generator supplied no options argument on the root collection',
            ).toBeDefined();
            const rootOptionsTypeName = renderTypeRef((rootOptions as IntrospectedArg).type);
            expect(sortedInputFieldNames(liveSchema, rootOptionsTypeName)).toEqual(
                expect.arrayContaining(GENERATED_LIST_OPTIONS_FIELDS),
            );

            const nestedField = findField(liveSchema, 'ReorderList', 'lines') as IntrospectedField;
            const nestedOptions = (nestedField.args ?? []).find(arg => arg.name === 'options');
            expect(
                nestedOptions,
                'The generator supplied no options argument on the nested collection',
            ).toBeDefined();
            const nestedOptionsTypeName = renderTypeRef((nestedOptions as IntrospectedArg).type);
            expect(sortedInputFieldNames(liveSchema, nestedOptionsTypeName)).toEqual(
                expect.arrayContaining(GENERATED_LIST_OPTIONS_FIELDS),
            );
            expect(nestedOptionsTypeName).not.toBe(rootOptionsTypeName);

            const documentSource = shopApiExtensions.loc?.source.body ?? '';
            expect(documentSource.length, 'The plugin SDL document carried no source text').toBeGreaterThan(
                0,
            );
            for (const generatedInputName of [rootOptionsTypeName, nestedOptionsTypeName]) {
                expect(
                    documentSource.includes(generatedInputName),
                    `The plugin document names the generator-owned input "${generatedInputName}"`,
                ).toBe(false);
            }
            expect(documentSource).not.toMatch(/lines\s*\(/);

            const singleField = findField(
                liveSchema,
                liveSchema.queryType.name,
                'activeCustomerReorderList',
            ) as IntrospectedField;
            for (const field of [rootField, singleField]) {
                const includeShared = (field.args ?? []).find(arg => arg.name === 'includeShared');
                expect(includeShared, `${field.name} does not publish includeShared`).toBeDefined();
                expect(renderTypeRef((includeShared as IntrospectedArg).type)).toBe('Boolean');
                expect((includeShared as IntrospectedArg).defaultValue).toBe('false');
            }
            expect((singleField.args ?? []).map(arg => arg.name).sort()).toEqual(['id', 'includeShared']);
        });
    });

    // Statement-count discipline (EPIC-001 sections 7.7.1a and 11.6.2; FEATURE-001-01 sections 2.6.1.1,
    // 2.6.2 and 2.6.3)
    //
    // Each test below states WHICH observation boundary it is making its claim at, because conflating them is
    // what produces a brittle assertion that fails on an unrelated platform change. The counted form is gated
    // to sql.js, where statement text and count are deterministic; the BEHAVIOUR each count evidences is
    // asserted ungated in the same test and therefore runs on all four engine jobs.

    describe('the reads-nothing contract (PLUGIN-STATEMENT boundary, exact number)', () => {
        it('asks exactly once, with the customer and the channel beside the row id, and returns no row', async () => {
            const own = await seedList('Scoped read');
            const foreign = await seedListForOtherCustomer('Another buyer\u2019s scoped read');
            const ownDbId = decodeId(own.id);
            const foreignDbId = decodeId(foreign.id);

            /**
             * Reads one identifier with the window opened around the request and nothing else, and returns
             * what the caller saw together with what the database was asked.
             */
            async function readAndCount(id: ReorderApiId): Promise<GraphQlEnvelope> {
                capture.reset();
                return capture.capture(() => rawShopRequest(GET_ACTIVE_CUSTOMER_REORDER_LIST, { id }));
            }

            const absent = await readAndCount(UNKNOWN_LIST_ID);
            expect(absent.data).toEqual({ activeCustomerReorderList: null });
            if (isStatementCountEngine()) {
                // EXACTLY ONE statement against `reorder_list` — never zero. The server cannot discover a row's
                // absence without asking, so a zero-statement claim here is unpassable for a correct
                // implementation and passable only by one that answers without looking.
                expect(capture.count(LIST_TABLE), countedDiagnostic()).toBe(1);
                expect(capture.selectsFor(LIST_TABLE).length, countedDiagnostic()).toBe(1);
                expect(capture.writesFor(LIST_TABLE).length, countedDiagnostic()).toBe(0);
                expect(capture.writesFor(LINE_TABLE).length, countedDiagnostic()).toBe(0);
                expect(capture.count(LINE_TABLE), countedDiagnostic()).toBe(0);
                const [statement] = capture.selectsFor(LIST_TABLE);
                expect(
                    whereRequiresScopedPredicates(statement, [
                        { column: 'id', relation: listAlias, value: decodeId(UNKNOWN_LIST_ID) },
                        { column: 'customerId', relation: listAlias, value: actingCustomerDbId },
                        { column: 'channelId', relation: listAlias, value: defaultChannelDbId },
                    ]),
                    capture.format(),
                ).toBe(true);
            }

            const notOwned = await readAndCount(foreign.id);
            expect(notOwned.data).toEqual({ activeCustomerReorderList: null });
            if (isStatementCountEngine()) {
                expect(capture.count(LIST_TABLE), countedDiagnostic()).toBe(1);
                expect(capture.writesFor(LIST_TABLE).length, countedDiagnostic()).toBe(0);
                const [statement] = capture.selectsFor(LIST_TABLE);
                expect(
                    whereRequiresScopedPredicates(statement, [
                        { column: 'id', relation: listAlias, value: foreignDbId },
                        { column: 'customerId', relation: listAlias, value: actingCustomerDbId },
                        { column: 'channelId', relation: listAlias, value: defaultChannelDbId },
                    ]),
                    capture.format(),
                ).toBe(true);
                expect(
                    whereRequiresScopedPredicates(statement, [
                        { column: 'customerId', relation: listAlias, value: otherCustomerDbId },
                    ]),
                    capture.format(),
                ).toBe(false);
            }

            shopClient.setChannelToken(SECOND_CHANNEL_TOKEN);
            const otherChannel = await readAndCount(own.id);
            shopClient.setChannelToken(E2E_DEFAULT_CHANNEL_TOKEN);
            expect(otherChannel.data).toEqual({ activeCustomerReorderList: null });
            if (isStatementCountEngine()) {
                expect(capture.count(LIST_TABLE), countedDiagnostic()).toBe(1);
                expect(capture.writesFor(LIST_TABLE).length, countedDiagnostic()).toBe(0);
                const [statement] = capture.selectsFor(LIST_TABLE);
                /*
                 * The channel conjunct carries THE SECOND CHANNEL'S OWN IDENTIFIER — the channel the `vendure-token`
                 * header selected — and not merely some value that differs from the default's. "Not the default" is
                 * satisfied by any value whatsoever, including one belonging to no channel at all, so it evidences
                 * inequality rather than scoping.
                 */
                expect(
                    whereRequiresScopedPredicates(statement, [
                        { column: 'id', relation: listAlias, value: ownDbId },
                        { column: 'customerId', relation: listAlias, value: actingCustomerDbId },
                        { column: 'channelId', relation: listAlias, value: secondChannelDbId },
                    ]),
                    capture.format(),
                ).toBe(true);
                expect(
                    whereRequiresScopedPredicates(statement, [
                        { column: 'channelId', relation: listAlias, value: defaultChannelDbId },
                    ]),
                    capture.format(),
                ).toBe(false);
            }

            expect(await readStoredList(own.id)).not.toBeNull();
            const accessible = await rawShopRequest(GET_ACTIVE_CUSTOMER_REORDER_LIST, { id: own.id });
            expect((accessible.data?.activeCustomerReorderList as { id: string }).id).toBe(own.id);
        });
    });

    describe('lineCount is the stored column (PLUGIN-STATEMENT boundary, exact number)', () => {
        it('costs the same statements for three lists as for four, the counter arriving with the row', async () => {
            const three = await seedLists('Counter fixture', 3, 2);
            expect(three).toHaveLength(3);

            capture.reset();
            const forThree = await capture.capture(() =>
                shopClient.query<
                    GetActiveCustomerReorderListsWithLinePagesQuery,
                    GetActiveCustomerReorderListsWithLinePagesQueryVariables
                >(GET_ACTIVE_CUSTOMER_REORDER_LISTS_WITH_LINE_PAGES, {}),
            );
            const statementsForThree = capture.count(LIST_TABLE, LINE_TABLE);
            const lineStatementsForThree = capture.count(LINE_TABLE);
            const captureForThree = countedDiagnostic();

            expect(forThree.activeCustomerReorderLists.totalItems).toBe(3);
            for (const entry of forThree.activeCustomerReorderLists.items) {
                expect(entry.lineCount).toBe(2);
                expect(entry.lines.totalItems).toBe(2);
            }

            await seedLists('Counter fixture extra', 1, 2);
            capture.reset();
            const forFour = await capture.capture(() =>
                shopClient.query<
                    GetActiveCustomerReorderListsWithLinePagesQuery,
                    GetActiveCustomerReorderListsWithLinePagesQueryVariables
                >(GET_ACTIVE_CUSTOMER_REORDER_LISTS_WITH_LINE_PAGES, {}),
            );
            const statementsForFour = capture.count(LIST_TABLE, LINE_TABLE);
            const lineStatementsForFour = capture.count(LINE_TABLE);

            expect(forFour.activeCustomerReorderLists.totalItems).toBe(4);
            for (const entry of forFour.activeCustomerReorderLists.items) {
                expect(entry.lineCount).toBe(2);
            }

            if (isStatementCountEngine()) {
                // THE EXACT NUMBER, and its composition, named: one statement resolving the page of lists — the
                // platform computes the total locally when the page is not saturated — plus exactly two
                // resolving every entry's lines, one for the rows and one for the per-parent totals.
                expect(statementsForThree, captureForThree).toBe(3);
                expect(lineStatementsForThree, captureForThree).toBe(2);
                expect(statementsForFour, countedDiagnostic()).toBe(3);
                expect(lineStatementsForFour, countedDiagnostic()).toBe(2);
                expect(statementsForFour).toBe(statementsForThree);
                expect(capture.writesFor(LIST_TABLE).length, countedDiagnostic()).toBe(0);
            }
        });

        it('reports a lineCount that differs from the length of the nested page it returned', async () => {
            const seeded = await seedList('Counter versus page', [
                { productVariantId: catalogueVariants[0].id, quantity: 2 },
                { productVariantId: catalogueVariants[1].id, quantity: 3 },
                { productVariantId: catalogueVariants[2].id, quantity: 4 },
            ]);

            const { activeCustomerReorderList } = await shopClient.query<
                GetActiveCustomerReorderListWithPagedLinesQuery,
                GetActiveCustomerReorderListWithPagedLinesQueryVariables
            >(GET_ACTIVE_CUSTOMER_REORDER_LIST_WITH_PAGED_LINES, {
                id: seeded.id,
                linesTake: 2,
                linesSkip: 0,
                linesCreatedAtSort: SortOrder.ASC,
                linesIdSort: SortOrder.ASC,
            });

            const list = activeCustomerReorderList as NonNullable<typeof activeCustomerReorderList>;
            expect(list.lineCount).toBe(3);
            expect(list.lines.totalItems).toBe(3);
            expect(list.lines.items).toHaveLength(2);
            expect(list.lineCount).not.toBe(list.lines.items.length);
            expect((await readStoredList(seeded.id))?.lineCount).toBe(3);
            expect(await countStoredLines(seeded.id)).toBe(3);
        });
    });

    describe('per-page non-growth (WHOLE-REQUEST boundary, non-growth only)', () => {
        it('issues the same number of statements for a page of three lists as for a page of six', async () => {
            const seeded = await seedLists('Non growth', 6, 2);
            expect(seeded).toHaveLength(6);

            /*
             * ONE WARM-UP REQUEST, OUTSIDE BOTH WINDOWS. The comparison below counts every statement the request
             * issued, including the platform's own session and channel resolution, and some of that is memoised per
             * process on first use.
             */
            await shopClient.query<
                GetActiveCustomerReorderListsWithLinePagesQuery,
                GetActiveCustomerReorderListsWithLinePagesQueryVariables
            >(GET_ACTIVE_CUSTOMER_REORDER_LISTS_WITH_LINE_PAGES, { take: 3, linesTake: 5 });

            capture.reset();
            const pageOfThree = await capture.capture(() =>
                shopClient.query<
                    GetActiveCustomerReorderListsWithLinePagesQuery,
                    GetActiveCustomerReorderListsWithLinePagesQueryVariables
                >(GET_ACTIVE_CUSTOMER_REORDER_LISTS_WITH_LINE_PAGES, { take: 3, linesTake: 5 }),
            );
            // UNFILTERED, because this is the WHOLE-REQUEST boundary — see `allDatabaseStatements`. Counting
            // only the plugin's two tables would leave an N+1 against `product_variant`, `customer` or any
            // other core table entirely invisible to the comparison.
            const statementsForThree = allDatabaseStatements().length;
            const captureForThree = wholeRequestDiagnostic('page of three');
            const pluginStatementsForThree = capture.count(LIST_TABLE, LINE_TABLE);

            capture.reset();
            const pageOfSix = await capture.capture(() =>
                shopClient.query<
                    GetActiveCustomerReorderListsWithLinePagesQuery,
                    GetActiveCustomerReorderListsWithLinePagesQueryVariables
                >(GET_ACTIVE_CUSTOMER_REORDER_LISTS_WITH_LINE_PAGES, { take: 6, linesTake: 5 }),
            );
            const statementsForSix = allDatabaseStatements().length;
            const pluginStatementsForSix = capture.count(LIST_TABLE, LINE_TABLE);

            // The BEHAVIOUR, ungated so it runs on all four engines: both requests answered the same field set
            // over their own page, and the larger page really is larger.
            expect(pageOfThree.activeCustomerReorderLists.items).toHaveLength(3);
            expect(pageOfSix.activeCustomerReorderLists.items).toHaveLength(6);
            for (const entry of [
                ...pageOfThree.activeCustomerReorderLists.items,
                ...pageOfSix.activeCustomerReorderLists.items,
            ]) {
                expect(entry.lines.items).toHaveLength(2);
                expect(entry.lineCount).toBe(2);
                expect(entry.viewerAccess.access).toBe('OWNED');
            }

            if (isStatementCountEngine()) {
                /*
                 * EQUALITY ACROSS THE TWO PAGE SIZES IS THE WHOLE ASSERTION, and no exact total is asserted at this
                 * boundary.
                 */
                expect(
                    statementsForSix,
                    `${captureForThree}\n---\n${wholeRequestDiagnostic('page of six')}`,
                ).toBe(statementsForThree);
                // A guard against the assertion passing because nothing was captured at all, stated at both the
                // whole-request and the plugin-statement boundary so a silent window is caught either way.
                expect(statementsForThree).toBeGreaterThan(0);
                expect(pluginStatementsForThree).toBeGreaterThan(0);
                expect(pluginStatementsForSix).toBe(pluginStatementsForThree);
            }
        });

        it('resolves viewerAccess for a whole page at zero statement cost', async () => {
            const seeded = await seedLists('Viewer access', 6);
            expect(seeded).toHaveLength(6);

            await shopClient.query<ViewerAccessPairQuery>(GET_LISTS_WITHOUT_VIEWER_ACCESS);

            capture.reset();
            const without = await capture.capture(() =>
                shopClient.query<ViewerAccessPairQuery>(GET_LISTS_WITHOUT_VIEWER_ACCESS),
            );
            const statementsWithout = allDatabaseStatements().length;
            const captureWithout = wholeRequestDiagnostic('without viewerAccess');

            capture.reset();
            const withField = await capture.capture(() =>
                shopClient.query<ViewerAccessPairQuery>(GET_LISTS_WITH_VIEWER_ACCESS),
            );
            const statementsWith = allDatabaseStatements().length;

            expect(without.activeCustomerReorderLists.items).toHaveLength(6);
            expect(withField.activeCustomerReorderLists.items).toHaveLength(6);
            expect(withField.activeCustomerReorderLists.totalItems).toBe(
                without.activeCustomerReorderLists.totalItems,
            );
            for (const entry of withField.activeCustomerReorderLists.items) {
                expect(entry.viewerAccess?.access).toBe('OWNED');
                expect(entry.viewerAccess?.grantedCapabilities).toEqual([]);
            }
            for (const entry of without.activeCustomerReorderLists.items) {
                expect(entry.viewerAccess).toBeUndefined();
            }

            if (isStatementCountEngine()) {
                /*
                 * ZERO COST, EXPRESSED AS A ZERO DELTA OVER EVERY STATEMENT THE TWO REQUESTS ISSUED. Selecting the
                 * field added nothing, anywhere — not one statement against the plugin's tables and not one against
                 * `customer`, `channel`, `session` or any other core table.
                 */
                expect(
                    statementsWith,
                    `${captureWithout}\n---\n${wholeRequestDiagnostic('with viewerAccess')}`,
                ).toBe(statementsWithout);
                // And the request that carries the field is still the shape this feature promises: one page
                // statement, no nested read for a selection that names no lines, and no write.
                expect(capture.count(LIST_TABLE), countedDiagnostic()).toBe(1);
                expect(capture.count(LINE_TABLE), countedDiagnostic()).toBe(0);
                expect(capture.writesFor(LIST_TABLE).length, countedDiagnostic()).toBe(0);
                expect(statementsWithout).toBeGreaterThan(0);
            }
        });
    });

    describe('service calls (SERVICE-CALL boundary, calls and never statements)', () => {
        it('calls getReorderLists once and getLinesForLists once for one page of lists', async () => {
            await seedLists('Service call', 3, 2);
            const listsSpy = vi.spyOn(reorderListService, 'getReorderLists');
            const singleSpy = vi.spyOn(reorderListService, 'getReorderList');
            const linesSpy = vi.spyOn(reorderListService, 'getLinesForLists');
            const repairSpy = vi.spyOn(reorderListService, 'reconcileLineCount');

            await shopClient.query<
                GetActiveCustomerReorderListsWithLinePagesQuery,
                GetActiveCustomerReorderListsWithLinePagesQueryVariables
            >(GET_ACTIVE_CUSTOMER_REORDER_LISTS_WITH_LINE_PAGES, {});

            expect(listsSpy).toHaveBeenCalledTimes(1);
            expect(linesSpy).toHaveBeenCalledTimes(1);
            expect(singleSpy).toHaveBeenCalledTimes(0);
            expect(repairSpy).toHaveBeenCalledTimes(0);
            // And the batched call was handed EVERY identifier on the page at once, which is what "once per
            // page" means at this boundary.
            expect((linesSpy.mock.calls[0][1] as unknown[]).length).toBe(3);
        });

        it('calls getReorderList once and getLinesForLists once for one single-list read', async () => {
            const seeded = await seedList('Single service call', [
                { productVariantId: catalogueVariants[0].id, quantity: 2 },
            ]);
            const listsSpy = vi.spyOn(reorderListService, 'getReorderLists');
            const singleSpy = vi.spyOn(reorderListService, 'getReorderList');
            const linesSpy = vi.spyOn(reorderListService, 'getLinesForLists');
            const repairSpy = vi.spyOn(reorderListService, 'reconcileLineCount');

            await shopClient.query<
                GetActiveCustomerReorderListQuery,
                GetActiveCustomerReorderListQueryVariables
            >(GET_ACTIVE_CUSTOMER_REORDER_LIST, { id: seeded.id });

            expect(singleSpy).toHaveBeenCalledTimes(1);
            expect(linesSpy).toHaveBeenCalledTimes(1);
            expect(listsSpy).toHaveBeenCalledTimes(0);
            expect(repairSpy).toHaveBeenCalledTimes(0);
        });
    });

    describe('the lineCount compare-and-set repair (single-list read only)', () => {
        /**
         * Drives the counter stale the way the contract describes: line rows disappear UNDERNEATH the plugin.
         */
        async function seedListWithStaleCounter(): Promise<{ list: SeededList; trueTotal: number }> {
            const list = await seedList('Stale counter', [
                { productVariantId: catalogueVariants[0].id, quantity: 2 },
                { productVariantId: catalogueVariants[1].id, quantity: 3 },
            ]);
            const bareVariantDbId = await createBareVariant(0);
            await insertLineDirectly(list.id, bareVariantDbId, 5);
            await setStoredLineCount(list.id, 3);
            expect(await countStoredLines(list.id)).toBe(3);

            await hardDeleteVariant(bareVariantDbId);

            expect(await countStoredLines(list.id)).toBe(2);
            expect((await readStoredList(list.id))?.lineCount).toBe(3);
            return { list, trueTotal: 2 };
        }

        /**
         * Backdates one list's stored audit column to a KNOWN instant, and returns the value that landed.
         *
         * It exists so that "the repairing read did not move `updatedAt`" is decided by the engine's stored
         * value rather than by its timestamp granularity. Every write before this point moved the column to
         * *now*, so a defect that reassigned it to `CURRENT_TIMESTAMP` a few milliseconds later could store the
         * same value it found on an engine whose column truncates below the second — and the assertion would
         * pass on a defect. Backdating puts years between the two, so the two outcomes cannot be confused.
         *
         * The instant carries no sub-second component, because the four engines do not agree on the precision
         * of a datetime column and a truncated fraction would make the round trip inexact for a reason that has
         * nothing to do with what is being measured. The write goes through the entity so the driver renders
         * the value in its own dialect, and the value that came back is READ AND RETURNED rather than assumed:
         * the caller compares against what the row actually holds.
         */
        async function backdateStoredUpdatedAt(listId: ReorderApiId): Promise<number> {
            const backdatedTo = new Date('2020-01-02T03:04:05.000Z');
            await dataSource
                .createQueryBuilder()
                .update(ReorderList)
                .set({ updatedAt: backdatedTo })
                .where('id = :id', { id: decodeId(listId) })
                .execute();
            const stored = await readStoredList(listId);
            const landed = new Date(stored?.updatedAt ?? 0).getTime();
            expect(
                landed,
                'The audit column could not be backdated, so a repair that moved it would be ' +
                    'indistinguishable from one that did not',
            ).toBeLessThan(Date.now() - 60_000);
            return landed;
        }

        /** The list's PUBLISHED `updatedAt`, taken through the collection read, which never repairs. */
        async function publishedUpdatedAtThroughCollection(listId: ReorderApiId): Promise<string> {
            const page = await shopClient.query<GetActiveCustomerReorderListsQuery>(
                GET_ACTIVE_CUSTOMER_REORDER_LISTS,
            );
            const entry = page.activeCustomerReorderLists.items.find(
                item => String(item.id) === String(listId),
            );
            expect(entry, 'The seeded list was absent from its owner\u2019s own page').toBeDefined();
            return String(entry?.updatedAt);
        }

        it('repairs on the first single-list read with exactly one guarded update and issues none on the second', async () => {
            const { list, trueTotal } = await seedListWithStaleCounter();
            const staleValue = 3;

            capture.reset();
            const first = await capture.capture(() =>
                shopClient.query<
                    GetActiveCustomerReorderListQuery,
                    GetActiveCustomerReorderListQueryVariables
                >(GET_ACTIVE_CUSTOMER_REORDER_LIST, { id: list.id }),
            );
            const firstWrites = capture.writesFor(LIST_TABLE);
            const firstCapture = countedDiagnostic();

            expect(first.activeCustomerReorderList?.lineCount).toBe(trueTotal);
            expect(first.activeCustomerReorderList?.lines.totalItems).toBe(trueTotal);
            expect((await readStoredList(list.id))?.lineCount).toBe(trueTotal);

            if (isStatementCountEngine()) {
                // Counted rather than matched on the array: a captured statement carries its raw bound
                // parameters, so handing the array to `toHaveLength` would print them on failure. The redacted
                // capture description is the message, which is where the detail belongs.
                expect(firstWrites.length, firstCapture).toBe(1);
                expect(firstWrites[0].kind, firstCapture).toBe('update');
                // ALL FOUR CONJUNCTS, on the live statement.
                expect(
                    whereRequiresScopedPredicates(firstWrites[0], [
                        { column: 'id', value: decodeId(list.id) },
                        { column: 'lineCount', value: staleValue },
                        { column: 'customerId', value: actingCustomerDbId },
                        { column: 'channelId', value: defaultChannelDbId },
                    ]),
                    firstCapture,
                ).toBe(true);
                expect(capture.writesFor(LINE_TABLE).length, firstCapture).toBe(0);
            }

            capture.reset();
            const second = await capture.capture(() =>
                shopClient.query<
                    GetActiveCustomerReorderListQuery,
                    GetActiveCustomerReorderListQueryVariables
                >(GET_ACTIVE_CUSTOMER_REORDER_LIST, { id: list.id }),
            );

            expect(second.activeCustomerReorderList?.lineCount).toBe(trueTotal);
            if (isStatementCountEngine()) {
                expect(capture.writesFor(LIST_TABLE).length, countedDiagnostic()).toBe(0);
                expect(capture.writesFor(LINE_TABLE).length, countedDiagnostic()).toBe(0);
            }
        });

        it('repairs the counter without moving the published modification time of the row', async () => {
            // A READ MAY CHANGE THE COUNTER AND NOTHING ELSE. `updatedAt` is a published, sortable field of
            // `ReorderList`, so a repair that moved it would reorder a later page sorted on it and would show
            // every consumer using it for change detection or cache validation a modification that never
            // happened — and the specified repair sets `lineCount` alone. The query builder appends
            // `updatedAt = CURRENT_TIMESTAMP` to every update it renders for an entity carrying an update-date
            // column unless that column is itself among the ones being set, so the service names it and assigns
            // it to itself. Both halves of that are asserted here: the user-visible one on all four engines
            // through the published value, and the statement's own text on the engine where statement text is
            // deterministic.
            const { list, trueTotal } = await seedListWithStaleCounter();
            const staleValue = 3;
            const storedUpdatedAtBefore = await backdateStoredUpdatedAt(list.id);
            const publishedUpdatedAtBefore = await publishedUpdatedAtThroughCollection(list.id);

            capture.reset();
            const repairing = await capture.capture(() =>
                shopClient.query<
                    GetActiveCustomerReorderListQuery,
                    GetActiveCustomerReorderListQueryVariables
                >(GET_ACTIVE_CUSTOMER_REORDER_LIST, { id: list.id }),
            );
            const repairWrites = capture.writesFor(LIST_TABLE);
            const repairCapture = countedDiagnostic();

            // The repair happened: the corrected value is in the same response and in the stored row.
            expect(repairing.activeCustomerReorderList?.lineCount).toBe(trueTotal);
            expect((await readStoredList(list.id))?.lineCount).toBe(trueTotal);

            // AND THE AUDIT COLUMN DID NOT MOVE — the stored instant, and the published value read back
            // afterwards through the same document the reproduction used, are both exactly what they were.
            const storedUpdatedAtAfter = new Date((await readStoredList(list.id))?.updatedAt ?? 0).getTime();
            expect(storedUpdatedAtAfter).toBe(storedUpdatedAtBefore);
            expect(await publishedUpdatedAtThroughCollection(list.id)).toBe(publishedUpdatedAtBefore);
            const afterRepair = await shopClient.query<
                GetActiveCustomerReorderListQuery,
                GetActiveCustomerReorderListQueryVariables
            >(GET_ACTIVE_CUSTOMER_REORDER_LIST, { id: list.id });
            expect(String(afterRepair.activeCustomerReorderList?.updatedAt)).toBe(publishedUpdatedAtBefore);
            // The repairing response itself served the same value, so no client sees the field flicker either.
            expect(String(repairing.activeCustomerReorderList?.updatedAt)).toBe(publishedUpdatedAtBefore);

            if (isStatementCountEngine()) {
                expect(repairWrites.length, repairCapture).toBe(1);
                expect(repairWrites[0].kind, repairCapture).toBe('update');
                // THE PIN, IN THE STATEMENT'S OWN TEXT: the audit column assigned the audit column, quoted the
                // way the connected driver quotes an identifier rather than the way one engine does.
                const auditColumn = quotedIdentifier(UPDATE_DATE_COLUMN);
                expect(repairWrites[0].query, repairCapture).toContain(`${auditColumn} = ${auditColumn}`);
                // And no fresh timestamp reached the clause, under any spelling the four engines use for one.
                expect(repairWrites[0].query.toUpperCase(), repairCapture).not.toMatch(
                    /CURRENT_TIMESTAMP|NOW\s*\(|LOCALTIMESTAMP|GETDATE/,
                );
                // The four conjuncts are untouched by the pin: the row, the stale counter it expects to find,
                // and the ownership pair that scopes the write in the database rather than in the caller.
                expect(
                    whereRequiresScopedPredicates(repairWrites[0], [
                        { column: 'id', value: decodeId(list.id) },
                        { column: 'lineCount', value: staleValue },
                        { column: 'customerId', value: actingCustomerDbId },
                        { column: 'channelId', value: defaultChannelDbId },
                    ]),
                    repairCapture,
                ).toBe(true);
            }
        });

        it('never repairs on the collection read, which reports the stored column as it stands', async () => {
            const { list } = await seedListWithStaleCounter();
            await setStoredLineCount(list.id, 9);

            capture.reset();
            const page = await capture.capture(() =>
                shopClient.query<
                    GetActiveCustomerReorderListsWithLinePagesQuery,
                    GetActiveCustomerReorderListsWithLinePagesQueryVariables
                >(GET_ACTIVE_CUSTOMER_REORDER_LISTS_WITH_LINE_PAGES, {}),
            );

            const entry = page.activeCustomerReorderLists.items.find(item => String(item.id) === list.id);
            expect(entry, 'The seeded list was absent from its owner\u2019s own page').toBeDefined();
            expect(entry?.lineCount).toBe(9);
            expect(entry?.lines.totalItems).toBe(2);
            expect((await readStoredList(list.id))?.lineCount).toBe(9);

            if (isStatementCountEngine()) {
                expect(capture.writesFor(LIST_TABLE).length, countedDiagnostic()).toBe(0);
            }

            const single = await shopClient.query<
                GetActiveCustomerReorderListQuery,
                GetActiveCustomerReorderListQueryVariables
            >(GET_ACTIVE_CUSTOMER_REORDER_LIST, { id: list.id });
            expect(single.activeCustomerReorderList?.lineCount).toBe(2);
            expect((await readStoredList(list.id))?.lineCount).toBe(2);
        });
    });

    describe('\u00a77 scenario 1: an empty collection, and an empty list returned rather than omitted', () => {
        it('returns totalItems 0 with an empty items collection for a customer holding no list', async () => {
            const envelope = await rawShopRequest(GET_ACTIVE_CUSTOMER_REORDER_LISTS);

            expect(envelope.errors, JSON.stringify(envelope)).toBeUndefined();
            expect(envelope.data).toEqual({ activeCustomerReorderLists: { totalItems: 0, items: [] } });
        });

        it('returns an empty list with lineCount 0 and an empty lines page rather than omitting it', async () => {
            const seeded = await seedList('An empty list');

            const collection = await shopClient.query<GetActiveCustomerReorderListsQuery>(
                GET_ACTIVE_CUSTOMER_REORDER_LISTS,
            );
            expect(collection.activeCustomerReorderLists.totalItems).toBe(1);
            expect(collection.activeCustomerReorderLists.items[0].lineCount).toBe(0);

            const { activeCustomerReorderList } = await shopClient.query<
                GetActiveCustomerReorderListQuery,
                GetActiveCustomerReorderListQueryVariables
            >(GET_ACTIVE_CUSTOMER_REORDER_LIST, { id: seeded.id });

            expect(activeCustomerReorderList).not.toBeNull();
            expect(activeCustomerReorderList?.lineCount).toBe(0);
            expect(activeCustomerReorderList?.lines.totalItems).toBe(0);
            expect(activeCustomerReorderList?.lines.items).toEqual([]);
            expect((await readStoredList(seeded.id))?.lineCount).toBe(0);
        });
    });

    describe('\u00a77 scenario 2: a variant disabled since the line was added, and a variant soft-deleted', () => {
        it('returns both lines, keeps both stored variant ids, and nulls only the soft-deleted line\u2019s variant', async () => {
            const disabledVariant = catalogueVariants[0];
            const deletedVariant = catalogueVariants[1];
            const seeded = await seedList('Availability changed', [
                { productVariantId: disabledVariant.id, quantity: 2 },
                { productVariantId: deletedVariant.id, quantity: 3 },
            ]);

            await captureVariantAvailability(disabledVariant.id);
            await dataSource
                .createQueryBuilder()
                .update(ProductVariant)
                .set({ enabled: false })
                .where('id = :id', { id: decodeId(disabledVariant.id) })
                .execute();
            await captureVariantAvailability(deletedVariant.id);
            await dataSource
                .createQueryBuilder()
                .update(ProductVariant)
                .set({ deletedAt: new Date() })
                .where('id = :id', { id: decodeId(deletedVariant.id) })
                .execute();

            const { activeCustomerReorderList } = await shopClient.query<
                GetActiveCustomerReorderListQuery,
                GetActiveCustomerReorderListQueryVariables
            >(GET_ACTIVE_CUSTOMER_REORDER_LIST, { id: seeded.id });

            const list = activeCustomerReorderList as NonNullable<typeof activeCustomerReorderList>;
            expect(list.lineCount).toBe(2);
            expect(list.lines.totalItems).toBe(2);
            expect(list.lines.items).toHaveLength(2);

            const disabledLine = list.lines.items.find(
                line => String(line.productVariantId) === String(disabledVariant.id),
            );
            const deletedLine = list.lines.items.find(
                line => String(line.productVariantId) === String(deletedVariant.id),
            );

            expect(disabledLine?.productVariantId).toBeDefined();
            expect(deletedLine?.productVariantId).toBeDefined();
            expect(disabledLine?.quantity).toBe(2);
            expect(deletedLine?.quantity).toBe(3);

            expect(disabledLine?.productVariant).not.toBeNull();
            expect(disabledLine?.productVariant?.name).toBe(disabledVariant.name);
            expect(deletedLine?.productVariant).toBeNull();
            expect(String(deletedLine?.productVariantId)).toBe(String(deletedVariant.id));
        });
    });

    describe('\u00a77 scenario 3: a price changed since the line was added', () => {
        it('makes no observable difference to either read', async () => {
            const variant = catalogueVariants[0];
            const seeded = await seedList('Price changed', [{ productVariantId: variant.id, quantity: 4 }]);

            const collectionBefore = await shopClient.query<GetActiveCustomerReorderListsQuery>(
                GET_ACTIVE_CUSTOMER_REORDER_LISTS,
            );
            const singleBefore = await shopClient.query<
                GetActiveCustomerReorderListQuery,
                GetActiveCustomerReorderListQueryVariables
            >(GET_ACTIVE_CUSTOMER_REORDER_LIST, { id: seeded.id });

            // A CORE ROW THIS TEST DID NOT CREATE, with two ordering requirements that are not visible in the
            // statements themselves. First, the price is read NOW rather than taken from the fixture:
            // `catalogueVariants` was captured in `beforeAll`, and restoring to a value read then would write
            // back a figure that need not still be current — a contamination dressed as a cleanup. Second, the
            // exact restoration is queued BEFORE the write is issued rather than after it succeeds, because a
            // failure between the two would leave the catalogue altered with no undo action registered.
            const [{ price: originalPrice }] = (
                await adminClient.query<GetVariantsQuery>(GET_VARIANTS_FOR_REORDER_READ)
            ).productVariants.items.filter(candidate => candidate.id === variant.id);
            expect(originalPrice, 'the variant whose price this scenario moves was not found').toBeTypeOf(
                'number',
            );
            const changedPrice = originalPrice + 4321;
            const pricedVariantDbId = decodeId(variant.id);
            await captureCoreRows('product_variant', 'captured_row.id = :variantId', {
                variantId: pricedVariantDbId,
            });
            await captureCoreRows('product_variant_price', 'captured_row.variantId = :variantId', {
                variantId: pricedVariantDbId,
            });
            const { updateProductVariants } = await adminClient.query<UpdateVariantsMutation>(
                UPDATE_VARIANTS_FOR_REORDER_READ,
                { input: [{ id: variant.id, price: changedPrice }] },
            );
            expect(updateProductVariants[0].price).toBe(changedPrice);
            const [{ price: priceNow }] = (
                await adminClient.query<GetVariantsQuery>(GET_VARIANTS_FOR_REORDER_READ)
            ).productVariants.items.filter(candidate => candidate.id === variant.id);
            expect(priceNow, 'the price read back is not the changed price').toBe(changedPrice);
            expect(priceNow).not.toBe(originalPrice);

            const collectionAfter = await shopClient.query<GetActiveCustomerReorderListsQuery>(
                GET_ACTIVE_CUSTOMER_REORDER_LISTS,
            );
            const singleAfter = await shopClient.query<
                GetActiveCustomerReorderListQuery,
                GetActiveCustomerReorderListQueryVariables
            >(GET_ACTIVE_CUSTOMER_REORDER_LIST, { id: seeded.id });

            expect(collectionAfter.activeCustomerReorderLists).toEqual(
                collectionBefore.activeCustomerReorderLists,
            );
            expect(singleAfter.activeCustomerReorderList).toEqual(singleBefore.activeCustomerReorderList);
            expect(String(singleAfter.activeCustomerReorderList?.id)).toBe(seeded.id);
            expect(singleAfter.activeCustomerReorderList?.name).toBe('Price changed');
            expect(singleAfter.activeCustomerReorderList?.lines.items[0].quantity).toBe(4);
        });
    });

    describe('\u00a77 scenario 4: a read observing a write another session made afterwards', () => {
        it('leaves the recorded payload unchanged and shows the removal only on the next read', async () => {
            const seeded = await seedList('Stale read', [
                { productVariantId: catalogueVariants[0].id, quantity: 2 },
                { productVariantId: catalogueVariants[1].id, quantity: 3 },
            ]);
            const removedLineId = seeded.lineIds[0];
            const survivingLineId = seeded.lineIds[1];

            const recorded = await shopClient.query<
                GetActiveCustomerReorderListQuery,
                GetActiveCustomerReorderListQueryVariables
            >(GET_ACTIVE_CUSTOMER_REORDER_LIST, { id: seeded.id });
            const recordedSnapshot = JSON.parse(
                JSON.stringify(recorded),
            ) as GetActiveCustomerReorderListQuery;
            expect(recorded.activeCustomerReorderList?.lineCount).toBe(2);

            await secondShopClient.asUserWithCredentials(
                actingCustomer.emailAddress,
                SEEDED_CUSTOMER_PASSWORD,
            );
            secondShopClient.setChannelToken(E2E_DEFAULT_CHANNEL_TOKEN);
            const { removeReorderListLine } = await secondShopClient.query<
                RemoveReorderListLineMutation,
                RemoveReorderListLineMutationVariables
            >(REMOVE_REORDER_LIST_LINE, {
                input: { reorderListId: seeded.id, lineId: removedLineId },
            });
            expect(removeReorderListLine.__typename).toBe('ReorderList');

            const reread = await shopClient.query<
                GetActiveCustomerReorderListQuery,
                GetActiveCustomerReorderListQueryVariables
            >(GET_ACTIVE_CUSTOMER_REORDER_LIST, { id: seeded.id });

            expect(recorded).toEqual(recordedSnapshot);
            expect(recorded.activeCustomerReorderList?.lines.items).toHaveLength(2);

            expect(reread.activeCustomerReorderList?.lineCount).toBe(1);
            expect(reread.activeCustomerReorderList?.lines.totalItems).toBe(1);
            expect(reread.activeCustomerReorderList?.lines.items).toHaveLength(1);
            expect(String(reread.activeCustomerReorderList?.lines.items[0].id)).toBe(survivingLineId);
            expect(reread.activeCustomerReorderList?.lines.items.map(line => String(line.id))).not.toContain(
                removedLineId,
            );

            expect(recorded.activeCustomerReorderList).not.toBeNull();
            expect(reread.activeCustomerReorderList).not.toBeNull();
        });
    });

    describe('\u00a77 scenario 5: the channel and the language a request names', () => {
        it('answers an empty page and an exact null under the second channel\u2019s token', async () => {
            const seeded = await seedList('Channel scoped', [
                { productVariantId: catalogueVariants[0].id, quantity: 2 },
            ]);

            shopClient.setChannelToken(SECOND_CHANNEL_TOKEN);
            const collection = await rawShopRequest(GET_ACTIVE_CUSTOMER_REORDER_LISTS);
            const single = await rawShopRequest(GET_ACTIVE_CUSTOMER_REORDER_LIST, { id: seeded.id });
            shopClient.setChannelToken(E2E_DEFAULT_CHANNEL_TOKEN);

            expect(collection.errors, JSON.stringify(collection)).toBeUndefined();
            expect(collection.data).toEqual({ activeCustomerReorderLists: { totalItems: 0, items: [] } });
            expect(single.errors, JSON.stringify(single)).toBeUndefined();
            expect(single.data).toEqual({ activeCustomerReorderList: null });

            const onOwnChannel = await shopClient.query<
                GetActiveCustomerReorderListQuery,
                GetActiveCustomerReorderListQueryVariables
            >(GET_ACTIVE_CUSTOMER_REORDER_LIST, { id: seeded.id });
            expect(String(onOwnChannel.activeCustomerReorderList?.id)).toBe(seeded.id);
        });

        it('returns the same list under two languages, the variant name differing and the list name not', async () => {
            const variant = catalogueVariants[0];
            const germanVariantName = 'Laptop dreizehn Zoll mit acht Gigabyte';
            const listName = 'Sprachunabh\u00e4ngiger Name';
            const seeded = await seedList(listName, [{ productVariantId: variant.id, quantity: 6 }]);

            const priorGerman = await captureVariantTranslation(variant.id, LanguageCode.de);
            expect(
                priorGerman.row,
                'the seeded catalogue is expected to ship English alone; if that changes, the restoration ' +
                    'below puts the prior row back rather than deleting it, and this expectation is what ' +
                    'records which of the two this run took',
            ).toBeUndefined();

            await adminClient.query<UpdateVariantsMutation>(UPDATE_VARIANTS_FOR_REORDER_READ, {
                input: [
                    {
                        id: variant.id,
                        translations: [{ languageCode: LanguageCode.de, name: germanVariantName }],
                    },
                ],
            });

            const writtenGerman = await dataSource
                .createQueryBuilder()
                .select('translation.name', 'name')
                .from(VARIANT_TRANSLATION_TABLE, 'translation')
                .where('translation.baseId = :variantId', { variantId: Number(decodeId(variant.id)) })
                .andWhere('translation.languageCode = :languageCode', { languageCode: LanguageCode.de })
                .getRawOne<{ name: string }>();
            expect(writtenGerman?.name, 'the German variant name was not written').toBe(germanVariantName);

            const inEnglish = await shopClient.query<
                GetActiveCustomerReorderListQuery,
                GetActiveCustomerReorderListQueryVariables
            >(GET_ACTIVE_CUSTOMER_REORDER_LIST, { id: seeded.id }, { languageCode: LanguageCode.en });
            const inGerman = await shopClient.query<
                GetActiveCustomerReorderListQuery,
                GetActiveCustomerReorderListQueryVariables
            >(GET_ACTIVE_CUSTOMER_REORDER_LIST, { id: seeded.id }, { languageCode: LanguageCode.de });

            expect(String(inGerman.activeCustomerReorderList?.id)).toBe(seeded.id);
            expect(inGerman.activeCustomerReorderList?.lineCount).toBe(
                inEnglish.activeCustomerReorderList?.lineCount,
            );
            expect(inGerman.activeCustomerReorderList?.lineCount).toBe(1);
            expect(String(inGerman.activeCustomerReorderList?.lines.items[0].id)).toBe(
                String(inEnglish.activeCustomerReorderList?.lines.items[0].id),
            );
            expect(inGerman.activeCustomerReorderList?.lines.items[0].quantity).toBe(6);

            expect(inEnglish.activeCustomerReorderList?.lines.items[0].productVariant?.name).toBe(
                variant.name,
            );
            expect(inGerman.activeCustomerReorderList?.lines.items[0].productVariant?.name).toBe(
                germanVariantName,
            );
            expect(inGerman.activeCustomerReorderList?.lines.items[0].productVariant?.name).not.toBe(
                inEnglish.activeCustomerReorderList?.lines.items[0].productVariant?.name,
            );

            expect(inEnglish.activeCustomerReorderList?.name).toBe(listName);
            expect(inGerman.activeCustomerReorderList?.name).toBe(listName);
        });
    });

    // The empty-generation assertion this suite owns
    //
    // STORY-001-01-04 owns NO MIGRATION: every table, column, index and constraint its two reads rely on ships
    // in the single additive migration STORY-001-01-01 generates. A generated file appearing here is the signal
    // that this story has altered a mapping it does not own.

    describe('this story owns no migration', () => {
        it('emits no migration file against a schema the checked-in migration created', async () => {
            const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'reorder-read-migration-'));
            temporaryDirectories.push(outputDir);
            const snapshotDir = await fs.mkdtemp(path.join(os.tmpdir(), 'reorder-read-schema-'));
            temporaryDirectories.push(snapshotDir);

            // WHAT THE GENERATOR IS POINTED AT IS THE MIGRATION'S OWN OUTPUT, which is the whole point of this
            // assertion rather than a refinement of it.
            const schemaIsTheMigrations = await rebuildPluginSchemaFromCheckedInMigration();

            // WHAT THE ASSERTION RESTS ON, which differs by engine and is recorded rather than glossed. On the
            // generation engine the diff is taken against a schema the shipped artefact built, so an empty
            // result means the artefact and the entities agree.
            expect(
                schemaIsTheMigrations,
                'the rebuild must run on exactly the engine the shipped artefact was generated against',
            ).toBe(committedMigrationApplies(String(dataSource.options.type)));

            // THE GENERATOR'S OWN DECISION INPUT, read from the running server's connection, because that is
            // where the diagnostic lives: `generateMigration` writes a file if and only if this log's
            // `upQueries` is non-empty, so naming the offending statements turns a bare `undefined` expectation
            // into a failure a reader can act on.
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

            // And the platform entry point itself, against that same migration-created schema. It returns
            // `undefined` and writes NO FILE; the platform logs "No changes in database schema were found -
            // cannot generate a migration." on this path (`packages/core/src/migrate.ts`).
            const generated = await generateMigration(
                await generatorConfigAgainstMigratedSchema(snapshotDir),
                {
                    name: 'storyOneOhOneOhFourShouldEmitNothing',
                    outputDir,
                },
            );
            expect(
                generated,
                `generateMigration emitted a migration against the migration-created schema: ${
                    generated ? await fs.readFile(generated, 'utf-8') : ''
                }`,
            ).toBeUndefined();
            expect(await fs.readdir(outputDir)).toEqual([]);

            expect(path.isAbsolute(outputDir)).toBe(true);
            expect(outputDir.startsWith(path.join(__dirname, '..'))).toBe(false);

            const stillWorking = await seedList('After the generation pass', [
                { productVariantId: catalogueVariants[0].id, quantity: 2 },
            ]);
            const afterwards = await shopClient.query<
                GetActiveCustomerReorderListQuery,
                GetActiveCustomerReorderListQueryVariables
            >(GET_ACTIVE_CUSTOMER_REORDER_LIST, { id: stillWorking.id });
            expect(afterwards.activeCustomerReorderList?.lineCount).toBe(1);
        });
    });
});

/*
 * The correlated-ownership verifier, tested as the load-bearing instrument it is.
 */
describe('the query-capture instrument this suite measures with', () => {
    /** The decoded identifiers a fixture would hold, standing in for rows it created. */
    const CUSTOMER_ID = 5;
    const CHANNEL_ID = 1;
    const LIST_ID = 100;
    const LINE_ID = 200;

    /**
     * The ownership claim a line write must satisfy, built fresh per assertion so that no test can observe a
     * requirement another one mutated.
     */
    function ownedLineScope(): CorrelatedOwnershipRequirement {
        return {
            table: 'reorder_list',
            correlation: { column: 'id', outerColumn: 'reorderListId' },
            predicates: [
                { column: 'customerId', value: CUSTOMER_ID },
                { column: 'channelId', value: CHANNEL_ID },
            ],
        };
    }

    /**
     * Captures one statement the way a real run does: through the logger's own TypeORM hook, with a query
     * runner whose connection reports the engine.
     */
    function captureOne(query: string, parameters: unknown[], engine: string): CapturedStatement {
        const logger = new QueryCaptureLogger();
        logger.enable();
        const runner = {
            connection: { options: { type: engine } },
            isTransactionActive: true,
        } as unknown as QueryRunner;
        logger.logQuery(query, parameters, runner);
        const [statement] = logger.statements;
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
        `AND "owned_list_scope"."customerId" = ${CUSTOMER_ID} ` +
        `AND "owned_list_scope"."channelId" = ${CHANNEL_ID})`;

    /** A PostgreSQL adjust whose `EXISTS` clause is supplied, so one shape can be varied at a time. */
    function postgresAdjust(existsClause: string): CapturedStatement {
        return captureOne(
            'UPDATE "reorder_list_line" SET "quantity" = $1 ' +
                `WHERE "id" = $2 AND "reorderListId" = $3 AND ${existsClause}`,
            [7, LINE_ID, LIST_ID, CUSTOMER_ID, CHANNEL_ID],
            'postgres',
        );
    }

    describe('whereRequiresCorrelatedOwnership', () => {
        describe('certifies the ownership sub-query the service writes', () => {
            it('certifies the PostgreSQL adjust, resolving both bound values through their placeholders', () => {
                const statement = postgresAdjust(POSTGRES_EXISTS);

                expect(whereRequiresCorrelatedOwnership(statement, ownedLineScope())).toBe(true);
            });

            it('certifies the MySQL accumulate, whose placeholders are positional', () => {
                // The `SET` clause binds ahead of the predicate, so the customer and channel are the fourth and
                // fifth parameters of the statement rather than the first two of the sub-query. Resolving them
                // requires the offset arithmetic the parser performs; a verifier that numbered the sub-query's
                // own placeholders from zero would read the quantity and the line id as the tenant.
                const statement = captureOne(
                    'UPDATE `reorder_list_line` SET `quantity` = `quantity` + ? ' +
                        `WHERE \`id\` = ? AND \`reorderListId\` = ? AND ${MYSQL_EXISTS}`,
                    [3, LINE_ID, LIST_ID, CUSTOMER_ID, CHANNEL_ID],
                    'mysql',
                );

                expect(whereRequiresCorrelatedOwnership(statement, ownedLineScope())).toBe(true);
            });

            it('certifies the MariaDB remove, which is a delete rather than an update', () => {
                const statement = captureOne(
                    `DELETE FROM \`reorder_list_line\` WHERE \`id\` = ? AND \`reorderListId\` = ? AND ${MYSQL_EXISTS}`,
                    [LINE_ID, LIST_ID, CUSTOMER_ID, CHANNEL_ID],
                    'mariadb',
                );

                expect(whereRequiresCorrelatedOwnership(statement, ownedLineScope())).toBe(true);
            });

            it('certifies the sql.js adjust, whose values are inline literals rather than parameters', () => {
                const statement = captureOne(
                    `UPDATE "reorder_list_line" SET "quantity" = 7 WHERE "id" = ${LINE_ID} ` +
                        `AND "reorderListId" = ${LIST_ID} AND ${SQLJS_EXISTS}`,
                    [],
                    'sqljs',
                );

                expect(whereRequiresCorrelatedOwnership(statement, ownedLineScope())).toBe(true);
            });

            it('certifies the same sub-query under a configured schema, which qualifies the relation', () => {
                // The form a deployment with `dbConnectionOptions.schema` actually receives. The service builds
                // the sub-query's relation from `metadata.tablePath` rather than from `tableName`, so under a
                // configured schema it arrives qualified — a tenant-isolation requirement rather than a
                // spelling choice, because the driver never issues `SET search_path` from that option
                // (`node_modules/typeorm/driver/postgres/PostgresDriver.js:L266-L281`) and a bare relation
                // would resolve through the session's own path into another schema. This instrument decides
                // every line-write ownership assertion in this package, so it has to certify the qualified
                // form.
                const statement = postgresAdjust(
                    'EXISTS (SELECT 1 FROM "tenant_schema"."reorder_list" "owned_list_scope" ' +
                        'WHERE "owned_list_scope"."id" = "reorderListId" ' +
                        'AND "owned_list_scope"."customerId" = $4 AND "owned_list_scope"."channelId" = $5)',
                );

                expect(whereRequiresCorrelatedOwnership(statement, ownedLineScope())).toBe(true);
            });

            it('still refuses a qualified relation whose final segment is the wrong table', () => {
                const statement = postgresAdjust(
                    'EXISTS (SELECT 1 FROM "reorder_list"."reorder_list_line" "owned_list_scope" ' +
                        'WHERE "owned_list_scope"."id" = "reorderListId" ' +
                        'AND "owned_list_scope"."customerId" = $4 AND "owned_list_scope"."channelId" = $5)',
                );

                expect(whereRequiresCorrelatedOwnership(statement, ownedLineScope())).toBe(false);
            });

            it('accepts a caller that names the alias and the outer relation exactly', () => {
                const statement = postgresAdjust(POSTGRES_EXISTS);
                const requirement = ownedLineScope();
                requirement.correlation.outerRelation = undefined;
                requirement.predicates[0].relation = 'owned_list_scope';
                requirement.predicates[1].relation = 'owned_list_scope';

                expect(whereRequiresCorrelatedOwnership(statement, requirement)).toBe(true);
            });

            it('refuses a caller that names an alias the sub-query did not use', () => {
                const statement = postgresAdjust(POSTGRES_EXISTS);
                const requirement = ownedLineScope();
                requirement.predicates[0].relation = 'reorder_list_line';

                expect(whereRequiresCorrelatedOwnership(statement, requirement)).toBe(false);
            });

            it('reads a raw statement string, resolving inline literals only', () => {
                const raw =
                    `UPDATE "reorder_list_line" SET "quantity" = 7 WHERE "id" = ${LINE_ID} ` +
                    `AND "reorderListId" = ${LIST_ID} AND ${SQLJS_EXISTS}`;

                expect(whereRequiresCorrelatedOwnership(raw, ownedLineScope(), 'sqljs')).toBe(true);
            });
        });

        describe('refuses a requirement whose scope values it cannot decide', () => {
            it('refuses a scope predicate with no expected value, rather than checking the column alone', () => {
                const requirement = {
                    table: 'reorder_list',
                    correlation: { column: 'id', outerColumn: 'reorderListId' },
                    predicates: [{ column: 'customerId' }, { column: 'channelId', value: CHANNEL_ID }],
                } as unknown as CorrelatedOwnershipRequirement;

                expect(whereRequiresCorrelatedOwnership(postgresAdjust(POSTGRES_EXISTS), requirement)).toBe(
                    false,
                );
            });

            it('refuses a scope predicate whose expected value is explicitly undefined', () => {
                const requirement = {
                    table: 'reorder_list',
                    correlation: { column: 'id', outerColumn: 'reorderListId' },
                    predicates: [
                        { column: 'customerId', value: undefined },
                        { column: 'channelId', value: CHANNEL_ID },
                    ],
                } as unknown as CorrelatedOwnershipRequirement;

                expect(whereRequiresCorrelatedOwnership(postgresAdjust(POSTGRES_EXISTS), requirement)).toBe(
                    false,
                );
            });

            it('refuses the swapped tenant binding, which has the right shape and the wrong owner', () => {
                const requirement = ownedLineScope();
                requirement.predicates[0].value = CHANNEL_ID;
                requirement.predicates[1].value = CUSTOMER_ID;

                expect(whereRequiresCorrelatedOwnership(postgresAdjust(POSTGRES_EXISTS), requirement)).toBe(
                    false,
                );
            });

            it('refuses a value no parameter carries, so a stale fixture identifier fails loudly', () => {
                const requirement = ownedLineScope();
                requirement.predicates[0].value = CUSTOMER_ID + 1;

                expect(whereRequiresCorrelatedOwnership(postgresAdjust(POSTGRES_EXISTS), requirement)).toBe(
                    false,
                );
            });

            it('refuses an empty predicates list, because a correlation alone proves existence not ownership', () => {
                const requirement = ownedLineScope();
                requirement.predicates = [];

                expect(whereRequiresCorrelatedOwnership(postgresAdjust(POSTGRES_EXISTS), requirement)).toBe(
                    false,
                );
            });

            it('refuses a malformed requirement instead of throwing', () => {
                const statement = postgresAdjust(POSTGRES_EXISTS);

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
                        predicates: [{ column: 'customerId', value: CUSTOMER_ID }],
                    }),
                ).toBe(false);
            });
        });

        describe('refuses a sub-query whose row count does not follow its predicate', () => {
            it('refuses an ungrouped aggregate projection, which is satisfied for every row', () => {
                const statement = postgresAdjust(POSTGRES_EXISTS.replace('SELECT 1', 'SELECT COUNT(*)'));

                expect(whereRequiresCorrelatedOwnership(statement, ownedLineScope())).toBe(false);
            });

            it('refuses an empty grouping set, which synthesises a row from no rows', () => {
                const statement = postgresAdjust(
                    POSTGRES_EXISTS.replace(/\)$/, ' GROUP BY GROUPING SETS (()))'),
                );

                expect(whereRequiresCorrelatedOwnership(statement, ownedLineScope())).toBe(false);
            });

            it('refuses a HAVING clause, whose group is not a row of the relation', () => {
                const statement = postgresAdjust(POSTGRES_EXISTS.replace(/\)$/, ' HAVING COUNT(*) >= 0)'));

                expect(whereRequiresCorrelatedOwnership(statement, ownedLineScope())).toBe(false);
            });

            it('refuses a row-limiting tail, which decouples the result in the other direction', () => {
                const statement = postgresAdjust(POSTGRES_EXISTS.replace(/\)$/, ' LIMIT 0)'));

                expect(whereRequiresCorrelatedOwnership(statement, ownedLineScope())).toBe(false);
            });

            it('refuses a projection this parser has not modelled, rather than reading through it', () => {
                for (const projection of ['SELECT *', 'SELECT DISTINCT 1', 'SELECT 1, 1', 'SELECT ol.id']) {
                    const statement = postgresAdjust(POSTGRES_EXISTS.replace('SELECT 1', projection));

                    expect(whereRequiresCorrelatedOwnership(statement, ownedLineScope())).toBe(false);
                }
            });

            it('refuses a set operator inside the sub-query, which answers for rows it never read', () => {
                const statement = postgresAdjust(POSTGRES_EXISTS.replace(/\)$/, ' UNION SELECT 1)'));

                expect(whereRequiresCorrelatedOwnership(statement, ownedLineScope())).toBe(false);
            });
        });

        describe('refuses a sub-query that scopes something other than the addressed row', () => {
            it('refuses a sub-query over the wrong table', () => {
                const statement = postgresAdjust(
                    POSTGRES_EXISTS.replace(
                        '"reorder_list" "owned_list_scope"',
                        '"customer" "owned_list_scope"',
                    ),
                );

                expect(whereRequiresCorrelatedOwnership(statement, ownedLineScope())).toBe(false);
            });

            it('refuses a second relation, which lets the correlation and the scope address different rows', () => {
                const statement = postgresAdjust(
                    POSTGRES_EXISTS.replace(
                        '"reorder_list" "owned_list_scope"',
                        '"reorder_list" "owned_list_scope", "reorder_list" "other"',
                    ),
                );

                expect(whereRequiresCorrelatedOwnership(statement, ownedLineScope())).toBe(false);
            });

            it('refuses a sub-query with no correlation, which any owned list satisfies', () => {
                const statement = postgresAdjust(
                    'EXISTS (SELECT 1 FROM "reorder_list" "owned_list_scope" ' +
                        'WHERE "owned_list_scope"."customerId" = $4 AND "owned_list_scope"."channelId" = $5)',
                );

                expect(whereRequiresCorrelatedOwnership(statement, ownedLineScope())).toBe(false);
            });

            it('refuses a correlation compared to a bound parameter rather than to the outer column', () => {
                const statement = postgresAdjust(
                    POSTGRES_EXISTS.replace(
                        '"owned_list_scope"."id" = "reorderListId"',
                        '"owned_list_scope"."id" = $3',
                    ),
                );

                expect(whereRequiresCorrelatedOwnership(statement, ownedLineScope())).toBe(false);
            });

            it('refuses a correlation qualified by the sub-query own alias, which compares a row to itself', () => {
                const statement = postgresAdjust(
                    POSTGRES_EXISTS.replace(
                        '"owned_list_scope"."id" = "reorderListId"',
                        '"owned_list_scope"."id" = "owned_list_scope"."reorderListId"',
                    ),
                );

                expect(whereRequiresCorrelatedOwnership(statement, ownedLineScope())).toBe(false);
            });

            it('refuses a scope comparison that is only a disjunct of the sub-query predicate', () => {
                const statement = postgresAdjust(
                    POSTGRES_EXISTS.replace(
                        'AND "owned_list_scope"."channelId" = $5',
                        'AND ("owned_list_scope"."channelId" = $5 OR "owned_list_scope"."id" = $3)',
                    ),
                );

                expect(whereRequiresCorrelatedOwnership(statement, ownedLineScope())).toBe(false);
            });
        });

        describe('refuses an EXISTS that the outer predicate does not require', () => {
            it('refuses an EXISTS under a disjunction', () => {
                const statement = captureOne(
                    `UPDATE "reorder_list_line" SET "quantity" = $1 WHERE "id" = $2 OR ${POSTGRES_EXISTS}`,
                    [7, LINE_ID, LIST_ID, CUSTOMER_ID, CHANNEL_ID],
                    'postgres',
                );

                expect(whereRequiresCorrelatedOwnership(statement, ownedLineScope())).toBe(false);
            });

            it('refuses a negated EXISTS, which requires the row NOT to be owned', () => {
                const statement = postgresAdjust(`NOT ${POSTGRES_EXISTS}`);

                expect(whereRequiresCorrelatedOwnership(statement, ownedLineScope())).toBe(false);
            });

            it('refuses an EXISTS that is only part of its leaf', () => {
                const statement = postgresAdjust(`${POSTGRES_EXISTS} IS NOT NULL`);

                expect(whereRequiresCorrelatedOwnership(statement, ownedLineScope())).toBe(false);
            });

            it('refuses a perfect sub-query standing beside an always-true disjunct', () => {
                const statement = captureOne(
                    'UPDATE "reorder_list_line" SET "quantity" = $1 ' +
                        `WHERE "id" = $2 AND (1 = 1 OR ${POSTGRES_EXISTS})`,
                    [7, LINE_ID, LIST_ID, CUSTOMER_ID, CHANNEL_ID],
                    'postgres',
                );

                expect(whereRequiresCorrelatedOwnership(statement, ownedLineScope())).toBe(false);
            });

            it('refuses a statement carrying no EXISTS at all', () => {
                const statement = captureOne(
                    'UPDATE "reorder_list_line" SET "quantity" = $1 WHERE "id" = $2 AND "reorderListId" = $3',
                    [7, LINE_ID, LIST_ID],
                    'postgres',
                );

                expect(whereRequiresCorrelatedOwnership(statement, ownedLineScope())).toBe(false);
            });
        });

        describe('complements the other two predicate helpers rather than duplicating them', () => {
            it('is the only one of the three that can read the sub-query', () => {
                const statement = postgresAdjust(POSTGRES_EXISTS);

                expect(
                    whereRequiresScopedPredicates(statement, [
                        { column: 'customerId', value: CUSTOMER_ID },
                        { column: 'channelId', value: CHANNEL_ID },
                    ]),
                ).toBe(false);
                expect(whereMentionsColumns(statement, ['customerId'])).toBe(false);

                expect(whereMentionsColumns(statement, ['id', 'reorderListId'])).toBe(true);
                expect(whereRequiresCorrelatedOwnership(statement, ownedLineScope())).toBe(true);
            });
        });
    });

    describe('the diagnostic dump, which must not publish what it captured', () => {
        /**
         * A value shaped like the one that makes this a security property rather than a preference: the
         * platform's own session token, which every authenticated request looks a session up by.
         */
        const TOKEN = ['s3cr3t', 'session', 'token', '0f7a19'].join('-');

        /** A logger holding one statement that carries the token both ways a target engine delivers it. */
        function captureTokenBearingStatement(): QueryCaptureLogger {
            const logger = new QueryCaptureLogger();
            logger.enable();
            const runner = {
                connection: { options: { type: 'postgres' } },
                isTransactionActive: true,
            } as unknown as QueryRunner;
            // BOUND, as the server engines receive it...
            logger.logQuery('SELECT "id" FROM "session" WHERE "token" = $1', [TOKEN], runner);
            // ...and INLINE, as the SQLite family receives it, which is this package's default engine.
            logger.logQuery(`SELECT "id" FROM "session" WHERE "token" = '${TOKEN}'`, [], runner);
            // A COUNT: this logger deliberately holds a statement whose parameter IS the token under test, so
            // the array is the one thing in this file that must never reach a matcher.
            expect(logger.statements.length).toBe(2);
            return logger;
        }

        it('describes a bound value and an inline literal instead of rendering either', () => {
            // Why this is a security property and not a formatting preference. The instrument is attached to
            // the whole connection, so it captures the platform's statements as well as the plugin's —
            // including the session look-up an authenticated request performs, whose value is the caller's
            // credential. Dozens of assertion sites in this package pass `capture.format()` as their failure
            // message, and a failure message goes into the run's log: on continuous integration that log is
            // readable by everyone who can see the build. A dump that renders values therefore turns any flaky
            // count assertion into a credential disclosure.
            const dump = captureTokenBearingStatement().format();

            expect(dump, 'the dump must not contain the value it captured').not.toContain(TOKEN);
            expect(dump).toContain(`string(${TOKEN.length})`);
            expect(dump).toContain(`'<redacted:${TOKEN.length}>'`);
            expect(dump).toContain('session');
            expect(dump).toContain('SELECT');
        });

        it('renders values verbatim only when explicitly asked, which no assertion may commit', () => {
            // The opt-in exists for a local investigation, and it is asserted so that "redacted by default"
            // is a statement about the DEFAULT rather than about a lost capability: the raw values are still
            // reachable, both here and — for every assertion — through `statement.parameters`.
            const logger = captureTokenBearingStatement();

            const revealed = logger.format(undefined, { revealValues: true });
            expect(revealed).toContain(TOKEN);
            expect(revealed).not.toContain('<redacted:');

            expect(logger.statements[0].parameters).toEqual([TOKEN]);
        });

        it('fails closed on a literal it cannot see the end of', () => {
            const logger = new QueryCaptureLogger();
            logger.enable();
            const runner = {
                connection: { options: { type: 'postgres' } },
                isTransactionActive: true,
            } as unknown as QueryRunner;
            logger.logQuery(`SELECT "id" FROM "session" WHERE "token" = '${TOKEN}`, [], runner);

            const dump = logger.format();
            expect(dump).not.toContain(TOKEN);
            expect(dump).toContain('<redacted:');
        });

        it('redacts the value a driver quotes into its own failure message', () => {
            // The other way a captured value reaches the dump. A constraint violation on the MySQL family
            // quotes the offending value into the error text, and the create suite deliberately provokes one,
            // so an unredacted error line would publish what the parameter list no longer does. The constraint
            // NAME survives, which is what the suites that assert on a violation actually read.
            const logger = new QueryCaptureLogger();
            logger.enable();
            const runner = {
                connection: { options: { type: 'mysql' } },
                isTransactionActive: true,
            } as unknown as QueryRunner;
            const statement = 'INSERT INTO `reorder_list` (`nameKey`) VALUES (?)';
            logger.logQuery(statement, [TOKEN], runner);
            logger.logQueryError(
                `Duplicate entry '${TOKEN}' for key 'UQ_reorder_list_customer_channel_name_key'`,
                statement,
                [TOKEN],
                runner,
            );

            const dump = logger.format();
            expect(dump).not.toContain(TOKEN);
            expect(dump).toContain('UQ_reorder_list_customer_channel_name_key');
            expect(logger.format(undefined, { revealValues: true })).toContain(`Duplicate entry '${TOKEN}'`);
        });

        it('consumes an escaped quote inside a literal rather than ending the literal early', () => {
            // Both conventions the target engines use, so a value containing a quote is still consumed whole: a
            // scanner that ended the literal at the escape would render the rest of the value as SQL.
            const logger = new QueryCaptureLogger();
            logger.enable();
            const runner = {
                connection: { options: { type: 'mysql' } },
                isTransactionActive: true,
            } as unknown as QueryRunner;
            logger.logQuery(`SELECT 1 FROM t WHERE a = 'ab''${TOKEN}' AND b = 2`, [], runner);
            logger.logQuery(`SELECT 1 FROM t WHERE a = 'ab\\'${TOKEN}' AND b = 3`, [], runner);

            const dump = logger.format();
            expect(dump).not.toContain(TOKEN);
            // The statement continues to be readable on both sides of the redaction, which is what keeps the
            // dump useful: a scanner that swallowed the rest of the statement would hide the shape too.
            expect(dump).toContain('AND b = 2');
            expect(dump).toContain('AND b = 3');
        });
    });
});
