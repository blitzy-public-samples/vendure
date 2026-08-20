/*
 * End-to-end specification for STORY-001-01-03 — the four mutations that keep a saved set current in
 * place: `adjustReorderListLine`, `removeReorderListLine`, `updateReorderList` and `deleteReorderList`.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────────
 * ATTRIBUTION — WHERE EVERY OBLIGATION IN THIS FILE COMES FROM.
 *
 * `review_rules` was read in full for this run and returned exactly "No user rules provided." **No
 * user-specified rule governs this file, and no rule forced it into scope**, so nothing below may be
 * cited as one. Enterprise-standard best practice is applied in their place rather than treated as a
 * licence to assert less. Every obligation this file discharges is either PROMPT-DERIVED (the Agent
 * Action Plan) or TICKET-DERIVED:
 *
 *   - STORY-001-01-03 §5 (AC-1 … AC-8), §7 (four edge-case scenarios) and §10 (the ten-item story DoD);
 *   - FEATURE-001-01 §2.6.1 rows 3–6, §2.6.1.1 (how a "reads nothing" claim is evidenced) and §2.11
 *     (names, bounds and the rules that make the contract deterministic);
 *   - EPIC-001 §7.7 (the three observation boundaries), §7.8 (the persistence contract and the
 *     race-evidence rule), §11.6.1 (the canonical test lifecycle and isolation contract), §11.6.2 (the
 *     canonical query-capture harness) and §11.6.3 (which engines evidence a race).
 *
 * Corroboration that no rules document exists: AAP §0.8.1 and EPIC-001 §11.9, two independent reads.
 * ─────────────────────────────────────────────────────────────────────────────────────────────────────
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
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────────
 * TWO DOCUMENTED REFINEMENTS OF THE LITERAL CRITERION TEXT. Neither weakens a claim; both replace an
 * assertion that cannot be true with the strictly true one, and both are stated here because EPIC-001
 * §0.8.2's no-silent-deviation obligation applies to a test as much as to an implementation.
 *
 * (R-i) AC-6 asks for "zero statements against `reorder_list_line`" on the rename path. The published
 *   success member of `updateReorderList` is the whole `ReorderList`, and the single authority for these
 *   documents selects it with its nested `lines` page [packages/reorder-plugin/e2e/graphql/
 *   reorder-definitions.ts]. Resolving that page necessarily READS `reorder_list_line`, so a whole-request
 *   count of zero statements against that table is false for any correct implementation. What is true, and
 *   what the criterion is actually about, is asserted instead as two equalities: **zero write statements
 *   whose target is `reorder_list_line`**, and **every statement against that table in the window being a
 *   `SELECT`** — so a rename that touched a line row fails, while the response's own page does not
 *   masquerade as one. Both are equalities at the plugin-statement boundary, per EPIC-001 §11.6.2.
 *
 * (R-ii) AC-5 asks for "`data.removeReorderListLine` exactly null" on the unauthenticated call. The field
 *   is declared `RemoveReorderListLineResult!` — Non-Null — so a thrown error propagates past the field to
 *   the root and the response carries `data: null` wholesale rather than an object with a null member.
 *   Asserted as "no payload was returned": `data` is exactly `null`, which is strictly stronger than the
 *   member being null, together with the single top-level `errors` entry the criterion names.
 * ─────────────────────────────────────────────────────────────────────────────────────────────────────
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT DO.
 *
 *   - It never asserts `NegativeQuantityError`. A non-positive or over-maximum quantity is a malformed
 *     request rather than a business outcome, refused by a thrown input error with a plugin-owned message
 *     key (EPIC-001 ruling R13). That platform type covers a NEGATIVE `OrderLine` quantity, is silent on
 *     zero, and is about a different row.
 *   - It never asserts that a session holds `Permission.Owner`. That member is declared unassignable and
 *     internal, so no session can hold it; the gate marks the request context and the service-layer
 *     ownership-and-channel predicate is the whole of the control.
 *   - It names no request-deduplication key, because the add input declares none: two deliveries of one
 *     add accumulate, delivery is at-least-once, and `adjustReorderListLine`'s absolute set is the
 *     published remedy — which is asserted here as an idempotence property.
 *   - It declares no per-row list-options input and passes no hand-written `options` argument; the
 *     platform's generator owns both.
 *   - It asserts no latency, throughput, service-level, conversion or revenue figure. The two millisecond
 *     values it does carry are control values bounding a wait, and are labelled as such.
 *   - It creates no file: the empty-generation assertion writes into a temporary directory outside the
 *     repository and removes it, so `git status --porcelain` is clean after a run.
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
    resolveConfiguredEngine,
    runBarrieredPair,
    runSequentialPair,
    SQLJS_EXCLUSION_REASON,
    supportsForcedInterleaving,
    TransactionBinder,
} from './fixtures/concurrency-barrier';
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

// ═════════════════════════════════════════════════════════════════════════════════════════════════════
// Control values and fixture constants
// ═════════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * The quantity ceiling this test deployment is configured with.
 *
 * It is deliberately far below the plugin's declared default of 999 so that AC-2's above-maximum case is
 * reachable with a small, readable number. **Configuring a value for a test deployment is not choosing a
 * product default**: the declared defaults live with the options themselves
 * [packages/reorder-plugin/src/types.ts] and STORY-001-01-01 owns them.
 */
const MAX_QUANTITY_PER_LINE = 10;

/** The line-count ceiling, at its declared default. No test here can reach it: an adjustment adds no line. */
const MAX_LINES_PER_LIST = 200;

/** The list-count ceiling, at its declared default. Reached by no test here; STORY-001-01-01 owns it. */
const MAX_LISTS_PER_CUSTOMER = 25;

/**
 * The suffix that marks the counted form of a claim in a test title, naming the engine it is counted on.
 *
 * EPIC-001 §11.6.2 fixes an exact statement count to the one engine on which statement text and statement
 * count are deterministic, and requires the BEHAVIOUR each count evidences — the response, the persisted
 * rows, the refusal — to be asserted on all four engine jobs. Every `it.skipIf(!isStatementCountEngine())`
 * in this file therefore has an ungated behavioural sibling, and the reason is stated in full once, on the
 * describe block that owns this story's two structural claims.
 *
 * ★ The engine named is the one the counted form RUNS ON, taken from the gate's own list, and never the engine
 * the current run happens to use. Interpolating `resolveConfiguredEngine()` here — as an earlier revision did —
 * makes the label state the opposite of the truth on every job except the one it is counted on: a MySQL run
 * printed `[counted form, mysql only]` against tests it had just SKIPPED, so a reader of that log would
 * conclude either that the suite is broken or that MySQL ought to have run them. Reading the label off
 * `STATEMENT_COUNT_ENGINES` also means it cannot drift from the gate it describes.
 */
const COUNTED_FORM = `[counted form, ${STATEMENT_COUNT_ENGINES.join(' / ')} only]`;

/** The token of the second, real channel this suite creates through the Admin API. */
const SECOND_CHANNEL_TOKEN = 'reorder-mutate-second-channel';

/** An identifier in the platform's external `T_n` form that no `reorder_list` row can carry. */
const UNKNOWN_LIST_ID = 'T_999999';

/** An identifier in the platform's external `T_n` form that no `reorder_list_line` row can carry. */
const UNKNOWN_LINE_ID = 'T_999999';

/** The two plugin-owned tables this story writes to, child first — the order `afterEach` deletes in. */
const PLUGIN_TABLES_CHILD_FIRST = ['reorder_list_line', 'reorder_list'] as const;

/** The resolved English message the plugin's catalogue registers for a non-positive quantity. */
const QUANTITY_MUST_BE_POSITIVE_MESSAGE = 'The quantity for a reorder list line must be a positive integer';

/** The resolved English message for a resulting quantity above the configured maximum. */
const QUANTITY_ABOVE_MAXIMUM_MESSAGE =
    `The resulting quantity for this reorder list line would exceed the maximum of ` +
    `${String(MAX_QUANTITY_PER_LINE)}`;

/** The resolved English message for a name whose canonical form cannot be stored. */
const NAME_EMPTY_MESSAGE =
    'The reorder list name must be between 1 and 191 characters once surrounding whitespace is removed, ' +
    'and must not contain control or zero-width characters';

