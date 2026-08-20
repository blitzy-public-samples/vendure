/*
 * STORY-001-01-01 — "Create a named reorder list".
 *
 * WHAT THIS FILE IS, AND THE ORDER IT RUNS IN.
 *
 * The four staged checkpoints of STORY-001-01-01 section 2.1 run BEFORE the first domain assertion, then
 * AC-1 through AC-8 of its section 5, then the five scenarios of its section 7. The ordering IS the
 * mechanism rather than a tidiness preference: a red result at checkpoint N with checkpoints 1..N-1 green
 * names the broken layer, and a red result in the criteria with all four checkpoints green is a defect in
 * this story's own logic rather than in the toolchain. Each checkpoint therefore carries its own diagnostic
 * in the text of its assertion, naming the layer a reader should look at and no other.
 *
 * ATTRIBUTION OF EVERY OBLIGATION BELOW. `review_rules` was read in full for this run and returned exactly
 * "No user rules provided." NO user-specified rule governs this file and no rule forced it into scope.
 * Every obligation discharged here is PROMPT-DERIVED (the Agent Action Plan) or TICKET-DERIVED
 * (STORY-001-01-01, FEATURE-001-01, and the EPIC-001 sections named inline), and is cited as such — never
 * as a rule returned by that tool. The absence of rules is not licence to lower the bar; the standard
 * applied is the epic's own testing contract, corroborated independently at EPIC-001 section 11.9.
 *
 * THE OPTION VALUES THIS SUITE DRIVES, AND WHY ONE SERVER SERVES THE WHOLE FILE.
 *
 * `maxListsPerCustomer` is configured to 2 for the whole file, because AC-4 requires that exact configured
 * value and STORY-001-01-01's note under AC-4 draws the distinction this relies on: configuring 2 for a
 * TEST DEPLOYMENT is not the same act as choosing a product default, and no product default is invented
 * here. The shipped defaults — 25 / 200 / 999 / 25 / 50 — are asserted by the co-located unit specification
 * `src/reorder.plugin.spec.ts` instead, which is where a claim about a DEFAULT belongs.
 *
 * A second `describe` with a second server was the alternative and is deliberately not taken. `testConfig()`
 * derives its port from the calling file's index within its own directory listing
 * (`e2e-common/test-config.ts`), so two calls from this file would compute the SAME port and a second server
 * would be racing the first for it. One server, one bound, one port.
 *
 * THE ISOLATION CONTRACT (EPIC-001 section 11.6.1), stated here because every exact count below rests on it.
 * One `TestServer`, initialised in `beforeAll` under the long setup timeout; `afterAll` calls
 * `await server.destroy()` UNCONDITIONALLY; `beforeEach` seeds only its own test's fixture and resets the
 * capture instrument; `afterEach` deletes every plugin-owned row addressing `reorder_list_line` BEFORE
 * `reorder_list` so a foreign key is never what fails the cleanup, and restores every core row a test
 * mutated. The harness's wholesale table clear is NEVER used between tests: it synchronises the schema
 * (`packages/testing/src/data-population/clear-all-tables.ts`) and would drop the populated catalogue every
 * later case depends on. No test consumes the state a sibling criterion left behind, which is why each one
 * builds its own precondition through {@link seedLists} rather than reading a leftover.
 *
 * STATEMENT-COUNT DISCIPLINE (EPIC-001 sections 7.7.1a and 11.6.2, FEATURE-001-01 section 2.6.1.1).
 * Exactly one boundary carries an exact number here — the PLUGIN-STATEMENT boundary — and every such
 * assertion is an equality, never "at least one" and never "no more than". The instrument is the canonical
 * one: a TypeORM logger OBJECT supplied on `dbConnectionOptions` through `queryCaptureConfig`, reset in
 * `beforeEach`, opened immediately before the operation under test and closed the moment it returns, and
 * filtered by table name with the filter named at the assertion site. The boolean `logging` flag and a spy
 * on the repository accessor are both refused by that contract and neither appears in this file. The counted
 * form runs on sql.js, where statement text and count are deterministic; the behaviour each count evidences
 * is asserted on all four engine jobs and is never gated.
 *
 * "Zero statements" is asserted only where zero is reachable — against `product_variant` and `stock_level`,
 * which this operation legitimately never touches. It is NEVER asserted against `reorder_list`: the server
 * cannot discover a row's absence without asking, so a zero-statement claim there is unpassable for a
 * correct implementation and passable only by one that answers without looking.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT CONTAIN. No assertion that any session holds `Permission.Owner` —
 * it is declared `assignable: false, internal: true` (`packages/core/src/common/constants.ts` L27-L32), so
 * no session can hold it and EPIC-001 rulings R2 and R3 forbid the claim. No custom permission, registered
 * or asserted: this feature registers zero and the published `Permission` enum stays at 97 members, a zero
 * delta that AC-8 asserts rather than omits (ruling R15). No `NegativeQuantityError`, which covers
 * `quantity < 0` on an `OrderLine` only (ruling R13). No forced-interleaving claim on sql.js, which runs the
 * sequential form of the same contract instead (EPIC-001 section 11.6.3). No `it.only` or `describe.only`:
 * the shared configuration sets `allowOnly: true`, so one would pass CI in silence.
 *
 * THE PUBLISHED WIDTHS ASSERTED HERE ARE THIS STORY'S OWN, never the epic's whole-programme ledger. The
 * baseline read from the untouched `schema-shop.json` is 19 root queries, 32 root mutations, 32 `ErrorCode`
 * members and 97 `Permission` members; this story adds one mutation and no query, so the root query total
 * is still 19 and `Permission` is still 97. The cumulative width once every feature has shipped is
 * EPIC-001 section 6.5's to state and appears nowhere below.
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
    createPreWriteRendezvous,
    createTransactionBinder,
    DEFAULT_PAIR_BUDGET_MS,
    PreWriteRendezvous,
    resolveConfiguredEngine,
    runBarrieredPair,
    runSequentialPair,
    SQLJS_EXCLUSION_REASON,
    supportsForcedInterleaving,
    TransactionBinder,
} from './fixtures/concurrency-barrier';
import {
    classifyLockClause,
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

// ---------------------------------------------------------------------------------------------------
// The values this suite drives, and the two tables it owns
// ---------------------------------------------------------------------------------------------------

/**
 * `maxListsPerCustomer` for this test deployment, and the value AC-4 asserts as `maxItems`.
 *
 * Two rather than the shipped default, because AC-4's Given fixes it at two and its barrier half needs a
 * bound a pair of requests can actually reach. It is one constant so that the configuration and every
 * assertion about it cannot drift.
 */
const MAX_LISTS_PER_CUSTOMER = 2;

/** `maxLinesPerList`, at its declared default. No criterion in this story reaches it: a created list is empty. */
const MAX_LINES_PER_LIST = 200;

/** `maxQuantityPerLine`, at its declared default. Unreachable here for the same reason. */
const MAX_QUANTITY_PER_LINE = 999;

/** The collection read's default page size, at its declared default. STORY-001-01-04 owns every read assertion. */
const DEFAULT_LISTS_PAGE_SIZE = 25;

/** The nested `lines` default page size, at its declared default. Owned by STORY-001-01-04 likewise. */
const DEFAULT_LINES_PAGE_SIZE = 50;

/**
 * The validated list-name bound, written out as a literal rather than imported.
 *
 * Conflict C-B (AAP section 0.8.3.2) resolves STORY-001-01-01's self-contradicting definition-of-done item
 * in favour of the FIXED CONSTANT: there is deliberately no `maxListNameLength` option, and the number is
 * the declared width of the `name` column. Writing it out here rather than importing the plugin's own
 * constant is the point — importing it would make the boundary assertion compare the implementation with
 * itself and pass for any value. 190, 191 and 192 below are measured against this literal.
 */
const MAX_LIST_NAME_LENGTH = 191;

/** The parent table. Named as a constant because every table filter on the capture instrument names it. */
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
 *
 * Required alongside the name because the four target engines do not agree on how they report the violation:
 * MySQL, MariaDB and PostgreSQL name the object, while the SQLite family names the COLUMNS instead
 * (`UNIQUE constraint failed: reorder_list.customerId, reorder_list.channelId, reorder_list.nameKey`) and
 * never the object. AC-7's refusal is therefore asserted as "this named object, spelled the way the running
 * engine spells it" rather than as one string that only three engines can produce.
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

/** The three columns inherited from `VendureEntity` and re-declared by neither entity. */
const INHERITED_ENTITY_COLUMNS = ['createdAt', 'id', 'updatedAt'];

/** The name AC-1, AC-3, AC-7 and three of the five scenarios all use, spelled once. */
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

/** The second real channel's code. */
const SECOND_CHANNEL_CODE = 'reorder-create-second-channel';

/**
 * A second `languageCode` for AC-1's language dimension.
 *
 * `RequestContextService` format-validates the query parameter and does not require the channel to list the
 * language, so this needs no channel configuration — which is the point: a list name is a plugin-owned
 * string on the plugin's own table with no translation entity behind it, so the stored `name` must come back
 * byte-identical under a request that resolves a different language.
 */
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
 *
 * Both concurrency criteria carry two halves: a barrier-released pair gated to the three engines that can hold
 * two concurrent transactions, and a sequential pair that runs everywhere. The sequential half is a real
 * assertion about the same contract — which is what keeps the sql.js job meaningful rather than skipped — and
 * it is never presented as a race. This string is used verbatim at the assertion sites of both halves so the
 * exclusion is stated in the failure output rather than left in a comment a reader may not reach.
 */
const SEQUENTIAL_FORM_NOTE =
    'A sequential pair evidences single-connection correctness rather than interleaving, and must not be ' +
    `read as a race. ${SQLJS_EXCLUSION_REASON}`;

/**
 * The password every seeded customer is created with.
 *
 * It is the ONE credential detail that may be a literal here: the seed sets it as a fixed value
 * (`packages/testing/src/data-population/populate-customers.ts` L19), whereas the email addresses are
 * generated mock data and are therefore READ through the Admin API rather than assumed — which is what
 * STORY-001-01-01's definition-of-done item 10 requires of a demonstration a reader can reproduce holding
 * only that file.
 */
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
 *
 * It is stated as a TRANSITION rather than as a post-plugin total: this story adds one mutation and NO query,
 * so the root query width is 19 before and 19 after. An absolute post-plugin total would stop being true the
 * moment a query-adding sibling merged, which is why EPIC-001 ruling R15 asks for baseline-plus-owned-additions.
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
 * NEITHER IS THIS STORY'S. STORY-001-01-01 contributes one mutation and no query, and its criteria are
 * written that way. But the document it founds is one `gql` document carrying FEATURE-001-01's whole
 * published surface, so a server running this plugin publishes both reads whether or not this story asserts
 * anything about them — and STORY-001-01-04 owns every assertion about their behaviour.
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

/** The one root mutation STORY-001-01-01 itself contributes. */
const STORY_ROOT_MUTATION = 'createReorderList';

/**
 * The three shipped order mutations AC-8 asserts gain no argument.
 *
 * They are named individually as well as covered by the whole-root comparison, because they are the three the
 * story's definition-of-done item 5 names: a custom field on `OrderLine` would widen all three as a side
 * effect, and this feature registers none.
 */
const UNWIDENED_ORDER_MUTATIONS = ['addItemToOrder', 'addItemsToOrder', 'adjustOrderLine'];

// ---------------------------------------------------------------------------------------------------
// Documents this file owns
//
// The eight reorder operations come from `./graphql/reorder-definitions`, which is their single authority,
// and NOT ONE of them is re-declared below. What is declared here is the set of SHIPPED PLATFORM operations
// this suite drives to build and inspect its own fixtures — seeded customers, the second real channel, a
// catalogue variant, the customer soft delete and the shipped `activeCustomer` read — none of which belongs
// in a module whose remit is this plugin's own contract.
//
// They are plain `graphql-tag` documents with hand-written result types, for the reason the shared module
// records: `schema-shop.json` is never regenerated for this feature, so no typed-document artefact can exist
// for the plugin's surface, and mixing two idioms in one suite would be worse than using one.
// ---------------------------------------------------------------------------------------------------

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

/** The channels that exist, with the two zone identifiers `CreateChannelInput` requires. */
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

/** Creates the second real channel whose token the channel-scope cases send. */
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

/** Flips a variant's `enabled` flag, and flips it back. */
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
 * The introspection of the booted Shop API, shaped so that ONE code path can read both it and the untouched
 * `schema-shop.json` snapshot.
 *
 * The root types are deliberately reached through `types` by name rather than through `queryType { fields }`:
 * the standard introspection query the snapshot was produced with selects only `queryType { name }` and puts
 * every field under `types`, so reading both sides the same way is what makes the comparison a comparison
 * rather than two different readings that happen to agree.
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

// ---------------------------------------------------------------------------------------------------
// Result shapes for the documents above, and for the introspection comparison
// ---------------------------------------------------------------------------------------------------

/** A seeded customer as the Admin API returns it. */
interface SeededCustomer {
    id: ReorderApiId;
    emailAddress: string;
    user: { id: ReorderApiId } | null;
}

interface GetSeededCustomersQuery {
    customers: { totalItems: number; items: SeededCustomer[] };
}

/** A channel as the Admin API returns it, carrying the two zone identifiers a new channel needs. */
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
    /** The variant's price in the active channel, in minor units. */
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

/** One node of an introspected type reference, to whatever depth the document selected. */
interface IntrospectedTypeRef {
    kind: string;
    name: string | null;
    ofType?: IntrospectedTypeRef | null;
}

