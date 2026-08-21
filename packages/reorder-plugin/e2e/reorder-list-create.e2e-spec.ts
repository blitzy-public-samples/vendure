/*
 * STORY-001-01-01 — "Create a named reorder list".
 */
import {
    ConfigService,
    Customer,
    mergeConfig,
    Permission,
    RequestContext,
    RequestContextService,
    SessionService,
    TransactionalConnection,
} from '@vendure/core';
import {
    ClientError,
    createTestEnvironment,
    E2E_DEFAULT_CHANNEL_TOKEN,
    SimpleGraphQLClient,
} from '@vendure/testing';
import fs from 'fs';
import gql from 'graphql-tag';
import path from 'path';
import { DataSource, QueryRunner } from 'typeorm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { initialData } from '../../../e2e-common/e2e-initial-data';
import { TEST_SETUP_TIMEOUT_MS, testConfig } from '../../../e2e-common/test-config';
import { ReorderList, ReorderListLine, ReorderPlugin } from '../index';
import { REORDER_PLUGIN_OPTIONS } from '../src/constants';
import { AddReorderLists1786838400000 } from '../src/migrations/1786838400000-add-reorder-lists';
import {
    CreateReorderListResult,
    ReorderListLimitError,
    ReorderListNameConflictError,
    ReorderListService,
} from '../src/service/reorder-list.service';
import { ResolvedReorderPluginOptions } from '../src/types';

import {
    asShopApiContext,
    BarrierParticipantSpec,
    canonicaliseCell,
    createPreWriteRendezvous,
    createTransactionBinder,
    DEFAULT_PAIR_BUDGET_MS,
    describeRowDifferences,
    describeSettledOutcomes,
    NO_ROW_DIFFERENCE,
    PreWriteRendezvous,
    redactTeardownDiagnostic,
    resolveConfiguredEngine,
    rethrowRedacted,
    runAllTeardownStages,
    runBarrieredPair,
    runSequentialPair,
    SQLJS_EXCLUSION_REASON,
    supportsForcedInterleaving,
    TransactionBinder,
} from './fixtures/concurrency-barrier';
import {
    classifyLockClause,
    committedMigrationApplies,
    isStatementCountEngine,
    queryCaptureConfig,
    QueryCaptureLogger,
    STATEMENT_COUNT_ENGINE_REASON,
    whereRequiresScopedPredicates,
} from './fixtures/query-capture';
import {
    CREATE_REORDER_LIST,
    CreateReorderListMutation,
    CreateReorderListMutationVariables,
    CreateReorderListResultShape,
    ReorderApiId,
    ReorderListLimitErrorShape,
    ReorderListNameConflictErrorShape,
    ReorderListSuccessShape,
} from './graphql/reorder-definitions';

/**
 * `maxListsPerCustomer` for this test deployment, and the value AC-4 asserts as `maxItems`.
 *
 * Two rather than the shipped default, because AC-4's Given fixes it at two and its barrier half needs a
 * bound a pair of requests can actually reach. It is one constant so that the configuration and every
 * assertion about it cannot drift.
 */
const MAX_LISTS_PER_CUSTOMER = 2;

const MAX_LINES_PER_LIST = 200;

const MAX_QUANTITY_PER_LINE = 999;

const DEFAULT_LISTS_PAGE_SIZE = 25;

const DEFAULT_LINES_PAGE_SIZE = 50;

/**
 * The validated list-name bound, written out as a literal rather than imported from the implementation.
 *
 * Importing the constant the service validates against would make the boundary cases below tautological:
 * they would move with the implementation and pass whatever it was changed to. The literal is what makes
 * 190, 191 and 192 an assertion about the published contract.
 */
const MAX_LIST_NAME_LENGTH = 191;

const LIST_TABLE = 'reorder_list';

/** The child table, addressed BEFORE {@link LIST_TABLE} in every cleanup. */
const LINE_TABLE = 'reorder_list_line';

/**
 * The one named database object AC-7 proves is the database's rather than the service's.
 *
 * Its exact spelling is load-bearing: the service translates a violation of THIS object, matched by name,
 * into `ReorderListNameConflictError` and re-raises every other database failure sanitised.
 */
const NAME_CONFLICT_CONSTRAINT = 'UQ_reorder_list_customer_channel_name_key';

/**
 * The same object's columns, in declaration order.
 */
const NAME_CONFLICT_CONSTRAINT_COLUMNS = ['customerId', 'channelId', 'nameKey'];

/**
 * The exact five data columns AC-1 requires on a `reorder_list` row, and nothing else.
 *
 * No contact detail, no free-text note beyond the name the buyer supplied, and no serialised request
 * context — the minimisation EPIC-001 section 8.1 requires of every plugin-owned customer-linked table
 * while the customer-data-lifecycle decision is open.
 */
const EXPECTED_LIST_DATA_COLUMNS = ['channelId', 'customerId', 'lineCount', 'name', 'nameKey'];

const INHERITED_ENTITY_COLUMNS = ['createdAt', 'id', 'updatedAt'];

const BASE_LIST_NAME = 'Weekly grocery restock';

/**
 * The hostile-input name of AC-1, carrying markup-significant characters and an HTML entity.
 *
 * It must round-trip byte-for-byte: neither escaped, nor stripped, nor interpreted as markup, nor
 * entity-decoded. This story owns the TRANSPORT half of that guarantee only; the rendering half belongs to
 * STORY-001-08-03 in batch B5 and is explicitly not claimed here.
 */
const MARKUP_LIST_NAME = '<b>Tools</b> &amp; spares';

/** The second real channel's token. A foreign-channel case sends this, never a mutated variable. */
const SECOND_CHANNEL_TOKEN = 'reorder-create-second-channel';

const SECOND_CHANNEL_CODE = 'reorder-create-second-channel';

const SECOND_LANGUAGE_CODE = 'de';

/** The `extensions.code` the platform's `UserInputError` carries. AC-2 asserts this exact string. */
const USER_INPUT_ERROR_CODE = 'USER_INPUT_ERROR';

/**
 * The `extensions.code` the platform's `ForbiddenError` carries. AC-5 asserts this exact string and NOT
 * `UNAUTHORIZED`: the platform raises `UnauthorizedError` where credentials do not match, whereas an absent
 * session on a permission-gated operation is reported as forbidden.
 */
const FORBIDDEN_ERROR_CODE = 'FORBIDDEN';

/**
 * What a SEQUENTIAL pair evidences, and what it does not, quoted from the fixture rather than paraphrased.
 */
const SEQUENTIAL_FORM_NOTE =
    'A sequential pair evidences single-connection correctness rather than interleaving, and must not be ' +
    `read as a race. ${SQLJS_EXCLUSION_REASON}`;

const SEEDED_CUSTOMER_PASSWORD = 'test';

/**
 * The number of customers the seed creates.
 *
 * Two is the minimum this suite can run on: AC-6 needs a second customer to authenticate as, and its
 * assertion that no row owned by the FIRST customer can be produced needs a first customer to own none.
 */
const SEEDED_CUSTOMER_COUNT = 2;

/**
 * The published root-`Query` field count of the untouched Shop API baseline, measured against
 * `schema-shop.json` in this checkout.
 */
const BASELINE_ROOT_QUERY_FIELD_COUNT = 19;

/** The published root-`Mutation` field count of the same baseline. This story contributes exactly one. */
const BASELINE_ROOT_MUTATION_FIELD_COUNT = 32;

/** The published `Permission` member count of the same baseline, and of the schema after this plugin loads. */
const BASELINE_PERMISSION_MEMBER_COUNT = 97;

/** The published `ErrorCode` member count of the same baseline. This feature's four declarations widen it. */
const BASELINE_ERROR_CODE_MEMBER_COUNT = 32;

/** The number of baseline types implementing `ErrorResult`. The four declarations widen this by the same four. */
const BASELINE_ERROR_RESULT_IMPLEMENTOR_COUNT = 31;

/** The four error results FEATURE-001-01 declares, all of them owned by this story's schema sub-task. */
const FEATURE_ERROR_RESULTS = [
    'ReorderListLimitError',
    'ReorderListLineNotFoundError',
    'ReorderListNameConflictError',
    'ReorderListNotFoundError',
];

/**
 * The two root queries this plugin's SDL document declares.
 *
 * They are named here for one purpose only: so that the additive-only check can say WHICH fields appeared
 * and refuse any other. A root query that appeared and is not one of these is a platform widening, which is
 * the case EPIC-001 section 6.1 asks to be reported rather than absorbed.
 */
const FEATURE_ROOT_QUERIES = ['activeCustomerReorderList', 'activeCustomerReorderLists'];

/**
 * The six root mutations the same document declares, of which `createReorderList` is this story's one.
 *
 * The other five belong to STORY-001-01-02 and STORY-001-01-03 and are asserted by their own suites; they
 * are listed for the same reason as the queries above.
 */
const FEATURE_ROOT_MUTATIONS = [
    'addItemToReorderList',
    'adjustReorderListLine',
    'createReorderList',
    'deleteReorderList',
    'removeReorderListLine',
    'updateReorderList',
];

const STORY_ROOT_MUTATION = 'createReorderList';

/**
 * The three shipped order mutations AC-8 asserts gain no argument.
 *
 * They are named individually as well as covered by the whole-root comparison, because they are the three the
 * story's definition-of-done item 5 names: a custom field on `OrderLine` would widen all three as a side
 * effect, and this feature registers none.
 */
const UNWIDENED_ORDER_MUTATIONS = ['addItemToOrder', 'addItemsToOrder', 'adjustOrderLine'];

/**
 * The seeded customers, read through the Admin API rather than assumed.
 *
 * The generated email addresses are mock data and must never be hard-coded: STORY-001-01-01's
 * definition-of-done item 10 requires the address to be READ through the named Admin API query, with only
 * the password being the fixed value the seed sets.
 */
const GET_SEEDED_CUSTOMERS = gql`
    query GetSeededCustomersForReorderCreate {
        customers(options: { sort: { id: ASC } }) {
            totalItems
            items {
                id
                emailAddress
                user {
                    id
                }
            }
        }
    }
`;