/**
 * The field names a monetary, currency or stock value would arrive under.
 *
 * Deliberately does NOT include `total`: `totalItems` and `totalQuantity` are pagination and line counts,
 * which the published contract carries by design, and matching them would make this assertion fail on a
 * correct schema. What it does match is every shape a price, a currency code or an availability figure could
 * take on either plugin payload — none of which may exist, because a saved line stores a variant reference
 * and an integer quantity and nothing else (FEATURE-001-01 §2.9).
 */
const MONETARY_OR_STOCK_FIELD_NAME = /price|currenc|stock|money|amount|saleable|inventory|tax/i;

/** The resolved English message the platform's own `ForbiddenError` carries. */
const FORBIDDEN_MESSAGE = 'You are not currently authorized to perform this action';

// ═════════════════════════════════════════════════════════════════════════════════════════════════════
// Local documents
//
// Every reorder document comes from `./graphql/reorder-definitions`, which is their single authority — no
// copy of one is inlined here. The documents below address the PLATFORM's own operations, which that
// module does not declare and must not grow to: the customer roster and the second channel this suite
// needs as fixtures, the active order AC-7 and AC-8 assert is untouched, and the runtime introspection
// AC-8 compares against the checked-in snapshot.
// ═════════════════════════════════════════════════════════════════════════════════════════════════════

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

/** Creates the second, real channel whose token AC-3's third call sends. */
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

/** The existing Shop `activeOrder` query — the single operation under test in AC-8. */
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

/**
 * Runtime introspection of one root type's fields.
 *
 * AC-8's signature comparison is made against a booted server carrying the plugin and compared to the
 * checked-in `schema-shop.json`, which is read **read-only** and is neither edited nor regenerated
 * (AAP §0.4.1.5). The type reference is unwrapped to four levels, which covers every wrapper depth the
 * four compared fields use — `Order`, `UpdateOrderItemsResult!` and `RemoveOrderItemsResult!`.
 */
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

/** Runtime introspection of one enum's members, for the two published widths AC-8 states. */
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

// ═════════════════════════════════════════════════════════════════════════════════════════════════════
// Local result shapes for the platform documents above
//
// Written out rather than generated, for the reason `./graphql/reorder-definitions` records: this
// plugin's types can never appear in the checked-in introspection snapshot, so no generated artefact
// covers a suite that mixes the two. These cover the platform half only.
// ═════════════════════════════════════════════════════════════════════════════════════════════════════

/** One seeded customer, as {@link GET_CUSTOMER_LIST} returns it. */
interface SeededCustomer {
    id: string;
    emailAddress: string;
}

/** {@link GET_CUSTOMER_LIST}. */
interface GetCustomerListQuery {
    customers: { totalItems: number; items: SeededCustomer[] };
}

/** {@link GET_ACTIVE_CHANNEL}. */
interface GetActiveChannelQuery {
    activeChannel: { id: string; code: string; token: string };
}

/** {@link CREATE_SECOND_CHANNEL}. */
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

/** {@link ADD_ITEM_TO_ORDER}. */
interface AddItemToOrderMutation {
    addItemToOrder: ActiveOrderShape | { __typename: string; errorCode: string; message: string };
}

/** {@link GET_ACTIVE_ORDER}. */
interface GetActiveOrderQuery {
    activeOrder: ActiveOrderShape | null;
}

/** An introspected type reference, unwrapped to the depth {@link INTROSPECT_ROOT_TYPE} selects. */
interface IntrospectedTypeRef {
    kind: string;
    name: string | null;
    ofType?: IntrospectedTypeRef | null;
}

/** One introspected field argument. */
interface IntrospectedArg {
    name: string;
    defaultValue: string | null;
    type: IntrospectedTypeRef;
}

/** One introspected field. */
interface IntrospectedField {
    name: string;
    args: IntrospectedArg[];
    type: IntrospectedTypeRef;
}

/** {@link INTROSPECT_ROOT_TYPE}. */
interface IntrospectRootTypeQuery {
    __type: { name: string; fields: IntrospectedField[] } | null;
}

/** {@link INTROSPECT_ENUM}. */
interface IntrospectEnumQuery {
    __type: { name: string; enumValues: Array<{ name: string }> } | null;
}
/** {@link INTROSPECT_TYPE_FIELDS}. */
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

/** One stored `reorder_list` row, as this suite reads it back through the repository. */
interface StoredList {
    id: number | string;
    name: string;
    nameKey: string;
    lineCount: number;
    customerId: number | string;
    channelId: number | string;
}

/** One stored `reorder_list_line` row. */
interface StoredLine {
    id: number | string;
    reorderListId: number | string;
    productVariantId: number | string;
    quantity: number;
}

/** A seeded list together with the identifiers of the lines seeded onto it, in insertion order. */
interface SeededList {
    listId: string;
    lineIds: string[];
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════
// The server, the instrument, and the configuration that installs it
//
// `testConfig()` is called HERE, at the top level of this spec file, and never from a helper module: it
// derives its port from the calling file's own index within its own directory listing
// [e2e-common/test-config.ts], so a call made from anywhere else indexes against the wrong directory and
// can collide two suites on one port. The base is 3250 because `reorder-plugin` carries no offset in that
// file's own table — which is REPORTED here rather than corrected there, `e2e-common/` being outside the
// boundary this work may edit.
//
// That index is a directory listing position, so it is not stable against the directory's own contents:
// this file sits at 4 while `__data__` is absent and at 5 once the sqljs cache exists, and two checkouts
// of this package on one host therefore need not agree on which port belongs to which suite. A collision
// surfaces not as a failing assertion but as `EADDRINUSE` thrown by `NestApplication.listen` inside
// `beforeAll`, which vitest reports as one failed FILE with every test in it SKIPPED. Diagnosed and
// reproduced deliberately during validation, and recorded here so the symptom is not mistaken for an
// ordering defect in this suite; the fix belongs to `e2e-common/test-config.ts`, which is out of bounds.
//
// The instrument is a TypeORM logger OBJECT supplied on `dbConnectionOptions`, per EPIC-001 §11.6.2.
// Neither withdrawn mechanism appears anywhere in this file: the boolean logging flag prints instead of
// returning, and a spy on the deprecated repository accessor counts handles rather than statements.
// ═════════════════════════════════════════════════════════════════════════════════════════════════════

const capture = new QueryCaptureLogger();

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
    /** The decoded database identifier of the order itself. */
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