/** An argument or input field, carrying everything the byte-identical comparison needs. */
interface IntrospectedInputValue {
    name: string;
    defaultValue?: string | null;
    type?: IntrospectedTypeRef | null;
}

/** A field of an object type, with its full argument list and return type. */
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

// ---------------------------------------------------------------------------------------------------
// Schema-shape helpers, shared by checkpoint 3, AC-1, AC-6 and AC-8
// ---------------------------------------------------------------------------------------------------

/**
 * Renders a type reference to its SDL spelling — `String!`, `[ReorderList!]!`, `ID`.
 *
 * One string carries the return type AND its nullability AND its list depth, which is exactly what "byte-
 * identical in return type and nullability" has to compare. Comparing the nested objects instead would
 * compare `description` and `isDeprecated` too and would fail on a documentation edit that changed no
 * contract.
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

/** The input-field names of a named input type, sorted. */
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

/**
 * A field name that would carry a monetary amount, a currency or a stock figure.
 *
 * AC-1's currency dimension is discharged at the PAYLOAD level against the introspected schema rather than by
 * reading the plugin's source, so the check has to be a property of the published shape. The pattern is
 * deliberately broad: this feature stores, returns and compares no monetary value of any kind, so ANY match
 * is a finding rather than a false positive.
 */
const MONETARY_OR_STOCK_FIELD = /price|money|amount|currency|tax|stock|inventory|saleable/i;

// ---------------------------------------------------------------------------------------------------
// The instrument, the configuration and the environment
// ---------------------------------------------------------------------------------------------------

/**
 * The canonical query-capture instrument, installed once for the life of the server.
 *
 * It is created here and merged onto `dbConnectionOptions.logger` by {@link queryCaptureConfig}, which is the
 * only mechanism EPIC-001 section 11.6.2 and FEATURE-001-01 section 2.6.1.1 accept. `mergeConfig` assigns a
 * class instance by reference, so `capture.reset()` in `beforeEach` reaches the very object TypeORM holds.
 * The window is closed on a fresh instance, so installing it for the whole run costs nothing until a test
 * opens it.
 */
const capture = new QueryCaptureLogger();

/**
 * `testConfig()` is called HERE, at this file's top level, and nowhere else.
 *
 * Its port is `getBasePort() + <index of this file in its own directory listing>`, computed from the CALLING
 * file, so a call made from a helper in `fixtures/` would index against that directory and could collide two
 * suites on one port. No port is hard-coded anywhere in this file.
 *
 * `importExportOptions.importAssetsDir` is overridden because the shared configuration points it at this
 * package's own `e2e/fixtures/assets`, which this package does not ship; the seeded catalogue's assets live
 * in core's fixtures, and the shipped cross-package precedent is `packages/dashboard/e2e/global-setup.ts`.
 */
// THE SQL.JS SNAPSHOT DIRECTORY, CREATED IDEMPOTENTLY AND AT MODULE SCOPE, FOR TWO SEPARATE REASONS.
//
// The first is a race. The platform's own initializer creates it with a bare, non-recursive `mkdirSync`
// guarded by a preceding `existsSync` (`packages/testing/src/initializers/sqljs-initializer.ts` L31-L35),
// which is a check-then-act race: this package's six suites start together, so when the directory is absent —
// as it is on a fresh checkout, and after the operational reset a schema change requires — two of them can
// both observe it missing and the loser fails its `beforeAll` with `EEXIST`. Measured, not hypothesised: that
// is exactly how one four-engine sweep of this package failed on sql.js while the three server engines, which
// use no snapshot directory, all passed.
//
// The second is why it happens HERE, before `testConfig()` below, rather than inside `beforeAll`.
// `e2e-common/test-config.ts` derives this suite's server port from the INDEX of this file within `e2e/` —
// `getIndexOfTestFileInParentDir` reads the listing with `readdirSync` and takes `indexOf` — so a directory
// that appears inside `e2e/` between one suite's index computation and another's shifts the second suite's
// port onto a neighbour's and one of them dies of `EADDRINUSE`. Creating it before this file computes its own
// index means every suite computes with it present, whichever arrives first.
//
// `recursive` makes the call idempotent, so whichever suite arrives second simply proceeds. An EMPTY
// directory is not a cached snapshot — the initializer keys synchronisation on the snapshot FILE — so this
// does not weaken the stale-cache reset it exists alongside.
fs.mkdirSync(path.join(__dirname, '__data__'), { recursive: true });
/**
 * The registration this suite installs, held in a constant rather than built inline.
 *
 * `init()` returns a registration bound to the option set that call resolved — a distinct subclass of
 * `ReorderPlugin`, so that two differently-configured servers in one process cannot share one options slot
 * (`createScopedRegistration` in `src/reorder.plugin.ts`). Checkpoint 1 below asserts the server registered
 * THIS object and that its injector resolves THESE options, which is only expressible if the value is named.
 */
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

