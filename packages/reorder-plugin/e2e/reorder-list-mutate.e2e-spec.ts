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
import { generateMigration, mergeConfig, ProductVariant, TransactionalConnection } from '@vendure/core';
import { createTestEnvironment, E2E_DEFAULT_CHANNEL_TOKEN } from '@vendure/testing';
import fs from 'fs-extra';
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
    resolveConfiguredEngine,
    runBarrieredPair,
    runSequentialPair,
    SQLJS_EXCLUSION_REASON,
    supportsForcedInterleaving,
} from './fixtures/concurrency-barrier';
import {
    isStatementCountEngine,
    queryCaptureConfig,
    QueryCaptureLogger,
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
 */
const COUNTED_FORM = `[counted form, ${resolveConfiguredEngine()} only]`;

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
    data: Record<string, unknown> | null;
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

describe('Reorder list mutations — adjust, remove, rename and delete (STORY-001-01-03)', () => {
    const { server, adminClient, shopClient } = createTestEnvironment(serverConfig);

    /** The two seeded buyers. `[0]` is the acting customer throughout; `[1]` is the second customer AC-3 needs. */
    let customers: SeededCustomer[] = [];
    /** The active channel's identifier in its external form, read from the server rather than assumed. */
    let activeChannelId = '';
    /** The live data source, for the raw reads every stored-row assertion is made against. */
    let dataSource: DataSource;
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
        // Every plugin-owned row this test created, deleted CHILD TABLE BEFORE PARENT so a foreign key is
        // never what fails the cleanup (EPIC-001 §11.6.1, §7.8). Only this suite writes these two tables in
        // this database, so emptying them deletes exactly this test's rows and nothing else.
        //
        // The harness's wholesale table clear is deliberately NOT used: it synchronises the schema and drops
        // the populated catalogue every later test reads.
        await deleteAllPluginRows();
        // Core rows a test mutated but did not create are restored in the same hook — the variant `enabled`
        // flag and the soft-deletion timestamp §7's second scenario writes, and any price §7's third one
        // changes.
        await restoreAllVariants();
        for (const restore of coreRowRestorers) {
            await restore();
        }
        coreRowRestorers = [];
        for (const directory of temporaryDirectories) {
            await fs.remove(directory);
        }
        temporaryDirectories = [];
        capture.reset();
        capture.disable();
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
     * Restores every product variant to the state the harness populated: enabled, and not soft-deleted.
     *
     * §7's second scenario disables one variant and soft-deletes another, both of which are core rows the
     * test did not create. Restoring them is idempotent and unconditional, so a test that failed part-way
     * through cannot leave the shared catalogue altered for the next one.
     */
    async function restoreAllVariants(): Promise<void> {
        await dataSource
            .createQueryBuilder()
            .update(ProductVariant)
            .set({ enabled: true, deletedAt: null })
            .where('1 = 1')
            .execute();
    }

    /** Sets one variant's `enabled` flag directly, so §7's scenario can observe a disabled variant. */
    async function setVariantEnabled(externalVariantId: string, enabled: boolean): Promise<void> {
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
            return existing.activeOrder.totalQuantity;
        }
        const { addItemToOrder } = await shopClient.query<AddItemToOrderMutation>(ADD_ITEM_TO_ORDER, {
            productVariantId,
            quantity: 1,
        });
        if (!('totalQuantity' in addItemToOrder)) {
            throw new Error(`Fixture could not create an active order: ${JSON.stringify(addItemToOrder)}`);
        }
        return addItemToOrder.totalQuantity;
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
            // Non-Null, so the error propagates past it to the root and `data` is null wholesale — strictly
            // stronger than the member alone being null, which the second assertion states as well.
            expect(response.data).toBeNull();
            expect(response.data?.removeReorderListLine ?? null).toBeNull();
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
         * The conditional absolute set, as a barrier participant, returning its own affected-row count.
         *
         * It mirrors the service's own statement shape for the part the race turns on — the line's identifier
         * together with its parent's — and reads the affected count, which is the authority. The ownership
         * conjuncts the real statement additionally carries are evidenced against the REAL statements in the
         * section above; a participant cannot borrow the service's transaction, so it issues the statement
         * itself on the connection the barrier holds.
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

        /** The conditional delete, as a barrier participant, returning its own affected-row count. */
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

        /**
         * The invariant BOTH orderings must satisfy, whichever caller actually won.
         *
         * Exactly one of two outcomes is permitted, and the two forbidden ones are named so the assertion
         * fails on them rather than on a count that happens to agree:
         *
         *   - the adjustment committed first, so both statements applied — `(adjust 1, remove 1)`;
         *   - the removal committed first, so the adjustment matched nothing — `(adjust 0, remove 1)`.
         *
         * `(adjust 1, remove 0)` is the outcome a read-then-write without an affected-row check would permit:
         * a line left at the adjusted quantity that a caller was told had been removed. `(adjust 0, remove 0)`
         * would mean neither write applied while the row is gone. Both are refused here.
         */
        async function assertRaceInvariant(
            listId: string,
            adjustAffected: number,
            removeAffected: number,
        ): Promise<void> {
            expect(removeAffected).toBe(1);
            expect([0, 1]).toContain(adjustAffected);
            // BOTH ORDERINGS END AT EXACTLY 0 LINES, and no ordering leaves a line behind.
            expect(await readStoredLines(listId)).toHaveLength(0);
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
                `forces adjust-then-remove on ${resolveConfiguredEngine()} and ends at zero lines with the loser told the line is gone`,
                async () => {
                    const seeded = await seedList(customers[0], 'Barrier adjust then remove', [
                        { productVariantId: 'T_1', quantity: 2 },
                    ]);
                    // The collection-time gate and the running data source agree on the engine.
                    expect(supportsForcedInterleaving(dataSource)).toBe(true);
                    const listId = decodeId(seeded.listId);
                    const lineId = decodeId(seeded.lineIds[0]);

                    const result = await runBarrieredPair(dataSource, {
                        a: conditionalAdjust(listId, lineId, 6, 'adjust'),
                        b: conditionalRemove(listId, lineId, 'remove'),
                    });

                    // Both participants were provably held at the rendezvous and released together before either
                    // wrote, which is the property a race claim rests on.
                    expect(result.a.releasedBeforeWrite).toBe(true);
                    expect(result.b.releasedBeforeWrite).toBe(true);
                    expect(result.rejected.length).toBe(0);
                    await assertRaceInvariant(
                        seeded.listId,
                        affectedRowsOf(result.a),
                        affectedRowsOf(result.b),
                    );
                    await assertLoserReceivesLineNotFound(seeded);
                },
            );

            it.skipIf(!supportsForcedInterleaving())(
                `forces remove-then-adjust on ${resolveConfiguredEngine()} and ends at zero lines with the loser told the line is gone`,
                async () => {
                    const seeded = await seedList(customers[0], 'Barrier remove then adjust', [
                        { productVariantId: 'T_1', quantity: 2 },
                    ]);
                    expect(supportsForcedInterleaving(dataSource)).toBe(true);
                    const listId = decodeId(seeded.listId);
                    const lineId = decodeId(seeded.lineIds[0]);

                    const result = await runBarrieredPair(dataSource, {
                        a: conditionalRemove(listId, lineId, 'remove'),
                        b: conditionalAdjust(listId, lineId, 6, 'adjust'),
                    });

                    expect(result.a.releasedBeforeWrite).toBe(true);
                    expect(result.b.releasedBeforeWrite).toBe(true);
                    expect(result.rejected.length).toBe(0);
                    await assertRaceInvariant(
                        seeded.listId,
                        affectedRowsOf(result.b),
                        affectedRowsOf(result.a),
                    );
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
            // The refusal happens before execution, so the response carries no `data` key populated by a
            // resolver at all and the message names the field that was missing.
            expect(response.data ?? null).toBeNull();
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
            const variantBefore = product?.variants.find(variant => variant.id === 'T_1');
            expect(variantBefore).toBeDefined();
            const recordedPrice = variantBefore?.price as number;
            const updateVariantPrice = async (price: number) => {
                await adminClient.query(
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
            };
            // The price is a core row this test did not create, so its restoration is queued for `afterEach`.
            coreRowRestorers.push(() => updateVariantPrice(recordedPrice));
            await updateVariantPrice(recordedPrice + 5000);
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
        it('emits no migration file, the four operations having altered no mapping', async () => {
            const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'reorder-mutate-migration-'));
            // Queued before the call, so the directory is removed even if the assertion below fails.
            temporaryDirectories.push(outputDir);

            // THE LIVE SERVER'S OWN CONNECTION OPTIONS, and this is load-bearing rather than tidy. The sqljs
            // initializer mutates `location` on the very options object the running server was built from, so
            // passing a freshly derived configuration instead would open an EMPTY database, diff the entities
            // against nothing, and emit the whole schema — a failure that looks like a defect in this story
            // while being an artefact of the harness.
            const generated = await generateMigration(serverConfig, {
                name: 'storyOneOhOneOhThreeShouldEmitNothing',
                outputDir,
            });

            // It returns `undefined` and writes no file. The platform logs "No changes in database schema were
            // found - cannot generate a migration." on this path.
            expect(generated).toBeUndefined();
            expect(await fs.readdir(outputDir)).toEqual([]);

            // TWO HONESTY CONSTRAINTS ON WHAT THIS ASSERTION EVIDENCES, stated here rather than left implicit.
            //
            // First, the schema this ran against was created by the harness's own synchronisation rather than
            // by the migration: the sql.js initializer enables synchronisation while it populates, and the
            // MySQL and PostgreSQL initializers force it outright. So an empty result here evidences that THIS
            // STORY'S service and resolver work introduced no mapping change — which is exactly the claim
            // STORY-001-01-03 makes — and it does NOT by itself evidence that the checked-in migration matches
            // the entity declarations. That second claim belongs to the migration suite, which drives a
            // data-bearing up/down/up cycle against a schema the migration itself created.
            //
            // Second, the output directory is a temporary one outside the repository, so nothing is ever
            // written under this package's own migrations directory and `git status --porcelain` is clean after
            // a run whatever this assertion finds.
            expect(path.isAbsolute(outputDir)).toBe(true);
            expect(outputDir.startsWith(path.join(__dirname, '..'))).toBe(false);

            // The running server is unaffected by the generation pass, which is asserted rather than assumed
            // because that pass loads and then resets the platform's module-level configuration.
            const stillWorking = await seedList(customers[0], 'After the generation pass', [
                { productVariantId: 'T_1', quantity: 2 },
            ]);
            expect((await readStoredLines(stillWorking.listId)).length).toBe(1);
        });
    });
});