    /** The two seeded buyers. `[0]` is the acting customer throughout; `[1]` is the second customer AC-3 needs. */
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
        //
        // Then the orders this file's own fixture created, then the core rows a test mutated but did not
        // create — each restored to its exact captured value by a restorer queued at the point of mutation,
        // in reverse order so a later change layered on an earlier one unwinds in the order it was applied.
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
            ...directories.map(directory => ({
                what: `temporary directory ${directory}`,
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

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    // Fixture helpers. Every one of them is a FUNCTION each test calls from its own body — never a
    // leftover a sibling criterion built, which is what lets any test here run alone and the file run in
    // reverse order with the same result (EPIC-001 §11.6.1).
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

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

    /** Authenticates the Shop client as one seeded buyer in the default channel. */
    async function authenticateAs(customer: SeededCustomer): Promise<void> {
        await shopClient.asUserWithCredentials(customer.emailAddress, 'test');
    }

    /**
     * Seeds one list, optionally with lines, for the given buyer and returns the identifiers.
     *
     * The line identifiers are collected from each add's own response rather than from a later read, so the
     * order they are returned in is the order they were created in — which is what makes "the first of those
     * two lines" a fact rather than an assumption. The lines' default sort is ascending by the inherited
     * creation timestamp, and this helper's insertion order agrees with it.
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

    /** Reads one stored `reorder_list` row straight from the database, or `null` when it is gone. */
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
     * Reverting and re-applying the artefact is what makes the schema afterwards the migration's rather than
     * the harness's synchronisation — see the reasoning on the empty-generation assertion at the end of this
     * file, which is the only thing that calls this. The artefact drops the child table first and creates the
     * parent table first, so a foreign key is never what fails either direction.
     *
     * Both tables are emptied by this. Every test that runs after it therefore seeds its own rows.
     */
    async function rebuildPluginSchemaFromCheckedInMigration(): Promise<void> {
        const migration = new AddReorderLists1786838400000();
        const runner = dataSource.createQueryRunner();
        try {
            await migration.down(runner);
            await migration.up(runner);
        } finally {
            await runner.release();
        }
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
     * Two earlier revisions were weaker in different ways. The first restored the whole catalogue in
     * `afterEach` — `UPDATE product_variant SET enabled = true, deletedAt = NULL WHERE 1 = 1` — which reaches
     * every row in the database rather than the ones section 7's second scenario touches: a variant the seed
     * had legitimately disabled would be silently enabled, and a defect elsewhere that disabled or
     * soft-deleted a variant it should not have would be quietly repaired between tests instead of failing
     * something. The second captured only `enabled` and `deletedAt`, so the compensating write put those two
     * back and advanced the row's `updatedAt` on its way — restoring the columns under test while changing
     * one that was not, and reporting success either way.
     */
    async function captureVariantAvailability(externalVariantId: string): Promise<void> {
        const variantId = decodeId(externalVariantId);
        const captured = await captureCoreRows('product_variant', 'captured_row.id = :variantId', {
            variantId,
        });
        expect(captured.rows, `No product_variant row with id ${String(variantId)} to capture`).toHaveLength(
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
     *
     * Idempotent: an order the session already has is reused rather than duplicated. Each test records the
     * value THIS call returned and asserts against that recording, so no test depends on the order another
     * one left behind — which is the isolation EPIC-001 §11.6.1 requires even for a core row.
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
     *
     * WHY IT HAS TO BE REMOVED AT ALL. This fixture exists only to give the buyer an active order that the
     * noninterference assertions can observe going unchanged — but an active order is real core state: it
     * survives the test, the session keeps pointing at it, and the next test's own call to this fixture then
     * REUSES it rather than creating one, so what the next test records as its baseline is a row this test
     * left behind. Nothing in this file is supposed to depend on an order another test created, and until the
     * rows are removed that independence is a hope rather than a property.
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
        // THE PARENT JOINS THE LEDGER FIRST, BEFORE ANYTHING THAT CAN THROW. The mutation above has already
        // committed the order, so every statement from here on is a fallible inspection of a row that
        // already exists: reading it back can fail, and either assertion below can fail. Registering the
        // parent only after that inspection would leave teardown knowing about neither the order nor its
        // lines precisely when it matters most, and the order, its lines and the session link pointing at
        // it would all survive into the next test.
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
                failures.push(`order ${entry.orderId}: ${err instanceof Error ? err.message : String(err)}`);
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
     * A linear teardown stops at the first failure, stranding every later stage — the plugin-row cleanup, the
     * restoration of a core row a test changed, the order rows, the temporary directories, the capture reset —
     * so one broken test leaves the next running against state it never established. Collecting the failures
     * and raising them once at the end keeps the diagnosis and loses none of the cleanup.
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
     * Runs a request expected to be refused with top-level errors and returns the whole response.
     *
     * The shipped client throws for a response carrying `errors`, exposing the parsed body on the thrown
     * error, so this is the only way to assert on the `errors` array and on `data` together — which AC-2 and
     * AC-5 both require. A request that unexpectedly SUCCEEDS fails here rather than further down, with the
     * payload in the message.
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
     * The contract is stated there as two separately counted halves, so both are asserted separately here:
     *
     *   - **exactly one scoped `SELECT` against the addressed plugin table, returning zero rows** — the
     *     addressed table being `reorder_list`, because that is the row whose accessibility was in question;
     *   - **and no `INSERT`, `UPDATE` or `DELETE` at all** — the write half is genuinely zero.
     *
     * The predicate's shape is asserted alongside the count, because the claim is about SCOPE: the one
     * statement must REQUIRE the row identifier, the acting customer and the active channel as mandatory
     * conjuncts, each bound to its expected value. That is what
     * {@link whereRequiresScopedPredicates} verifies and what a name-presence search cannot: a disjunction,
     * a swapped binding and a sub-query-supplied token all mention the right columns and scope nothing.
     *
     * `relation` is given as the lower-cased alias and matched case-insensitively, which is what makes ONE
     * assertion correct on every engine: the service reads through a locking query builder aliased
     * `reorderlist` where the engine has a row lock and through the repository's own `ReorderList` alias
     * where it does not.
     *
     * "Zero rows returned" is asserted as the absence of any subsequent statement against either plugin
     * table together with the operation's normalised not-found result — a `SELECT` that had returned the row
     * would have been followed by the conditional write.
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
        // The write half, stated as its own equality over both plugin tables.
        expect(capture.writesFor('reorder_list').length, capture.format()).toBe(0);
        expect(capture.writesFor('reorder_list_line').length, capture.format()).toBe(0);
        // And nothing reached the line table at all: the refusal happened before the row was addressed.
        expect(capture.count('reorder_list_line'), capture.format()).toBe(0);
        // Exactly one statement against the addressed table in total, so no second read followed it.
        expect(capture.count('reorder_list'), capture.format()).toBe(1);
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    // AC-1 — A line's quantity is set to a new positive integer and nothing else about the list changes
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

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
            // THE WHOLE POINT OF "ABSOLUTE SET": exactly the submitted 6, and never the sum 8 of the
            // submitted value and the stored 2. An accumulating implementation fails on this line alone.
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

            // The channel's own default language, which the request resolves to when it names none.
            const inChannelDefault = await shopClient.query<
                GetActiveCustomerReorderListQuery,
                GetActiveCustomerReorderListQueryVariables
            >(GET_ACTIVE_CUSTOMER_REORDER_LIST, { id: seeded.listId });
            // And a second, explicitly different language, requested the way the platform accepts one.
            const inSecondLanguage = await shopClient.query<
                GetActiveCustomerReorderListQuery,
                GetActiveCustomerReorderListQueryVariables
            >(GET_ACTIVE_CUSTOMER_REORDER_LIST, { id: seeded.listId }, { languageCode: LanguageCode.de });

            const defaultLine = inChannelDefault.activeCustomerReorderList?.lines.items[0];
            const secondLanguageLine = inSecondLanguage.activeCustomerReorderList?.lines.items[0];
            expect(defaultLine).toBeDefined();
            expect(secondLanguageLine).toBeDefined();
            // The line ITSELF is language-invariant: same row, same variant reference, same integer.
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
                // The stored line count is deliberately untouched: no line was added and none removed.
                expect(capture.writesFor('reorder_list').length, capture.format()).toBe(0);
                const storedList = await readStoredList(seeded.listId);
                expect(storedList?.lineCount).toBe(1);
            },
        );
    });

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    // AC-2 — A zero or negative quantity is refused as a request-level input error
    //
    // The line-count bound is DELIBERATELY not evaluated by this operation: `maxLinesPerList` is
    // evaluated by the add path and explicitly not by an adjustment, because changing the quantity of a
    // line that already exists creates no line and so cannot breach a bound on the NUMBER of lines
    // (FEATURE-001-01 §2.11). No criterion in this story therefore returns `ReorderListLimitError`, and
    // that absence is deliberate rather than an omission.
    //
    // `NegativeQuantityError` is never asserted here. Its own description covers setting a negative
    // ORDER LINE quantity, the platform returns it for values strictly below zero and it is silent on
    // zero, so reporting a zero quantity on a LIST line under that name would misname the condition
    // twice over. EPIC-001 ruling R13 fixes the contract as a thrown input error instead, which is also
    // why this feature declares four error results and not five.
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    describe('AC-2: adjustReorderListLine refuses a quantity it cannot store', () => {
        /**
         * The four assertions every one of the three refusals below makes over one response.
         *
         * Asserted as the RESOLVED English message rather than as a key passthrough: the keys are registered
         * from the plugin's own catalogue through the platform's translation-file mechanism, and an
         * unregistered key surfaces as the key itself — so an assertion against the resolved text is what
         * catches a catalogue that was never loaded.
         */
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

            // ZERO IS REFUSED RATHER THAN TREATED AS A REMOVAL, so the line still EXISTS afterwards.
            // Removal stays the declared responsibility of one named operation.
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
                // The quantity guard runs BEFORE any write, so neither plugin table is written. The guard
                // deliberately does not claim to run before any STATEMENT: the owner scope is resolved first,
                // and that read touches neither of these two tables.
                expect(capture.writesFor('reorder_list').length, capture.format()).toBe(0);
                expect(capture.writesFor('reorder_list_line').length, capture.format()).toBe(0);
            },
        );
    });

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    // AC-3 — A line the caller does not hold returns a not-found result that discloses nothing
    //
    // The two error types are NOT interchangeable and the split is contractual: a line absent from a list
    // the caller DOES own is a different fact from a list the caller does not own, and a client can act on
    // the first by refreshing while the second means the list is not theirs to refresh. What must be
    // indistinguishable is the three ways a LIST can fail to resolve — absent, another customer's, another
    // channel's — because identifiers are sequential under the default strategy and a distinguishable
    // refusal would be an enumeration channel rather than a courtesy.
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

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