/**
 * The Shop API URL, derived from the very configuration the server was built from.
 *
 * It exists so that the concurrency cases can drive a SECOND real client against the same server — two real
 * API calls rather than one call and a simulation of another — and it reads the port and the path off
 * `suiteConfig` rather than restating either, because a port restated is a port that can drift from the one
 * `testConfig()` computed.
 */
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
     *
     * Used by the two barrier-released races only. Every other assertion in this file drives the PUBLISHED
     * mutation over HTTP, which is the path a storefront reaches; a race, however, has to hold the
     * rendezvous inside the real service transaction, and an HTTP call opens a transaction of the server's
     * own choosing on a connection the barrier has never touched.
     */
    let reorderListService: ReorderListService;

    /**
     * The verified binding that puts a real service operation on a barrier participant's own transaction.
     *
     * Built once, and `createTransactionBinder` proves the platform honours it before returning — so a
     * mechanism that stopped working fails here, loudly, rather than leaving every race silently unbound.
     */
    let transactionBinder: TransactionBinder;

    /** The two seeded customers. AC-6 needs two, and the second is the one this suite authenticates as. */
    let seededCustomers: SeededCustomer[];

    /** The customer every test acts as: the SECOND of the two, which is what AC-6's Given fixes. */
    let actingCustomer: SeededCustomer;

    /** The FIRST seeded customer, whose rows AC-6 proves this call cannot produce. */
    let otherCustomer: SeededCustomer;

    /** The acting customer's decoded database identifier, for every raw comparison and predicate. */
    let actingCustomerDbId: number;

    /** The other customer's decoded database identifier. */
    let otherCustomerDbId: number;

    /** The default channel's decoded database identifier. */
    let defaultChannelDbId: number;

    /** The second real channel's decoded database identifier. */
    let secondChannelDbId: number;

    /** One catalogue variant, used only by the disabled-variant scenario. */
    let catalogueVariant: AdminProductVariant;

    /** The live Shop schema, introspected once after the server booted. */
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

    // -----------------------------------------------------------------------------------------------
    // Portable database access
    //
    // Raw statements below carry NO bound parameters, deliberately. The four target engines disagree on
    // placeholder syntax — PostgreSQL renders `$1` while the others render `?` — so a parameterised raw
    // statement is portable only by accident. Anything needing a VALUE goes through a repository, which
    // builds the engine's own form; anything raw is value-free and quotes its identifiers through
    // `driver.escape()`, the shipped idiom at `packages/core/e2e/migrate-asset-translations.e2e-spec.ts`.
    // -----------------------------------------------------------------------------------------------

    /**
     * Decodes an API identifier to the value the database actually stores.
     *
     * The shared test configuration installs `TestingEntityIdStrategy`, which prefixes every identifier with
     * `T_` on the wire while the column holds an integer. Every raw comparison and every capture predicate
     * below therefore has to compare the DECODED value; comparing `'T_5'` against `5` would silently fail an
     * assertion that is actually true, or worse, pass one that is not.
     */
    function decodeId(apiId: ReorderApiId): number {
        return Number.parseInt(String(apiId).replace('T_', ''), 10);
    }

    /** The number of `reorder_list` rows one customer owns in one channel, counted through the repository. */
    async function countLists(customerDbId: number, channelDbId: number): Promise<number> {
        return dataSource
            .getRepository(ReorderList)
            .count({ where: { customerId: customerDbId, channelId: channelDbId } });
    }

    /** The number of `reorder_list` rows one customer owns in one channel under one canonical key. */
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

    /** The single stored row, when a test's own precondition established that there is exactly one. */
    async function readTheOnlyListRow(): Promise<Record<string, unknown>> {
        const rows = await readAllListRows();
        expect(rows.length, `Expected exactly one ${LIST_TABLE} row, found ${rows.length}`).toBe(1);
        return rows[0];
    }

    /** The stored row for one API identifier, or `undefined`. */
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
     *
     * `RequestContextService.fromRequest` is used rather than `create`, and the difference is load-bearing:
     * `create` hard-codes `isAuthorized: true` and `authorizedAsOwnerOnly: false`, whereas this operation is
     * gated on `Permission.Owner` — a member no session can hold, being declared `assignable: false,
     * internal: true` — so the context a real request produces is the opposite pair, and it is the service's
     * own ownership predicate rather than the gate that decides the outcome. A race driven with a context the
     * guard could never produce would be asserting against a code path no buyer reaches.
     *
     * Required by the two barrier-released races, which invoke the service directly so that the rendezvous
     * sits inside the real transaction. Checkpoint 4 asserts the properties of this same path.
     */
    async function shopContextFor(client: SimpleGraphQLClient): Promise<RequestContext> {
        const session = await server.app.get(SessionService).getSessionFromToken(client.getAuthToken());
        expect(
            session,
            'The client holds no session, so no authenticated context can be built',
        ).toBeDefined();
        const channelTokenKey = server.app.get(ConfigService).apiOptions.channelTokenKey ?? 'vendure-token';
        const request = { query: {}, headers: { [channelTokenKey]: E2E_DEFAULT_CHANNEL_TOKEN } };
        const ctx = await server.app
            .get(RequestContextService)
            .fromRequest(request as never, undefined, [Permission.Owner], session);
        // The two properties every assertion below depends on: the gate admitted the request as owner-only,
        // and the channel is the one this suite acts in.
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

    /** One service-returned union member, named for a diagnostic. The success member is an entity, so it
     * carries no `__typename` of its own and is named here from its class instead. */
    function describeServiceResult(result: CreateReorderListResult): string {
        return result instanceof ReorderList
            ? `ReorderList(name=${String(result.name)}, lineCount=${String(result.lineCount)})`
            : `${result.__typename}(${result.errorCode})`;
    }

    /**
     * Deletes every plugin-owned row, child table BEFORE parent.
     *
     * Addressing `reorder_list_line` first is what stops a foreign key being the thing that fails the cleanup
     * (EPIC-001 section 7.8). Both tables are emptied rather than only the rows a test recorded: each test
     * file gets its own disposable database — sql.js writes one file per spec and the server initializers drop
     * and recreate one database per spec — so these two tables belong to this file alone, and emptying them is
     * the strictest possible reading of "no test consumes a sibling criterion's state".
     *
     * The harness's wholesale table clear is NOT used and must not be: it synchronises the schema and would
     * drop the populated catalogue every later test depends on.
     */
    async function deleteAllPluginRows(): Promise<void> {
        await queryRunner.query(`DELETE FROM ${esc(LINE_TABLE)}`);
        await queryRunner.query(`DELETE FROM ${esc(LIST_TABLE)}`);
    }

    /**
     * The exact prior state of every core row the soft-delete scenario disturbs: the ONE `customer` row, the
     * ONE `user` row it points at, and EVERY `session` row that user holds.
     *
     * The third of those is not optional. The platform's own delete path soft-deletes the user and then hard
     * DELETES every authenticated session it held
     * [packages/core/src/service/services/session.service.ts:L313-L317] before marking it
     * [packages/core/src/service/services/user.service.ts:L203-L210], so a scenario that captured only the
     * two `deletedAt` markers would put those back and leave the sessions gone — core rows destroyed by this
     * test and never recreated. Capturing them means the delete is genuinely observable inside the test and
     * the rows are back afterwards, verbatim, primary keys included.
     *
     * An even earlier revision ran `UPDATE customer SET deletedAt = NULL WHERE deletedAt IS NOT NULL` over the
     * whole table, and the same for `user`. That reaches every row in the database rather than the ones this
     * file touches, so a defect elsewhere that soft-deleted a buyer it should not have would be quietly
     * repaired between tests, and a fixture that legitimately arrived soft-deleted would be silently revived.
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
        // The `user` relation is eager on `Customer`, so one read carries both rows. `deletedAt` is an
        // ordinary nullable column rather than a TypeORM delete-date column, so a marked row is still
        // returned by an ordinary read — which is what makes this observable and restorable at all.
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

    // ═══════════════════════════════════════════════════════════════════════════════════════════════
    // Exact restoration of the core rows a test changes
    //
    // A core row this suite touches is put back COLUMN FOR COLUMN, and the restoration is then ASSERTED
    // against what was captured. Two mechanisms make that stricter than it first sounds, and an earlier
    // revision satisfied neither.
    //
    // TypeORM appends `updatedAt = CURRENT_TIMESTAMP` to any update addressed through an ENTITY whose values
    // set omits the update-date column [node_modules/typeorm/query-builder/UpdateQueryBuilder.js:L401-L404],
    // so a compensating write naming only the column it is undoing silently advances the audit timestamp of
    // the very row it claims to have restored. A compensating write issued through the platform's own Admin
    // API does the same — and can additionally INSERT a row that no value restoration removes, because
    // `updateProductVariants` carrying a `stockOnHand` writes a `stock_movement`
    // [packages/core/src/service/services/stock-movement.service.ts:L113-L119]. Either way the row the next
    // test reads is not the row that was there, and nothing says so.
    //
    // So each capture takes `SELECT *` over exactly the rows its predicate names, and the restoration:
    //   - rewrites, through a RAW TABLE update, only the columns whose value actually MOVED. A raw table name
    //     carries no entity metadata, so nothing is appended to the SET list, and a column that did not move
    //     is not rewritten at all.
    //   - re-INSERTS verbatim any captured row that has since been DELETED — which is how the sessions the
    //     platform's customer delete removes come back
    //     [packages/core/src/service/services/session.service.ts:L313-L317].
    //   - DELETES any row matching the same predicate that was NOT in the capture, which is how a
    //     `stock_movement` written during the window goes.
    // and then reads the rows back and requires them to equal the capture, cell for cell.
    //
    // The fidelity bound is the driver's own round trip, and it is stated rather than implied: a value is
    // compared through the same read that captured it, so datetime precision the driver does not surface to
    // JavaScript is outside what this — or anything else in this repository — can observe.
    // ═══════════════════════════════════════════════════════════════════════════════════════════════

    /**
     * The inherited audit column every core table carries, named once because the restoration has to re-state
     * it explicitly on every compensating write. See `restoreCoreRowsExactly` for why.
     */
    const UPDATE_DATE_COLUMN = 'updatedAt';

    /** Every column of exactly the rows one predicate names, as they stood before a test changed them. */
    interface CoreRowsCapture {
        /** The table the rows live in, addressed by name so no entity metadata is involved. */
        readonly table: string;
        /** The read predicate, alias-qualified as `captured_row.<column>`. */
        readonly where: string;
        readonly parameters: Record<string, unknown>;
        readonly rows: Array<Record<string, unknown>>;
    }

    /**
     * One cell rendered so that two reads of the same stored value compare equal.
     *
     * The drivers do not agree on representation — a boolean column arrives as `true` from PostgreSQL and as
     * `1` from the MySQL family and sql.js — so a bare `toEqual` over raw rows would report a difference that
     * is the driver's rather than the data's. Both are folded onto the same rendering, and a `Date` onto its
     * epoch milliseconds, which is the precision a driver surfaces.
     */
    function canonicaliseCell(value: unknown): string {
        if (value === null || value === undefined) {
            return 'null';
        }
        if (value instanceof Date) {
            return `date:${value.getTime()}`;
        }
        if (Buffer.isBuffer(value)) {
            return `buffer:${value.toString('hex')}`;
        }
        if (typeof value === 'boolean') {
            return `number:${value ? 1 : 0}`;
        }
        if (typeof value === 'number') {
            return `number:${value}`;
        }
        return `string:${String(value)}`;
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
     *
     * Every write below goes through here rather than through the query builder, and that is the whole point.
     * `createQueryBuilder().update('<table name>')` looks metadata-free and is not: TypeORM resolves an entity
     * by TABLE NAME as well as by class, so the update it builds passes each value through
     * `preparePersistentValue` for the resolved column and appends `updatedAt = CURRENT_TIMESTAMP` when the
     * values set omits it. Restoring a captured value through that path therefore does not restore it — a
     * boolean column captured as the number `1` is prepared as `0`, because the driver's boolean conversion
     * tests for `true` rather than for truthiness, and a datetime captured as text is rewritten in the
     * driver's own serialisation instead of the text that was there. Both were observed; hence raw SQL, where
     * the captured value is bound and stored as captured.
     */
    async function executeRawStatement(sql: string, parameters: Record<string, unknown>): Promise<void> {
        const [query, bound] = dataSource.driver.escapeQueryWithParameters(sql, parameters, {});
        await dataSource.query(query, bound);
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
     *
     * The registration precedes the write deliberately: a write that lands and then throws, or anything
     * throwing between the write and a later registration, would otherwise leave the row changed with nothing
     * queued to put it back, and every following test in the file would run against state this one made.
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
                // The row was DELETED inside the window, so it goes back verbatim, primary key included.
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
     * Names every cell that differs between a capture and the rows as they stand now, so a failure says which
     * column was not restored rather than that two long strings are unequal.
     */
    function describeRowDifferences(
        captured: Array<Record<string, unknown>>,
        now: Array<Record<string, unknown>>,
    ): string {
        const nowById = new Map(now.map(row => [String(row.id), row]));
        const capturedIds = new Set(captured.map(row => String(row.id)));
        const differences: string[] = [];
        for (const row of captured) {
            const current = nowById.get(String(row.id));
            if (current === undefined) {
                differences.push(`row ${String(row.id)} is missing`);
                continue;
            }
            for (const column of Object.keys(row).sort()) {
                const was = canonicaliseCell(row[column]);
                const is = canonicaliseCell(current[column]);
                if (was !== is) {
                    differences.push(`row ${String(row.id)}.${column} was ${was} and is now ${is}`);
                }
            }
        }
        for (const row of now) {
            if (!capturedIds.has(String(row.id))) {
                differences.push(`row ${String(row.id)} was added`);
            }
        }
        return differences.length === 0 ? 'no cell differs' : differences.join('; ');
    }

    /** Requires the rows the predicate names to equal the capture cell for cell, so restoration is proved. */
    async function expectCoreRowsRestored(rowsCapture: CoreRowsCapture): Promise<void> {
        const render = (rows: Array<Record<string, unknown>>): string[] =>
            rows
                .map(row =>
                    Object.keys(row)
                        .sort()
                        .map(column => `${column}=${canonicaliseCell(row[column])}`)
                        .join(', '),
                )
                .sort();
        const now = await readCoreRows(rowsCapture.table, rowsCapture.where, rowsCapture.parameters);
        expect(
            render(now),
            `${rowsCapture.table} was not restored exactly for ${rowsCapture.where} — ` +
                describeRowDifferences(rowsCapture.rows, now),
        ).toEqual(render(rowsCapture.rows));
    }

    /**
     * Runs EVERY teardown stage, in order, whatever any of them does, and reports the failures afterwards.
     *
     * A linear `await a(); await b(); await c();` teardown stops at the first failure, stranding every later
     * stage — the plugin-row cleanup, the restoration of a core row a test changed, the client's channel
     * token — so one broken test leaves the next one running against state it never established. Collecting
     * the failures and raising them once at the end keeps the diagnosis and loses none of the cleanup.
     */
    async function runAllTeardownStages(
        stages: Array<{ what: string; run: () => Promise<void> }>,
    ): Promise<void> {
        const failures: string[] = [];
        for (const stage of stages) {
            try {
                await stage.run();
            } catch (err: unknown) {
                failures.push(`${stage.what}: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
        if (failures.length > 0) {
            throw new Error(`Teardown did not complete cleanly — ${failures.join(' | ')}`);
        }
    }

    /**
     * A census of the core rows the baseline is known-good BY, read with portable statements.
     *
     * Checkpoint 2 reverts the checked-in migration, and a revert that took collateral core data with it would
     * pass a schema-only assertion while destroying the very seed every criterion below depends on. Counting
     * the three tables the plugin's foreign keys point AT, plus reading back one identified row field-for-field,
     * is what turns "the tables are gone" into "the tables are gone and nothing else moved".
     */
    async function readCoreRowCensus(): Promise<{
        customers: number;
        channels: number;
        productVariants: number;
        actingCustomerEmail: string | undefined;
    }> {
        const countOf = async (table: string): Promise<number> => {
            const rows: unknown = await queryRunner.query(
                `SELECT COUNT(*) AS ${esc('total')} FROM ${esc(table)}`,
            );
            const first = ((rows ?? []) as Array<Record<string, unknown>>)[0];
            return Number(first?.total ?? -1);
        };
        // `actingCustomerDbId` is a decoded integer, so it is interpolated rather than bound: the three
        // engines spell a positional placeholder three different ways, and this file's statements have to
        // work unchanged on all four.
        const identified: unknown = await queryRunner.query(
            `SELECT ${esc('emailAddress')} FROM ${esc('customer')} WHERE ${esc('id')} = ${Number(
                actingCustomerDbId,
            )}`,
        );
        const identifiedRow = ((identified ?? []) as Array<Record<string, unknown>>)[0];
        return {
            customers: await countOf('customer'),
            channels: await countOf('channel'),
            productVariants: await countOf('product_variant'),
            actingCustomerEmail:
                identifiedRow?.emailAddress === undefined ? undefined : String(identifiedRow.emailAddress),
        };
    }

    // -----------------------------------------------------------------------------------------------
    // Operation helpers
    // -----------------------------------------------------------------------------------------------

    /** Executes the published mutation on the suite's main client. */
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

    /** Narrows a create result to `ReorderListNameConflictError`. */
    function expectNameConflict(result: CreateReorderListResultShape): ReorderListNameConflictErrorShape {
        expect(
            result.__typename,
            `Expected a ReorderListNameConflictError, received ${result.__typename}`,
        ).toBe('ReorderListNameConflictError');
        return result as ReorderListNameConflictErrorShape;
    }

    /** Narrows a create result to `ReorderListLimitError`. */
    function expectLimit(result: CreateReorderListResultShape): ReorderListLimitErrorShape {
        expect(result.__typename, `Expected a ReorderListLimitError, received ${result.__typename}`).toBe(
            'ReorderListLimitError',
        );
        return result as ReorderListLimitErrorShape;
    }

    /** One entry of a GraphQL response's top-level `errors` array, at the granularity AC-2 and AC-5 assert. */
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
     *
     * The shipped client throws when a response carries an `errors` array, so both AC-2 and AC-5 — which
     * assert the exact number of entries, the exact `extensions.code` and an exactly null `data` field — reach
     * that response through the thrown error rather than through a return value. Resolving is itself a
     * failure here and is reported as one.
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
     *
     * The count is an equality rather than a lower bound, because "at least one error" is satisfied by a
     * resolver that also emitted an unrelated one, and the whole point of naming the code is that a crash and
     * a genuine refusal must not be indistinguishable.
     *
     * `data` is asserted to be exactly `null` on the unmodified envelope, not "either the whole of `data` or
     * just the union member". The requirement is that the refusal reaches the client as one top-level entry
     * *with `data` null*, and `data: { createReorderList: null }` is a materially different response: it says
     * the operation was executed and its field resolved to null. Because the published field is
     * `createReorderList(...): CreateReorderListResult!`, a thrown error nullifies the non-null field and
     * propagates to the root, so `null` is the only envelope a genuine refusal can produce — accepting the
     * member-null form would let a resolver that returned null instead of throwing pass this assertion.
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
     *
     * MySQL, MariaDB and PostgreSQL name the object; the SQLite family names its qualified COLUMNS instead and
     * never the object, so a match on the name alone would fail on the very engine the default end-to-end job
     * runs. Both spellings identify the SAME named object, and requiring the uniqueness wording alongside the
     * column list keeps the column form object-specific rather than merely table-specific — a check-constraint
     * or not-null failure on the same table names columns too.
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

    // -----------------------------------------------------------------------------------------------
    // Lifecycle (EPIC-001 section 11.6.1)
    // -----------------------------------------------------------------------------------------------

    beforeAll(async () => {
        // Called DIRECTLY from this file, because `TestServer.init` derives the disposable database's name
        // from its own caller's filename. Routing it through a helper would give this suite a database named
        // after the helper — shared with any other suite that used the same helper.
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
        // Read from metadata rather than written out: a repository query's default alias is the entity
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

        // The SECOND REAL CHANNEL, created once because it is immutable shared setup rather than any one
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
                    // Read off the default channel rather than chosen here: a channel must declare a
                    // currency, and naming one this seed does not use would make the second channel differ
                    // from the first along a dimension no criterion is about.
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

        // Introspected ONCE, from the booted server carrying the plugin. Comparing a runtime schema against
        // the untouched snapshot is the only correct way to evidence the delta: the introspection that
        // produces `schema-shop.json` declares its own configuration and never reads a plugin's, so the
        // snapshot cannot move and must be neither edited nor regenerated (AAP section 0.4.1.5).
        const introspected = await shopClient.query<ShopSchemaShapeQuery>(SHOP_SCHEMA_SHAPE);
        liveSchema = introspected.__schema;

        const snapshotPath = path.join(__dirname, '../../../schema-shop.json');
        const snapshotText = fs.readFileSync(snapshotPath, 'utf-8');
        const snapshot = JSON.parse(snapshotText) as { data: ShopSchemaShapeQuery };
        snapshotSchema = snapshot.data.__schema;
    }, TEST_SETUP_TIMEOUT_MS);

    afterAll(async () => {
        // `server.destroy()` is called UNCONDITIONALLY and last: a suite that tears the server down only on
        // its success path leaks a listening port into the next file. The query runner is released first
        // inside a `try` so that a release failure cannot skip the teardown that matters.
        try {
            if (queryRunner && queryRunner.isReleased === false) {
                await queryRunner.release();
            }
        } finally {
            await server.destroy();
        }
    });

    beforeEach(async () => {
        // Each test's own scope, established here and never inherited: the restore queue starts empty, the
        // capture window starts closed and empty, both plugin tables start empty, and the acting session is
        // freshly authenticated on the default channel token.
        restoreActions = [];
        capture.reset();
        await deleteAllPluginRows();
        shopClient.setChannelToken(E2E_DEFAULT_CHANNEL_TOKEN);
        await shopClient.asUserWithCredentials(actingCustomer.emailAddress, SEEDED_CUSTOMER_PASSWORD);
        shopClient.setChannelToken(E2E_DEFAULT_CHANNEL_TOKEN);
    });

    afterEach(async () => {
        // EVERY STAGE RUNS, whatever any of them does, and the failures are reported once at the end. Core
        // rows this test mutated are restored FIRST and in reverse order, so a later mutation layered on an
        // earlier one unwinds in the order it was applied; the plugin rows go next, child table before parent;
        // the client's channel token is reset last.
        //
        // There is deliberately no blanket repair of soft-delete markers here. The one test that sets one
        // queues its own exact restoration at the point of mutation, so nothing in this file needs to reach
        // rows it did not touch — see {@link captureSoftDeleteState}.
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

    // ===============================================================================================
    // The four staged checkpoints (STORY-001-01-01 section 2.1)
    //
    // They run BEFORE the first domain assertion and each depends only on the layers below it, so a red
    // result at checkpoint N with 1..N-1 green names the layer that broke. Each assertion carries its own
    // diagnostic, and no checkpoint reaches the list-creation logic.
    // ===============================================================================================

    describe('staged checkpoints', () => {
        it('checkpoint 1: the plugin module loads and the server boots with ReorderPlugin registered', () => {
            // DIAGNOSTIC ON FAILURE: the plugin's own metadata, providers or imports are wrong. Nothing about
            // migrations, schema or authentication has been touched yet.
            const diagnostic =
                'checkpoint 1 (plugin metadata / providers / imports): the server did not boot with ' +
                'ReorderPlugin registered';
            expect(server.app, diagnostic).toBeDefined();
            const registeredPlugins = server.app.get(ConfigService).plugins;
            expect(registeredPlugins, diagnostic).toContain(reorderPluginRegistration);
            // The options the server is serving requests with are the options this file configured, so a
            // later criterion asserting `maxItems` of 2 is asserting the bound actually in force. Read out of
            // the INJECTOR rather than off the static, because the injector is what the service and the
            // resolvers read: this asserts the value this registration was created with reached them, which is
            // the guarantee a process holding a second, differently-configured registration would need.
            const injected = server.app.get<ResolvedReorderPluginOptions>(REORDER_PLUGIN_OPTIONS);
            expect(injected.maxListsPerCustomer, diagnostic).toBe(MAX_LISTS_PER_CUSTOMER);
            expect(injected.maxLinesPerList, diagnostic).toBe(MAX_LINES_PER_LIST);
            expect(injected.maxQuantityPerLine, diagnostic).toBe(MAX_QUANTITY_PER_LINE);
            expect(injected.defaultReorderListsPageSize, diagnostic).toBe(DEFAULT_LISTS_PAGE_SIZE);
            expect(injected.defaultReorderListLinesPageSize, diagnostic).toBe(DEFAULT_LINES_PAGE_SIZE);
            // The service, the two entity classes and the three resolver classes all resolve through the
            // injector or the schema, so a provider or entity the metadata failed to register would fail here
            // rather than on the first request a buyer makes.
            expect(dataSource.hasMetadata(ReorderList), diagnostic).toBe(true);
            expect(dataSource.hasMetadata(ReorderListLine), diagnostic).toBe(true);
        });

        it('checkpoint 2: the checked-in migration applies and reverts on this engine, against a plugin-less baseline', async () => {
            // DIAGNOSTIC ON FAILURE: the checked-in migration, or the entity definitions it has to agree with,
            // are wrong ON THIS ENGINE — a failure here on one engine with three green localises the defect to
            // that engine rather than to the plugin.
            //
            // WHAT IS UNDER TEST IS THE ARTEFACT, not the harness's synchronisation. Every initializer this
            // suite can run under creates the schema by synchronising the entity declarations — the sql.js
            // initializer enables it while it populates and the MySQL and PostgreSQL initializers force it
            // outright — so simply querying the two tables would pass with the migration file deleted, broken,
            // or never written. So this checkpoint reverts the migration to reach a KNOWN-GOOD, PLUGIN-LESS
            // BASELINE, applies it, queries what it created, reverts it again and reads the core rows back
            // field-for-field. Nothing re-creates the tables between the revert and the apply, which the
            // baseline assertions below establish rather than assume: no synchronisation runs after boot.
            //
            // The migration's own `up` and `down` are driven directly on the live connection rather than
            // through `runMigrations`, and that is deliberate: the platform entry point loads and then RESETS
            // the module-level configuration and opens a connection of its own, which would leave the running
            // server this file is asserting against in a different state than it booted in. The platform
            // lifecycle path, the five named objects asserted twice, the data-bearing cycle and the absence of
            // the withdrawn claim columns all belong to `reorder-list-migration.e2e-spec.ts`; what this
            // checkpoint owns is the one claim the criteria below depend on — the artefact applies and reverts
            // here, on this engine, without taking the seed with it.
            const diagnostic = `checkpoint 2 (the checked-in migration on ${resolveConfiguredEngine()})`;

            // Both tables are addressable by the names the entity declarations produce, which is what every
            // table-filtered statement count below relies on, and what the migration has to agree with.
            expect(dataSource.getMetadata(ReorderList).tableName, diagnostic).toBe(LIST_TABLE);
            expect(dataSource.getMetadata(ReorderListLine).tableName, diagnostic).toBe(LINE_TABLE);

            const migration = new AddReorderLists1786838400000();
            const coreBaseline = await readCoreRowCensus();
            expect(
                coreBaseline.customers,
                `${diagnostic}: the core seed is not present to begin with`,
            ).toBeGreaterThan(0);
            expect(coreBaseline.actingCustomerEmail, `${diagnostic}: the acting customer is not seeded`).toBe(
                actingCustomer.emailAddress,
            );

            let bodyError: unknown;
            try {
                // THE PLUGIN-LESS BASELINE, reached by the artefact's own reverse. It drops the child table
                // first, so a foreign key is never what fails the revert.
                await migration.down(queryRunner);
                expect(
                    await queryRunner.hasTable(LINE_TABLE),
                    `${diagnostic}: down() left ${LINE_TABLE} behind`,
                ).toBe(false);
                expect(
                    await queryRunner.hasTable(LIST_TABLE),
                    `${diagnostic}: down() left ${LIST_TABLE} behind`,
                ).toBe(false);
                // The baseline is still known-good, and nothing re-created the two tables behind the test.
                expect(
                    await readCoreRowCensus(),
                    `${diagnostic}: reverting the migration moved core rows`,
                ).toEqual(coreBaseline);

                // APPLIED. The parent table is created first, and both are queryable afterwards — which is
                // the claim every criterion below rests on, now made about the migration's own output.
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
                expect(Array.isArray(listRows), `${diagnostic}: ${LIST_TABLE} is not queryable`).toBe(true);
                expect(listRows.length, `${diagnostic}: ${LIST_TABLE} was created carrying rows`).toBe(0);
                expect(await countAllLines(), `${diagnostic}: ${LINE_TABLE} is not queryable`).toBe(0);

                // REVERTED a second time, and the core rows the baseline is known-good by survive. A revert
                // is only reversible if it is also non-destructive to everything it does not own.
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

            // THE SCHEMA IS RESTORED UNCONDITIONALLY, because every later test in this file addresses these
            // two tables and `afterEach` empties them. The reverse runs first so a partially applied state is
            // cleaned rather than built on, and the body's own error is preserved rather than replaced by a
            // failure that happened while putting the schema back.
            //
            // EACH STEP IS GUARDED BY THE STATE IT NEEDS, because a generated migration is not idempotent —
            // no generated migration is. The artefact's `down()` is the generator's own reverse, so run
            // against an already-reverted schema it fails on the first table it addresses (`no such table:
            // reorder_list_line` on the SQLite family), and its `up()` fails just as surely on a table that
            // already exists. The body above may end in either state depending on where it stopped, so the
            // reverse runs only when both tables are present and the apply only when neither is. A state
            // with exactly one of them present is reported by the two assertions below rather than papered
            // over here: it means a statement failed mid-migration, which is the body's finding to make.
            const restoreFailures: string[] = [];
            const bothPresent = async (): Promise<boolean> =>
                (await queryRunner.hasTable(LIST_TABLE)) && (await queryRunner.hasTable(LINE_TABLE));
            const neitherPresent = async (): Promise<boolean> =>
                !(await queryRunner.hasTable(LIST_TABLE)) && !(await queryRunner.hasTable(LINE_TABLE));
            for (const step of [
                { what: 'down()', ready: bothPresent, run: () => migration.down(queryRunner) },
                { what: 'up()', ready: neitherPresent, run: () => migration.up(queryRunner) },
            ]) {
                try {
                    if (await step.ready()) {
                        await step.run();
                    }
                } catch (e) {
                    restoreFailures.push(`${step.what}: ${e instanceof Error ? e.message : String(e)}`);
                }
            }
            if (bodyError) {
                throw bodyError;
            }
            expect(restoreFailures, `${diagnostic}: restoring the schema after the cycle failed`).toEqual([]);
            expect(await queryRunner.hasTable(LIST_TABLE), `${diagnostic}: schema not restored`).toBe(true);
            expect(await queryRunner.hasTable(LINE_TABLE), `${diagnostic}: schema not restored`).toBe(true);
        });

        it('checkpoint 3: createReorderList is published and all 19 baseline root queries are byte-identical', () => {
            // DIAGNOSTIC ON FAILURE: the `shopApiExtensions` wiring is wrong, or a generator widened
            // something. Two assertions and NO database work at all.
            const diagnostic =
                'checkpoint 3 (shopApiExtensions wiring, or a generator widened an existing field)';

            const liveMutations = fieldSignaturesOf(liveSchema, 'Mutation');
            expect(
                liveMutations.has(STORY_ROOT_MUTATION),
                `${diagnostic}: ${STORY_ROOT_MUTATION} is not on the root Mutation type`,
            ).toBe(true);

            // The nineteen baseline root queries, each compared as a whole signature — name, ordered argument
            // list, argument types and defaults, return type and nullability.
            const baselineQueries = fieldSignaturesOf(snapshotSchema, 'Query');
            const liveQueries = fieldSignaturesOf(liveSchema, 'Query');
            expect(baselineQueries.size, 'The checked-in snapshot moved').toBe(
                BASELINE_ROOT_QUERY_FIELD_COUNT,
            );
            for (const [name, signature] of baselineQueries) {
                expect(liveQueries.get(name), `${diagnostic}: root query ${name} changed`).toBe(signature);
            }

            // THIS STORY ADDS NO QUERY, and the form of that assertion matters. An exact post-plugin total is
            // refused by EPIC-001 ruling R15 because a total stops being true the moment a query-adding sibling
            // merges — and the sibling here is in the same `gql` document, since one document carries
            // FEATURE-001-01's whole surface. So what is asserted is baseline-plus-owned-additions: nothing was
            // removed, and every field that appeared is one of this plugin's own declared reads, neither of
            // which this story contributes.
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
            // wrong — never the list-creation logic, which no assertion has reached yet, and never a
            // permission registration, of which this story has none.
            const diagnostic = 'checkpoint 4 (seed / credential / channel token / @Allow wiring)';

            // Signed in through the shipped Shop operation, and confirmed through the shipped read.
            const { activeCustomer } = await shopClient.query<GetActiveCustomerQuery>(
                GET_ACTIVE_CUSTOMER_FOR_REORDER_CREATE,
            );
            expect(activeCustomer, `${diagnostic}: no active customer after sign-in`).not.toBeNull();
            expect((activeCustomer as { id: ReorderApiId }).id, diagnostic).toBe(actingCustomer.id);

            // THE PAIR THE PLATFORM CAN ACTUALLY PRODUCE. The session holds `Permission.Authenticated` and
            // nothing else, and the gate marks the context `authorizedAsOwnerOnly`. It is deliberately NOT
            // asserted that any session "holds Permission.Owner": that member is declared
            // `assignable: false, internal: true`, so it is in no session's permission set and the claim
            // would be false against a correct platform (EPIC-001 rulings R2 and R3).
            const session = await server.app
                .get(SessionService)
                .getSessionFromToken(shopClient.getAuthToken());
            expect(session, `${diagnostic}: the bearer token resolved to no session`).toBeDefined();
            const sessionUser = session?.user;
            expect(sessionUser, `${diagnostic}: the session carries no user`).toBeDefined();
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

            // The gate's own computation, run through the platform's own helper with the permission the
            // resolver lists. `RequestContextService.create()` cannot be used for this: it hard-codes
            // `authorizedAsOwnerOnly` to false, whereas `fromRequest` is the path the guard itself takes.
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

            // One call to the new mutation, observed ONLY for not being refused by the gate. Nothing about
            // the created row is asserted here; that is AC-1's job.
            const result = await createReorderList('Checkpoint four list');
            expect(result.__typename, `${diagnostic}: the gate refused an authenticated buyer`).toBe(
                'ReorderList',
            );
        });
    });

    // ===============================================================================================
    // AC-1 — a named list is created for the authenticated customer in the active channel
    // ===============================================================================================

    describe('AC-1: a named list is created for the authenticated customer in the active channel', () => {
        it('createReorderList returns the submitted name character for character with lineCount exactly 0', async () => {
            const result = expectCreated(await createReorderList(BASE_LIST_NAME));

            // Character for character rather than "contains" or "matches": a trimmed, re-cased or
            // whitespace-rewritten name would satisfy a looser assertion while breaking the contract.
            expect(result.name).toBe(BASE_LIST_NAME);
            expect(result.name.length).toBe(BASE_LIST_NAME.length);
            // Exactly zero, and stated as an identity rather than as falsiness: this story writes no line row
            // at all, the first arriving with `addItemToReorderList` in STORY-001-01-02.
            expect(result.lineCount).toBe(0);
            expect(result.lines.totalItems).toBe(0);
            expect(result.lines.items).toEqual([]);
            // The forward-compatible sharing shape, published now and truthful now: the shared set is empty by
            // construction because no grant table exists until FEATURE-001-06.
            expect(result.viewerAccess).toEqual({ access: 'OWNED', grantedCapabilities: [] });
            expect(await countAllLines()).toBe(0);
        });

        it('createReorderList stores the authenticated customerId and the token channelId', async () => {
            const result = expectCreated(await createReorderList(BASE_LIST_NAME));

            const row = await readTheOnlyListRow();
            // The OWNER is the authenticated session's customer and the CHANNEL is the one the
            // `vendure-token` header selected — read from the stored row rather than from the payload, because
            // the payload could report either without the row carrying it.
            expect(Number(row.customerId)).toBe(actingCustomerDbId);
            expect(Number(row.channelId)).toBe(defaultChannelDbId);
            expect(Number(row.id)).toBe(decodeId(result.id));
            expect(await countLists(actingCustomerDbId, defaultChannelDbId)).toBe(1);
            // Nothing landed under the other customer or the other channel.
            expect(await countLists(otherCustomerDbId, defaultChannelDbId)).toBe(0);
            expect(await countLists(actingCustomerDbId, secondChannelDbId)).toBe(0);
        });

        it('createReorderList returns the same name string under a second languageCode', async () => {
            // A list name is a plugin-owned string on the plugin's own table with NO translation entity behind
            // it, so the language a request resolves must not touch it. Two halves make that falsifiable, and
            // they run in this order because the list bound is checked before the name: adding the second row
            // first would make the conflict attempt below reach the bound instead of the name rule.
            const created = expectCreated(await createReorderList(BASE_LIST_NAME));
            expect(created.name).toBe(BASE_LIST_NAME);
            const storedKey = String((await readTheOnlyListRow()).nameKey);

            // Half one, and the one a translated column would fail: the SAME name submitted again under a
            // second language collides with the row created under the default language. A per-language
            // translation scope would leave the name free there and return a second `ReorderList`.
            const conflict = expectNameConflict(
                await createReorderListInLanguage(BASE_LIST_NAME, SECOND_LANGUAGE_CODE),
            );
            expect(conflict.conflictingNameKey).toBe(storedKey);
            expect(await countLists(actingCustomerDbId, defaultChannelDbId)).toBe(1);

            // Half two: a create under the second language returns its own submitted name byte-identically and
            // stores it byte-identically, so the request's language changes neither the payload nor the row.
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

            // Neither escaped, nor stripped, nor interpreted as markup, nor entity-decoded: the field carries
            // DATA and every consumer renders it as text. This story owns the transport half of that guarantee
            // only; the rendering half belongs to STORY-001-08-03 in batch B5 and is not claimed here.
            expect(result.name).toBe(MARKUP_LIST_NAME);
            expect(result.name).toContain('<b>');
            expect(result.name).toContain('&amp;');
            expect(result.name).not.toContain('&lt;');
            expect(result.name).not.toContain(' & ');

            // And the value AT REST is the same bytes, which is the half a response-only assertion misses.
            const row = await readTheOnlyListRow();
            expect(String(row.name)).toBe(MARKUP_LIST_NAME);
        });

        it('createReorderList stores exactly five data columns beyond id, createdAt and updatedAt', async () => {
            expectCreated(await createReorderList(BASE_LIST_NAME));

            // The column set comes from the DATABASE — the keys of a `SELECT *` row — rather than from a
            // column list written here, which would simply not select a sixth column and would pass.
            const row = await readTheOnlyListRow();
            const observedColumns = Object.keys(row).sort();
            expect(observedColumns).toEqual(
                [...EXPECTED_LIST_DATA_COLUMNS, ...INHERITED_ENTITY_COLUMNS].sort(),
            );

            // The ORM's own metadata has to agree with the physical table, so a column declared but not
            // created — or created but not declared — is a failure rather than a silent divergence.
            const declaredColumns = dataSource
                .getMetadata(ReorderList)
                .columns.map(column => column.databaseName)
                .sort();
            expect(declaredColumns).toEqual(observedColumns);

            // Named individually as well as counted, because the requirement is a NAMED five: no contact
            // detail, no free-text note beyond the name the buyer supplied, and no serialised request context.
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
            // The CURRENCY dimension, discharged at the payload level against the INTROSPECTED schema rather
            // than by reading this plugin's source. This feature stores, returns and compares no monetary value
            // of any kind, so any match is a finding.
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
            // And the row itself carries none either, asserted against the same declared column set.
            for (const column of dataSource.getMetadata(ReorderList).columns) {
                expect(
                    MONETARY_OR_STOCK_FIELD.test(column.databaseName),
                    `${LIST_TABLE}.${column.databaseName} looks like a monetary or stock column`,
                ).toBe(false);
            }
        });
    });

    // ===============================================================================================
    // AC-2 — a name failing the input contract is rejected, writes no row, and is neither truncated
    //        nor silently altered
    // ===============================================================================================

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
                // Recorded BEFORE each call, so the assertion after it is about this call rather than about the
                // state some earlier call happened to leave.
                const countBefore = await countLists(actingCustomerDbId, defaultChannelDbId);

                const response = await expectTopLevelFailure(
                    () => createReorderList(name),
                    `${label} was accepted rather than refused`,
                );
                // Exactly one entry, its `extensions.code` exactly USER_INPUT_ERROR, `data.createReorderList`
                // exactly null, and no other entry — never a union member, because none of this feature's four
                // error results covers a malformed name and a fifth is deliberately not invented.
                expectExactlyOneTopLevelError(response, USER_INPUT_ERROR_CODE);

                expect(
                    await countLists(actingCustomerDbId, defaultChannelDbId),
                    `${label} changed the stored row count`,
                ).toBe(countBefore);
                expect(await readAllListRows(), `${label} wrote a row`).toEqual([]);
            }
        });

        it('createReorderList accepts a canonical name of exactly 190 characters', async () => {
            // One below the bound. Asserted against the FIXED CONSTANT written out in this file rather than
            // against a configured value: conflict C-B resolves the story's self-contradiction in favour of the
            // constant, because there is deliberately no name-length option and the number is the `name`
            // column's declared width.
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

            // THE FIFTH CALL, and the reason it exists. Submitting the same name MINUS ITS FINAL CHARACTER is
            // how "nothing was truncated" is PROVED rather than assumed: if the refused call had quietly stored
            // a shortened 191-character version, this call would collide with it instead of storing.
            const trimmedToBound = overLong.slice(0, MAX_LIST_NAME_LENGTH);
            expect(trimmedToBound.length).toBe(MAX_LIST_NAME_LENGTH);
            const stored = expectCreated(await createReorderList(trimmedToBound));
            expect(stored.name).toBe(trimmedToBound);
            expect(await countLists(actingCustomerDbId, defaultChannelDbId)).toBe(1);
            expect(String((await readTheOnlyListRow()).name)).toBe(trimmedToBound);
        });
    });

    // ===============================================================================================
    // AC-3 — a name the same customer already holds returns ReorderListNameConflictError
    // ===============================================================================================

    describe('AC-3: a name the same customer already holds returns ReorderListNameConflictError', () => {
        it('createReorderList refuses an identical and a case-folded name, leaving exactly one row', async () => {
            // Call one establishes this test's own precondition.
            const created = expectCreated(await createReorderList(BASE_LIST_NAME));
            const storedKey = String((await readTheOnlyListRow()).nameKey);
            // The stored key is what the pipeline produced; comparing it with the locally-lower-cased name is
            // safe for THIS name alone, which is pure ASCII, already trimmed and already single-spaced — and it
            // is asserted rather than assumed so the two cannot drift.
            expect(storedKey).toBe(BASE_LIST_NAME.toLowerCase());

            // Call two: the same name.
            const identical = expectNameConflict(await createReorderList(BASE_LIST_NAME));
            expect(identical.errorCode).toBe('REORDER_LIST_NAME_CONFLICT_ERROR');
            expect(identical.conflictingNameKey).toBe(storedKey);
            expect(identical.message.length).toBeGreaterThan(0);
            expect(await countLists(actingCustomerDbId, defaultChannelDbId)).toBe(1);

            // Call three: the same name altered ONLY along a dimension the canonicalisation collapses. Because
            // it collides, the normalisation the service applies before comparing is observable from the
            // published operation rather than only from the database's collation.
            const caseFolded = expectNameConflict(await createReorderList(BASE_LIST_NAME.toUpperCase()));
            expect(caseFolded.errorCode).toBe('REORDER_LIST_NAME_CONFLICT_ERROR');
            expect(caseFolded.conflictingNameKey).toBe(storedKey);

            // Exactly one row after all three calls.
            expect(await countLists(actingCustomerDbId, defaultChannelDbId)).toBe(1);
            expect(await countListsWithKey(actingCustomerDbId, defaultChannelDbId, storedKey)).toBe(1);
            expect(String((await readTheOnlyListRow()).name)).toBe(BASE_LIST_NAME);
        });

        it('createReorderList refuses a name differing only by surrounding and internal whitespace', async () => {
            expectCreated(await createReorderList(BASE_LIST_NAME));
            const storedKey = String((await readTheOnlyListRow()).nameKey);

            // Leading and trailing whitespace is removed and internal whitespace runs collapse to one space,
            // so all three of these canonicalise onto the stored key.
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
            // Precomposed U+00E9. The pipeline normalises to NFC before lower-casing, so the decomposed form
            // of the same characters produces the same key — while dropping the accent produces a DIFFERENT
            // key, because the comparison is case-insensitive and accent-PRESERVING.
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

    // ===============================================================================================
    // AC-4 — the configured list bound, and two simultaneous creates that cannot exceed it
    // ===============================================================================================

    describe('AC-4: the configured list bound returns ReorderListLimitError and cannot be exceeded', () => {
        /**
         * One side of a create race: its precheck counts the lists it holds on its OWN connection, and its
         * write is THE REAL SERVICE OPERATION, executed on that same connection inside that same open
         * transaction.
         *
         * Two properties make this evidence rather than a hopeful pair of calls, and neither is optional.
         *
         * Both prechecks run to completion before either write begins, so both callers provably saw the same
         * starting state — which is exactly the window a count-then-insert implementation loses a row in.
         *
         * And the write is bound to this participant's transaction rather than issued over HTTP. An HTTP call
         * opens a transaction of the server's own choosing on a connection this barrier has never touched, so
         * the rendezvous would sit outside the operation under test: the two requests could be serialised end
         * to end by the server and the run would still look green, which is precisely how an implementation
         * with neither a row lock nor a constraint passes a race test. Binding the context puts the whole
         * operation — its locking read, its bound count and its insert — on the held connection, so the
         * overlap the assertion claims is the overlap that occurred.
         *
         * The published mutation is NOT abandoned by this: the sequential form of the same contract below
         * drives it over HTTP on every engine, and so does every other criterion in this file.
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
                    // bound count the service then takes would answer from a snapshot older than the winner's
                    // commit. The harness would be creating the very lost-update it set out to detect. Read on the
                    // shared data source instead: the observation is of the same shared state at the same moment,
                    // and the participant's transaction reaches the service uncontaminated, exactly as a real
                    // request's does.
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
                    // Asserted rather than trusted. A context that silently lost its binding would run the
                    // operation on a connection of the platform's choosing, and the run would report a clean
                    // serialisation while evidencing nothing about the race.
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
         *
         * The success member is a `ReorderList` entity and the refusal is the plugin's own error class, so
         * both are discriminated by class rather than by a `__typename` the entity does not carry — and the
         * refusal's three published fields are asserted on the object the resolver would hand the union
         * resolver, not on a re-serialised copy of it.
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
            // The winner is a real stored row owned by the acting customer in the acting channel, with the
            // published initial count — a refusal reported as a success would otherwise satisfy the counts.
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

            // AT the maximum as well as over it: holding exactly the maximum leaves no room for one more.
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
                // BEHAVIOURAL half of the same claim — the limit error and the unchanged row count — is
                // asserted by the ungated case above and therefore runs on all four engine jobs.
                //
                // "Zero statements against reorder_list" is deliberately NOT asserted: the server cannot
                // discover how many lists a customer holds without asking, so that assertion is unpassable
                // for a correct implementation.
                await seedLists('AC-4 instrumented', MAX_LISTS_PER_CUSTOMER);

                // Reset immediately before the window so the seeding statements fall outside the number, and
                // captured through `capture()` so the window closes the moment the operation returns.
                capture.reset();
                const refused = expectLimit(
                    await capture.capture(() => createReorderList('AC-4 instrumented refusal')),
                );
                expect(refused.maxItems).toBe(MAX_LISTS_PER_CUSTOMER);

                const scoped = capture.selectsFor(LIST_TABLE);
                // Equality, never "at least one" and never "no more than".
                expect(scoped.length, `filtered to ${LIST_TABLE}:\n${capture.format()}`).toBe(1);
                // The write half is genuinely zero, and is stated separately from the read half.
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
                // used rather than a name search precisely because a disjunction, a swapped binding or a
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
                // ★ THE BLAST RADIUS OF THE LOCK, ASSERTED AS A STATEMENT SHAPE.
                //
                // The list bound is enforced by counting and inserting inside one transaction under a
                // pessimistic lock on the owning `customer` row, and the lock's WIDTH is a property no payload
                // can show. TypeORM renders `setLock('pessimistic_write')` as a bare `FOR UPDATE` with no `OF`
                // list, and a bare `FOR UPDATE` locks a row in EVERY table the statement reads — so a shape
                // that reached the acting customer through `INNER JOIN "user" ON "user"."id" =
                // "customer"."userId"` would hold a lock on a `user` row too, for the whole of the
                // transaction, on a row an authentication path may itself be writing. Nothing about the
                // outcome would look wrong; the cost would appear as unrelated logins waiting on a list
                // creation.
                //
                // So the statement is required to name one table. It reaches the acting customer by the
                // relation's own join column instead, which addresses the same single row and reads the same
                // physical column the join read.
                //
                // Gated on the engines that take row locks: the SQLite family emits no lock clause at all,
                // serving a single connection, and the behaviour the lock protects is asserted on all four
                // engine jobs by the bound's own cases above.
                capture.reset();
                const created = await capture.capture(() => createReorderList('Customer lock scope'));
                expect(created.__typename).toBe('ReorderList');

                const locked = capture.statements.filter(
                    statement => classifyLockClause(statement) !== 'none',
                );
                // Exactly one locking statement in the whole operation, and it is the owner look-up.
                expect(locked.length, capture.format()).toBe(1);
                expect(classifyLockClause(locked[0]), capture.format()).toBe('exclusive');
                expect(locked[0].kind, capture.format()).toBe('select');
                // ONE TABLE. `tables` is reference attribution — every table the statement reads, including
                // through a join or a sub-query — which is exactly the set a bare `FOR UPDATE` locks in.
                expect(locked[0].tables, capture.format()).toEqual(['customer']);
                // And it is its TRANSACTION's first statement, which the bound separately depends on: on the
                // MySQL family a plain read issued before the lock would fix this transaction's read view
                // before the lock was held, and the count would then answer from a snapshot older than a
                // competing creator's commit.
                //
                // "First of its transaction" rather than "first of the window": the window is the whole
                // request, which begins with the platform's own session and channel reads on other
                // connections. So the claim is read off the connection that issued the lock — every statement
                // of that connection before it must be transaction control (`START TRANSACTION`, `SAVEPOINT`)
                // and nothing else.
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
                // two independent connections against. It is skipped on the single-connection family, which
                // runs the sequential form below instead — see SEQUENTIAL_FORM_NOTE for the stated reason.
                await seedLists('AC-4 racing held', MAX_LISTS_PER_CUSTOMER - 1);
                expect(await countLists(actingCustomerDbId, defaultChannelDbId)).toBe(
                    MAX_LISTS_PER_CUSTOMER - 1,
                );
                await secondShopClient.asUserWithCredentials(
                    actingCustomer.emailAddress,
                    SEEDED_CUSTOMER_PASSWORD,
                );
                secondShopClient.setChannelToken(E2E_DEFAULT_CHANNEL_TOKEN);

                // One authenticated context per caller, built before the pair starts so that resolving the
                // session and the channel is never work done inside a held transaction.
                const firstContext = await shopContextFor(shopClient);
                const secondContext = await shopContextFor(secondShopClient);

                const outcome = await runBarrieredPair(dataSource, {
                    a: racingCreate('first-writer', firstContext, 'AC-4 racing alpha', 1),
                    b: racingCreate('second-writer', secondContext, 'AC-4 racing beta', 1),
                });

                // Both callers RESOLVE here — one with a list and one with a refusal — so `fulfilled` is the
                // right accessor and `winner`/`loser`, which require exactly one rejection, are correctly
                // undefined. The harness has already refused to return a result unless both participants were
                // held at the rendezvous and released before writing; asserting it makes that explicit.
                expect(
                    outcome.rejected,
                    JSON.stringify(outcome.rejected.map(entry => String(entry.label))),
                ).toEqual([]);
                expect(outcome.fulfilled.length).toBe(2);
                expect(outcome.a.releasedBeforeWrite).toBe(true);
                expect(outcome.b.releasedBeforeWrite).toBe(true);

                const results = outcome.fulfilled.map(
                    entry => (entry as { value: CreateReorderListResult }).value,
                );
                expectExactlyOneServiceCreateAndOneLimitRefusal(results);

                // The assertion a count-before-insert implementation fails: exactly the bound, not one past it.
                expect(await countLists(actingCustomerDbId, defaultChannelDbId)).toBe(MAX_LISTS_PER_CUSTOMER);
                // And the winner's row is genuinely committed and readable outside either transaction, which is
                // what distinguishes a real create from a value the loser's rollback took with it.
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
            // single-connection family this is the only form available, and SEQUENTIAL_FORM_NOTE states what it
            // does and does not evidence — it is quoted in the assertion message so a failure carries it.
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

    // ===============================================================================================
    // AC-5 — an unauthenticated request writes nothing
    // ===============================================================================================

    describe('AC-5: an unauthenticated request writes nothing', () => {
        it('createReorderList refuses an unauthenticated request with exactly one FORBIDDEN entry', async () => {
            // The request still carries a valid channel token; only the session is absent.
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
            // `Permission.Owner`, which is `assignable: false, internal: true`, so the guard admits a session
            // that does not hold it and merely marks the context `authorizedAsOwnerOnly` — which is why an
            // unauthenticated request reaches the resolver at all and is stopped there.
            expect(await readAllListRows()).toEqual([]);
            expect(await countLists(actingCustomerDbId, defaultChannelDbId)).toBe(0);
            expect(await countAllLines()).toBe(0);
        });
    });

    // ===============================================================================================
    // AC-6 — an ordinary customer session reaches the operation, and ownership is session-derived
    // ===============================================================================================

    describe('AC-6: an ordinary customer session succeeds and cannot nominate a different owner', () => {
        it('createReorderList succeeds for a session holding only Permission.Authenticated', async () => {
            // Authenticated as the SECOND of the two seeded customers, holding the single permission the
            // Customer Role carries and NO plugin-registered permission of any kind — this feature registers
            // none. This POSITIVE assertion is the one whose absence would let the design fault the epic
            // records as collision C7 reach production: the obvious reading of the gate would refuse every
            // buyer, so what has to be proved is that an ordinary buyer SUCCEEDS.
            expect(seededCustomers.length).toBeGreaterThanOrEqual(2);
            expect(actingCustomer.id).not.toBe(otherCustomer.id);
            expect(await countLists(otherCustomerDbId, defaultChannelDbId)).toBe(0);

            const created = expectCreated(await createReorderList('AC-6 ordinary session list'));

            const row = await readTheOnlyListRow();
            expect(Number(row.customerId)).toBe(actingCustomerDbId);
            expect(Number(row.channelId)).toBe(defaultChannelDbId);
            expect(Number(row.id)).toBe(decodeId(created.id));

            // NO row owned by the first customer can be produced by this call.
            expect(await countLists(otherCustomerDbId, defaultChannelDbId)).toBe(0);
            expect(await countLists(otherCustomerDbId, secondChannelDbId)).toBe(0);
        });

        it('createReorderList exposes no argument able to nominate a different owner', async () => {
            // Asserted against the INTROSPECTED input rather than against this plugin's source: the input
            // declares exactly one field, so there is no argument through which a caller could name an owner, a
            // customer or a channel. Ownership is derived from the session and the channel from the token.
            expect(sortedInputFieldNames(liveSchema, 'CreateReorderListInput')).toEqual(['name']);

            const mutationFields = requireType(liveSchema, 'Mutation').fields ?? [];
            const createField = mutationFields.find(field => field.name === 'createReorderList');
            expect(createField, 'createReorderList is absent from the root Mutation type').toBeDefined();
            expect((createField?.args ?? []).map(arg => arg.name)).toEqual(['input']);
            expect(renderFieldSignature(createField as IntrospectedField)).toBe(
                'createReorderList(input: CreateReorderListInput!): CreateReorderListResult!',
            );

            // And the behavioural half: the only field there is carries a NAME, so the created row's owner is
            // the session's customer whatever the caller writes into it.
            const created = expectCreated(await createReorderList('AC-6 owner is session derived'));
            expect(Number((await readTheOnlyListRow()).customerId)).toBe(actingCustomerDbId);
            expect(created.name).toBe('AC-6 owner is session derived');
        });
    });

    // ===============================================================================================
    // AC-7 — two concurrent requests for the same name leave exactly one row and one exact conflict
    // ===============================================================================================

    describe('AC-7: concurrent same-name creates leave exactly one row and one exact conflict error', () => {
        /**
         * One side of a same-name race: precheck counts the rows already carrying the canonical key, write is a
         * real API call carrying that name.
         *
         * Both prechecks resolve to zero before either write starts, which is what puts both callers inside the
         * window `UQ_reorder_list_customer_channel_name_key` exists to survive — a service pre-check alone
         * cannot answer this case, because both requests legitimately read "no such name".
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
                    // bound count the service then takes would answer from a snapshot older than the winner's
                    // commit. The harness would be creating the very lost-update it set out to detect. Read on the
                    // shared data source instead: the observation is of the same shared state at the same moment,
                    // and the participant's transaction reaches the service uncontaminated, exactly as a real
                    // request's does.
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
                    // the two calls could be serialised end to end — which is exactly the run in which the
                    // service's advisory pre-check answers both callers and the constraint is never reached.
                    // Bound here, both callers pass that pre-check and the named constraint is what decides.
                    const boundContext = transactionBinder.bind(sessionContext, ctx.manager);
                    expect(
                        transactionBinder.managerOf(boundContext),
                        `${label} is not bound to its own barrier transaction`,
                    ).toBe(ctx.manager);
                    // A ONE-PARTICIPANT PRE-WRITE HOLD, WHICH FIRES AND CONTINUES RATHER THAN WAITING, and
                    // the participant count is one for a reason that belongs to the operation rather than to
                    // this harness. `createReorderList` takes a pessimistic write lock on the owning customer
                    // row as its FIRST statement (`getLockedOwnerScope`, taken for lock ORDER across the
                    // service), so a second caller for the same customer blocks there and can never reach its
                    // own write while the first is held: a two-participant hold placed here would deadlock
                    // both callers until its deadline and would evidence nothing. What this one-participant
                    // hold does establish is that the operation's first statement against a plugin table was
                    // issued THROUGH THIS PARTICIPANT'S OWN HELD CONNECTION and after its own reads — so a
                    // refactor that moved the write onto a connection of the platform's choosing would fail
                    // here rather than quietly turn this race back into two independent requests.
                    //
                    // The window this operation cannot be held in two at a time is held open singly, and
                    // asserted, by the case below this pair.
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
            // The key the loser is told about is the key the winner stored, so a client can act on it.
            expect(refused[0].conflictingNameKey).toBe(String(created[0].nameKey));
            // NEITHER execution returns a database-level failure to the caller, so the mapped message carries
            // no driver text, no SQL fragment and no constraint name.
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
            // NEITHER execution returns a database-level failure to the caller, so the mapped message carries
            // no driver text, no SQL fragment and no constraint name — a raw driver message can disclose the
            // schema, the column list and sometimes the conflicting value itself.
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

                // One authenticated context per caller, built before the pair starts so that resolving the
                // session and the channel is never work done inside a held transaction.
                const firstContext = await shopContextFor(shopClient);
                const secondContext = await shopContextFor(secondShopClient);

                // One rendezvous per participant, for the participant-count reason documented in
                // racingSameNameCreate: these two callers cannot be held simultaneously, so each is held
                // singly and each is asserted to have fired.
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

                expect(outcome.rejected).toEqual([]);
                expect(outcome.fulfilled.length).toBe(2);
                expect(outcome.a.releasedBeforeWrite).toBe(true);
                expect(outcome.b.releasedBeforeWrite).toBe(true);
                // The WINNER's first write on the list table went through its own held connection. Exactly
                // one of the two reaches a write at all: the loser is refused before writing anything, by the
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
         *
         * This bounds an event that happened rather than inferring one from silence, and it exists for a
         * single reason: MariaDB answers `NOWAIT` with its lock-wait-timeout error code, so the code alone
         * cannot distinguish an immediate refusal from a wait that ran its course. Every engine's configured
         * wait is far longer than this — `innodb_lock_wait_timeout` defaults to 50 seconds and PostgreSQL
         * waits indefinitely — so a refusal inside this bound cannot have been produced by one.
         */
        const LOCK_REFUSAL_CEILING_MS = 8000;

        /**
         * Both outcomes of a pair rendered for a diagnostic, INCLUDING the reason a rejected participant
         * carries — without which a failed race reports only that a participant rejected and not why.
         */
        function describeAbandonedPair(result: {
            a: { label: string; status: string; reason?: unknown };
            b: { label: string; status: string; reason?: unknown };
        }): string {
            return [result.a, result.b]
                .map(entry =>
                    entry.status === 'rejected'
                        ? `${entry.label} REJECTED: ${
                              entry.reason instanceof Error ? entry.reason.message : String(entry.reason)
                          }`
                        : `${entry.label}=fulfilled`,
                )
                .join(' | ');
        }

        /**
         * The competing lock request, spelled so that the ENGINE answers it immediately either way.
         *
         * `FOR UPDATE NOWAIT` is what makes this case deterministic rather than timed. A plain `FOR UPDATE`
         * would block, and the only way to observe blocking is to wait a while and conclude from silence —
         * which cannot tell a held row lock apart from a merely slow statement, and never proves the request
         * reached the database at all. `NOWAIT` turns both halves into positive, server-generated events: the
         * row's owner is another transaction, so the engine refuses at once with a lock-not-available error
         * carrying its own code; the owner commits, so the same statement succeeds at once. Every assertion
         * below is on one of those two answers.
         *
         * Supported by all three engines this case runs on — PostgreSQL, MySQL 8.0.1 and above, MariaDB 10.3
         * and above — and sql.js runs no barriered form at all.
         */
        function competingLockSql(): string {
            return (
                `SELECT ${esc('id')} FROM ${esc('customer')} ` +
                `WHERE ${esc('id')} = ${actingCustomerDbId} FOR UPDATE NOWAIT`
            );
        }

        /**
         * Whether an error is the engine saying "that row is locked by someone else, and you said NOWAIT".
         *
         * THREE SPELLINGS, ALL MEASURED ON THE ENGINES THIS CASE RUNS ON rather than taken from a manual:
         *
         *   - PostgreSQL raises SQLSTATE `55P03`, `lock_not_available`.
         *   - MySQL 8 raises `ER_LOCK_NOWAIT`, 3572, "Statement aborted because lock(s) could not be
         *     acquired immediately and NOWAIT is set."
         *   - MariaDB 11.5 reuses `ER_LOCK_WAIT_TIMEOUT`, 1205, "Lock wait timeout exceeded" — its `NOWAIT`
         *     is implemented as a zero wait, so the refusal arrives through the timeout error code. Accepting
         *     1205 does NOT weaken the evidence into a timing inference: the statement carried `NOWAIT`, so
         *     there was no wait to time out, and {@link LOCK_REFUSAL_CEILING_MS} asserts the refusal came
         *     back far sooner than any engine's configured wait could have elapsed.
         *
         * The message forms are accepted as a fallback so a driver that surfaces the code differently still
         * classifies, and a failure prints the whole error so a new spelling is added deliberately rather
         * than swallowed.
         */
        /** An unrecognised engine answer rendered in full, so a new spelling is added rather than guessed. */
        function describeUnknownError(err: unknown): string {
            const candidate = err as { code?: unknown; errno?: unknown; message?: unknown } | undefined;
            return `code=${String(candidate?.code)} errno=${String(candidate?.errno)} message=${String(
                candidate?.message,
            )}`;
        }

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
                 * WHAT THIS CASE ADDS TO THE PAIR ABOVE, AND WHY IT IS A SEPARATE CASE RATHER THAN AN
                 * ASSERTION INSIDE IT.
                 *
                 * The pair above releases both callers together, which starts both operations at the same
                 * moment. That is not the same claim as "both operations were inside the window their
                 * uniqueness rule has to survive": each operation performs its own scoped duplicate count
                 * before it inserts, and a pair released together can still run one wholly after the other.
                 *
                 * For THIS operation the two callers provably cannot overlap, and the reason is the design
                 * rather than the harness: `getLockedOwnerScope` takes a pessimistic write lock on the owning
                 * customer row as the transaction's FIRST statement, so a second caller for the same customer
                 * blocks there and reaches none of its own reads while the first is held. Holding two of them
                 * at a pre-write rendezvous would deadlock both until the rendezvous deadline and would
                 * evidence nothing at all.
                 *
                 * So the window is held open ONCE and measured. One real `createReorderList` is stopped
                 * immediately before its own `INSERT` — past its owner lock, past its list-count bound check
                 * and past its scoped duplicate count, with nothing yet written — and a second transaction
                 * then attempts the very lock that operation's first statement takes. It cannot have it while
                 * the window is open, and it takes it immediately once the window closes. That is the
                 * serialisation the pair above depends on, asserted rather than assumed: it is what makes a
                 * conflicting row impossible to commit between this operation's duplicate count and its
                 * insert, and therefore what makes the pair's single surviving row a property of the design
                 * instead of a scheduling accident.
                 *
                 * The constraint's own half is not weakened by this and is not asserted here: the case below
                 * writes a duplicate straight through the repository, on all four engines, where no lock and
                 * no service pre-check can intercept it.
                 */
                expect(SQLJS_EXCLUSION_REASON.length).toBeGreaterThan(0);
                const nameKey = BASE_LIST_NAME.toLowerCase();
                expect(await countListsWithKey(actingCustomerDbId, defaultChannelDbId, nameKey)).toBe(0);

                const sessionContext = await shopContextFor(shopClient);
                // Two arrivals: the held operation itself, and this test through `arriveExternally` once it
                // has finished measuring the window.
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
                                // stopped at can be named in a diagnostic, and so the hold's OWN release
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
                            // The window is not open until the operation has actually reached its write. An
                            // offer made before that would be answered by an unlocked row.
                            expect(
                                await preWrite.waitForArrivals(1),
                                'The creating operation never reached its own first write, so there was no ' +
                                    'window in which to offer the competing lock',
                            ).toBe(true);

                            // THE FIRST HALF OF THE EVIDENCE, AND THE ENGINE PRODUCES IT. The same row the
                            // operation locked is requested `NOWAIT`, so the answer is a refusal carrying the
                            // engine's own lock-not-available code — which is proof both that the statement
                            // reached the database and that the row was held by another transaction. Nothing
                            // here is inferred from how long anything took.
                            const offeredAt = Date.now();
                            refusalWhileHeld = await offerCompetingLock(ctx.queryRunner);
                            refusalElapsedMs = Date.now() - offeredAt;

                            // Releases the held operation, which then inserts, returns, and has its
                            // transaction committed by this harness — at which point the lock is free.
                            preWrite.arriveExternally();

                            // THE SECOND HALF, ALSO A POSITIVE EVENT. The identical statement is re-offered
                            // until the engine grants it. The commit that frees the row happens on the other
                            // participant's chain, so a refusal here is transient and re-offering is the only
                            // correct response; the budget bounds the loop so a lock that never frees fails
                            // this case rather than hanging it.
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

                expect(outcome.rejected, describeAbandonedPair(outcome)).toEqual([]);
                expect(outcome.a.releasedBeforeWrite).toBe(true);
                expect(outcome.b.releasedBeforeWrite).toBe(true);

                // THE OPERATION WAS ACTUALLY HELD, and at a write rather than anywhere else.
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
                // PER HOLD, not the aggregate: this one operation was still waiting when the set completed.
                expect(
                    holdReleasedBy,
                    'The hold was let go by something other than the arrival set, so it may have written ' +
                        'before the competing lock was ever offered',
                ).toBe('arrival');

                // AND THE ENGINE REFUSED THE COMPETING LOCK WHILE IT WAS HELD, then granted it once the
                // window closed. Both halves are answers the database gave, so neither is an inference from
                // elapsed time and both prove the statement was dispatched. Together they say: no second
                // caller can be between its own duplicate count and its own insert at the same time as this
                // one, because it cannot hold the row this one holds.
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

                // The held operation still produced the ordinary success, so nothing about being held changed
                // what the caller received.
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
            // written DIRECTLY through the repository so that no service pre-check can intercept it: driving it
            // through the mutation would let the advisory count answer first, and a passing test would then
            // prove nothing about whether the DATABASE enforces the rule. Two sequential single writes rather
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

            expect(outcome.a.status, JSON.stringify(outcome.a)).toBe('fulfilled');
            expect((outcome.a as { value: number }).value).toBe(1);
            // The second write is REJECTED by the database, and the rejection identifies the one named object.
            expect(outcome.b.status, 'The database accepted a duplicate canonical key').toBe('rejected');
            expect(outcome.rejected.length).toBe(1);
            expect(outcome.loser?.label).toBe('writes-the-duplicate-directly');
            const reason = (outcome.b as { reason: unknown }).reason;
            const reasonText = reason instanceof Error ? reason.message : String(reason);
            expect(
                identifiesNameConflictConstraint(reasonText),
                `The refusal identified neither ${NAME_CONFLICT_CONSTRAINT} nor its qualified column list ` +
                    `on ${resolveConfiguredEngine()}: ${reasonText}`,
            ).toBe(true);

            // The row count is still exactly one, and it is still the row the mutation created.
            expect(await countListsWithKey(actingCustomerDbId, defaultChannelDbId, storedKey)).toBe(1);
            expect(Number((await readTheOnlyListRow()).id)).toBe(decodeId(created.id));
        });

        it('createReorderList admits the same name under a second real channel token', async () => {
            // The CHANNEL dimension, discharged by a named test rather than by prose. The uniqueness rule is
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

            // The new row carries the SECOND channel's id, and the first channel's count is unchanged.
            const secondChannelRow = await readListRowById(inSecondChannel.id);
            expect(secondChannelRow, 'The second-channel create wrote no row').toBeDefined();
            expect(Number((secondChannelRow as Record<string, unknown>).channelId)).toBe(secondChannelDbId);
            expect(Number((secondChannelRow as Record<string, unknown>).customerId)).toBe(actingCustomerDbId);
            expect(String((secondChannelRow as Record<string, unknown>).nameKey)).toBe(storedKey);
            expect(await countLists(actingCustomerDbId, defaultChannelDbId)).toBe(1);
            expect(await countLists(actingCustomerDbId, secondChannelDbId)).toBe(1);
        });
    });

    // ===============================================================================================
    // AC-8 — the server boots with the plugin registered and the existing read path is unchanged
    // ===============================================================================================

    describe('AC-8: the server boots with the plugin registered and nothing existing moved', () => {
        it('createReorderList is published while activeCustomer answers exactly as before', async () => {
            // The server reached a READY STATE with the plugin registered, asserted as an observed state rather
            // than as an absence of errors: it is answering requests.
            expect(server.app.get(ConfigService).plugins).toContain(reorderPluginRegistration);

            const { activeCustomer } = await shopClient.query<GetActiveCustomerQuery>(
                GET_ACTIVE_CUSTOMER_FOR_REORDER_CREATE,
            );
            expect(activeCustomer).not.toBeNull();
            expect((activeCustomer as { id: ReorderApiId }).id).toBe(actingCustomer.id);
            expect((activeCustomer as { emailAddress: string }).emailAddress).toBe(
                actingCustomer.emailAddress,
            );

            // And its DECLARED signature is byte-identical against the untouched snapshot.
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

            // The MEASURED BASELINE, stated so that the delta below is a transition rather than a bare number.
            expect(baselineQueries.size, 'The checked-in snapshot moved').toBe(
                BASELINE_ROOT_QUERY_FIELD_COUNT,
            );
            expect(baselineMutations.size, 'The checked-in snapshot moved').toBe(
                BASELINE_ROOT_MUTATION_FIELD_COUNT,
            );

            // Every baseline field, byte-identical in name, arguments, argument types, return type and
            // nullability. Nothing is removed and nothing is widened.
            for (const [name, signature] of baselineQueries) {
                expect(liveQueries.get(name), `root query ${name} changed`).toBe(signature);
            }
            for (const [name, signature] of baselineMutations) {
                expect(liveMutations.get(name), `root mutation ${name} changed`).toBe(signature);
            }

            // Every field that APPEARED is one this plugin declares — never an absolute post-plugin total, per
            // EPIC-001 ruling R15.
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
            // And this story's own contribution is one of them.
            expect(addedMutations).toContain(STORY_ROOT_MUTATION);
        });

        it('addItemToOrder, addItemsToOrder and adjustOrderLine gain no argument', () => {
            // Named individually as well as covered above, because a custom field on `OrderLine` would widen
            // all three as a side effect — and this feature registers ZERO custom fields, so
            // `customFields: {}` stays empty and none of the three moves.
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
            // This feature registers NO `PermissionDefinition`, so the published enum cannot move. The delta is
            // zero and EPIC-001 ruling R15 requires a zero delta to be asserted rather than left out.
            const baselinePermissions = sortedEnumValues(snapshotSchema, 'Permission');
            const livePermissions = sortedEnumValues(liveSchema, 'Permission');
            expect(baselinePermissions.length).toBe(BASELINE_PERMISSION_MEMBER_COUNT);
            expect(livePermissions.length).toBe(BASELINE_PERMISSION_MEMBER_COUNT);
            expect(livePermissions).toEqual(baselinePermissions);
        });

        it('the published ErrorCode enum grows by exactly this feature four declarations and loses none', () => {
            // The enum is generated from every type implementing `ErrorResult`, so the four declarations this
            // story owns are what widen it. Stated as a transition: 32 baseline members, all still present by
            // name, plus exactly the four this feature declares.
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

            // And the four are declared as field-complete `ErrorResult` implementors rather than merely named
            // as union members, which is what EPIC-001 ruling R8 and matrix row 11 require.
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
            // The platform's list-options generator owns the two inputs it derives from the plugin's two
            // `PaginatedList` implementors, and this document declares neither and names neither. What is
            // asserted here is the OUTCOME of that choice: the generator produced them, and it added the
            // `options` argument to the root collection field and to the nested `lines` field alike.
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

    // ===============================================================================================
    // The five edge-case scenarios of STORY-001-01-01 section 7
    //
    // Each is its own named test, because a scenario outside the automation gate is untested behaviour
    // whatever the prose around it says — which is exactly why the duplicate-name race was promoted out of
    // that section into AC-7 rather than left in it. Two of the three unconditionally required categories
    // resolve to PROCEED rather than to a block or a warning, and that is asserted honestly rather than
    // force-fitted into a failure the operation cannot have.
    // ===============================================================================================

    describe('section 7 scenarios', () => {
        it('scenario 1: an empty starting state proceeds, giving lineCount 0 and exactly one list', async () => {
            // Zero, null or empty collection — the customer owns no reorder list at all. An empty starting
            // state is the normal first call rather than an error path.
            expect(await countLists(actingCustomerDbId, defaultChannelDbId)).toBe(0);
            expect(await readAllListRows()).toEqual([]);

            const created = expectCreated(await createReorderList(BASE_LIST_NAME));

            expect(created.lineCount).toBe(0);
            expect(created.name).toBe(BASE_LIST_NAME);
            expect(created.lines.totalItems).toBe(0);
            expect(await countLists(actingCustomerDbId, defaultChannelDbId)).toBe(1);
        });

        it('scenario 2: a variant disabled since the last purchase proceeds, and no variant is read at all', async () => {
            // Given a variant the buyer previously purchased whose `enabled` flag is now false. The flag is
            // flipped through the Admin API and restored in this test's own `afterEach` entry, because it is a
            // core row this test did not create.
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
            // The variant is a core row this test did not create, so EVERY COLUMN of it is captured and its
            // exact restoration queued before the flag is flipped. Restoring by issuing the inverse Admin
            // mutation would put the flag back and advance the row's `updatedAt` while doing so, leaving the
            // next test reading a row that is not the row that was there.
            await captureCoreRows('product_variant', 'captured_row.id = :variantId', {
                variantId: decodeId(catalogueVariant.id),
            });
            await setEnabled(false);

            // Then PROCEED, with no warning and no audit record. The counted form of "reads no variant at all"
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
                // ZERO is reachable here and is therefore asserted as a number: a list is created EMPTY, so
                // this operation has no reason to resolve a variant or to read an availability figure, and lines
                // arrive only with STORY-001-01-02. This is the one place a zero-statement claim is legitimate —
                // unlike a claim of zero statements against `reorder_list`, which no correct implementation
                // could satisfy.
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
            /*
             * GIVEN a variant the buyer previously purchased whose price has since changed. The scenario's
             * premise is a real prior-versus-current difference, so one is established here rather than
             * assumed: the current price is read, a different one is written through the Admin API, the exact
             * restoration is queued before the write, and the platform's own returned value is compared
             * against the prior one so that the delta is measured rather than presumed to have happened.
             *
             * A structural-only discharge was not sufficient. "No monetary column exists" is true of a
             * database whose price never moved, so it cannot distinguish an implementation that ignores the
             * price from one that was simply never shown a changed price. The state under test has to exist
             * before the assertions about it mean anything.
             */
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
            // Captured BEFORE the write, so the prior state is restored even if an assertion below throws.
            // The variant is a core row this test did not create, so EVERY COLUMN of it — and of every
            // `product_variant_price` row belonging to it, which is where the price actually lives — is put
            // back exactly as it was found. Restoring by issuing the inverse Admin mutation would put the
            // NUMBER back and advance the `updatedAt` of both rows while doing so.
            await captureCoreRows('product_variant', 'captured_row.id = :variantId', {
                variantId: decodeId(catalogueVariant.id),
            });
            await captureCoreRows('product_variant_price', 'captured_row.variantId = :variantId', {
                variantId: decodeId(catalogueVariant.id),
            });

            const changedPrice = priorPrice + 100_000;
            await setPrice(changedPrice);

            /*
             * The premise, measured by an INDEPENDENT read rather than by the mutation's own echo: the price
             * this variant carries now is not the price it carried before. Trusting the write's response would
             * leave the premise resting on the harness, and a scenario whose given state was never established
             * asserts nothing about the behaviour that follows it.
             */
            const { productVariants } = await adminClient.query<GetVariantQuery>(
                GET_VARIANT_FOR_REORDER_CREATE,
            );
            const reread = productVariants.items[0];
            expect(reread?.id).toBe(catalogueVariant.id);
            const currentPrice = reread?.price;
            expect(currentPrice, 'the price read back is not the changed price').toBe(changedPrice);
            expect(currentPrice).not.toBe(priorPrice);

            // WHEN the buyer creates a list, THEN PROCEED, with no warning: the `reorder_list` table stores no
            // monetary column, so this story holds no price that could go stale. Copying a price onto a list
            // row would be a defect rather than an optimisation, and a price delta is computed at preview time
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
            // The success payload the caller actually received carries no monetary key either.
            for (const key of Object.keys(created)) {
                expect(MONETARY_OR_STOCK_FIELD.test(key), `The payload carries ${key}`).toBe(false);
            }

            /*
             * Neither price reached the row or the payload under ANY column or key name. This is the half a
             * name-shaped check cannot cover: an implementation that copied the current price into a column
             * called `lineCount` would satisfy every assertion above. Both values are checked — the current
             * price is what a naive "store today's price" would write, and the prior one is what a stale cache
             * would carry — and the collision-freedom of the comparison rests on the guard at the top of this
             * test plus a changed price a hundred thousand minor units clear of any identifier or counter.
             */
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
            // scenario keeps the two halves of it that are NOT a duplicate of that criterion.
            //
            // HALF ONE — the translation is NARROW. A violation of one named object maps to
            // `ReorderListNameConflictError`; every other database failure is re-raised as an internal error;
            // and the API-visible message on either path carries no driver text, no SQL fragment and no
            // constraint name.
            expectCreated(await createReorderList(BASE_LIST_NAME));
            const storedKey = String((await readTheOnlyListRow()).nameKey);
            const conflict = expectNameConflict(await createReorderList(BASE_LIST_NAME));
            expect(conflict.errorCode).toBe('REORDER_LIST_NAME_CONFLICT_ERROR');
            // It echoes the caller's OWN canonical key and discloses nothing about any other row.
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
                expect(
                    lowered,
                    `The mapped message discloses "${needle}": ${conflict.message}`,
                ).not.toContain(needle);
            }
            expect(await countLists(actingCustomerDbId, defaultChannelDbId)).toBe(1);

            // HALF TWO — the uniqueness rule is scoped to the owning customer AND the active channel, so the
            // same name submitted under a SECOND REAL TOKEN proceeds: it writes a new row carrying the second
            // channel's id, and the count of that customer's rows in the first channel is unchanged.
            shopClient.setChannelToken(SECOND_CHANNEL_TOKEN);
            const inSecondChannel = expectCreated(await createReorderList(BASE_LIST_NAME));
            const secondRow = await readListRowById(inSecondChannel.id);
            expect(secondRow, 'The second-channel create wrote no row').toBeDefined();
            expect(Number((secondRow as Record<string, unknown>).channelId)).toBe(secondChannelDbId);
            expect(await countLists(actingCustomerDbId, defaultChannelDbId)).toBe(1);
            expect(await countLists(actingCustomerDbId, secondChannelDbId)).toBe(1);
        });

        it('scenario 5: a customer soft-deleted after owning a list keeps the row, and nothing purges it', async () => {
            // Given a Returning Buyer owning exactly one list, who is subsequently soft-deleted. `Customer` is
            // declared soft-deletable, so its row and this story's rows outlive the buyer.
            const created = expectCreated(await createReorderList(BASE_LIST_NAME));
            const storedKey = String((await readTheOnlyListRow()).nameKey);
            expect(await countLists(actingCustomerDbId, defaultChannelDbId)).toBe(1);

            // ------------------------------------------------------------------------------------------
            // FORM ONE — the soft delete exactly as the scenario's Given cites it: the `deletedAt` marker on
            // the `customer` row, which is what makes `Customer` soft-deletable. It is set through the
            // repository — one row, by identifier, engine-portably — so that the buyer's SESSION survives,
            // which is what makes the scenario's own `When` reachable at all: "createReorderList is executed
            // again with that same name, FIRST BY A SESSION FOR THE SOFT-DELETED CUSTOMER".
            //
            // FORM TWO below drives the platform's own Admin API delete, and documents why that path cannot
            // serve this half: it additionally soft-deletes the buyer's `User` and DELETES EVERY SESSION it
            // had, so after it no session for the soft-deleted customer can exist and none can be obtained.
            // ------------------------------------------------------------------------------------------
            // The exact prior state of every core row this scenario disturbs — the customer, its user, and
            // every session that user holds — captured before the first mutation, with restoration and the
            // assertion that it happened queued immediately. So an assertion failing anywhere below still
            // leaves all three exactly as they were found, timestamps included.
            const softDeleteCapture = await captureSoftDeleteState(actingCustomerDbId);
            expect(softDeleteCapture.customer.rows).toHaveLength(1);
            expect(softDeleteCapture.customer.rows[0].deletedAt ?? null).toBeNull();
            expect(softDeleteCapture.user.rows).toHaveLength(1);
            expect(softDeleteCapture.user.rows[0].deletedAt ?? null).toBeNull();
            // And the buyer HOLDS a session right now, which is what makes FORM TWO's destruction of it
            // observable rather than vacuous — and what makes its restoration mean something.
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
            // The row is STILL PRESENT and still carries that `customerId`: the per-customer-and-channel
            // uniqueness rule is unchanged by the buyer's disposal, because there is no disposal behaviour.
            const survivingRow = await readTheOnlyListRow();
            expect(Number(survivingRow.customerId)).toBe(actingCustomerDbId);
            expect(String(survivingRow.name)).toBe(BASE_LIST_NAME);
            expect(Number(survivingRow.id)).toBe(decodeId(created.id));
            expect(await countLists(actingCustomerDbId, defaultChannelDbId)).toBe(1);

            // A SECOND customer's create in the same channel succeeds, because uniqueness is scoped to the
            // owning customer. Driven on the second real client so the first session is left untouched.
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

            // ------------------------------------------------------------------------------------------
            // FORM TWO — the platform's own Admin API soft delete, which is what a deployment actually runs.
            // The marker set by FORM ONE is cleared first so this path starts from a live customer and the
            // delete is genuinely the thing under observation.
            // ------------------------------------------------------------------------------------------
            await restoreCustomerAndUserExactly(softDeleteCapture);
            const { deleteCustomer } = await adminClient.query<DeleteCustomerMutation>(
                DELETE_CUSTOMER_FOR_REORDER_CREATE,
                { id: actingCustomer.id },
            );
            expect(deleteCustomer.result, JSON.stringify(deleteCustomer)).toBe('DELETED');

            // The list row PERSISTS and still carries that `customerId`. The database cascade on
            // `ReorderList.customerId` is the only lifecycle behaviour present, and a SOFT delete removes no
            // row for it to fire on — which is exactly the observable consequence the pull request body reports.
            expect(await countLists(actingCustomerDbId, defaultChannelDbId)).toBe(1);
            const rowAfterApiDelete = await readListRowById(created.id);
            expect(rowAfterApiDelete, 'The Admin API delete removed the list row').toBeDefined();
            expect(Number((rowAfterApiDelete as Record<string, unknown>).customerId)).toBe(
                actingCustomerDbId,
            );
            expect(String((rowAfterApiDelete as Record<string, unknown>).name)).toBe(BASE_LIST_NAME);

            // THE PLATFORM CONSTRAINT, REPORTED RATHER THAN ABSORBED. This path soft-deletes the buyer's
            // `User` and deletes every session it held, so after it there is no session for the soft-deleted
            // customer and no way to obtain one — which is why FORM ONE above exercises the scenario's `When`
            // through the marker its own `Given` cites.
            // The token is read into a variable rather than off the client at each use, and asserted
            // non-empty. `asUserWithCredentials` clears the client's token when the credentials are refused,
            // so a later `getAuthToken()` returns the empty string — against which `getSessionFromToken`
            // resolves nothing whatever the database holds, and both the assertion below and the restoration
            // assertion at the end of this test would pass without observing anything.
            const buyerAuthToken = shopClient.getAuthToken();
            expect(buyerAuthToken, 'the acting buyer holds no auth token to resolve').not.toBe('');
            const sessionAfterDelete = await server.app
                .get(SessionService)
                .getSessionFromToken(buyerAuthToken);
            expect(sessionAfterDelete, 'The soft delete left a live session behind').toBeUndefined();
            const refusedLogin = await shopClient.asUserWithCredentials(
                actingCustomer.emailAddress,
                SEEDED_CUSTOMER_PASSWORD,
            );
            expect(
                (refusedLogin as { errorCode?: string }).errorCode,
                JSON.stringify(refusedLogin),
            ).toBeDefined();

            // And the uniqueness rule still holds for that customer, proved on the only path a soft-deleted
            // buyer has left: a duplicate written DIRECTLY through the repository is refused by the database
            // naming the same object, with the row count still exactly one.
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
            expect(
                identifiesNameConflictConstraint(directFailureText),
                `The refusal identified neither ${NAME_CONFLICT_CONSTRAINT} nor its qualified column list ` +
                    `on ${resolveConfiguredEngine()}: ${directFailureText}`,
            ).toBe(true);
            expect(await countListsWithKey(actingCustomerDbId, defaultChannelDbId, storedKey)).toBe(1);

            // THIS STORY IMPLEMENTS NO DELETION, ANONYMISATION OR PURGE BEHAVIOUR on either table (EPIC-001
            // ruling R19 — the lifecycle pass belongs to FEATURE-001-07 in batch B5). Asserted as the absence
            // of both a mechanism and a place to record one: no column on either table could carry a retention
            // decision, and the surviving row's name is byte-identical rather than anonymised.
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

            // AND THE CORE ROWS THIS SCENARIO DESTROYED COME BACK USABLE, not merely row-shaped. The Admin
            // path hard-deletes every session the buyer held, so putting the graph back is the only way this
            // test leaves the fixture as it found it — and a re-inserted row that the platform could no
            // longer resolve would be a restoration in appearance only. The restoration is idempotent and is
            // queued for `afterEach` as well; it is driven here so that the FUNCTIONAL half can be asserted
            // while the server is still up.
            await restoreCoreRowsExactly(softDeleteCapture.sessions);
            await restoreCustomerAndUserExactly(softDeleteCapture);
            const sessionAfterRestore = await server.app
                .get(SessionService)
                .getSessionFromToken(buyerAuthToken);
            expect(
                sessionAfterRestore,
                'the re-inserted session rows did not resolve back to a live session',
            ).toBeDefined();
            expect(Number((sessionAfterRestore as { user: { id: unknown } }).user.id)).toBe(
                softDeleteCapture.userId,
            );
        });
    });
});