const GET_CHANNELS_FOR_REORDER_CREATE = gql`
    query GetChannelsForReorderCreate {
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

const CREATE_CHANNEL_FOR_REORDER_CREATE = gql`
    mutation CreateChannelForReorderCreate($input: CreateChannelInput!) {
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

/** Soft-deletes a customer. `Customer` is declared soft-deletable, so the row and its list rows survive. */
const DELETE_CUSTOMER_FOR_REORDER_CREATE = gql`
    mutation DeleteCustomerForReorderCreate($id: ID!) {
        deleteCustomer(id: $id) {
            result
            message
        }
    }
`;

/**
 * One catalogue variant, for the two scenarios in which something about a previously purchased variant has
 * since changed: its `enabled` flag, and its price. `price` is selected because scenario 3 moves it and needs
 * the prior value to move it back to.
 */
const GET_VARIANT_FOR_REORDER_CREATE = gql`
    query GetVariantForReorderCreate {
        productVariants(options: { take: 1, sort: { id: ASC } }) {
            totalItems
            items {
                id
                name
                enabled
                price
            }
        }
    }
`;

const SET_VARIANT_ENABLED_FOR_REORDER_CREATE = gql`
    mutation SetVariantEnabledForReorderCreate($input: [UpdateProductVariantInput!]!) {
        updateProductVariants(input: $input) {
            id
            enabled
        }
    }
`;

/**
 * Moves a variant's price, and moves it back.
 *
 * Selecting `price` back is what makes the move measurable rather than assumed: the returned value is the one
 * the platform actually stored, so scenario 3 can assert the prior and current prices genuinely differ before
 * it asserts anything about the operation under test.
 */
const SET_VARIANT_PRICE_FOR_REORDER_CREATE = gql`
    mutation SetVariantPriceForReorderCreate($input: [UpdateProductVariantInput!]!) {
        updateProductVariants(input: $input) {
            id
            price
        }
    }
`;

/**
 * The shipped Shop read whose behaviour AC-8 asserts is unchanged, and which checkpoint 4 uses to prove a
 * session authenticated at all using only operations that already ship.
 */
const GET_ACTIVE_CUSTOMER_FOR_REORDER_CREATE = gql`
    query GetActiveCustomerForReorderCreate {
        activeCustomer {
            id
            emailAddress
        }
    }
`;

/**
 * The introspection of the booted Shop API, shaped so that ONE code path can read both it and the untouched `schema-
 * shop.json` snapshot.
 */
const SHOP_SCHEMA_SHAPE = gql`
    query ReorderCreateShopSchemaShape {
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
                            ...ReorderCreateTypeRef
                        }
                    }
                    type {
                        ...ReorderCreateTypeRef
                    }
                }
                inputFields {
                    name
                    defaultValue
                    type {
                        ...ReorderCreateTypeRef
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

    fragment ReorderCreateTypeRef on __Type {
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
    user: { id: ReorderApiId } | null;
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
    createChannel:
        | { __typename: 'Channel'; id: ReorderApiId; code: string; token: string }
        | { __typename: 'LanguageNotAvailableError'; errorCode: string; message: string };
}

interface DeleteCustomerMutation {
    deleteCustomer: { result: string; message: string | null };
}

interface AdminProductVariant {
    id: ReorderApiId;
    name: string;
    enabled: boolean;
    price: number;
}

interface GetVariantQuery {
    productVariants: { totalItems: number; items: AdminProductVariant[] };
}

interface SetVariantEnabledMutation {
    updateProductVariants: Array<{ id: ReorderApiId; enabled: boolean } | null>;
}

interface SetVariantPriceMutation {
    updateProductVariants: Array<{ id: ReorderApiId; price: number } | null>;
}

interface GetActiveCustomerQuery {
    activeCustomer: { id: ReorderApiId; emailAddress: string } | null;
}

interface IntrospectedTypeRef {
    kind: string;
    name: string | null;
    ofType?: IntrospectedTypeRef | null;
}

interface IntrospectedInputValue {
    name: string;
    defaultValue?: string | null;
    type?: IntrospectedTypeRef | null;
}

interface IntrospectedField {
    name: string;
    args?: IntrospectedInputValue[] | null;
    type?: IntrospectedTypeRef | null;
}

/** One named type of the schema, at the granularity every assertion below needs. */
interface IntrospectedType {
    name: string | null;
    kind: string;
    fields?: IntrospectedField[] | null;
    inputFields?: IntrospectedInputValue[] | null;
    enumValues?: Array<{ name: string }> | null;
    interfaces?: Array<{ name: string | null }> | null;
}

/** The `__schema` object, identical in shape on the live side and the snapshot side. */
interface IntrospectedSchema {
    types: IntrospectedType[];
}

interface ShopSchemaShapeQuery {
    __schema: IntrospectedSchema;
}

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
 * Renders one field to its full declared signature: name, ordered argument list with each argument's type
 * and default, and the return type.
 *
 * Arguments are rendered in declaration order rather than sorted, because argument ORDER is part of a
 * published signature for a client that supplies them positionally in a generated SDL dump.
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

/** The named type, or `undefined`. Used where absence is itself the thing being asserted. */
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
    const type = requireType(schema, typeName);
    const signatures = new Map<string, string>();
    for (const field of type.fields ?? []) {
        signatures.set(field.name, renderFieldSignature(field));
    }
    return signatures;
}

/** The field names of a named object type, sorted so a comparison is order-independent. */
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

const MONETARY_OR_STOCK_FIELD = /price|money|amount|currency|tax|stock|inventory|saleable/i;

const capture = new QueryCaptureLogger();

// The first is a race. The platform's own initializer creates it with a bare, non-recursive `mkdirSync`
// guarded by a preceding `existsSync` (`packages/testing/src/initializers/sqljs-initializer.ts` L31-L35),
// which is a check-then-act race: this package's e2e suites start together, so when the directory is absent —
// both observe it missing and the loser fails its `beforeAll` with `EEXIST`. The three server engines use no
fs.mkdirSync(path.join(__dirname, '__data__'), { recursive: true });
const reorderPluginRegistration = ReorderPlugin.init({
    maxListsPerCustomer: MAX_LISTS_PER_CUSTOMER,
    maxLinesPerList: MAX_LINES_PER_LIST,
    maxQuantityPerLine: MAX_QUANTITY_PER_LINE,
    defaultReorderListsPageSize: DEFAULT_LISTS_PAGE_SIZE,
    defaultReorderListLinesPageSize: DEFAULT_LINES_PAGE_SIZE,
});

const suiteConfig = mergeConfig(testConfig(), {
    plugins: [reorderPluginRegistration],
    importExportOptions: {
        importAssetsDir: path.join(__dirname, '../../core/e2e/fixtures/assets'),
    },
    ...queryCaptureConfig(capture),
});

const { server, adminClient, shopClient } = createTestEnvironment(suiteConfig);

const shopApiUrl = `http://localhost:${suiteConfig.apiOptions.port}/${
    suiteConfig.apiOptions.shopApiPath ?? 'shop-api'
}`;

describe('STORY-001-01-01 createReorderList (Shop API)', () => {
    /** The raw data source, for the fixture reads, the direct writes and the barrier driver. */
    let dataSource: DataSource;

    /** One query runner for this suite's own portable statements. Released unconditionally in `afterAll`. */
    let queryRunner: QueryRunner;

    /** Engine-correct identifier quoting, so every raw statement below works on all four engines. */
    let esc: (identifier: string) => string;

    /** The alias TypeORM gives `reorder_list` in a repository query, read from metadata rather than guessed. */
    let listAlias: string;

    /**
     * The running server's own service instance, resolved from the injector rather than constructed.
     */
    let reorderListService: ReorderListService;

    /**
     * The verified binding that puts a real service operation on a barrier participant's own transaction.
     *
     * Built once, and `createTransactionBinder` proves the platform honours it before returning — so a
     * mechanism that stopped working fails here, loudly, rather than leaving every race silently unbound.
     */
    let transactionBinder: TransactionBinder;

    let seededCustomers: SeededCustomer[];

    /** The customer every test acts as: the SECOND of the two, which is what AC-6's Given fixes. */
    let actingCustomer: SeededCustomer;

    /** The FIRST seeded customer, whose rows AC-6 proves this call cannot produce. */
    let otherCustomer: SeededCustomer;

    /** The acting customer's decoded database identifier, for every raw comparison and predicate. */
    let actingCustomerDbId: number;

    let otherCustomerDbId: number;

    let defaultChannelDbId: number;

    let secondChannelDbId: number;

    /** One catalogue variant, used only by the disabled-variant scenario. */
    let catalogueVariant: AdminProductVariant;

    let liveSchema: IntrospectedSchema;

    /** The untouched checked-in baseline. Read from disk, never edited and never regenerated. */
    let snapshotSchema: IntrospectedSchema;

    /**
     * Undo actions for core rows a test mutated, drained LIFO in `afterEach`.
     *
     * Reset in `beforeEach` and drained in `afterEach`, so no test can observe another's entry — and a test
     * that mutated a channel, a variant's `enabled` flag or a customer's soft-delete marker restores it in
     * the same `afterEach` that deletes its plugin rows.
     */
    let restoreActions: Array<() => Promise<void>>;

    /**
     * A second real Shop client, for the two concurrency criteria.
     *
     * A race claim needs two callers, and mutating one client's state would produce one caller pretending to
     * be two. This is a genuinely separate client with its own session, and it drives the same published
     * mutation over its own HTTP request.
     */
    let secondShopClient: SimpleGraphQLClient;

    // Raw statements below carry NO bound parameters, deliberately. The four target engines disagree on
    // placeholder syntax — PostgreSQL renders `$1` while the others render `?` — so a parameterised raw
    // statement is portable only by accident. Anything needing a VALUE goes through a repository, which
    // builds the engine's own form; anything raw is value-free and quotes its identifiers through
    // `driver.escape()`, the shipped idiom at `packages/core/e2e/migrate-asset-translations.e2e-spec.ts`.

    /**
     * Decodes an API identifier to the value the database actually stores.
     */
    function decodeId(apiId: ReorderApiId): number {
        return Number.parseInt(String(apiId).replace('T_', ''), 10);
    }

    async function countLists(customerDbId: number, channelDbId: number): Promise<number> {
        return dataSource
            .getRepository(ReorderList)
            .count({ where: { customerId: customerDbId, channelId: channelDbId } });
    }

    async function countListsWithKey(
        customerDbId: number,
        channelDbId: number,
        nameKey: string,
    ): Promise<number> {
        return dataSource
            .getRepository(ReorderList)
            .count({ where: { customerId: customerDbId, channelId: channelDbId, nameKey } });
    }

    /** Every `reorder_list_line` row, counted through the repository. This story writes none. */
    async function countAllLines(): Promise<number> {
        return dataSource.getRepository(ReorderListLine).count();
    }

    /**
     * Every `reorder_list` row as the DATABASE returns it, with the column keys the database itself supplies.
     *
     * `SELECT *` rather than a column list, because AC-1 asserts the row's column SET and a list this file
     * wrote would be asserting itself: a sixth column would simply not be selected and the assertion would
     * pass. The keys of the returned object are the table's real columns.
     */
    async function readAllListRows(): Promise<Array<Record<string, unknown>>> {
        const rows: unknown = await queryRunner.query(`SELECT * FROM ${esc(LIST_TABLE)}`);
        return (rows ?? []) as Array<Record<string, unknown>>;
    }

    async function readTheOnlyListRow(): Promise<Record<string, unknown>> {
        const rows = await readAllListRows();
        expect(rows.length, `Expected exactly one ${LIST_TABLE} row, found ${rows.length}`).toBe(1);
        return rows[0];
    }

    async function readListRowById(apiId: ReorderApiId): Promise<Record<string, unknown> | undefined> {
        const wanted = decodeId(apiId);
        const rows = await readAllListRows();
        return rows.find(row => Number(row.id) === wanted);
    }

    /**
     * Writes a `reorder_list` row DIRECTLY through the repository, bypassing the service entirely.
     *
     * AC-7 requires the duplicate to be written this way "so that no service pre-check can intercept it":
     * driving it through the mutation would let the advisory count answer first, and a passing test would then
     * prove nothing about whether the DATABASE enforces the rule.
     */
    async function insertListRowDirectly(row: {
        customerId: number;
        channelId: number;
        name: string;
        nameKey: string;
        lineCount: number;
    }): Promise<void> {
        await dataSource.getRepository(ReorderList).insert(row);
    }

    /**
     * The request context an authenticated client's next request would arrive with, built through the
     * platform's OWN guard path.
     */
    async function shopContextFor(client: SimpleGraphQLClient): Promise<RequestContext> {
        const session = await server.app.get(SessionService).getSessionFromToken(client.getAuthToken());
        // side of this assertion carries the session token, and the direction of an assertion is one edit
        expect(
            session !== undefined,
            'The client holds no session, so no authenticated context can be built',
        ).toBe(true);
        const channelTokenKey = server.app.get(ConfigService).apiOptions.channelTokenKey ?? 'vendure-token';
        const request = { query: {}, headers: { [channelTokenKey]: E2E_DEFAULT_CHANNEL_TOKEN } };
        const ctx = await server.app
            .get(RequestContextService)
            .fromRequest(request as never, undefined, [Permission.Owner], session);
        expect(ctx.authorizedAsOwnerOnly).toBe(true);
        expect(ctx.channel.token).toBe(E2E_DEFAULT_CHANNEL_TOKEN);
        expect(ctx.activeUserId).toBeDefined();
        // has, so `fromRequest` alone yields `custom` and a race would then be exercising a
        const shopCtx = asShopApiContext(ctx);
        expect(shopCtx.apiType).toBe('shop');
        return shopCtx;
    }

    /** One service-returned union member, named for a diagnostic. The success member is an entity, so it
     * carries no `__typename` of its own and is named here from its class instead. */
    function describeServiceResult(result: CreateReorderListResult): string {
        return result instanceof ReorderList
            ? `ReorderList(name=${String(result.name)}, lineCount=${String(result.lineCount)})`
            : `${result.__typename}(${result.errorCode})`;
    }

    /**
     * Deletes every plugin-owned row, child table BEFORE parent.
     */
    async function deleteAllPluginRows(): Promise<void> {
        await queryRunner.query(`DELETE FROM ${esc(LINE_TABLE)}`);
        await queryRunner.query(`DELETE FROM ${esc(LIST_TABLE)}`);
    }

    /**
     * The exact prior state of every core row the soft-delete scenario disturbs: the ONE `customer` row, the ONE
     * `user` row it points at, and EVERY `session` row that user holds.
     */
    interface SoftDeleteCapture {
        readonly customer: CoreRowsCapture;
        readonly user: CoreRowsCapture;
        readonly sessions: CoreRowsCapture;
        readonly customerId: number;
        readonly userId: number;
    }

    /**
     * Captures those rows and queues their exact restoration, then returns the captures so the scenario can
     * also return to its own starting state part-way through.
     */
    async function captureSoftDeleteState(customerDbId: number): Promise<SoftDeleteCapture> {
        const customer = await dataSource.getRepository(Customer).findOne({ where: { id: customerDbId } });
        expect(customer, `No customer row with id ${customerDbId} to capture`).not.toBeNull();
        const userId = Number(customer?.user?.id);
        expect(
            Number.isInteger(userId),
            `The customer with id ${customerDbId} points at no user row, so the scenario has no user to mark`,
        ).toBe(true);
        return {
            customerId: customerDbId,
            userId,
            customer: await captureCoreRows('customer', 'captured_row.id = :customerId', {
                customerId: customerDbId,
            }),
            user: await captureCoreRows('user', 'captured_row.id = :userId', { userId }),
            sessions: await captureCoreRows('session', 'captured_row.userId = :userId', { userId }),
        };
    }

    /** Returns the customer and its user to their captured state, leaving the session rows as they are. */
    async function restoreCustomerAndUserExactly(softDelete: SoftDeleteCapture): Promise<void> {
        await restoreCoreRowsExactly(softDelete.customer);
        await restoreCoreRowsExactly(softDelete.user);
    }

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
            // THE ONE DIAGNOSTIC SINK THAT REDACTING AT THE CALLER CANNOT CLOSE, WHICH IS WHY IT IS CLOSED
            // Every statement this helper runs binds CAPTURED CELLS: the values a restoration is putting
            // an address, a password hash, an authentication token. TypeORM raises a failure from
            // `JSON.stringify(err)` both publish the statement and every bound value, and so does the runner
            // outside the aggregator and travel straight to the runner. Sanitising HERE covers both, and
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
            // AND THE UPDATE-DATE COLUMN IS ALWAYS RE-STATED, even when it did not move. On the MySQL family
            // from its SET list is re-timestamped BY THE ENGINE, below TypeORM and below this helper. That was
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
        // `user` and `session` rows, `session.token` included. The numbers say exactly the same thing and
        if (now.length !== rowsCapture.rows.length) {
            throw new Error(
                `${rowsCapture.table} holds ${String(now.length)} rows for ${rowsCapture.where} where the ` +
                    `capture held ${String(rowsCapture.rows.length)}; the rows themselves are deliberately ` +
                    'not reported',
            );
        }
    }

    /**
     * A census of the core rows the baseline is known-good BY, read with portable statements.
     */
    async function readCoreRowCensus(): Promise<{
        customers: number;
        channels: number;
        productVariants: number;
        actingCustomerRowPresent: boolean;
        actingCustomerEmailMatches: boolean;
    }> {
        const countOf = async (table: string): Promise<number> => {
            const rows: unknown = await queryRunner.query(
                `SELECT COUNT(*) AS ${esc('total')} FROM ${esc(table)}`,
            );
            const first = ((rows ?? []) as Array<Record<string, unknown>>)[0];
            return Number(first?.total ?? -1);
        };
        // engines spell a positional placeholder three different ways, and this file's statements have to
        const identified: unknown = await queryRunner.query(
            `SELECT ${esc('emailAddress')} FROM ${esc('customer')} WHERE ${esc('id')} = ${Number(
                actingCustomerDbId,
            )}`,
        );
        const identifiedRow = ((identified ?? []) as Array<Record<string, unknown>>)[0];
        const storedEmail = identifiedRow?.emailAddress;
        return {
            customers: await countOf('customer'),
            channels: await countOf('channel'),
            productVariants: await countOf('product_variant'),
            actingCustomerRowPresent: storedEmail !== undefined,
            actingCustomerEmailMatches:
                storedEmail !== undefined && String(storedEmail) === actingCustomer.emailAddress,
        };
    }

    async function createReorderList(
        name: string,
        client: SimpleGraphQLClient = shopClient,
    ): Promise<CreateReorderListResultShape> {
        const { createReorderList: result } = await client.query<
            CreateReorderListMutation,
            CreateReorderListMutationVariables
        >(CREATE_REORDER_LIST, { input: { name } });
        return result;
    }

    /**
     * Executes the published mutation with an explicit `languageCode` on the request.
     *
     * The parameter reaches `req.query.languageCode`, which is where the platform resolves a request's
     * language from, so this is a genuinely differently-scoped request rather than a differently-shaped one.
     */
    async function createReorderListInLanguage(
        name: string,
        languageCode: string,
    ): Promise<CreateReorderListResultShape> {
        const { createReorderList: result } = await shopClient.query<
            CreateReorderListMutation,
            CreateReorderListMutationVariables
        >(CREATE_REORDER_LIST, { input: { name } }, { languageCode });
        return result;
    }

    /** Narrows a create result to its success member, failing with the member that actually arrived. */
    function expectCreated(result: CreateReorderListResultShape): ReorderListSuccessShape {
        expect(
            result.__typename,
            `Expected a ReorderList, received ${result.__typename}: ${JSON.stringify(result)}`,
        ).toBe('ReorderList');
        return result as ReorderListSuccessShape;
    }

    function expectNameConflict(result: CreateReorderListResultShape): ReorderListNameConflictErrorShape {
        expect(
            result.__typename,
            `Expected a ReorderListNameConflictError, received ${result.__typename}`,
        ).toBe('ReorderListNameConflictError');
        return result as ReorderListNameConflictErrorShape;
    }

    function expectLimit(result: CreateReorderListResultShape): ReorderListLimitErrorShape {
        expect(result.__typename, `Expected a ReorderListLimitError, received ${result.__typename}`).toBe(
            'ReorderListLimitError',
        );
        return result as ReorderListLimitErrorShape;
    }

    interface TopLevelErrorEntry {
        message: string;
        extensions?: { code?: string };
    }

    /** A refused request's whole response: its `errors` array and its `data`. */
    interface TopLevelFailureResponse {
        errors: TopLevelErrorEntry[];
        data: { createReorderList: unknown } | null;
    }

    /**
     * Runs a request that must be refused at the TOP LEVEL and returns its whole response.
     */
    async function expectTopLevelFailure(
        run: () => Promise<unknown>,
        diagnostic: string,
    ): Promise<TopLevelFailureResponse> {
        let caught: unknown;
        try {
            await run();
        } catch (err: unknown) {
            caught = err;
        }
        expect(caught, diagnostic).toBeInstanceOf(ClientError);
        const response = (caught as ClientError).response as TopLevelFailureResponse;
        expect(Array.isArray(response.errors), `${diagnostic} (no errors array on the response)`).toBe(true);
        return response;
    }

    /**
     * Asserts the whole of AC-2's and AC-5's response contract in one place: exactly one `errors` entry, that
     * entry's exact `extensions.code`, and `data` exactly null.
     */
    function expectExactlyOneTopLevelError(response: TopLevelFailureResponse, expectedCode: string): void {
        expect(
            response.errors.length,
            `Expected exactly one errors entry: ${JSON.stringify(response.errors)}`,
        ).toBe(1);
        expect(response.errors[0].extensions?.code).toBe(expectedCode);
        expect(
            response.data,
            `Expected the response envelope to carry data exactly null: ${JSON.stringify(response.data)}`,
        ).toBeNull();
    }

    /**
     * Seeds `count` lists for the acting customer through the published mutation, and returns them.
     *
     * Every test that needs a precondition builds it by calling this from its OWN body, so no test reads a
     * row a sibling left behind. The names are derived from the caller's prefix so that two tests cannot
     * collide on a canonical key.
     */
    async function seedLists(prefix: string, count: number): Promise<ReorderListSuccessShape[]> {
        const created: ReorderListSuccessShape[] = [];
        for (let index = 0; index < count; index++) {
            created.push(expectCreated(await createReorderList(`${prefix} ${index + 1}`)));
        }
        return created;
    }

    /** A canonical-form name of exactly `length` characters, built from a single repeated ASCII letter. */
    function nameOfLength(length: number): string {
        return 'a'.repeat(length);
    }

    /**
     * True when a driver message identifies {@link NAME_CONFLICT_CONSTRAINT} in the form this engine spells it.
     */
    function identifiesNameConflictConstraint(message: string): boolean {
        const lowered = message.toLowerCase();
        if (message.includes(NAME_CONFLICT_CONSTRAINT)) {
            return true;
        }
        const namesUniquenessFailure = lowered.includes('unique constraint failed');
        const namesEveryColumn = NAME_CONFLICT_CONSTRAINT_COLUMNS.every(column =>
            message.includes(`${LIST_TABLE}.${column}`),
        );
        return namesUniquenessFailure && namesEveryColumn;
    }

    beforeAll(async () => {
        await server.init({
            initialData,
            productsCsvPath: path.join(__dirname, '../../core/e2e/fixtures/e2e-products-minimal.csv'),
            customerCount: SEEDED_CUSTOMER_COUNT,
        });

        dataSource = server.app.get(TransactionalConnection).rawConnection;
        reorderListService = server.app.get(ReorderListService);
        transactionBinder = await createTransactionBinder(server.app.get(TransactionalConnection));
        queryRunner = dataSource.createQueryRunner();
        esc = (identifier: string) => dataSource.driver.escape(identifier);
        // metadata's own name, and the capture predicates below must name the alias the statement actually
        listAlias = dataSource.getMetadata(ReorderList).name;

        await adminClient.asSuperAdmin();

        const { customers } = await adminClient.query<GetSeededCustomersQuery>(GET_SEEDED_CUSTOMERS);
        expect(
            customers.items.length,
            `The seed produced ${customers.items.length} customers; this suite needs ${SEEDED_CUSTOMER_COUNT}`,
        ).toBeGreaterThanOrEqual(SEEDED_CUSTOMER_COUNT);
        seededCustomers = customers.items;
        otherCustomer = seededCustomers[0];
        actingCustomer = seededCustomers[1];
        otherCustomerDbId = decodeId(otherCustomer.id);
        actingCustomerDbId = decodeId(actingCustomer.id);

        const { channels } = await adminClient.query<GetChannelsQuery>(GET_CHANNELS_FOR_REORDER_CREATE);
        const defaultChannel = channels.items.find(channel => channel.token === E2E_DEFAULT_CHANNEL_TOKEN);
        expect(
            defaultChannel,
            'The seeded default channel was not found by its configured token',
        ).toBeDefined();
        const resolvedDefaultChannel = defaultChannel as AdminChannel;
        defaultChannelDbId = decodeId(resolvedDefaultChannel.id);

        // test's fixture: no test below mutates it, and the channel-scope cases send its real token rather
        // than mutating a variable, which is the third of FEATURE-001-01 section 2.6.1's four matrix rules.
        const taxZone = resolvedDefaultChannel.defaultTaxZone;
        const shippingZone = resolvedDefaultChannel.defaultShippingZone;
        expect(taxZone, 'The default channel declares no default tax zone').toBeDefined();
        expect(shippingZone, 'The default channel declares no default shipping zone').toBeDefined();
        const { createChannel } = await adminClient.query<CreateChannelMutation>(
            CREATE_CHANNEL_FOR_REORDER_CREATE,
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
        secondChannelDbId = decodeId((createChannel as { id: ReorderApiId }).id);

        const { productVariants } = await adminClient.query<GetVariantQuery>(GET_VARIANT_FOR_REORDER_CREATE);
        expect(productVariants.items.length, 'The seeded catalogue produced no ProductVariant').toBe(1);
        catalogueVariant = productVariants.items[0];

        secondShopClient = new SimpleGraphQLClient(suiteConfig, shopApiUrl);

        // snapshot cannot move and must be neither edited nor regenerated (AAP section 0.4.1.5).
        const introspected = await shopClient.query<ShopSchemaShapeQuery>(SHOP_SCHEMA_SHAPE);
        liveSchema = introspected.__schema;

        const snapshotPath = path.join(__dirname, '../../../schema-shop.json');
        const snapshotText = fs.readFileSync(snapshotPath, 'utf-8');
        const snapshot = JSON.parse(snapshotText) as { data: ShopSchemaShapeQuery };
        snapshotSchema = snapshot.data.__schema;
    }, TEST_SETUP_TIMEOUT_MS);

    afterAll(async () => {
        // its success path leaks a listening port into the next file. The query runner is released first
        try {
            if (queryRunner && queryRunner.isReleased === false) {
                await queryRunner.release();
            }
        } finally {
            await server.destroy();
        }
    });

    beforeEach(async () => {
        // freshly authenticated on the default channel token.
        restoreActions = [];
        capture.reset();
        await deleteAllPluginRows();
        shopClient.setChannelToken(E2E_DEFAULT_CHANNEL_TOKEN);
        await shopClient.asUserWithCredentials(actingCustomer.emailAddress, SEEDED_CUSTOMER_PASSWORD);
        shopClient.setChannelToken(E2E_DEFAULT_CHANNEL_TOKEN);
    });

    afterEach(async () => {
        // the client's channel token is reset last.
        const queued = restoreActions.slice().reverse();
        restoreActions = [];
        await runAllTeardownStages([
            ...queued.map((restore, index) => ({
                what: `restore action ${String(queued.length - index)}`,
                run: restore,
            })),
            { what: 'plugin rows', run: deleteAllPluginRows },
            {
                what: 'channel token',
                run: () => {
                    shopClient.setChannelToken(E2E_DEFAULT_CHANNEL_TOKEN);
                    return Promise.resolve();
                },
            },
        ]);
    });

    // The four staged checkpoints (STORY-001-01-01 section 2.1)

    describe('staged checkpoints', () => {
        it('checkpoint 1: the plugin module loads and the server boots with ReorderPlugin registered', () => {
            const diagnostic =
                'checkpoint 1 (plugin metadata / providers / imports): the server did not boot with ' +
                'ReorderPlugin registered';
            expect(server.app, diagnostic).toBeDefined();
            const registeredPlugins = server.app.get(ConfigService).plugins;
            expect(registeredPlugins, diagnostic).toContain(reorderPluginRegistration);
            // the INJECTOR rather than off the static, because the injector is what the service and the
            const injected = server.app.get<ResolvedReorderPluginOptions>(REORDER_PLUGIN_OPTIONS);
            expect(injected.maxListsPerCustomer, diagnostic).toBe(MAX_LISTS_PER_CUSTOMER);
            expect(injected.maxLinesPerList, diagnostic).toBe(MAX_LINES_PER_LIST);
            expect(injected.maxQuantityPerLine, diagnostic).toBe(MAX_QUANTITY_PER_LINE);
            expect(injected.defaultReorderListsPageSize, diagnostic).toBe(DEFAULT_LISTS_PAGE_SIZE);
            expect(injected.defaultReorderListLinesPageSize, diagnostic).toBe(DEFAULT_LINES_PAGE_SIZE);
            expect(dataSource.hasMetadata(ReorderList), diagnostic).toBe(true);
            expect(dataSource.hasMetadata(ReorderListLine), diagnostic).toBe(true);
        });

        // WHY THIS ONE CHECKPOINT IS ENGINE-CONDITIONAL, AND WHERE THE FOUR-ENGINE CYCLE IS INSTEAD.
        // emitted migration is bound to the engine it was generated against ({@link committedMigrationApplies}
        // carries the citations), so those two methods can only be called where the dialect matches. That is a
        // owns the data-bearing up → down → up cycle and runs it on ALL FOUR engines, applying the checked-in
        // artefact where the dialect matches and the migration this engine's own lifecycle emits otherwise. So
        it.skipIf(!committedMigrationApplies(resolveConfiguredEngine()))(
            'checkpoint 2: the checked-in migration applies and reverts on this engine, against a plugin-less baseline',
            async () => {
                // are wrong ON THIS ENGINE — a failure here on one engine with three green localises the defect to
                // that engine rather than to the plugin.
                const diagnostic = `checkpoint 2 (the checked-in migration on ${resolveConfiguredEngine()})`;

                // table-filtered statement count below relies on, and what the migration has to agree with.
                expect(dataSource.getMetadata(ReorderList).tableName, diagnostic).toBe(LIST_TABLE);
                expect(dataSource.getMetadata(ReorderListLine).tableName, diagnostic).toBe(LINE_TABLE);

                const migration = new AddReorderLists1786838400000();
                const coreBaseline = await readCoreRowCensus();
                expect(
                    coreBaseline.customers,
                    `${diagnostic}: the core seed is not present to begin with`,
                ).toBeGreaterThan(0);
                expect(
                    coreBaseline.actingCustomerRowPresent,
                    `${diagnostic}: the acting customer row is not seeded`,
                ).toBe(true);
                expect(
                    coreBaseline.actingCustomerEmailMatches,
                    `${diagnostic}: the acting customer row does not carry the expected identifying field`,
                ).toBe(true);

                let bodyError: unknown;
                try {
                    await migration.down(queryRunner);
                    expect(
                        await queryRunner.hasTable(LINE_TABLE),
                        `${diagnostic}: down() left ${LINE_TABLE} behind`,
                    ).toBe(false);
                    expect(
                        await queryRunner.hasTable(LIST_TABLE),
                        `${diagnostic}: down() left ${LIST_TABLE} behind`,
                    ).toBe(false);
                    expect(
                        await readCoreRowCensus(),
                        `${diagnostic}: reverting the migration moved core rows`,
                    ).toEqual(coreBaseline);

                    await migration.up(queryRunner);
                    expect(
                        await queryRunner.hasTable(LIST_TABLE),
                        `${diagnostic}: up() did not create ${LIST_TABLE}`,
                    ).toBe(true);
                    expect(
                        await queryRunner.hasTable(LINE_TABLE),
                        `${diagnostic}: up() did not create ${LINE_TABLE}`,
                    ).toBe(true);
                    const listRows = await readAllListRows();
                    expect(Array.isArray(listRows), `${diagnostic}: ${LIST_TABLE} is not queryable`).toBe(
                        true,
                    );
                    expect(listRows.length, `${diagnostic}: ${LIST_TABLE} was created carrying rows`).toBe(0);
                    expect(await countAllLines(), `${diagnostic}: ${LINE_TABLE} is not queryable`).toBe(0);

                    await migration.down(queryRunner);
                    expect(
                        await queryRunner.hasTable(LINE_TABLE),
                        `${diagnostic}: the second down() left ${LINE_TABLE} behind`,
                    ).toBe(false);
                    expect(
                        await queryRunner.hasTable(LIST_TABLE),
                        `${diagnostic}: the second down() left ${LIST_TABLE} behind`,
                    ).toBe(false);
                    expect(
                        await readCoreRowCensus(),
                        `${diagnostic}: reverting the migration moved core rows`,
                    ).toEqual(coreBaseline);
                } catch (e) {
                    bodyError = e;
                }

                const bothPresent = async (): Promise<boolean> =>
                    (await queryRunner.hasTable(LIST_TABLE)) && (await queryRunner.hasTable(LINE_TABLE));
                const neitherPresent = async (): Promise<boolean> =>
                    !(await queryRunner.hasTable(LIST_TABLE)) && !(await queryRunner.hasTable(LINE_TABLE));
                // `QueryFailedError` arrives carrying its statement, its bound parameters and the driver's own
                // whatever the others do, describes each failure through the shared redactor and raises one
                let restoreFailure: unknown;
                try {
                    await runAllTeardownStages([
                        {
                            what: 'down()',
                            run: async () => {
                                if (await bothPresent()) {
                                    await migration.down(queryRunner);
                                }
                            },
                        },
                        {
                            what: 'up()',
                            run: async () => {
                                if (await neitherPresent()) {
                                    await migration.up(queryRunner);
                                }
                            },
                        },
                    ]);
                } catch (e: unknown) {
                    restoreFailure = e;
                }
                if (bodyError) {
                    throw bodyError;
                }
                if (restoreFailure) {
                    throw restoreFailure;
                }
                expect(await queryRunner.hasTable(LIST_TABLE), `${diagnostic}: schema not restored`).toBe(
                    true,
                );
                expect(await queryRunner.hasTable(LINE_TABLE), `${diagnostic}: schema not restored`).toBe(
                    true,
                );
            },
        );

        it('checkpoint 3: createReorderList is published and all 19 baseline root queries are byte-identical', () => {
            const diagnostic =
                'checkpoint 3 (shopApiExtensions wiring, or a generator widened an existing field)';

            const liveMutations = fieldSignaturesOf(liveSchema, 'Mutation');
            expect(
                liveMutations.has(STORY_ROOT_MUTATION),
                `${diagnostic}: ${STORY_ROOT_MUTATION} is not on the root Mutation type`,
            ).toBe(true);

            const baselineQueries = fieldSignaturesOf(snapshotSchema, 'Query');
            const liveQueries = fieldSignaturesOf(liveSchema, 'Query');
            expect(baselineQueries.size, 'The checked-in snapshot moved').toBe(
                BASELINE_ROOT_QUERY_FIELD_COUNT,
            );
            for (const [name, signature] of baselineQueries) {
                expect(liveQueries.get(name), `${diagnostic}: root query ${name} changed`).toBe(signature);
            }

            // FEATURE-001-01's whole surface. So what is asserted is baseline-plus-owned-additions: nothing was
            const addedQueries = [...liveQueries.keys()].filter(name => !baselineQueries.has(name)).sort();
            for (const name of addedQueries) {
                expect(
                    FEATURE_ROOT_QUERIES,
                    `${diagnostic}: the root Query type gained ${name}, which this plugin does not declare`,
                ).toContain(name);
            }
            expect(addedQueries, `${diagnostic}: this story declares no root query of its own`).not.toContain(
                STORY_ROOT_MUTATION,
            );
        });

        it('checkpoint 4: a seeded session authenticates and the gate marks the context owner-only', async () => {
            // DIAGNOSTIC ON FAILURE: the seed, the credential, the channel token or the `@Allow` wiring is
            const diagnostic = 'checkpoint 4 (seed / credential / channel token / @Allow wiring)';

            const { activeCustomer } = await shopClient.query<GetActiveCustomerQuery>(
                GET_ACTIVE_CUSTOMER_FOR_REORDER_CREATE,
            );
            expect(activeCustomer, `${diagnostic}: no active customer after sign-in`).not.toBeNull();
            expect((activeCustomer as { id: ReorderApiId }).id, diagnostic).toBe(actingCustomer.id);

            const session = await server.app
                .get(SessionService)
                .getSessionFromToken(shopClient.getAuthToken());
            expect(session !== undefined, `${diagnostic}: the bearer token resolved to no session`).toBe(
                true,
            );
            const sessionUser = session?.user;
            expect(sessionUser !== undefined, `${diagnostic}: the session carries no user`).toBe(true);
            const permissionsOnChannel = (sessionUser?.channelPermissions ?? []).find(
                entry => decodeId(entry.id) === defaultChannelDbId,
            );
            expect(permissionsOnChannel?.permissions, diagnostic).toEqual([Permission.Authenticated]);
            for (const entry of sessionUser?.channelPermissions ?? []) {
                expect(
                    entry.permissions,
                    `${diagnostic}: a session cannot hold Permission.Owner`,
                ).not.toContain(Permission.Owner);
            }

            const channelTokenKey =
                server.app.get(ConfigService).apiOptions.channelTokenKey ?? 'vendure-token';
            const syntheticRequest = {
                query: {},
                headers: { [channelTokenKey]: E2E_DEFAULT_CHANNEL_TOKEN },
            };
            const gatedContext = await server.app
                .get(RequestContextService)
                .fromRequest(syntheticRequest as never, undefined, [Permission.Owner], session);
            expect(gatedContext.authorizedAsOwnerOnly, diagnostic).toBe(true);
            expect(gatedContext.channel.token, diagnostic).toBe(E2E_DEFAULT_CHANNEL_TOKEN);

            const result = await createReorderList('Checkpoint four list');
            expect(result.__typename, `${diagnostic}: the gate refused an authenticated buyer`).toBe(
                'ReorderList',
            );
        });
    });

    describe('AC-1: a named list is created for the authenticated customer in the active channel', () => {
        it('createReorderList returns the submitted name character for character with lineCount exactly 0', async () => {
            const result = expectCreated(await createReorderList(BASE_LIST_NAME));

            expect(result.name).toBe(BASE_LIST_NAME);
            expect(result.name.length).toBe(BASE_LIST_NAME.length);
            // at all, the first arriving with `addItemToReorderList` in STORY-001-01-02.
            expect(result.lineCount).toBe(0);
            expect(result.lines.totalItems).toBe(0);
            expect(result.lines.items).toEqual([]);
            // construction because no grant table exists until FEATURE-001-06.
            expect(result.viewerAccess).toEqual({ access: 'OWNED', grantedCapabilities: [] });
            expect(await countAllLines()).toBe(0);
        });

        it('createReorderList stores the authenticated customerId and the token channelId', async () => {
            const result = expectCreated(await createReorderList(BASE_LIST_NAME));

            const row = await readTheOnlyListRow();
            expect(Number(row.customerId)).toBe(actingCustomerDbId);
            expect(Number(row.channelId)).toBe(defaultChannelDbId);
            expect(Number(row.id)).toBe(decodeId(result.id));
            expect(await countLists(actingCustomerDbId, defaultChannelDbId)).toBe(1);
            expect(await countLists(otherCustomerDbId, defaultChannelDbId)).toBe(0);
            expect(await countLists(actingCustomerDbId, secondChannelDbId)).toBe(0);
        });

        it('createReorderList returns the same name string under a second languageCode', async () => {
            const created = expectCreated(await createReorderList(BASE_LIST_NAME));
            expect(created.name).toBe(BASE_LIST_NAME);
            const storedKey = String((await readTheOnlyListRow()).nameKey);

            const conflict = expectNameConflict(
                await createReorderListInLanguage(BASE_LIST_NAME, SECOND_LANGUAGE_CODE),
            );
            expect(conflict.conflictingNameKey).toBe(storedKey);
            expect(await countLists(actingCustomerDbId, defaultChannelDbId)).toBe(1);

            const otherName = `${BASE_LIST_NAME} (second language)`;
            const inSecondLanguage = expectCreated(
                await createReorderListInLanguage(otherName, SECOND_LANGUAGE_CODE),
            );
            expect(inSecondLanguage.name).toBe(otherName);
            const storedNames = (await readAllListRows()).map(row => String(row.name)).sort();
            expect(storedNames).toEqual([BASE_LIST_NAME, otherName].sort());
        });

        it('createReorderList returns a markup-bearing name byte-for-byte', async () => {
            const result = expectCreated(await createReorderList(MARKUP_LIST_NAME));

            // only; the rendering half belongs to STORY-001-08-03 in batch B5 and is not claimed here.
            expect(result.name).toBe(MARKUP_LIST_NAME);
            expect(result.name).toContain('<b>');
            expect(result.name).toContain('&amp;');
            expect(result.name).not.toContain('&lt;');
            expect(result.name).not.toContain(' & ');

            const row = await readTheOnlyListRow();
            expect(String(row.name)).toBe(MARKUP_LIST_NAME);
        });

        it('createReorderList stores exactly five data columns beyond id, createdAt and updatedAt', async () => {
            expectCreated(await createReorderList(BASE_LIST_NAME));

            const row = await readTheOnlyListRow();
            const observedColumns = Object.keys(row).sort();
            expect(observedColumns).toEqual(
                [...EXPECTED_LIST_DATA_COLUMNS, ...INHERITED_ENTITY_COLUMNS].sort(),
            );

            const declaredColumns = dataSource
                .getMetadata(ReorderList)
                .columns.map(column => column.databaseName)
                .sort();
            expect(declaredColumns).toEqual(observedColumns);

            for (const column of EXPECTED_LIST_DATA_COLUMNS) {
                expect(observedColumns, `${LIST_TABLE} is missing the column ${column}`).toContain(column);
            }
            for (const column of INHERITED_ENTITY_COLUMNS) {
                expect(observedColumns, `${LIST_TABLE} is missing the inherited column ${column}`).toContain(
                    column,
                );
            }
            expect(Number(row.lineCount)).toBe(0);
            expect(String(row.nameKey)).toBe(BASE_LIST_NAME.toLowerCase());
        });

        it('createReorderList declares no monetary, currency or stock field on its input or its payload', () => {
            const pluginOwnedTypes = [
                'ReorderList',
                'ReorderListLine',
                'ReorderListViewerAccess',
                'ReorderListList',
                'ReorderListLineList',
            ];
            for (const typeName of pluginOwnedTypes) {
                for (const fieldName of sortedFieldNames(liveSchema, typeName)) {
                    expect(
                        MONETARY_OR_STOCK_FIELD.test(fieldName),
                        `${typeName}.${fieldName} looks like a monetary, currency or stock field`,
                    ).toBe(false);
                }
            }
            for (const fieldName of sortedInputFieldNames(liveSchema, 'CreateReorderListInput')) {
                expect(
                    MONETARY_OR_STOCK_FIELD.test(fieldName),
                    `CreateReorderListInput.${fieldName} looks like a monetary, currency or stock field`,
                ).toBe(false);
            }
            for (const column of dataSource.getMetadata(ReorderList).columns) {
                expect(
                    MONETARY_OR_STOCK_FIELD.test(column.databaseName),
                    `${LIST_TABLE}.${column.databaseName} looks like a monetary or stock column`,
                ).toBe(false);
            }
        });
    });

    describe('AC-2: a name failing the input contract is rejected and writes no row', () => {
        /**
         * The four names AC-2 names, each with the reason it fails.
         *
         * They share one operation, one `Then` and one table, so they are one table-driven case rather than
         * four criteria. Each is refused by canonicalisation BEFORE any statement is issued, which is why the
         * row count cannot move.
         */
        const refusedNames: Array<{ label: string; name: string }> = [
            { label: 'a name consisting only of space characters', name: '     ' },
            {
                label: `a name one character longer than the fixed ${MAX_LIST_NAME_LENGTH}-character bound`,
                name: nameOfLength(MAX_LIST_NAME_LENGTH + 1),
            },
            { label: 'a name containing the C0 control character U+0007', name: 'Alarm\u0007 list' },
            { label: 'a name containing the zero-width character U+200B', name: 'Zero\u200Bwidth list' },
        ];

        it('createReorderList refuses all four malformed names with exactly one USER_INPUT_ERROR each', async () => {
            for (const { label, name } of refusedNames) {
                const countBefore = await countLists(actingCustomerDbId, defaultChannelDbId);

                const response = await expectTopLevelFailure(
                    () => createReorderList(name),
                    `${label} was accepted rather than refused`,
                );
                expectExactlyOneTopLevelError(response, USER_INPUT_ERROR_CODE);

                expect(
                    await countLists(actingCustomerDbId, defaultChannelDbId),
                    `${label} changed the stored row count`,
                ).toBe(countBefore);
                expect(await readAllListRows(), `${label} wrote a row`).toEqual([]);
            }
        });

        it('createReorderList accepts a canonical name of exactly 190 characters', async () => {
            const name = nameOfLength(MAX_LIST_NAME_LENGTH - 1);
            const result = expectCreated(await createReorderList(name));

            expect(result.name).toBe(name);
            expect(result.name.length).toBe(MAX_LIST_NAME_LENGTH - 1);
            expect(String((await readTheOnlyListRow()).name)).toBe(name);
        });

        it('createReorderList accepts a canonical name of exactly 191 characters and stores it whole', async () => {
            const name = nameOfLength(MAX_LIST_NAME_LENGTH);
            const result = expectCreated(await createReorderList(name));

            expect(result.name).toBe(name);
            expect(result.name.length).toBe(MAX_LIST_NAME_LENGTH);
            const row = await readTheOnlyListRow();
            expect(String(row.name)).toBe(name);
            expect(String(row.name).length).toBe(MAX_LIST_NAME_LENGTH);
        });

        it('createReorderList refuses 192 characters and stores nothing truncated, proved by the 191st', async () => {
            const overLong = nameOfLength(MAX_LIST_NAME_LENGTH + 1);

            const response = await expectTopLevelFailure(
                () => createReorderList(overLong),
                'A 192-character name was accepted rather than refused',
            );
            expectExactlyOneTopLevelError(response, USER_INPUT_ERROR_CODE);
            expect(await readAllListRows()).toEqual([]);

            const trimmedToBound = overLong.slice(0, MAX_LIST_NAME_LENGTH);
            expect(trimmedToBound.length).toBe(MAX_LIST_NAME_LENGTH);
            const stored = expectCreated(await createReorderList(trimmedToBound));
            expect(stored.name).toBe(trimmedToBound);
            expect(await countLists(actingCustomerDbId, defaultChannelDbId)).toBe(1);
            expect(String((await readTheOnlyListRow()).name)).toBe(trimmedToBound);
        });

        it('createReorderList accepts an emoji name and stores every code point of it', async () => {
            // submitted string trimmed and collapsed and NOTHING ELSE [AAP §0.1.2.5]. An earlier revision of
            const emojiName = 'Favourites \u2764\uFE0F \u{1F468}\u200D\u{1F469}\u200D\u{1F467} Co\u00ADop';

            const created = expectCreated(await createReorderList(emojiName));

            expect(created.name).toBe(emojiName);
            expect(Array.from(created.name)).toEqual(Array.from(emojiName));
            const row = await readTheOnlyListRow();
            expect(String(row.name)).toBe(emojiName);
            expect(Array.from(String(row.name))).toEqual(Array.from(emojiName));
            expect(String(row.nameKey)).toBe(emojiName.toLowerCase());
        });
    });

    describe('AC-3: a name the same customer already holds returns ReorderListNameConflictError', () => {
        it('createReorderList refuses an identical and a case-folded name, leaving exactly one row', async () => {
            const created = expectCreated(await createReorderList(BASE_LIST_NAME));
            const storedKey = String((await readTheOnlyListRow()).nameKey);
            expect(storedKey).toBe(BASE_LIST_NAME.toLowerCase());

            const identical = expectNameConflict(await createReorderList(BASE_LIST_NAME));
            expect(identical.errorCode).toBe('REORDER_LIST_NAME_CONFLICT_ERROR');
            expect(identical.conflictingNameKey).toBe(storedKey);
            expect(identical.message.length).toBeGreaterThan(0);
            expect(await countLists(actingCustomerDbId, defaultChannelDbId)).toBe(1);

            const caseFolded = expectNameConflict(await createReorderList(BASE_LIST_NAME.toUpperCase()));
            expect(caseFolded.errorCode).toBe('REORDER_LIST_NAME_CONFLICT_ERROR');
            expect(caseFolded.conflictingNameKey).toBe(storedKey);

            expect(await countLists(actingCustomerDbId, defaultChannelDbId)).toBe(1);
            expect(await countListsWithKey(actingCustomerDbId, defaultChannelDbId, storedKey)).toBe(1);
            expect(String((await readTheOnlyListRow()).name)).toBe(BASE_LIST_NAME);
        });

        it('createReorderList refuses a name differing only by surrounding and internal whitespace', async () => {
            expectCreated(await createReorderList(BASE_LIST_NAME));
            const storedKey = String((await readTheOnlyListRow()).nameKey);

            for (const variant of [
                `  ${BASE_LIST_NAME}  `,
                `\t${BASE_LIST_NAME}\n`,
                BASE_LIST_NAME.replace(/ /g, '   '),
            ]) {
                const conflict = expectNameConflict(await createReorderList(variant));
                expect(
                    conflict.conflictingNameKey,
                    `"${variant}" did not canonicalise onto the stored key`,
                ).toBe(storedKey);
            }
            expect(await countLists(actingCustomerDbId, defaultChannelDbId)).toBe(1);
        });

        it('createReorderList treats a decomposed Unicode name as the same and an unaccented one as distinct', async () => {
            const precomposed = 'Caf\u00E9 weekly restock';
            const decomposed = 'Cafe\u0301 weekly restock';
            const unaccented = 'Cafe weekly restock';
            expect(precomposed).not.toBe(decomposed);

            expectCreated(await createReorderList(precomposed));
            const storedKey = String((await readTheOnlyListRow()).nameKey);

            const conflict = expectNameConflict(await createReorderList(decomposed));
            expect(conflict.conflictingNameKey).toBe(storedKey);
            expect(await countLists(actingCustomerDbId, defaultChannelDbId)).toBe(1);

            const distinct = expectCreated(await createReorderList(unaccented));
            expect(distinct.name).toBe(unaccented);
            expect(await countLists(actingCustomerDbId, defaultChannelDbId)).toBe(2);
        });
    });

    describe('AC-4: the configured list bound returns ReorderListLimitError and cannot be exceeded', () => {
        /**
         * One side of a create race: its precheck counts the lists it holds on its OWN connection, and its write is
         * THE REAL SERVICE OPERATION, executed on that same connection inside that same open transaction.
         */
        function racingCreate(
            label: string,
            sessionContext: RequestContext,
            name: string,
            expectedHeldBeforeEitherWrite: number,
        ): BarrierParticipantSpec<CreateReorderListResult, number> {
            return {
                label,
                precheck: async () =>
                    // ON THE SHARED CONNECTION, NOT THIS PARTICIPANT'S TRANSACTION, and that is a correctness
                    // requirement rather than a preference. Under the MySQL family's default REPEATABLE READ, a
                    // transaction's snapshot is fixed by its first CONSISTENT read — so a precheck issued inside
                    // the participant's own transaction would fix it BEFORE the service's locking read, and the
                    // and the participant's transaction reaches the service uncontaminated, exactly as a real
                    dataSource
                        .getRepository(ReorderList)
                        .count({ where: { customerId: actingCustomerDbId, channelId: defaultChannelDbId } }),
                write: async ctx => {
                    expect(
                        ctx.precheckResult,
                        `${label} did not observe ${expectedHeldBeforeEitherWrite} held list(s) before ` +
                            'either participant wrote, so this run evidences no race',
                    ).toBe(expectedHeldBeforeEitherWrite);
                    const boundContext = transactionBinder.bind(sessionContext, ctx.manager);
                    expect(
                        transactionBinder.managerOf(boundContext),
                        `${label} is not bound to its own barrier transaction`,
                    ).toBe(ctx.manager);
                    return reorderListService.createReorderList(boundContext, { name });
                },
            };
        }

        /**
         * Asserts the outcome the barrier-released pair must produce, over THE SERVICE'S OWN RETURN VALUES.
         */
        function expectExactlyOneServiceCreateAndOneLimitRefusal(results: CreateReorderListResult[]): void {
            const rendered = results.map(describeServiceResult).join(' | ');
            const created = results.filter((result): result is ReorderList => result instanceof ReorderList);
            const refused = results.filter(
                (result): result is ReorderListLimitError => result instanceof ReorderListLimitError,
            );
            expect(created.length, `Expected exactly one created list: ${rendered}`).toBe(1);
            expect(refused.length, `Expected exactly one ReorderListLimitError: ${rendered}`).toBe(1);
            expect(refused[0].__typename).toBe('ReorderListLimitError');
            expect(refused[0].errorCode).toBe('REORDER_LIST_LIMIT_ERROR');
            expect(refused[0].maxItems).toBe(MAX_LISTS_PER_CUSTOMER);
            expect(refused[0].message.length).toBeGreaterThan(0);
            expect(created[0].lineCount).toBe(0);
            expect(Number(created[0].customerId)).toBe(actingCustomerDbId);
            expect(Number(created[0].channelId)).toBe(defaultChannelDbId);
        }

        /**
         * Asserts the outcome both the barriered pair and the sequential pair must produce: one caller receives
         * a `ReorderList`, the other receives `ReorderListLimitError` carrying the configured maximum, and the
         * stored row count lands on the bound rather than one past it.
         */
        function expectExactlyOneCreateAndOneLimitRefusal(results: CreateReorderListResultShape[]): void {
            const created = results.filter(result => result.__typename === 'ReorderList');
            const refused = results.filter(result => result.__typename === 'ReorderListLimitError');
            expect(created.length, `Expected one ReorderList: ${JSON.stringify(results)}`).toBe(1);
            expect(refused.length, `Expected one ReorderListLimitError: ${JSON.stringify(results)}`).toBe(1);
            expect(refused[0].maxItems).toBe(MAX_LISTS_PER_CUSTOMER);
            expect(refused[0].errorCode).toBe('REORDER_LIST_LIMIT_ERROR');
        }

        it('createReorderList refuses a customer already holding exactly the maximum, writing no row', async () => {
            await seedLists('AC-4 held', MAX_LISTS_PER_CUSTOMER);
            expect(await countLists(actingCustomerDbId, defaultChannelDbId)).toBe(MAX_LISTS_PER_CUSTOMER);
            const namesBefore = (await readAllListRows()).map(row => String(row.name)).sort();

            const refused = expectLimit(await createReorderList('AC-4 one list too many'));

            expect(refused.maxItems).toBe(MAX_LISTS_PER_CUSTOMER);
            expect(refused.errorCode).toBe('REORDER_LIST_LIMIT_ERROR');
            expect(refused.message.length).toBeGreaterThan(0);
            expect(await countLists(actingCustomerDbId, defaultChannelDbId)).toBe(MAX_LISTS_PER_CUSTOMER);
            expect((await readAllListRows()).map(row => String(row.name)).sort()).toEqual(namesBefore);
        });

        it.skipIf(!isStatementCountEngine())(
            `createReorderList refuses at the bound with exactly one scoped statement — ${STATEMENT_COUNT_ENGINE_REASON}`,
            async () => {
                // THE PLUGIN-STATEMENT BOUNDARY, the only boundary at which an exact number is asserted, and
                // the counted form of the refused-write contract of FEATURE-001-01 section 2.6.1.1. The
                // asserted by the ungated case above and therefore runs on all four engine jobs.
                await seedLists('AC-4 instrumented', MAX_LISTS_PER_CUSTOMER);

                capture.reset();
                const refused = expectLimit(
                    await capture.capture(() => createReorderList('AC-4 instrumented refusal')),
                );
                expect(refused.maxItems).toBe(MAX_LISTS_PER_CUSTOMER);

                const scoped = capture.selectsFor(LIST_TABLE);
                expect(scoped.length, `filtered to ${LIST_TABLE}:\n${capture.format()}`).toBe(1);
                expect(
                    capture.writesFor(LIST_TABLE).length,
                    `filtered to ${LIST_TABLE}:\n${capture.format()}`,
                ).toBe(0);
                expect(
                    capture.writesFor(LINE_TABLE).length,
                    `filtered to ${LINE_TABLE}:\n${capture.format()}`,
                ).toBe(0);
                // And that one statement is SCOPED: the acting customer and the active channel are mandatory
                // conjuncts of its predicate, with each value bound to its own column. The ownership helper is
                // sub-query-supplied token would satisfy a name search and scope nothing.
                expect(
                    whereRequiresScopedPredicates(scoped[0], [
                        { column: 'customerId', value: actingCustomerDbId, relation: listAlias },
                        { column: 'channelId', value: defaultChannelDbId, relation: listAlias },
                    ]),
                    `filtered to ${LIST_TABLE}:\n${capture.format()}`,
                ).toBe(true);
            },
        );

        it.skipIf(!supportsForcedInterleaving())(
            `locks the owning customer row and no second table on ${resolveConfiguredEngine()}`,
            async () => {
                // THE BLAST RADIUS OF THE LOCK, ASSERTED AS A STATEMENT SHAPE.
                // The list bound is enforced by counting and inserting inside one transaction under a
                // pessimistic lock on the owning `customer` row, and the lock's WIDTH is a property no payload
                // can show. TypeORM renders `setLock('pessimistic_write')` as a bare `FOR UPDATE` with no `OF`
                // list, and a bare `FOR UPDATE` locks a row in EVERY table the statement reads — so a shape
                // "customer"."userId"` would hold a lock on a `user` row too, for the whole of the
                // transaction, on a row an authentication path may itself be writing. Nothing about the
                capture.reset();
                const created = await capture.capture(() => createReorderList('Customer lock scope'));
                expect(created.__typename).toBe('ReorderList');

                const locked = capture.statements.filter(
                    statement => classifyLockClause(statement) !== 'none',
                );
                expect(locked.length, capture.format()).toBe(1);
                expect(classifyLockClause(locked[0]), capture.format()).toBe('exclusive');
                expect(locked[0].kind, capture.format()).toBe('select');
                expect(locked[0].tables, capture.format()).toEqual(['customer']);
                // And it is its TRANSACTION's first statement, which the bound separately depends on: on the
                // MySQL family a plain read issued before the lock would fix this transaction's read view
                // before the lock was held, and the count would then answer from a snapshot older than a
                const beforeOnSameConnection = capture.statements.filter(
                    statement =>
                        statement.runnerId === locked[0].runnerId && statement.sequence < locked[0].sequence,
                );
                expect(
                    beforeOnSameConnection.map(statement => statement.kind),
                    capture.format(),
                ).toEqual(beforeOnSameConnection.map(() => 'transaction'));
            },
        );

        it.skipIf(!supportsForcedInterleaving())(
            `createReorderList admits exactly one of two barrier-released creates on ${resolveConfiguredEngine()}`,
            async () => {
                // FORCED INTERLEAVING, on the three engine jobs that run a database server this suite can open
                await seedLists('AC-4 racing held', MAX_LISTS_PER_CUSTOMER - 1);
                expect(await countLists(actingCustomerDbId, defaultChannelDbId)).toBe(
                    MAX_LISTS_PER_CUSTOMER - 1,
                );
                await secondShopClient.asUserWithCredentials(
                    actingCustomer.emailAddress,
                    SEEDED_CUSTOMER_PASSWORD,
                );
                secondShopClient.setChannelToken(E2E_DEFAULT_CHANNEL_TOKEN);

                const firstContext = await shopContextFor(shopClient);
                const secondContext = await shopContextFor(secondShopClient);

                const outcome = await runBarrieredPair(dataSource, {
                    a: racingCreate('first-writer', firstContext, 'AC-4 racing alpha', 1),
                    b: racingCreate('second-writer', secondContext, 'AC-4 racing beta', 1),
                });

                // held at the rendezvous and released before writing; asserting it makes that explicit.
                expect(
                    outcome.rejected.length,
                    JSON.stringify(outcome.rejected.map(entry => String(entry.label))),
                ).toBe(0);
                expect(outcome.fulfilled.length).toBe(2);
                expect(outcome.a.releasedBeforeWrite).toBe(true);
                expect(outcome.b.releasedBeforeWrite).toBe(true);

                const results = outcome.fulfilled.map(
                    entry => (entry as { value: CreateReorderListResult }).value,
                );
                expectExactlyOneServiceCreateAndOneLimitRefusal(results);

                expect(await countLists(actingCustomerDbId, defaultChannelDbId)).toBe(MAX_LISTS_PER_CUSTOMER);
                expect(
                    await countListsWithKey(
                        actingCustomerDbId,
                        defaultChannelDbId,
                        String(
                            (results.find(result => result instanceof ReorderList) as ReorderList).nameKey,
                        ),
                    ),
                ).toBe(1);
            },
            DEFAULT_PAIR_BUDGET_MS + 15000,
        );

        it('createReorderList admits exactly one of two sequential creates at the bound on every engine', async () => {
            // The SEQUENTIAL form of the same contract, ungated so that it runs on all four engine jobs. On the
            await seedLists('AC-4 sequential held', MAX_LISTS_PER_CUSTOMER - 1);
            await secondShopClient.asUserWithCredentials(
                actingCustomer.emailAddress,
                SEEDED_CUSTOMER_PASSWORD,
            );
            secondShopClient.setChannelToken(E2E_DEFAULT_CHANNEL_TOKEN);

            const first = await createReorderList('AC-4 sequential alpha', shopClient);
            const second = await createReorderList('AC-4 sequential beta', secondShopClient);

            expectExactlyOneCreateAndOneLimitRefusal([first, second]);
            expect(await countLists(actingCustomerDbId, defaultChannelDbId), SEQUENTIAL_FORM_NOTE).toBe(
                MAX_LISTS_PER_CUSTOMER,
            );
        });
    });

    describe('AC-5: an unauthenticated request writes nothing', () => {
        it('createReorderList refuses an unauthenticated request with exactly one FORBIDDEN entry', async () => {
            await shopClient.asAnonymousUser();
            shopClient.setChannelToken(E2E_DEFAULT_CHANNEL_TOKEN);
            expect(await readAllListRows()).toEqual([]);

            const response = await expectTopLevelFailure(
                () => createReorderList('AC-5 unauthenticated list'),
                'An unauthenticated createReorderList was accepted rather than refused',
            );

            // FORBIDDEN and NOT UNAUTHORIZED: the platform raises `UnauthorizedError` where credentials do not
            // match, whereas an absent session on a permission-gated operation is reported as forbidden.
            expectExactlyOneTopLevelError(response, FORBIDDEN_ERROR_CODE);
            expect(response.errors[0].extensions?.code).not.toBe('UNAUTHORIZED');

            // THE REFUSAL COMES FROM THE SERVICE'S OWN OWNERSHIP GUARD, NOT FROM THE GATE. `@Allow` lists
            expect(await readAllListRows()).toEqual([]);
            expect(await countLists(actingCustomerDbId, defaultChannelDbId)).toBe(0);
            expect(await countAllLines()).toBe(0);
        });
    });

    describe('AC-6: an ordinary customer session succeeds and cannot nominate a different owner', () => {
        it('createReorderList succeeds for a session holding only Permission.Authenticated', async () => {
            expect(seededCustomers.length).toBeGreaterThanOrEqual(2);
            expect(actingCustomer.id).not.toBe(otherCustomer.id);
            expect(await countLists(otherCustomerDbId, defaultChannelDbId)).toBe(0);

            const created = expectCreated(await createReorderList('AC-6 ordinary session list'));

            const row = await readTheOnlyListRow();
            expect(Number(row.customerId)).toBe(actingCustomerDbId);
            expect(Number(row.channelId)).toBe(defaultChannelDbId);
            expect(Number(row.id)).toBe(decodeId(created.id));

            expect(await countLists(otherCustomerDbId, defaultChannelDbId)).toBe(0);
            expect(await countLists(otherCustomerDbId, secondChannelDbId)).toBe(0);
        });

        it('createReorderList exposes no argument able to nominate a different owner', async () => {
            expect(sortedInputFieldNames(liveSchema, 'CreateReorderListInput')).toEqual(['name']);

            const mutationFields = requireType(liveSchema, 'Mutation').fields ?? [];
            const createField = mutationFields.find(field => field.name === 'createReorderList');
            expect(createField, 'createReorderList is absent from the root Mutation type').toBeDefined();
            expect((createField?.args ?? []).map(arg => arg.name)).toEqual(['input']);
            expect(renderFieldSignature(createField as IntrospectedField)).toBe(
                'createReorderList(input: CreateReorderListInput!): CreateReorderListResult!',
            );

            const created = expectCreated(await createReorderList('AC-6 owner is session derived'));
            expect(Number((await readTheOnlyListRow()).customerId)).toBe(actingCustomerDbId);
            expect(created.name).toBe('AC-6 owner is session derived');
        });
    });

    describe('AC-7: concurrent same-name creates leave exactly one row and one exact conflict error', () => {
        /**
         * One side of a same-name race: precheck counts the rows already carrying the canonical key, write is a
         * real API call carrying that name.
         */
        function racingSameNameCreate(
            label: string,
            sessionContext: RequestContext,
            name: string,
            nameKey: string,
            preWrite: PreWriteRendezvous,
        ): BarrierParticipantSpec<CreateReorderListResult, number> {
            return {
                label,
                precheck: async () =>
                    // ON THE SHARED CONNECTION, NOT THIS PARTICIPANT'S TRANSACTION, and that is a correctness
                    // requirement rather than a preference. Under the MySQL family's default REPEATABLE READ, a
                    // transaction's snapshot is fixed by its first CONSISTENT read — so a precheck issued inside
                    // the participant's own transaction would fix it BEFORE the service's locking read, and the
                    // and the participant's transaction reaches the service uncontaminated, exactly as a real
                    dataSource.getRepository(ReorderList).count({
                        where: {
                            customerId: actingCustomerDbId,
                            channelId: defaultChannelDbId,
                            nameKey,
                        },
                    }),
                write: async ctx => {
                    expect(
                        ctx.precheckResult,
                        `${label} saw the name already held before either participant wrote, so this run ` +
                            'evidences no race',
                    ).toBe(0);
                    // THE REAL SERVICE OPERATION, on this participant's own held transaction. Over HTTP the
                    // server would open its own transaction on a connection this barrier never touched, and
                    const boundContext = transactionBinder.bind(sessionContext, ctx.manager);
                    expect(
                        transactionBinder.managerOf(boundContext),
                        `${label} is not bound to its own barrier transaction`,
                    ).toBe(ctx.manager);
                    // this harness. `createReorderList` takes a pessimistic write lock on the owning customer
                    // row as its FIRST statement (`getLockedOwnerScope`, taken for lock ORDER across the
                    // service), so a second caller for the same customer blocks there and can never reach its
                    // own write while the first is held: a two-participant hold placed here would deadlock
                    // hold does establish is that the operation's first statement against a plugin table was
                    // here rather than quietly turn this race back into two independent requests.
                    const hold = preWrite.install(ctx);
                    try {
                        return await reorderListService.createReorderList(boundContext, { name });
                    } finally {
                        hold.restore();
                    }
                },
            };
        }

        /**
         * Asserts the outcome the barrier-released same-name pair must produce, over THE SERVICE'S OWN RETURN
         * VALUES rather than over a re-serialised response.
         */
        function expectExactlyOneServiceCreateAndOneNameConflict(results: CreateReorderListResult[]): void {
            const rendered = results.map(describeServiceResult).join(' | ');
            const created = results.filter((result): result is ReorderList => result instanceof ReorderList);
            const refused = results.filter(
                (result): result is ReorderListNameConflictError =>
                    result instanceof ReorderListNameConflictError,
            );
            expect(created.length, `Expected exactly one created list: ${rendered}`).toBe(1);
            expect(refused.length, `Expected exactly one conflict: ${rendered}`).toBe(1);
            expect(refused[0].__typename).toBe('ReorderListNameConflictError');
            expect(refused[0].errorCode).toBe('REORDER_LIST_NAME_CONFLICT_ERROR');
            expect(refused[0].conflictingNameKey).toBe(String(created[0].nameKey));
            expectNoDriverDetail(refused[0].message);
        }

        /** Asserts the outcome both halves of AC-7 must produce for a duplicate-name pair. */
        function expectExactlyOneCreateAndOneNameConflict(results: CreateReorderListResultShape[]): void {
            const created = results.filter(result => result.__typename === 'ReorderList');
            const refused = results.filter(result => result.__typename === 'ReorderListNameConflictError');
            expect(created.length, `Expected one ReorderList: ${JSON.stringify(results)}`).toBe(1);
            expect(refused.length, `Expected one conflict: ${JSON.stringify(results)}`).toBe(1);
            const conflict = refused[0];
            expect(conflict.errorCode).toBe('REORDER_LIST_NAME_CONFLICT_ERROR');
            expect(conflict.conflictingNameKey.length).toBeGreaterThan(0);
            // no driver text, no SQL fragment and no constraint name — a raw driver message can disclose the
            expectNoDriverDetail(conflict.message);
        }

        /**
         * Asserts an API-visible message discloses nothing about the database.
         *
         * Each needle is a thing a raw driver message routinely carries and a buyer-facing message must not: the
         * constraint's own name, the table and column names, the SQL verbs and the drivers' own wordings.
         */
        function expectNoDriverDetail(message: string): void {
            const lowered = message.toLowerCase();
            for (const needle of [
                NAME_CONFLICT_CONSTRAINT.toLowerCase(),
                LIST_TABLE,
                LINE_TABLE,
                'namekey',
                'insert',
                'select',
                'update',
                'duplicate entry',
                'unique constraint',
                'sqlstate',
                'er_dup_entry',
            ]) {
                expect(lowered, `The API-visible message discloses "${needle}": ${message}`).not.toContain(
                    needle,
                );
            }
        }

        it.skipIf(!supportsForcedInterleaving())(
            `createReorderList admits exactly one of two barrier-released duplicate names on ${resolveConfiguredEngine()}`,
            async () => {
                // The BARRIER half, on the three server engines only. sql.js carries the constraint-shape half
                // below and is not offered as concurrency evidence — see SEQUENTIAL_FORM_NOTE.
                const nameKey = BASE_LIST_NAME.toLowerCase();
                expect(await countListsWithKey(actingCustomerDbId, defaultChannelDbId, nameKey)).toBe(0);
                await secondShopClient.asUserWithCredentials(
                    actingCustomer.emailAddress,
                    SEEDED_CUSTOMER_PASSWORD,
                );
                secondShopClient.setChannelToken(E2E_DEFAULT_CHANNEL_TOKEN);

                const firstContext = await shopContextFor(shopClient);
                const secondContext = await shopContextFor(secondShopClient);

                // One rendezvous per participant, for the participant-count reason documented in
                const firstPreWrite = createPreWriteRendezvous({
                    participants: 1,
                    tables: [LIST_TABLE],
                });
                const secondPreWrite = createPreWriteRendezvous({
                    participants: 1,
                    tables: [LIST_TABLE],
                });

                const outcome = await runBarrieredPair(dataSource, {
                    a: racingSameNameCreate(
                        'first-writer',
                        firstContext,
                        BASE_LIST_NAME,
                        nameKey,
                        firstPreWrite,
                    ),
                    b: racingSameNameCreate(
                        'second-writer',
                        secondContext,
                        BASE_LIST_NAME,
                        nameKey,
                        secondPreWrite,
                    ),
                });

                // a matcher. The describer beside it is the redacted diagnostic.
                expect(outcome.rejected.length, describeAbandonedPair(outcome)).toBe(0);
                expect(outcome.fulfilled.length).toBe(2);
                expect(outcome.a.releasedBeforeWrite).toBe(true);
                expect(outcome.b.releasedBeforeWrite).toBe(true);
                // scoped duplicate count it takes under the lock the winner has already released.
                expect(
                    firstPreWrite.arrivedCount() + secondPreWrite.arrivedCount(),
                    'Exactly one of the two callers should have reached a write against the list table',
                ).toBe(1);

                expectExactlyOneServiceCreateAndOneNameConflict(
                    outcome.fulfilled.map(entry => (entry as { value: CreateReorderListResult }).value),
                );
                expect(await countListsWithKey(actingCustomerDbId, defaultChannelDbId, nameKey)).toBe(1);
                expect(await countLists(actingCustomerDbId, defaultChannelDbId)).toBe(1);
            },
            DEFAULT_PAIR_BUDGET_MS + 15000,
        );

        /**
         * How long the competing transaction keeps re-offering its lock request after the release.
         *
         * This bound is on a POSITIVE outcome — the acquisition must happen — so a slow engine costs time
         * rather than a wrong verdict. Nothing anywhere in this case infers a lock from elapsed time.
         */
        const LOCK_REACQUIRE_BUDGET_MS = 8000;

        /** The savepoint the competing lock attempt is wrapped in, so a refusal does not poison its
         * transaction. PostgreSQL puts a transaction whose statement failed into an aborted state in which
         * every later statement is refused, so without this the retry after the release could not run. */
        const LOCK_PROBE_SAVEPOINT = 'reorder_lock_probe';

        /**
         * The ceiling on how long the engine may take to REFUSE the competing lock.
         */
        const LOCK_REFUSAL_CEILING_MS = 8000;

        /**
         * Both outcomes of a pair rendered for a diagnostic, through the shared describer.
         */
        function describeAbandonedPair(result: {
            a: { label: string; status: string; reason?: unknown };
            b: { label: string; status: string; reason?: unknown };
        }): string {
            return describeSettledOutcomes([result.a, result.b]);
        }

        /**
         * The competing lock request, spelled so that the ENGINE answers it immediately either way.
         */
        function competingLockSql(): string {
            return (
                `SELECT ${esc('id')} FROM ${esc('customer')} ` +
                `WHERE ${esc('id')} = ${actingCustomerDbId} FOR UPDATE NOWAIT`
            );
        }

        /**
         * An unrecognised engine answer described so a new spelling is added deliberately rather than guessed.
         */
        function describeUnknownError(err: unknown): string {
            return redactTeardownDiagnostic(err);
        }

        /**
         * Whether an error is the engine saying "that row is locked by someone else, and you said NOWAIT".
         */
        function isLockNotAvailable(err: unknown): boolean {
            const candidate = err as { code?: unknown; errno?: unknown; message?: unknown } | undefined;
            const code = String(candidate?.code);
            if (code === '55P03' || code === 'ER_LOCK_NOWAIT' || code === 'ER_LOCK_WAIT_TIMEOUT') {
                return true;
            }
            if (Number(candidate?.errno) === 3572 || Number(candidate?.errno) === 1205) {
                return true;
            }
            const message = String(candidate?.message ?? '').toLowerCase();
            return (
                message.includes('could not obtain lock') ||
                message.includes('nowait is set') ||
                message.includes('lock wait timeout exceeded')
            );
        }

        /**
         * Offers the competing lock request once, inside its own savepoint, and reports what the engine said.
         *
         * `undefined` means the lock was acquired; anything else is the refusal the engine returned. The
         * savepoint is released on success and rolled back on refusal, so the transaction is usable either
         * way and the request can be offered again after the window closes.
         */
        async function offerCompetingLock(runner: QueryRunner): Promise<unknown | undefined> {
            await runner.query(`SAVEPOINT ${LOCK_PROBE_SAVEPOINT}`);
            try {
                await runner.query(competingLockSql());
            } catch (err: unknown) {
                await runner.query(`ROLLBACK TO SAVEPOINT ${LOCK_PROBE_SAVEPOINT}`);
                return err ?? new Error('The engine refused the lock without an error object');
            }
            await runner.query(`RELEASE SAVEPOINT ${LOCK_PROBE_SAVEPOINT}`);
            return undefined;
        }

        it.skipIf(!supportsForcedInterleaving())(
            `holds createReorderList between its own duplicate lookup and its own insert on ${resolveConfiguredEngine()}`,
            async () => {
                /*
                 * WHAT THIS CASE ADDS TO THE PAIR ABOVE, AND WHY IT IS A SEPARATE CASE RATHER THAN AN ASSERTION
                 * INSIDE IT.
                 */
                expect(SQLJS_EXCLUSION_REASON.length).toBeGreaterThan(0);
                const nameKey = BASE_LIST_NAME.toLowerCase();
                expect(await countListsWithKey(actingCustomerDbId, defaultChannelDbId, nameKey)).toBe(0);

                const sessionContext = await shopContextFor(shopClient);
                const preWrite = createPreWriteRendezvous({ participants: 2, tables: [LIST_TABLE] });
                let heldBeforeItsOwnInsert: string | undefined;
                let holdReleasedBy: 'arrival' | undefined;
                let refusalWhileHeld: unknown;
                let refusalElapsedMs = -1;
                let lockAcquiredAfterRelease = false;
                let offersAfterRelease = 0;

                const outcome = await runBarrieredPair(dataSource, {
                    a: {
                        label: 'held-creator',
                        write: async ctx => {
                            const boundContext = transactionBinder.bind(sessionContext, ctx.manager);
                            expect(
                                transactionBinder.managerOf(boundContext),
                                'held-creator is not bound to its own barrier transaction',
                            ).toBe(ctx.manager);
                            const hold = preWrite.install(ctx);
                            try {
                                return await reorderListService.createReorderList(boundContext, {
                                    name: BASE_LIST_NAME,
                                });
                            } finally {
                                // Recorded before the patch is removed, so the statement the operation was
                                // reason is read rather than a whole-rendezvous aggregate.
                                heldBeforeItsOwnInsert = hold.heldBefore();
                                holdReleasedBy = hold.releasedBy();
                                hold.restore();
                            }
                        },
                    },
                    b: {
                        label: 'competing-locker',
                        write: async ctx => {
                            expect(
                                await preWrite.waitForArrivals(1),
                                'The creating operation never reached its own first write, so there was no ' +
                                    'window in which to offer the competing lock',
                            ).toBe(true);

                            // THE FIRST HALF OF THE EVIDENCE, AND THE ENGINE PRODUCES IT. The same row the
                            // operation locked is requested `NOWAIT`, so the answer is a refusal carrying the
                            // engine's own lock-not-available code — which is proof both that the statement
                            // reached the database and that the row was held by another transaction. Nothing
                            const offeredAt = Date.now();
                            refusalWhileHeld = await offerCompetingLock(ctx.queryRunner);
                            refusalElapsedMs = Date.now() - offeredAt;

                            // transaction committed by this harness — at which point the lock is free.
                            preWrite.arriveExternally();

                            // THE SECOND HALF, ALSO A POSITIVE EVENT. The identical statement is re-offered
                            // until the engine grants it. The commit that frees the row happens on the other
                            // correct response; the budget bounds the loop so a lock that never frees fails
                            const deadline = Date.now() + LOCK_REACQUIRE_BUDGET_MS;
                            for (;;) {
                                offersAfterRelease += 1;
                                const refusal = await offerCompetingLock(ctx.queryRunner);
                                if (refusal === undefined) {
                                    lockAcquiredAfterRelease = true;
                                    return;
                                }
                                if (!isLockNotAvailable(refusal) || Date.now() >= deadline) {
                                    throw refusal instanceof Error ? refusal : new Error(String(refusal));
                                }
                                await new Promise<void>(resolve => {
                                    setTimeout(resolve, 25).unref?.();
                                });
                            }
                        },
                    },
                });

                expect(outcome.rejected.length, describeAbandonedPair(outcome)).toBe(0);
                expect(outcome.a.releasedBeforeWrite).toBe(true);
                expect(outcome.b.releasedBeforeWrite).toBe(true);

                expect(preWrite.installedCount()).toBe(1);
                expect(
                    heldBeforeItsOwnInsert,
                    'The creating operation issued no write against the list table, so it was never held ' +
                        'between its own duplicate lookup and its own insert',
                ).toBeDefined();
                expect(String(heldBeforeItsOwnInsert)).toMatch(/^\s*insert/i);
                expect(String(heldBeforeItsOwnInsert).toLowerCase()).toContain(LIST_TABLE);
                expect(preWrite.arrivedCount()).toBe(2);
                expect(preWrite.failureReason()?.message).toBeUndefined();
                expect(
                    preWrite.releasedByArrival(),
                    'The hold was not released by the complete arrival set, so the window was not open when ' +
                        'the competing lock was offered',
                ).toBe(true);
                expect(
                    holdReleasedBy,
                    'The hold was let go by something other than the arrival set, so it may have written ' +
                        'before the competing lock was ever offered',
                ).toBe('arrival');

                // AND THE ENGINE REFUSED THE COMPETING LOCK WHILE IT WAS HELD, then granted it once the
                // elapsed time and both prove the statement was dispatched. Together they say: no second
                expect(
                    refusalWhileHeld,
                    'The engine granted the competing lock while the creating operation was held between ' +
                        'its own duplicate lookup and its own insert, so the operation does not hold the ' +
                        'owner row across that window',
                ).toBeDefined();
                expect(
                    isLockNotAvailable(refusalWhileHeld),
                    `The refusal was not the engine's lock-not-available answer: ${describeUnknownError(
                        refusalWhileHeld,
                    )}`,
                ).toBe(true);
                expect(
                    refusalElapsedMs,
                    'The refusal took long enough that it could have been a wait running its course rather ' +
                        `than an immediate NOWAIT refusal (${String(refusalElapsedMs)}ms)`,
                ).toBeLessThan(LOCK_REFUSAL_CEILING_MS);
                expect(
                    lockAcquiredAfterRelease,
                    'The competing lock was never granted after the window closed, so the refusal above ' +
                        'cannot be attributed to the held operation',
                ).toBe(true);
                expect(offersAfterRelease).toBeGreaterThanOrEqual(1);

                expect(outcome.a.status, describeAbandonedPair(outcome)).toBe('fulfilled');
                const created = outcome.a.status === 'fulfilled' ? outcome.a.value : undefined;
                expect(created, 'The held operation returned no list').toBeInstanceOf(ReorderList);
                expect((created as ReorderList).name).toBe(BASE_LIST_NAME);
                expect(await countListsWithKey(actingCustomerDbId, defaultChannelDbId, nameKey)).toBe(1);
            },
            DEFAULT_PAIR_BUDGET_MS + 15000,
        );

        it('createReorderList admits exactly one of two sequential duplicate names on every engine', async () => {
            const nameKey = BASE_LIST_NAME.toLowerCase();
            await secondShopClient.asUserWithCredentials(
                actingCustomer.emailAddress,
                SEEDED_CUSTOMER_PASSWORD,
            );
            secondShopClient.setChannelToken(E2E_DEFAULT_CHANNEL_TOKEN);

            const first = await createReorderList(BASE_LIST_NAME, shopClient);
            const second = await createReorderList(BASE_LIST_NAME, secondShopClient);

            expectExactlyOneCreateAndOneNameConflict([first, second]);
            expect(
                await countListsWithKey(actingCustomerDbId, defaultChannelDbId, nameKey),
                SEQUENTIAL_FORM_NOTE,
            ).toBe(1);
        });

        it('the database refuses a duplicate written directly through the repository, on every engine', async () => {
            // THE CONSTRAINT-SHAPE HALF, and it runs on all four engine jobs including sql.js. The duplicate is
            // than an interleaving, which is exactly why every engine carries them.
            const created = expectCreated(await createReorderList(BASE_LIST_NAME));
            const row = await readTheOnlyListRow();
            const storedKey = String(row.nameKey);

            const duplicate = {
                customerId: actingCustomerDbId,
                channelId: defaultChannelDbId,
                name: `${BASE_LIST_NAME} (a second row for the same canonical key)`,
                nameKey: storedKey,
                lineCount: 0,
            };
            const outcome = await runSequentialPair(dataSource, {
                a: {
                    label: 'reads-the-committed-row',
                    write: async ctx =>
                        ctx.queryRunner.manager.getRepository(ReorderList).count({
                            where: {
                                customerId: actingCustomerDbId,
                                channelId: defaultChannelDbId,
                                nameKey: storedKey,
                            },
                        }),
                },
                b: {
                    label: 'writes-the-duplicate-directly',
                    write: async () => insertListRowDirectly(duplicate),
                },
            });

            expect(outcome.a.status, describeSettledOutcomes([outcome.a])).toBe('fulfilled');
            expect((outcome.a as { value: number }).value).toBe(1);
            expect(outcome.b.status, 'The database accepted a duplicate canonical key').toBe('rejected');
            expect(outcome.rejected.length).toBe(1);
            expect(outcome.loser?.label).toBe('writes-the-duplicate-directly');
            const reason = (outcome.b as { reason: unknown }).reason;
            const reasonText = reason instanceof Error ? reason.message : String(reason);
            // the message beside it is the shared redactor's description, which names the constraint when the
            expect(
                identifiesNameConflictConstraint(reasonText),
                `The refusal identified neither ${NAME_CONFLICT_CONSTRAINT} nor its qualified column list ` +
                    `on ${resolveConfiguredEngine()}: ${redactTeardownDiagnostic(reason)}`,
            ).toBe(true);

            expect(await countListsWithKey(actingCustomerDbId, defaultChannelDbId, storedKey)).toBe(1);
            expect(Number((await readTheOnlyListRow()).id)).toBe(decodeId(created.id));
        });

        it('createReorderList admits the same name under a second real channel token', async () => {
            // scoped to the owning customer AND the active channel, so the same name under a second REAL token
            // proceeds. A second token is sent rather than a variable mutated, which is the third of
            // FEATURE-001-01 section 2.6.1's four matrix rules.
            const created = expectCreated(await createReorderList(BASE_LIST_NAME));
            const storedKey = String((await readTheOnlyListRow()).nameKey);
            expect(await countLists(actingCustomerDbId, defaultChannelDbId)).toBe(1);

            shopClient.setChannelToken(SECOND_CHANNEL_TOKEN);
            const inSecondChannel = expectCreated(await createReorderList(BASE_LIST_NAME));
            expect(inSecondChannel.name).toBe(BASE_LIST_NAME);
            expect(inSecondChannel.id).not.toBe(created.id);

            const secondChannelRow = await readListRowById(inSecondChannel.id);
            expect(secondChannelRow, 'The second-channel create wrote no row').toBeDefined();
            expect(Number((secondChannelRow as Record<string, unknown>).channelId)).toBe(secondChannelDbId);
            expect(Number((secondChannelRow as Record<string, unknown>).customerId)).toBe(actingCustomerDbId);
            expect(String((secondChannelRow as Record<string, unknown>).nameKey)).toBe(storedKey);
            expect(await countLists(actingCustomerDbId, defaultChannelDbId)).toBe(1);
            expect(await countLists(actingCustomerDbId, secondChannelDbId)).toBe(1);
        });
    });

    describe('AC-8: the server boots with the plugin registered and nothing existing moved', () => {
        it('createReorderList is published while activeCustomer answers exactly as before', async () => {
            expect(server.app.get(ConfigService).plugins).toContain(reorderPluginRegistration);

            const { activeCustomer } = await shopClient.query<GetActiveCustomerQuery>(
                GET_ACTIVE_CUSTOMER_FOR_REORDER_CREATE,
            );
            expect(activeCustomer).not.toBeNull();
            expect((activeCustomer as { id: ReorderApiId }).id).toBe(actingCustomer.id);
            expect(
                (activeCustomer as { emailAddress: string }).emailAddress === actingCustomer.emailAddress,
                "activeCustomer returned a different customer's identifying field",
            ).toBe(true);

            const baselineQueries = fieldSignaturesOf(snapshotSchema, 'Query');
            const liveQueries = fieldSignaturesOf(liveSchema, 'Query');
            expect(liveQueries.get('activeCustomer')).toBe(baselineQueries.get('activeCustomer'));
            expect(liveQueries.get('activeCustomer')).toBe('activeCustomer(): Customer');
        });

        it('both root types grow only by addition, and every addition is one this plugin declares', () => {
            const baselineQueries = fieldSignaturesOf(snapshotSchema, 'Query');
            const liveQueries = fieldSignaturesOf(liveSchema, 'Query');
            const baselineMutations = fieldSignaturesOf(snapshotSchema, 'Mutation');
            const liveMutations = fieldSignaturesOf(liveSchema, 'Mutation');

            expect(baselineQueries.size, 'The checked-in snapshot moved').toBe(
                BASELINE_ROOT_QUERY_FIELD_COUNT,
            );
            expect(baselineMutations.size, 'The checked-in snapshot moved').toBe(
                BASELINE_ROOT_MUTATION_FIELD_COUNT,
            );

            for (const [name, signature] of baselineQueries) {
                expect(liveQueries.get(name), `root query ${name} changed`).toBe(signature);
            }
            for (const [name, signature] of baselineMutations) {
                expect(liveMutations.get(name), `root mutation ${name} changed`).toBe(signature);
            }

            const addedQueries = [...liveQueries.keys()].filter(name => !baselineQueries.has(name)).sort();
            const addedMutations = [...liveMutations.keys()]
                .filter(name => !baselineMutations.has(name))
                .sort();
            for (const name of addedQueries) {
                expect(
                    FEATURE_ROOT_QUERIES,
                    `the root Query type gained an undeclared field ${name}`,
                ).toContain(name);
            }
            for (const name of addedMutations) {
                expect(
                    FEATURE_ROOT_MUTATIONS,
                    `the root Mutation type gained an undeclared field ${name}`,
                ).toContain(name);
            }
            expect(addedMutations).toContain(STORY_ROOT_MUTATION);
        });

        it('addItemToOrder, addItemsToOrder and adjustOrderLine gain no argument', () => {
            const baselineMutations = fieldSignaturesOf(snapshotSchema, 'Mutation');
            const liveMutations = fieldSignaturesOf(liveSchema, 'Mutation');
            for (const name of UNWIDENED_ORDER_MUTATIONS) {
                const baseline = baselineMutations.get(name);
                expect(baseline, `The snapshot declares no ${name}`).toBeDefined();
                expect(liveMutations.get(name), `${name} gained or lost an argument`).toBe(baseline);
            }
            const addItemToOrder = (requireType(liveSchema, 'Mutation').fields ?? []).find(
                field => field.name === 'addItemToOrder',
            );
            expect((addItemToOrder?.args ?? []).map(arg => arg.name)).toEqual([
                'productVariantId',
                'quantity',
            ]);
        });

        it('the published Permission enum is unchanged at 97 members, a zero delta asserted rather than omitted', () => {
            const baselinePermissions = sortedEnumValues(snapshotSchema, 'Permission');
            const livePermissions = sortedEnumValues(liveSchema, 'Permission');
            expect(baselinePermissions.length).toBe(BASELINE_PERMISSION_MEMBER_COUNT);
            expect(livePermissions.length).toBe(BASELINE_PERMISSION_MEMBER_COUNT);
            expect(livePermissions).toEqual(baselinePermissions);
        });

        it('the published ErrorCode enum grows by exactly this feature four declarations and loses none', () => {
            const baselineCodes = sortedEnumValues(snapshotSchema, 'ErrorCode');
            const liveCodes = sortedEnumValues(liveSchema, 'ErrorCode');
            expect(baselineCodes.length).toBe(BASELINE_ERROR_CODE_MEMBER_COUNT);
            for (const member of baselineCodes) {
                expect(liveCodes, `The baseline ErrorCode member ${member} disappeared`).toContain(member);
            }
            const added = liveCodes.filter(member => !baselineCodes.includes(member));
            expect(added).toEqual(
                [
                    'REORDER_LIST_LIMIT_ERROR',
                    'REORDER_LIST_LINE_NOT_FOUND_ERROR',
                    'REORDER_LIST_NAME_CONFLICT_ERROR',
                    'REORDER_LIST_NOT_FOUND_ERROR',
                ].sort(),
            );
            expect(liveCodes.length).toBe(BASELINE_ERROR_CODE_MEMBER_COUNT + FEATURE_ERROR_RESULTS.length);

            const baselineImplementors = sortedErrorResultImplementors(snapshotSchema);
            const liveImplementors = sortedErrorResultImplementors(liveSchema);
            expect(baselineImplementors.length).toBe(BASELINE_ERROR_RESULT_IMPLEMENTOR_COUNT);
            expect(liveImplementors.length).toBe(
                BASELINE_ERROR_RESULT_IMPLEMENTOR_COUNT + FEATURE_ERROR_RESULTS.length,
            );
            for (const typeName of FEATURE_ERROR_RESULTS) {
                expect(liveImplementors, `${typeName} does not implement ErrorResult`).toContain(typeName);
                const fields = sortedFieldNames(liveSchema, typeName);
                expect(fields, `${typeName} is missing errorCode`).toContain('errorCode');
                expect(fields, `${typeName} is missing message`).toContain('message');
            }
            expect(sortedFieldNames(liveSchema, 'ReorderListNameConflictError')).toEqual([
                'conflictingNameKey',
                'errorCode',
                'message',
            ]);
            expect(sortedFieldNames(liveSchema, 'ReorderListLimitError')).toEqual([
                'errorCode',
                'maxItems',
                'message',
            ]);
        });

        it('neither per-row list-options input is declared by this plugin document', () => {
            const listsField = (requireType(liveSchema, 'Query').fields ?? []).find(
                field => field.name === 'activeCustomerReorderLists',
            );
            expect(listsField, 'activeCustomerReorderLists is absent from the root Query type').toBeDefined();
            expect((listsField?.args ?? []).map(arg => arg.name).sort()).toEqual([
                'includeShared',
                'options',
            ]);

            const linesField = (requireType(liveSchema, 'ReorderList').fields ?? []).find(
                field => field.name === 'lines',
            );
            expect(linesField, 'ReorderList.lines is absent').toBeDefined();
            expect((linesField?.args ?? []).map(arg => arg.name)).toEqual(['options']);
        });
    });

    // The five edge-case scenarios of STORY-001-01-01 section 7
    // whatever the prose around it says — which is exactly why the duplicate-name race was promoted out of
    // resolve to PROCEED rather than to a block or a warning, and that is asserted honestly rather than

    describe('section 7 scenarios', () => {
        it('scenario 1: an empty starting state proceeds, giving lineCount 0 and exactly one list', async () => {
            expect(await countLists(actingCustomerDbId, defaultChannelDbId)).toBe(0);
            expect(await readAllListRows()).toEqual([]);

            const created = expectCreated(await createReorderList(BASE_LIST_NAME));

            expect(created.lineCount).toBe(0);
            expect(created.name).toBe(BASE_LIST_NAME);
            expect(created.lines.totalItems).toBe(0);
            expect(await countLists(actingCustomerDbId, defaultChannelDbId)).toBe(1);
        });

        it('scenario 2: a variant disabled since the last purchase proceeds, and no variant is read at all', async () => {
            expect(
                catalogueVariant.enabled,
                'the variant this scenario disables did not start out enabled',
            ).toBe(true);
            const setEnabled = async (enabled: boolean) => {
                const { updateProductVariants } = await adminClient.query<SetVariantEnabledMutation>(
                    SET_VARIANT_ENABLED_FOR_REORDER_CREATE,
                    { input: [{ id: catalogueVariant.id, enabled }] },
                );
                expect(updateProductVariants.length).toBe(1);
                expect(updateProductVariants[0]?.enabled).toBe(enabled);
            };
            await captureCoreRows('product_variant', 'captured_row.id = :variantId', {
                variantId: decodeId(catalogueVariant.id),
            });
            await setEnabled(false);

            // is gated to the engine on which a statement count is deterministic; the behavioural half — that
            // the create succeeds regardless — is asserted below on all four engines.
            capture.reset();
            const created = expectCreated(
                await capture.capture(() => createReorderList('Scenario two disabled variant list')),
            );

            expect(created.lineCount).toBe(0);
            expect(created.lines.totalItems).toBe(0);
            expect(await countLists(actingCustomerDbId, defaultChannelDbId)).toBe(1);
            expect(await countAllLines()).toBe(0);

            if (isStatementCountEngine()) {
                // arrive only with STORY-001-01-02. This is the one place a zero-statement claim is legitimate —
                // unlike a claim of zero statements against `reorder_list`, which no correct implementation
                expect(
                    capture.count('product_variant'),
                    `filtered to product_variant — ${STATEMENT_COUNT_ENGINE_REASON}\n${capture.format()}`,
                ).toBe(0);
                expect(
                    capture.count('stock_level'),
                    `filtered to stock_level — ${STATEMENT_COUNT_ENGINE_REASON}\n${capture.format()}`,
                ).toBe(0);
                expect(
                    capture.count('product_variant_price'),
                    `filtered to product_variant_price — ${STATEMENT_COUNT_ENGINE_REASON}\n${capture.format()}`,
                ).toBe(0);
            }
        });

        it('scenario 3: a price changed since the last purchase proceeds, no price being stored or published', async () => {
            const priorPrice = catalogueVariant.price;
            expect(
                priorPrice,
                'the seeded variant price is too small for the value-collision check below to be meaningful',
            ).toBeGreaterThan(1000);

            const setPrice = async (price: number): Promise<number> => {
                const { updateProductVariants } = await adminClient.query<SetVariantPriceMutation>(
                    SET_VARIANT_PRICE_FOR_REORDER_CREATE,
                    { input: [{ id: catalogueVariant.id, price }] },
                );
                expect(updateProductVariants.length).toBe(1);
                const stored = updateProductVariants[0]?.price;
                expect(stored, `the platform did not store the price ${price}`).toBe(price);
                return stored as number;
            };
            await captureCoreRows('product_variant', 'captured_row.id = :variantId', {
                variantId: decodeId(catalogueVariant.id),
            });
            await captureCoreRows('product_variant_price', 'captured_row.variantId = :variantId', {
                variantId: decodeId(catalogueVariant.id),
            });

            const changedPrice = priorPrice + 100_000;
            await setPrice(changedPrice);

            const { productVariants } = await adminClient.query<GetVariantQuery>(
                GET_VARIANT_FOR_REORDER_CREATE,
            );
            const reread = productVariants.items[0];
            expect(reread?.id).toBe(catalogueVariant.id);
            const currentPrice = reread?.price;
            expect(currentPrice, 'the price read back is not the changed price').toBe(changedPrice);
            expect(currentPrice).not.toBe(priorPrice);

            // by FEATURE-001-03.
            capture.reset();
            const created = expectCreated(
                await capture.capture(() => createReorderList('Scenario three price changed list')),
            );
            expect(created.lineCount).toBe(0);
            expect(created.lines.totalItems).toBe(0);
            expect(await countLists(actingCustomerDbId, defaultChannelDbId)).toBe(1);

            const storedRow = await readTheOnlyListRow();
            for (const column of Object.keys(storedRow)) {
                expect(
                    MONETARY_OR_STOCK_FIELD.test(column),
                    `${LIST_TABLE}.${column} looks like a monetary column`,
                ).toBe(false);
            }
            for (const fieldName of sortedFieldNames(liveSchema, 'ReorderList')) {
                expect(
                    MONETARY_OR_STOCK_FIELD.test(fieldName),
                    `ReorderList.${fieldName} looks like a monetary field`,
                ).toBe(false);
            }
            for (const key of Object.keys(created)) {
                expect(MONETARY_OR_STOCK_FIELD.test(key), `The payload carries ${key}`).toBe(false);
            }

            const priceValues = new Set([String(priorPrice), String(changedPrice)]);
            for (const [column, value] of Object.entries(storedRow)) {
                expect(
                    priceValues.has(String(value)),
                    `${LIST_TABLE}.${column} carries a price value (${String(value)})`,
                ).toBe(false);
            }
            for (const [key, value] of Object.entries(created as unknown as Record<string, unknown>)) {
                expect(
                    priceValues.has(String(value)),
                    `The payload's ${key} carries a price value (${String(value)})`,
                ).toBe(false);
            }

            if (isStatementCountEngine()) {
                /*
                 * The operation is unaffected by the change because it never looks: creating an EMPTY list has
                 * no reason to resolve a variant or read a price, so zero is reachable and is asserted as a
                 * number rather than as a bound. This is the counted half of "proceeds"; the behavioural half
                 * above runs on all four engines.
                 */
                for (const table of ['product_variant_price', 'product_variant', 'stock_level']) {
                    expect(
                        capture.count(table),
                        `filtered to ${table} — ${STATEMENT_COUNT_ENGINE_REASON}\n${capture.format()}`,
                    ).toBe(0);
                }
            }
        });

        it('scenario 4: the narrow translation and the second channel halves of the same-name race', async () => {
            // The concurrent same-name race itself is AC-7, which is why it was promoted out of section 7. This
            expectCreated(await createReorderList(BASE_LIST_NAME));
            const storedKey = String((await readTheOnlyListRow()).nameKey);
            const conflict = expectNameConflict(await createReorderList(BASE_LIST_NAME));
            expect(conflict.errorCode).toBe('REORDER_LIST_NAME_CONFLICT_ERROR');
            expect(conflict.conflictingNameKey).toBe(storedKey);
            const lowered = conflict.message.toLowerCase();
            for (const needle of [
                NAME_CONFLICT_CONSTRAINT.toLowerCase(),
                LIST_TABLE,
                'namekey',
                'duplicate entry',
                'unique constraint',
                'insert into',
            ]) {
                // THE NEEDLE IS THE DISCLOSURE, so naming it is the whole diagnostic. Interpolating the
                // message beside it would reproduce the leak this assertion exists to catch, into the very
                expect(lowered, `The mapped message discloses "${needle}"`).not.toContain(needle);
            }
            expect(await countLists(actingCustomerDbId, defaultChannelDbId)).toBe(1);

            shopClient.setChannelToken(SECOND_CHANNEL_TOKEN);
            const inSecondChannel = expectCreated(await createReorderList(BASE_LIST_NAME));
            const secondRow = await readListRowById(inSecondChannel.id);
            expect(secondRow, 'The second-channel create wrote no row').toBeDefined();
            expect(Number((secondRow as Record<string, unknown>).channelId)).toBe(secondChannelDbId);
            expect(await countLists(actingCustomerDbId, defaultChannelDbId)).toBe(1);
            expect(await countLists(actingCustomerDbId, secondChannelDbId)).toBe(1);
        });

        it('scenario 5: a customer soft-deleted after owning a list keeps the row, and nothing purges it', async () => {
            const created = expectCreated(await createReorderList(BASE_LIST_NAME));
            const storedKey = String((await readTheOnlyListRow()).nameKey);
            expect(await countLists(actingCustomerDbId, defaultChannelDbId)).toBe(1);

            // repository — one row, by identifier, engine-portably — so that the buyer's SESSION survives,
            const softDeleteCapture = await captureSoftDeleteState(actingCustomerDbId);
            expect(softDeleteCapture.customer.rows.length, 'the acting customer row was not captured').toBe(
                1,
            );
            expect(softDeleteCapture.customer.rows[0].deletedAt ?? null).toBeNull();
            expect(
                softDeleteCapture.user.rows.length,
                "the acting customer's user row was not captured",
            ).toBe(1);
            expect(softDeleteCapture.user.rows[0].deletedAt ?? null).toBeNull();
            expect(
                softDeleteCapture.sessions.rows.length,
                'the acting buyer holds no session row, so the delete below destroys nothing',
            ).toBeGreaterThan(0);
            await dataSource
                .getRepository(Customer)
                .update({ id: actingCustomerDbId }, { deletedAt: new Date() });
            const markedRow: unknown = await dataSource
                .getRepository(Customer)
                .findOne({ where: { id: actingCustomerDbId }, select: { id: true, deletedAt: true } });
            expect((markedRow as { deletedAt: Date | null } | null)?.deletedAt).not.toBeNull();

            const conflictForDeletedCustomer = expectNameConflict(await createReorderList(BASE_LIST_NAME));
            expect(conflictForDeletedCustomer.errorCode).toBe('REORDER_LIST_NAME_CONFLICT_ERROR');
            expect(conflictForDeletedCustomer.conflictingNameKey).toBe(storedKey);
            const survivingRow = await readTheOnlyListRow();
            expect(Number(survivingRow.customerId)).toBe(actingCustomerDbId);
            expect(String(survivingRow.name)).toBe(BASE_LIST_NAME);
            expect(Number(survivingRow.id)).toBe(decodeId(created.id));
            expect(await countLists(actingCustomerDbId, defaultChannelDbId)).toBe(1);

            await secondShopClient.asUserWithCredentials(
                otherCustomer.emailAddress,
                SEEDED_CUSTOMER_PASSWORD,
            );
            secondShopClient.setChannelToken(E2E_DEFAULT_CHANNEL_TOKEN);
            const otherCustomersList = expectCreated(
                await createReorderList(BASE_LIST_NAME, secondShopClient),
            );
            expect(otherCustomersList.name).toBe(BASE_LIST_NAME);
            expect(await countLists(otherCustomerDbId, defaultChannelDbId)).toBe(1);
            expect(await countLists(actingCustomerDbId, defaultChannelDbId)).toBe(1);

            await restoreCustomerAndUserExactly(softDeleteCapture);
            const { deleteCustomer } = await adminClient.query<DeleteCustomerMutation>(
                DELETE_CUSTOMER_FOR_REORDER_CREATE,
                { id: actingCustomer.id },
            );
            expect(deleteCustomer.result, 'the Admin API did not report the customer as deleted').toBe(
                'DELETED',
            );

            expect(await countLists(actingCustomerDbId, defaultChannelDbId)).toBe(1);
            const rowAfterApiDelete = await readListRowById(created.id);
            expect(rowAfterApiDelete, 'The Admin API delete removed the list row').toBeDefined();
            expect(Number((rowAfterApiDelete as Record<string, unknown>).customerId)).toBe(
                actingCustomerDbId,
            );
            expect(String((rowAfterApiDelete as Record<string, unknown>).name)).toBe(BASE_LIST_NAME);

            const buyerAuthToken = shopClient.getAuthToken();
            expect(buyerAuthToken, 'the acting buyer holds no auth token to resolve').not.toBe('');
            const sessionAfterDelete = await server.app
                .get(SessionService)
                .getSessionFromToken(buyerAuthToken);
            // carries the session TOKEN and the cached user identifier. Comparing to `undefined` here and
            expect(sessionAfterDelete === undefined, 'The soft delete left a live session behind').toBe(true);
            const refusedLogin = await shopClient.asUserWithCredentials(
                actingCustomer.emailAddress,
                SEEDED_CUSTOMER_PASSWORD,
            );
            expect(
                (refusedLogin as { errorCode?: string }).errorCode,
                'a soft-deleted buyer was able to authenticate',
            ).toBeDefined();

            let directDuplicateFailure: unknown;
            try {
                await insertListRowDirectly({
                    customerId: actingCustomerDbId,
                    channelId: defaultChannelDbId,
                    name: `${BASE_LIST_NAME} (after the soft delete)`,
                    nameKey: storedKey,
                    lineCount: 0,
                });
            } catch (err: unknown) {
                directDuplicateFailure = err;
            }
            const directFailureText =
                directDuplicateFailure instanceof Error
                    ? directDuplicateFailure.message
                    : String(directDuplicateFailure);
            // Same division as above: the boolean reads the raw text, the message carries the redactor's
            // description. On MySQL the raw text is `Duplicate entry '<value>' for key '<name>'`, so the
            expect(
                identifiesNameConflictConstraint(directFailureText),
                `The refusal identified neither ${NAME_CONFLICT_CONSTRAINT} nor its qualified column list ` +
                    `on ${resolveConfiguredEngine()}: ${redactTeardownDiagnostic(directDuplicateFailure)}`,
            ).toBe(true);
            expect(await countListsWithKey(actingCustomerDbId, defaultChannelDbId, storedKey)).toBe(1);

            // ruling R19 — the lifecycle pass belongs to FEATURE-001-07 in batch B5). Asserted as the absence
            const listColumns = dataSource
                .getMetadata(ReorderList)
                .columns.map(column => column.databaseName);
            const lineColumns = dataSource
                .getMetadata(ReorderListLine)
                .columns.map(column => column.databaseName);
            for (const column of [...listColumns, ...lineColumns]) {
                expect(
                    /delete|anonymi|purge|retain|retention|expire|redact/i.test(column),
                    `A lifecycle column ${column} exists, and this story implements no lifecycle behaviour`,
                ).toBe(false);
            }
            expect(String((await readListRowById(created.id))?.name)).toBe(BASE_LIST_NAME);

            await restoreCoreRowsExactly(softDeleteCapture.sessions);
            await restoreCustomerAndUserExactly(softDeleteCapture);
            const sessionAfterRestore = await server.app
                .get(SessionService)
                .getSessionFromToken(buyerAuthToken);
            expect(
                sessionAfterRestore !== undefined,
                'the re-inserted session rows did not resolve back to a live session',
            ).toBe(true);
            expect(Number((sessionAfterRestore as { user: { id: unknown } }).user.id)).toBe(
                softDeleteCapture.userId,
            );
        });
    });
});