            // The list resolved and the line did not, which is a different fact from an inaccessible list.
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

            // (b) The SECOND CUSTOMER'S list together with that list's own line.
            const foreignCustomer = await shopClient.query<
                AdjustReorderListLineMutation,
                AdjustReorderListLineMutationVariables
            >(ADJUST_REORDER_LIST_LINE, {
                input: { reorderListId: theirs.listId, lineId: theirs.lineIds[0], quantity: 6 },
            });

            // (d) An identifier that matches no `reorder_list` row at all — the control the other two are
            //     compared against, because indistinguishability from THIS is what makes the read
            //     non-enumerable.
            const unknownIdentifier = await shopClient.query<
                AdjustReorderListLineMutation,
                AdjustReorderListLineMutationVariables
            >(ADJUST_REORDER_LIST_LINE, {
                input: { reorderListId: UNKNOWN_LIST_ID, lineId: UNKNOWN_LINE_ID, quantity: 6 },
            });

            // (c) The caller's OWN list and line, under the SECOND CHANNEL'S REAL TOKEN.
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
                // Restored to the default channel's token and never to `null`: a null token is sent as the
                // literal string "null" by the shipped client and no channel carries it.
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
            // Indistinguishable from ONE ANOTHER, field for field, and not merely each matching a template:
            // the same keys in the same shape with the same values.
            expect(foreignChannel).toEqual(foreignCustomer.adjustReorderListLine);
            expect(foreignChannel).toEqual(unknownIdentifier.adjustReorderListLine);
            expect(Object.keys(foreignChannel).sort()).toEqual(
                Object.keys(unknownIdentifier.adjustReorderListLine).sort(),
            );

            // NO ROW WAS WRITTEN BY ANY OF THE THREE.
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

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    // AC-4 — A named line is removed and the line that remains is the one not named
    //
    // The ordering is STATED rather than assumed: the published default sort for lines is ascending by the
    // creation timestamp the base entity supplies, with the identifier appended as the tie-break, so "the
    // first of those two lines" is a fact a test can assert rather than a coincidence of insertion order.
    // The surviving line is asserted by identifier AND by variant AND by quantity, so an implementation
    // that removed the wrong row and happened to leave a collection of one entry still fails.
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    describe('AC-4: removeReorderListLine removes exactly the line it was given', () => {
        /** Seeds the two-line list AC-4 is written against, in the default ascending creation order. */
        async function seedTwoLineList(): Promise<SeededList> {
            const seeded = await seedList(customers[0], 'Two line list', [
                { productVariantId: 'T_1', quantity: 2 },
                { productVariantId: 'T_2', quantity: 3 },
            ]);
            const storedLines = await readStoredLines(seeded.listId);
            expect(storedLines.length).toBe(2);
            // The stored order agrees with the insertion order the fixture recorded, which is what makes the
            // criterion's "first of those two lines" unambiguous.
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
            // THE LINE THAT REMAINS IS THE ONE THE REQUEST DID NOT NAME.
            expect(String(survivor.id)).toBe(seeded.lineIds[1]);
            expect(String(survivor.productVariantId)).toBe('T_2');
            expect(survivor.quantity).toBe(3);
            expect(removeReorderListLine.name).toBe('Two line list');

            const storedLines = await readStoredLines(seeded.listId);
            expect(storedLines.length).toBe(1);
            expect(String(storedLines[0].id)).toBe(String(decodeId(seeded.lineIds[1])));
            expect(storedLines[0].quantity).toBe(3);
            const storedList = await readStoredList(seeded.listId);
            // The counter agrees with the rows, which is the same-transaction decrement observed from outside.
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
                // The filter is named in the assertion: `product_variant`. Reads of it are expected — the
                // published payload carries the surviving line's variant — so the claim is about WRITES.
                expect(capture.writesFor('product_variant').length, capture.format()).toBe(0);
            },
        );
    });

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    // AC-5 — An unauthenticated remove writes nothing, and a second remove of the same line is refused
    //
    // The end state is idempotent while the RESPONSE is not, and the distinction is the point: a caller
    // retrying a removal reaches the same zero-line list either way, so no data is at risk, but a caller
    // who never removed anything and receives a success has been misinformed about a row that was never
    // theirs. That is why a repeated remove is refused rather than reported as a success.
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

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

            // The list is untouched, read back as the owner.
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

            // A REPEATED REMOVE IS REFUSED RATHER THAN REPORTED AS A SUCCESS, which is exactly what the
            // affected-row count of the conditional `DELETE` makes possible.
            expect(second.removeReorderListLine).toEqual({
                __typename: 'ReorderListLineNotFoundError',
                errorCode: 'REORDER_LIST_LINE_NOT_FOUND_ERROR',
                message: expect.any(String) as unknown as string,
            });
            expect((await readStoredLines(seeded.listId)).length).toBe(0);
            expect((await readStoredList(seeded.listId))?.lineCount).toBe(0);
        });
    });

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    // AC-6 — A rename is stored, and a rename onto a name the same customer already holds conflicts
    //
    // Uniqueness is evaluated on the canonical name column this feature stores rather than on a database
    // column collation, so the comparison behaves identically on every engine. The canonical form is the
    // input trimmed, its internal whitespace runs collapsed to one space, normalised to NFC and then
    // lower-cased — so `weekly kitchen restock` collides with `Weekly Kitchen Restock`. Canonicalisation
    // PRESERVES accents, so an accented spelling and its unaccented counterpart remain distinct; that is
    // settled by the feature contract and by the canonicalisation unit spec, and is deliberately not
    // re-asserted numerically here.
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

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
            // The line row is byte-for-byte the row it was, so a rename changed nothing about it.
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
            // The result carries the canonical key that collided, echoing the caller's OWN input so a rename
            // dialogue can explain precisely what collided while disclosing nothing about the other row.
            expect(updateReorderList.conflictingNameKey).toBe('weekly kitchen restock');
            expect(updateReorderList.message.length).toBeGreaterThan(0);
            // The API-visible message carries no driver text, no SQL fragment and no constraint name.
            expect(updateReorderList.message).not.toContain('UQ_reorder_list_customer_channel_name_key');
            expect(updateReorderList.message.toUpperCase()).not.toContain('SELECT');
            expect(updateReorderList.message.toUpperCase()).not.toContain('UPDATE');

            // NOTHING WAS STORED: the two names are exactly what they were, the collision having been raised
            // despite the difference in letter case.
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

            // A blank rename is deliberately NOT a fifth error result: a name whose canonical form is empty
            // cannot be stored, and a name that cannot be stored is a malformed request.
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
                // And the list row was written exactly once, by one conditional statement.
                const listWrites = capture.writesFor('reorder_list');
                expect(listWrites.length, capture.format()).toBe(1);
                expect(listWrites[0].kind, capture.format()).toBe('update');
            },
        );
    });

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    // AC-7 — A deleted list takes its lines with it in one transaction, and a repeat delete is refused
    //
    // The cascade is asserted by COUNTING ROWS rather than by naming a database clause: a criterion that
    // asserted the clause would test the migration's text, whereas a row count fails whether the cause is
    // a missing clause, a service that deletes the parent and abandons the children, or a transaction that
    // commits half the work.
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

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

            // Exactly 0 line rows belong to the list, and the customer owns exactly 0 lists in the channel.
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

            // NO `Order` OR `OrderLine` ROW WAS CREATED, ALTERED OR DELETED BY EITHER CALL.
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
                // Both effects land inside one transaction, so no line row is observable without its parent.
                expect(listWrites[0].inTransaction, capture.format()).toBe(true);
                // The filters are named in the assertion: `order` and `order_line`.
                expect(capture.writesFor('order').length, capture.format()).toBe(0);
                expect(capture.writesFor('order_line').length, capture.format()).toBe(0);
                // And the lines really are gone, so the cascade fired rather than being silently absent.
                expect((await readStoredLines(seeded.listId)).length).toBe(0);
            },
        );
    });

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    // AC-8 — The existing order operations are unchanged and the active order is untouched
    //
    // The comparison is made by RUNTIME INTROSPECTION of a booted server carrying the plugin, compared
    // field-by-field against the checked-in `schema-shop.json`. That snapshot is read READ-ONLY: it is
    // neither edited nor regenerated, and it cannot move, because the introspection that produces it
    // declares its own configuration and never reads the dev-server config (AAP §0.4.1.5). Editing it to
    // "record" the plugin's operations would be both wrong and a boundary breach.
    //
    // The criterion is written as two assertions rather than one because a schema comparison alone would
    // not catch a behavioural leak: a plugin that adjusted a list line AND an order line would pass a
    // signature check and fail a buyer.
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    describe('AC-8: activeOrder is unchanged in signature and in effect', () => {
        /** Reads the checked-in Shop introspection snapshot. Read-only, and never regenerated. */
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

        /** Reduces one field to the five things a SIGNATURE is: its name, its arguments and its return type. */
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

            // Additive, member for member: every baseline name survives under its own name.
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
            // All four mutations run here as SETUP; each one's own outcome is asserted by AC-1 through AC-7
            // rather than here. This criterion asserts only what `activeOrder` reports afterwards.
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

            // NO `OrderLine` ROW WAS READ OR WRITTEN BY ANY OF THE FOUR. The read half is asserted as a
            // count of zero because none of the four resolves an order at all — the filter is named:
            // `order_line`, and `order` beside it.
            expect(capture.count('order_line'), capture.format()).toBe(0);
            expect(capture.writesFor('order').length, capture.format()).toBe(0);

            const orderAfter = await shopClient.query<GetActiveOrderQuery>(GET_ACTIVE_ORDER);
            expect(orderAfter.activeOrder?.totalQuantity).toBe(recordedTotalQuantity);
            expect(orderAfter.activeOrder?.id).toBe(orderBefore.activeOrder?.id);
            expect(orderAfter.activeOrder?.lines).toEqual(orderBefore.activeOrder?.lines);
        });
    });

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    // The two structural claims of this story, asserted rather than assumed (FEATURE-001-01 §2.11)
    //
    // The counted and predicate-shape assertions in this section are gated to the one engine on which
    // statement text and statement count are deterministic, and the fixture's own exported sentence saying
    // why titles the describe below verbatim rather than being paraphrased here. Every behavioural sibling
    // above runs on all four engine jobs. The capture helpers themselves resolve placeholders on every
    // engine, so these assertions would hold elsewhere too; they are gated only because each shares a
    // capture window with an exact count.
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

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
                // The row is addressed by its OWN identifier together with its parent's, so a line identifier
                // belonging to another list cannot be reached through it.
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

                // THE SAME-TRANSACTION DECREMENT. One guarded counter update, carrying the same three
                // conjuncts as every other statement addressing the list row.
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

                // And the stored counter equals the remaining row count EXACTLY, observed from outside the
                // transaction once it has committed.
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

                // adjustReorderListLine
                capture.reset();
                const adjusted = await capture.capture(() =>
                    shopClient.query<AdjustReorderListLineMutation, AdjustReorderListLineMutationVariables>(
                        ADJUST_REORDER_LIST_LINE,
                        { input: { reorderListId: theirs.listId, lineId: theirs.lineIds[0], quantity: 6 } },
                    ),
                );
                expect(adjusted.adjustReorderListLine.__typename).toBe('ReorderListNotFoundError');
                assertRefusedWriteReadOneScopedListRow(theirs.listId, customers[0].id);

                // removeReorderListLine
                capture.reset();
                const removed = await capture.capture(() =>
                    shopClient.query<RemoveReorderListLineMutation, RemoveReorderListLineMutationVariables>(
                        REMOVE_REORDER_LIST_LINE,
                        { input: { reorderListId: theirs.listId, lineId: theirs.lineIds[0] } },
                    ),
                );
                expect(removed.removeReorderListLine.__typename).toBe('ReorderListNotFoundError');
                assertRefusedWriteReadOneScopedListRow(theirs.listId, customers[0].id);

                // updateReorderList
                capture.reset();
                const renamed = await capture.capture(() =>
                    shopClient.query<UpdateReorderListMutation, UpdateReorderListMutationVariables>(
                        UPDATE_REORDER_LIST,
                        { input: { id: theirs.listId, name: 'Renamed by a stranger' } },
                    ),
                );
                expect(renamed.updateReorderList.__typename).toBe('ReorderListNotFoundError');
                assertRefusedWriteReadOneScopedListRow(theirs.listId, customers[0].id);

                // deleteReorderList
                capture.reset();
                const deleted = await capture.capture(() =>
                    shopClient.query<DeleteReorderListMutation, DeleteReorderListMutationVariables>(
                        DELETE_REORDER_LIST,
                        { id: theirs.listId },
                    ),
                );
                expect(deleted.deleteReorderList.__typename).toBe('ReorderListNotFoundError');
                assertRefusedWriteReadOneScopedListRow(theirs.listId, customers[0].id);

                // The second customer's rows are exactly as they were.
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

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    // §7's fourth scenario — one request adjusts a line while another removes the same line
    //
    // BOTH interleavings are FORCED rather than awaited, on the three engine jobs that run a database
    // server two independent connections can be opened against: `e2e-mariadb`, `e2e-mysql` and
    // `e2e-postgres`. `Promise.all` alone does not satisfy the rule, which is why the barrier fixture — not
    // a bare pair of promises — is the instrument.
    //
    // **`e2e-sqljs` is EXCLUDED from the forced interleaving and carries the sequential form instead.** The
    // fixture's own exported sentence saying why titles the sequential describe below verbatim, so the
    // exclusion is stated at the site rather than paraphrased differently in each file.
    //
    // Each case asserts TWO things, because an implementation that returns success for a write which
    // affected nothing passes a count-only assertion: the final row count, AND the result the losing caller
    // received. At the statement level the loser's result is an affected-row count of zero; the published
    // result that count produces is asserted through the API in the same test.
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    describe(`§7 scenario 4: one request adjusts a line while another removes it (engine: ${resolveConfiguredEngine()})`, () => {
        /**
         * The request context an authenticated client's next request would arrive with, built through the
         * platform's OWN guard path.
         *
         * `fromRequest` rather than `create`: `create` hard-codes `isAuthorized: true` and
         * `authorizedAsOwnerOnly: false`, whereas these operations are gated on `Permission.Owner` — a member
         * no session can hold — so a real request produces the opposite pair and it is the service's own
         * ownership predicate rather than the gate that decides the outcome. A race driven with a context the
         * guard could never produce would assert against a path no buyer reaches.
         */
        async function shopContextFor(client: SimpleGraphQLClient): Promise<RequestContext> {
            const session = await server.app.get(SessionService).getSessionFromToken(client.getAuthToken());
            expect(
                session,
                'The client holds no session, so no authenticated context can be built',
            ).toBeDefined();
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
         * participant queue behind it. `'none'` is a follower. See {@link takeLeadLock} for why the correct
         * choice differs between the two pairings and what happens when it is wrong.
         */
        type LeadLock = 'none' | 'line' | 'list';

        /**
         * THE REAL `adjustReorderListLine` OPERATION as a barrier participant, executed on this participant's
         * own connection inside its own held transaction.
         *
         * An earlier revision issued a hand-written `UPDATE` here instead and read its affected count. That
         * measured the statement a test author wrote, not the one the service issues: it carried neither the
         * ownership conjuncts nor the counter maintenance, so a service whose adjust path lost its
         * affected-row check, reported success over a row it never touched, or left the parent counter wrong
         * would pass unchanged. Binding the context puts the operation under test — predicate, conditional
         * statement, affected-row branch and counter — inside the window the assertion claims.
         *
         * `leadLock` is what makes the ordering FORCED rather than observed. The participant that holds it
         * takes a pessimistic write lock on the row its sibling reaches first, in its PRECHECK, which
         * completes before either write begins; when the pair is released, that participant proceeds while
         * its sibling blocks on the lock, and the harness commits the holder as soon as its write returns, so
         * the sibling then runs against the holder's committed effect. Without it, which caller reaches the
         * row first is whatever the scheduler decided, and the pair could only assert a disjunction.
         *
         * WHY THESE PAIRINGS CARRY NO INNER PRE-WRITE RENDEZVOUS, unlike the add-item races. That instrument
         * exists to put two callers in the window between their own reads and their own writes, which is the
         * right claim where the contract is that both callers' effects must survive. It is the WRONG
         * instrument here: what these pairings assert is the outcome of a SPECIFIC order — an adjustment that
         * lands after a removal, and a removal that lands after an adjustment — and that order is produced by
         * the lead lock. Holding both callers before their writes would leave each waiting for the other while
         * one already held the lead lock, which is a deadlock rather than an interleaving. The two instruments
         * answer different questions and the choice between them is per pairing, not a house style.
         *
         * Identifiers are the INTERNAL ones: the platform decodes every `id` argument in an interceptor above
         * the resolver (`packages/core/src/api/middleware/id-interceptor.ts`), so a service invoked directly
         * receives decoded values.
         */
        /** One statement a real service operation issued on its own transaction, and what it affected. */
        interface CapturedServiceWrite {
            readonly statement: string;
            readonly affected: number | undefined;
        }

        /**
         * What a forced participant observed about its own EXECUTION, beyond the value it handed back.
         *
         * A result class alone cannot carry this claim. `adjustReorderListLine` returns the parent list on
         * the applied path, so an adjustment that matched NOTHING and still returned a list — the exact
         * read-then-write defect the affected-row rule exists to prevent — is indistinguishable by type from
         * one that applied, once the sibling removal has deleted the row and the stored state is empty either
         * way. What separates them is the count the driver reported for the operation's own conditional
         * statement, and the quantity that statement actually left behind. Both are recorded here.
         */
        interface ServiceObservation {
            /** Every statement the operation issued on this transaction, with its affected-row count. */
            readonly writes: CapturedServiceWrite[];
            /**
             * The line's stored quantity, read back INSIDE the operation's own transaction after its DML and
             * before it committed — so it is the value that operation left, not a later reading of it.
             */
            quantityInTransaction?: number;
            /** Whether that read-back found the row at all. */
            lineFoundInTransaction?: boolean;
        }

        function newObservation(): ServiceObservation {
            return { writes: [] };
        }

        /**
         * Records every statement this participant's transaction issues, together with the affected-row count
         * the driver returned for it.
         *
         * This wraps the runner the barrier has already patched, so the pre-write hold still happens inside:
         * the service's statement reaches this wrapper, which forwards to the hold, which forwards to the
         * driver. The count is available because TypeORM asks for it — `UpdateQueryBuilder.execute()` and its
         * delete counterpart call `queryRunner.query(sql, parameters, true)`, and that third argument is what
         * makes the driver return a structured result carrying `affected` rather than bare rows
         * (`node_modules/typeorm/query-builder/UpdateQueryBuilder.js:L83`). It is the very number the service
         * itself branches on, so this observes the operation's own authority rather than re-deriving one.
         *
         * Nothing needs restoring: the barrier's own `restore()` reassigns the runner's original `query`, which
         * discards this wrapper with the patch it sat on.
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
         *
         * The line table is selected by its own name; the parent table's name is a prefix of it, so a naive
         * match on `reorder_list` would also match every statement against `reorder_list_line` and the
         * ownership sub-query each of them carries. Requiring exactly one match is part of the assertion: an
         * operation that issued two conditional statements against the line, or none, is not the shape these
         * tests describe, and reporting a count picked out of several would hide that.
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
                    await takeLeadLock(ctx.manager, leadLock, listRowId, lineRowId);
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
                    await takeLeadLock(ctx.manager, leadLock, listRowId, lineRowId);
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
         * Takes the pessimistic write lock that establishes a forced ordering, or none.
         *
         * ★ WHICH ROW THE LEADER HOLDS IS NOT INTERCHANGEABLE, and getting it wrong manufactures a deadlock
         * instead of an ordering. The leader must hold the row the FOLLOWER reaches FIRST, because that is the
         * only row on which the follower can be made to queue. The two service paths reach their two rows in
         * OPPOSITE ORDERS, so the answer differs per pairing:
         *
         *   - `removeReorderListLine` takes the PARENT first, as a locking read
         *     (`findOwnedListForUpdate`), and only then deletes the line. So an adjustment leading a removal
         *     must hold the **parent**.
         *   - `adjustReorderListLine` deliberately does NOT lock the parent — its scoped admission read is
         *     non-locking, by an explicit decision recorded at that read, because holding the parent would
         *     serialise concurrent adjustments and turn this very evidence into sequencing. Its single
         *     conditional `UPDATE` therefore takes the LINE first (and the parent only as a shared read, inside
         *     that one statement). So a removal leading an adjustment must hold the **line**.
         *
         * MEASURED, NOT REASONED FROM THE OUTSIDE. An earlier revision had the leading adjustment hold the
         * line, on the assumption that a removal reaches the line first. It does not, and the result was a
         * genuine InnoDB deadlock on MySQL: the adjustment held the line record and waited for a shared lock on
         * the parent while the removal held the parent exclusively and waited for the line. MySQL rolled the
         * victim's whole transaction back, which discards its savepoints, so the next statement failed with
         * `ER_SP_DOES_NOT_EXIST (1305) SAVEPOINT typeorm_1 does not exist` — a symptom three layers from its
         * cause. `SHOW ENGINE INNODB STATUS` named both sides of it under LATEST DETECTED DEADLOCK. The other
         * ordering, whose leader already held the line, passed throughout.
         *
         * ‼ THE UNDERLYING INVERSION IS REAL AND IS NOT FIXED BY THIS FILE. Two genuine concurrent requests —
         * one adjusting, one removing the same line, with no test lock anywhere — take the same two rows in the
         * same opposite orders and can deadlock in production on MySQL. It is not an oversight in either path
         * but a consequence of two requirements that cannot both be relaxed: the removal must hold the parent so
         * that its counter decrement shares the delete's transaction, and the adjustment must NOT hold the
         * parent so that concurrent adjustments interleave. A deadlock is the engine's own, correctly detected
         * response to that, and the caller sees the plugin's generic internal error rather than a wrong result,
         * so nothing is silently corrupted. It is reported rather than absorbed here, because a forced ordering
         * chosen to avoid it must not be mistaken for evidence that it cannot happen.
         *
         * Only the three server engines run the forced orderings, and each of them honours
         * `pessimistic_write` — which is exactly why the sql.js job runs the sequential form instead.
         */
        async function takeLeadLock(
            manager: EntityManager,
            leadLock: LeadLock,
            listRowId: number,
            lineRowId: number,
        ): Promise<void> {
            if (leadLock === 'line') {
                await lockLineRow(manager, listRowId, lineRowId);
            } else if (leadLock === 'list') {
                await lockListRow(manager, listRowId);
            }
        }

        /**
         * Takes a pessimistic write lock on one parent list row, on the given transaction — the lock a leading
         * adjustment needs, because it is the row `removeReorderListLine` reaches first.
         */
        async function lockListRow(manager: EntityManager, listRowId: number): Promise<void> {
            const held = await manager
                .createQueryBuilder(ReorderList, 'list')
                .setLock('pessimistic_write')
                .where('list.id = :listId', { listId: listRowId })
                .getOne();
            expect(held?.id !== undefined, 'the parent list row to be held was not found').toBe(true);
        }

        /**
         * Takes a pessimistic write lock on one line row, on the given transaction.
         *
         * Only the three server engines run the forced orderings, and each of them honours
         * `pessimistic_write` — which is exactly why the sql.js job runs the sequential form instead.
         */
        async function lockLineRow(
            manager: EntityManager,
            listRowId: number,
            lineRowId: number,
        ): Promise<void> {
            const held = await manager
                .createQueryBuilder(ReorderListLine, 'line')
                .setLock('pessimistic_write')
                .where('line.id = :lineId', { lineId: lineRowId })
                .andWhere('line.reorderListId = :listId', { listId: listRowId })
                .getOne();
            expect(held, 'The line to be held at the barrier does not exist').not.toBeNull();
        }

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

        /** Reads an outcome's affected count, failing loudly for a participant that did not fulfil. */
        function affectedRowsOf(outcome: { status: string; value?: number; reason?: unknown }): number {
            expect(outcome.status, `participant rejected: ${String(outcome.reason)}`).toBe('fulfilled');
            return outcome.value as number;
        }

        /** Reads a participant's fulfilled value, failing loudly with the reason if it rejected instead. */
        function fulfilledValueOf<T>(outcome: {
            label: string;
            status: string;
            value?: T;
            reason?: unknown;
        }): T {
            expect(
                outcome.status,
                `${outcome.label} rejected: ${
                    outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)
                }`,
            ).toBe('fulfilled');
            return outcome.value as T;
        }

        /** Both participants' rejection reasons, so a failed race names why rather than only that. */
        function describeOutcomeReasons(result: {
            a: { label: string; status: string; reason?: unknown };
            b: { label: string; status: string; reason?: unknown };
        }): string {
            return [result.a, result.b]
                .filter(outcome => outcome.status !== 'fulfilled')
                .map(
                    outcome =>
                        `${outcome.label}: ${
                            outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)
                        }`,
                )
                .join(' | ');
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

                    // THE ORDERING IS FORCED, not observed: the adjustment holds the PARENT row for the window,
                    // which is the row `removeReorderListLine` reaches first, so the removal queues on its own
                    // opening statement and cannot touch the line until the adjustment has committed. Holding
                    // the line here instead would not order the pair — it would deadlock it; see
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
                    // The counter on the object the removal HANDED BACK, not merely the one in the table: a
                    // decrement applied to the row but absent from the returned payload would leave a client
                    // rendering a stale count.
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

                    // AND THE VALUE THE ADJUSTMENT ACTUALLY LEFT, read inside its own transaction before the
                    // removal could reach the row. An adjustment that affected one row but wrote the wrong
                    // quantity would pass the count assertion above and fail here.
                    expect(
                        adjustObservation.lineFoundInTransaction,
                        'the adjustment could not see its own line inside its own transaction',
                    ).toBe(true);
                    expect(adjustObservation.quantityInTransaction).toBe(6);

                    // THE STORED STATE, including the PARENT COUNTER the removal has to maintain in the same
                    // transaction as the delete. A decrement left out of that transaction leaves the counter at
                    // one over a list with no lines, which is exactly what this asserts against.
                    expect(await readStoredLines(seeded.listId)).toHaveLength(0);
                    expect((await readStoredList(seeded.listId))?.lineCount).toBe(0);

                    // And the published result a caller now receives for the row that is gone.
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

                    // THE OPPOSITE ORDERING, forced the same way: the removal holds the line row, so the
                    // adjustment cannot reach it until the row is gone and its own statement matches nothing.
                    const removeObservation = newObservation();
                    const adjustObservation = newObservation();
                    const result = await runBarrieredPair(dataSource, {
                        a: serviceRemove('remove', sessionContext, listId, lineId, 'line', removeObservation),
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
                    // about the operation, and this assertion was wrong once for saying otherwise: under the
                    // REPEATABLE READ default of the MySQL family, this transaction's snapshot predates the
                    // sibling's committed removal, so a plain SELECT still returns a row the transaction can
                    // no longer update, while PostgreSQL's READ COMMITTED default reports it already gone.
                    // Measured on all three server engines, not assumed.
                    //
                    // That divergence is the whole reason the affected-row count above is the authority: it
                    // comes from a CURRENT read, which sees the committed deletion, and a prior SELECT does
                    // not. So what is asserted here is the part that holds on every engine — the refused
                    // adjustment left the stored quantity untouched wherever it is visible at all — rather
                    // than one engine's snapshot behaviour dressed up as a contract.
                    expect(
                        typeof adjustObservation.lineFoundInTransaction,
                        'the adjustment never performed its in-transaction read-back, so this proves nothing',
                    ).toBe('boolean');
                    if (adjustObservation.lineFoundInTransaction === true) {
                        expect(adjustObservation.quantityInTransaction).toBe(2);
                    } else {
                        expect(adjustObservation.quantityInTransaction).toBeUndefined();
                    }

                    // THE STORED STATE AND THE PARENT COUNTER. The refused adjustment changed neither, and the
                    // removal's decrement landed in its own transaction.
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
                // The remove applied and the adjustment that followed it MATCHED NOTHING — 1 then 0, which is the
                // affected-row count acting as the authority rather than a read-then-write reporting success.
                expect(affectedRowsOf(result.a)).toBe(1);
                expect(affectedRowsOf(result.b)).toBe(0);
                expect(await readStoredLines(seeded.listId)).toHaveLength(0);
                // And the published result that same zero count produces.
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
                // A second removal of the row that is already gone matches nothing, which is the same authority
                // read once more — and the published refusal it produces.
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

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    // §7's first three scenarios. The fourth — concurrent modification — is the describe above.
    //
    // TWO OF THE THREE REQUIRED CATEGORIES RESOLVE TO *PROCEED* RATHER THAN TO A BLOCK, and that is stated
    // honestly here rather than force-fitted into a failure these operations cannot have: a saved list
    // records INTENT rather than availability, so neither a disabled variant nor a changed price is a
    // precondition of amending a line.
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

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

            // The LIST resolved under the ownership predicate and the LINE did not exist to remove.
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
            // The refusal happens before execution, so the response carries no `data` entry at all — which is
            // a different envelope from the `data: null` an execution-time refusal produces, and is asserted
            // as such rather than coalesced into it, because the absence is the evidence that nothing ran.
            expect(
                'data' in response,
                `Expected no data entry on a pre-execution rejection: ${JSON.stringify(response)}`,
            ).toBe(false);
            expect(response.errors[0].message).toContain('quantity');
            // And nothing was written: the list is exactly as the fixture left it.
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
            // The first variant is DISABLED since the line was added; the second is SOFT-deleted, which sets a
            // timestamp and leaves the row — and therefore the line — in place.
            await setVariantEnabled('T_1', false);
            await softDeleteVariant('T_2');

            const { adjustReorderListLine } = await shopClient.query<
                AdjustReorderListLineMutation,
                AdjustReorderListLineMutationVariables
            >(ADJUST_REORDER_LIST_LINE, {
                input: { reorderListId: seeded.listId, lineId: seeded.lineIds[0], quantity: 6 },
            });
            // PROCEED, with no warning and no audit record: a buyer who bought something regularly still
            // intends to buy it, and refusing to let them change the amount would strand the line in a state
            // they cannot amend. Neither operation reads the `enabled` flag as a precondition.
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
            // A SOFT-DELETED variant is not resolvable, so the field is null while the stored identifier
            // survives — which is exactly what lets a buyer see and remove the stale line.
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
            // A LINE IS REMOVABLE IN EVERY CASE, whatever the state of the variant behind it. A list a buyer
            // cannot prune because the catalogue moved underneath them is the failure mode this rules out.
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
                // The mutation's OWN result, rather than the absence of a top-level error: an update that
                // returned nothing, or returned some other variant, or silently left the price where it was,
                // would otherwise pass for a price change.
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

            // AND THE STATE ITSELF, read back independently of the write that made it. Trusting the mutation's
            // echo would leave the premise resting on the harness rather than on the database.
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

            // PROCEED on both, with no warning: an adjustment changes an integer quantity and nothing
            // monetary, a rename changes a string and nothing monetary, and the line table stores no price at
            // all — so there is no stored value for a price change to invalidate.
            expect(adjustReorderListLine.__typename).toBe('ReorderList');
            expect(updateReorderList.__typename).toBe('ReorderList');
            if (adjustReorderListLine.__typename !== 'ReorderList') {
                throw new Error('adjustReorderListLine did not return a ReorderList');
            }
            expect(adjustReorderListLine.lines.items[0].quantity).toBe(6);
            // Nothing in either payload is a monetary, currency or stock value — asserted structurally over
            // the whole response rather than field by field, so a field added later cannot slip past it.
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

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    // The empty-generation assertion this suite owns
    //
    // STORY-001-01-03 requires NO MIGRATION OF ITS OWN, and the absence is verified rather than asserted:
    // every table, column, index, constraint and on-delete action it relies on ships in the single additive
    // migration STORY-001-01-01 generates. A generated file appearing at this point is the signal that this
    // story has altered a mapping it does not own.
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

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
            await rebuildPluginSchemaFromCheckedInMigration();

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

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    // The four mandatory authorisation cases, carried for EVERY ONE of this story's four mutations
    //
    // STORY-001-01-03 §10 requires the four authorisation cases as REAL API CALLS for each of the four
    // mutations — "each of which is a real API call asserting both the returned payload and the stored row
    // count rather than a unit test of a guard function, and the foreign-channel case sending a second real
    // channel token rather than mutating a variable" — which is four callers × four operations, sixteen
    // cells. §10 also states which four callers: a session holding no custom permission SUCCEEDS, a request
    // authenticated as a DIFFERENT CUSTOMER is refused, a request carrying a FOREIGN CHANNEL TOKEN reaches
    // nothing, and an UNAUTHENTICATED request writes nothing.
    //
    // The ledger is written out here so the matrix can be COUNTED in one place rather than reassembled by
    // reading the whole file. The positive cell of each operation lives with the criterion that owns its
    // behaviour, because that is where the payload is asserted in full; the three refusal cells live here:
    //
    //   adjustReorderListLine   succeeds → AC-1  ·  other customer → AC-3  ·  foreign channel → AC-3  ·  unauthenticated → HERE
    //   removeReorderListLine   succeeds → AC-4  ·  other customer → HERE  ·  foreign channel → HERE  ·  unauthenticated → AC-5
    //   updateReorderList       succeeds → AC-6  ·  other customer → HERE  ·  foreign channel → HERE  ·  unauthenticated → HERE
    //   deleteReorderList       succeeds → AC-7  ·  other customer → HERE  ·  foreign channel → HERE  ·  unauthenticated → HERE
    //
    // **Every cell here is UNGATED**, so all sixteen are exercised on all four engine jobs. The instrumented
    // sibling in the section below — which asserts an exact statement count for the other-customer refusal of
    // all four operations — is gated to the one engine on which a count is deterministic (EPIC-001 §11.6.2),
    // and a gated cell cannot be the only evidence of a behaviour the story requires everywhere. The
    // other-customer cells here are that gated test's behavioural siblings and assert the same refusal
    // without counting.
    //
    // Two shapes of refusal appear, and the difference is the point rather than an inconsistency:
    //
    //   - The UNAUTHENTICATED call never reaches a row, so it is refused by the service's own session guard
    //     and surfaces as exactly one TOP-LEVEL `errors` entry whose `extensions.code` is exactly `FORBIDDEN`
    //     — never `UNAUTHORIZED`, which is raised where credentials do not MATCH. `data` is null wholesale,
    //     because the field is declared Non-Null and the error propagates past it to the root. This is the
    //     one place a claim of ZERO statements is made, and it is claimable because the guard is evaluated
    //     before any statement is issued.
    //   - The OTHER-CUSTOMER and FOREIGN-CHANNEL calls address a row that exists, so the server cannot
    //     discover its inaccessibility without asking. Each is refused with the normalised
    //     `ReorderListNotFoundError` — asserted INDISTINGUISHABLE from an identifier matching no row at all,
    //     which is what makes the surface non-enumerable — and each asserts ZERO writes against both plugin
    //     tables rather than zero statements.
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    describe('The four mandatory authorisation cases, per operation', () => {
        /** The normalised refusal every inaccessible-row call in this section must be indistinguishable from. */
        const INACCESSIBLE_LIST = {
            __typename: 'ReorderListNotFoundError',
            errorCode: 'REORDER_LIST_NOT_FOUND_ERROR',
            message: expect.any(String) as unknown as string,
        };

        /**
         * Runs one call under the SECOND, REAL channel's own token, restoring the default token unconditionally.
         *
         * A second real channel created through the Admin API and addressed by its token is what
         * STORY-001-01-03 §10 requires of the foreign-channel case; mutating a variable would prove nothing
         * about the channel the request actually resolved. The token is restored in a `finally` so a failing
         * assertion cannot leak the foreign channel into the next test, and it is restored to the default
         * channel's token rather than to `null`: a null token is sent as the literal string "null" by the
         * shipped client and no channel carries it.
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

        // ── adjustReorderListLine ─────────────────────────────────────────────────────────────────────

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
            // Refused before either plugin table was reached at all: the session guard runs before any
            // statement is issued, so this is a path refused rather than a read that found nothing.
            expect(capture.count('reorder_list'), capture.format()).toBe(0);
            expect(capture.count('reorder_list_line'), capture.format()).toBe(0);

            // The line is exactly as it was, read back as its owner.
            await authenticateAs(customers[0]);
            const storedLines = await readStoredLines(seeded.listId);
            expect(storedLines.length).toBe(1);
            expect(storedLines[0].quantity).toBe(2);
            expect((await readStoredList(seeded.listId))?.lineCount).toBe(1);
        });

        // ── removeReorderListLine ─────────────────────────────────────────────────────────────────────

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

            // The caller's OWN list and OWN line, under a channel the row does not belong to: refused, and
            // refused as the same normalised result an identifier matching no row at all produces.
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

            // NOTHING WAS REMOVED, and the counter is untouched.
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

            // The other customer's line and counter are exactly as they were.
            const theirLines = await readStoredLines(theirs.listId);
            expect(theirLines.length).toBe(1);
            expect(theirLines[0].quantity).toBe(4);
            expect((await readStoredList(theirs.listId))?.lineCount).toBe(1);
        });

        // ── updateReorderList ─────────────────────────────────────────────────────────────────────────

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

            // THE STORED NAME IS EXACTLY WHAT IT WAS, in both its display and its canonical form.
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

        // ── deleteReorderList ─────────────────────────────────────────────────────────────────────────

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

// ═════════════════════════════════════════════════════════════════════════════════════════════════════
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
//
// ★ WHY IN THIS FILE RATHER THAN A FILE OF THEIR OWN. The AAP closes this package's `e2e/` inventory at six
// suites plus their shared documents, harnesses and compiler fixtures (§0.5.1.8), so these cases are carried
// by the suite that consumes the verifier most heavily rather than by a seventh discovered spec. They boot
// no server, open no database, seed nothing and destroy nothing: they are declared as their OWN top-level
// describe so that this file's `beforeAll`, `beforeEach` and `afterEach` — all declared inside the suite
// above — do not apply to them, and the suite above is unaffected by their presence.
//
// ★ THE STATEMENTS ARE THE REAL RENDERINGS, not invented SQL. The PostgreSQL, MySQL/MariaDB and sql.js forms
// below were taken from what TypeORM 0.3.28 actually emits for `ReorderListService.ownedListExistsClause()`
// on each engine: `$n` and double-quoted identifiers on PostgreSQL, positional `?` and backticks on the
// MySQL family, and inline numeric literals with an empty parameter array on sql.js. Each is fed through
// {@link QueryCaptureLogger} exactly as the suite above receives it, so the capture path is exercised
// alongside the parser and the dialect is read from the runner's own connection rather than passed in beside
// it. The identifiers are prefixed `VERIFIER_` so that nothing here can be confused with a row this file's
// own fixtures created.
// ═════════════════════════════════════════════════════════════════════════════════════════════════════
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
 *
 * The runner is the smallest object the logger reads — `connection.options.type` for the dialect and
 * `isTransactionActive` for the transaction flag — and it is cast rather than constructed because
 * TypeORM's `QueryRunner` is a large interface and none of the rest of it is consulted.
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
            // `ol.id = $3` names whichever list that parameter carries. It is not a correlation at all, and a
            // statement addressing the line by its own identifier then reaches a line of any list.
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

            // What they DO answer for is the row's own identifier, which the correlated helper does not
            // assert — so a complete line-write claim uses both.
            expect(whereMentionsColumns(statement, ['id', 'reorderListId'])).toBe(true);
            expect(whereRequiresCorrelatedOwnership(statement, verifierLineScope())).toBe(true);
        });
    });
});
