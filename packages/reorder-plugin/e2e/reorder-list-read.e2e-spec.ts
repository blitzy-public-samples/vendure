/*
 * STORY-001-01-04 — "Read reorder lists through the Shop API".
 *
 * WHAT THIS FILE IS.
 *
 * The two published reads — `activeCustomerReorderLists` and `activeCustomerReorderList` — and every claim
 * STORY-001-01-04 makes about them. Its eight acceptance criteria run first, then the schema-delta
 * comparison, then the statement-count contracts, then the five scenarios of its section 7, then the one
 * empty-generation assertion this suite owns. Every criterion and every scenario is a NAMED test, so a red
 * result names the requirement rather than a helper.
 *
 * ATTRIBUTION OF EVERY OBLIGATION BELOW. `review_rules` was read in full for this run and returned exactly
 * "No user rules provided." NO user-specified rule governs this file, and no rule forced it into scope.
 * Every obligation discharged here is PROMPT-DERIVED (the Agent Action Plan, sections 0.7.1, 0.7.3 and
 * 0.7.6) or TICKET-DERIVED (STORY-001-01-04; FEATURE-001-01 sections 2.6.1, 2.6.1.1, 2.6.2 and 2.6.3;
 * EPIC-001 sections 6.5, 7.7 and 11.6) and is cited as such — never as a rule returned by that tool. The
 * absence of rules is not licence to lower the bar: the standard applied is the epic's own testing
 * contract, corroborated independently at EPIC-001 section 11.9.
 *
 * THE ISOLATION CONTRACT (EPIC-001 section 11.6.1), stated here because every exact count below rests on it.
 * One `TestServer`, initialised in `beforeAll` under the long setup timeout; `afterAll` calls
 * `await server.destroy()` UNCONDITIONALLY; `beforeEach` resets the capture instrument, empties both plugin
 * tables and authenticates the acting session; `afterEach` deletes every plugin-owned row addressing
 * `reorder_list_line` BEFORE `reorder_list` so a foreign key is never what fails the cleanup, and restores
 * every core row a test mutated but did not create. The harness's wholesale table clear is NEVER used
 * between tests: it synchronises the schema
 * (`packages/testing/src/data-population/clear-all-tables.ts`) and would drop the populated catalogue every
 * later case depends on. No test consumes the state a sibling criterion left behind — each builds its own
 * precondition by CALLING a fixture helper — which is what lets any test here run alone and the file run in
 * reverse order with the same result.
 *
 * DETERMINISM. An ordering assertion below NAMES the tie-break column the query it sent declares, and a
 * paginated assertion NAMES the page arguments it sent. Nothing here asserts an ordering the query does not
 * make total: the collection default is `createdAt` DESC then `id` DESC and the nested lines default is
 * `createdAt` ASC then `id` ASC, and the identifier half of each is what makes a page boundary stable when
 * rows share a timestamp — which they routinely do, the column having one-second resolution on the SQLite
 * family.
 *
 * STATEMENT-COUNT DISCIPLINE (EPIC-001 sections 7.7.1a and 11.6.2; FEATURE-001-01 sections 2.6.1.1, 2.6.2
 * and 2.6.3). Three observation boundaries are kept apart, and every assertion below says which one it is
 * making:
 *
 *   - PLUGIN-STATEMENT boundary — statements against this plugin's own two tables. This is the ONLY boundary
 *     at which an exact number is asserted, and every such assertion is an EQUALITY: never "at least", never
 *     "no more than".
 *   - SERVICE-CALL boundary — the named service method is spied and its CALLS are asserted. Never statements.
 *   - WHOLE-REQUEST boundary — NON-GROWTH ONLY across two input sizes, and never an exact total. A page of
 *     three lists and a page of six must issue the same number of statements against the two plugin tables;
 *     equality across the two sizes is the whole assertion.
 *
 * The instrument is the canonical one: a TypeORM logger OBJECT supplied on `dbConnectionOptions` through
 * `queryCaptureConfig`, reset in `beforeEach`, opened immediately before the operation under test and closed
 * the moment it returns, and filtered by table name with the filter NAMED at the assertion site. The boolean
 * `logging` flag and a spy on the repository accessor are both refused by that contract and neither appears
 * in this file. The counted form runs on sql.js, where statement text and count are deterministic; the
 * BEHAVIOUR each count evidences is asserted ungated and therefore runs on all four engine jobs.
 *
 * "Zero statements" is asserted only where zero is REACHABLE: against `reorder_list_line` on a read that
 * selects no nested collection, and against `reorder_list` on the over-limit refusal, which the platform
 * raises while building the query and therefore before any row is read. It is NEVER asserted against
 * `reorder_list` for an inaccessible single read — the server cannot discover a row's absence without
 * asking, so a zero-statement claim there is unpassable for a correct implementation and passable only by
 * one that answers without looking. That case asserts EXACTLY ONE scoped statement instead.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT CONTAIN. No assertion that any session holds `Permission.Owner` — it
 * is declared `assignable: false, internal: true` (`packages/core/src/common/constants.ts`), so no session
 * can hold it and EPIC-001 rulings R2 and R3 forbid the claim. No custom permission, registered or
 * asserted: this feature registers zero, and the published `Permission` enum stays at 97 members — a zero
 * delta this file ASSERTS rather than omits (ruling R15). No barrier or forced-interleaving claim: neither
 * read writes, and STORY-001-01-04's own section 7 rules the race category inapplicable, its staleness
 * scenario being a read observing a concurrent write rather than a race. No `it.only` or `describe.only`:
 * the shared configuration sets `allowOnly: true`, so one would pass CI in silence. No
 * `ReorderListListOptions` or `ReorderListLineListOptions` is declared or passed, and no `options` argument
 * is hand-written: the platform's list-options generator owns both, and this file asserts that ownership
 * from the introspected schema rather than participating in it.
 *
 * THE PUBLISHED WIDTHS ASSERTED HERE ARE THIS FEATURE'S OWN. The baseline read from the untouched
 * `schema-shop.json` is 19 root queries, 32 root mutations, 32 `ErrorCode` members, 31 `ErrorResult`
 * implementors and 97 `Permission` members; F-101 contributes 2 queries, 6 mutations, 4 error codes, 4
 * implementors and ZERO permissions, so the runtime transitions asserted below are 19→21, 32→38, 32→36,
 * 31→35 and 97→97. EPIC-001 section 6.5's cumulative ledger — 19→23, 32→42, `ErrorCode` 32→38,
 * `Permission` 97→101 — describes ALL EIGHT features of the epic and appears nowhere in this file.
 * Asserting those figures as this feature's delta is the exact defect ruling R15 exists to close.
 *
 * FOUR DIVERGENCES, RECORDED HERE RATHER THAN RESOLVED SILENTLY.
 *
 *  1. The e2e port base for this package is 3250 because `reorder-plugin` carries no offset entry in
 *     `e2e-common/test-config.ts`'s own table, and the per-file offset is that file's index within its own
 *     directory listing — so adding or removing a file in this directory renumbers the others. That is
 *     REPORTED here and not corrected there: `e2e-common/` is outside the boundary this work may edit. The
 *     symptom of a collision is `EADDRINUSE` from `NestApplication.listen` inside `beforeAll`, reported by
 *     vitest as one failed FILE with every test in it skipped — not as a failing assertion.
 *  2. STORY-001-01-04's AC-8 expects the two compiler fixtures to compile against types REGENERATED by the
 *     repository's codegen. That is unreachable by construction: `schema-shop.json` is never edited and
 *     never regenerated for this feature, and the introspection that produces it declares its own
 *     configuration with `plugins: [AdminUiPlugin]` and never reads a plugin's (AAP section 0.4.1.5). The
 *     faithful substitute, which the two fixtures implement, is a plugin-local union of the four added
 *     literals beside the platform's own generated `ErrorCode` enum.
 *  3. The same criterion asks for the two compiler runs to be declared as PACKAGE SCRIPTS. The AAP closes
 *     this package's manifest script set at seven (section 0.5.2.1) and that manifest belongs to another
 *     agent, so this suite invokes the pinned compiler directly instead. `packages/reorder-plugin/package.json`
 *     is not edited.
 *  4. FEATURE-001-01 section 2.6.1 row 11a presupposes a plugin-owned middleware refusing a `GET` or a wrong
 *     content type. AAP section 0.2.2.5 records that this plugin registers NO middleware and declares no
 *     `configure` method, so there is nothing to assert; no such assertion is written and the divergence is
 *     recorded here rather than satisfied by testing the platform's own transport.
 */
import { LanguageCode } from '@vendure/common/lib/generated-shop-types';
import { generateMigration, mergeConfig, ProductVariant, TransactionalConnection } from '@vendure/core';
import { createTestEnvironment, E2E_DEFAULT_CHANNEL_TOKEN, SimpleGraphQLClient } from '@vendure/testing';
import { execFileSync } from 'child_process';
import fs from 'fs-extra';
import { DocumentNode, print } from 'graphql';
import gql from 'graphql-tag';
import os from 'os';
import path from 'path';
import { DataSource } from 'typeorm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { initialData } from '../../../e2e-common/e2e-initial-data';
import { TEST_SETUP_TIMEOUT_MS, testConfig } from '../../../e2e-common/test-config';
import { ReorderList, ReorderListLine, ReorderPlugin } from '../index';
import { shopApiExtensions } from '../src/api/api-extensions';
import { ReorderListService } from '../src/service/reorder-list.service';

import {
    isStatementCountEngine,
    queryCaptureConfig,
    QueryCaptureLogger,
    STATEMENT_COUNT_ENGINE_REASON,
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

// ═════════════════════════════════════════════════════════════════════════════════════════════════════
// The values this suite drives
// ═════════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * `maxListsPerCustomer` for this TEST DEPLOYMENT.
 *
 * Thirty rather than the shipped twenty-five, because AC-3(b) has to observe the collection read's
 * DEFAULT PAGE SIZE actually truncating a page — which needs more lists than that page size, and every one
 * of them created through the published mutation rather than smuggled past the bound with a direct insert.
 * Configuring a bound for a test deployment is not the same act as choosing a product default, and no
 * product default is invented here: the shipped defaults — 25 / 200 / 999 / 25 / 50 — are asserted by the
 * co-located unit specification `src/reorder.plugin.spec.ts`, which is where a claim about a DEFAULT belongs.
 */
const MAX_LISTS_PER_CUSTOMER = 30;

/** `maxLinesPerList`, at its declared default. No criterion here reaches it. */
const MAX_LINES_PER_LIST = 200;

/** `maxQuantityPerLine`, at its declared default. No criterion here reaches it. */
const MAX_QUANTITY_PER_LINE = 999;

/**
 * The collection read's default page size, at its DECLARED default, because AC-3(b) asserts this exact
 * number as the page ceiling a caller reaches by supplying no page size at all.
 */
const DEFAULT_LISTS_PAGE_SIZE = 25;

/** The nested `lines` default page size, at its DECLARED default, and asserted the same way. */
const DEFAULT_LINES_PAGE_SIZE = 50;

/**
 * The platform's own Shop list-query maximum, at its shipped default
 * (`packages/core/src/config/default-config.ts`).
 *
 * It is NOT overridden by this suite's configuration and `ignoreQueryLimits` is left false on every query,
 * which is what makes AC-3(a)'s refusal the platform's own rather than a local contrivance. Both plugin
 * defaults above are STRICTER than this number, which is the second-order check AAP section 0.8.3.3 records.
 */
const SHOP_LIST_QUERY_LIMIT = 100;

/** The parent table. Named as a constant because every table filter on the capture instrument names it. */
const LIST_TABLE = 'reorder_list';

/** The child table, addressed BEFORE {@link LIST_TABLE} in every cleanup. */
const LINE_TABLE = 'reorder_list_line';

/** Both plugin tables, child first, for the cleanup that runs after every test. */
const PLUGIN_TABLES_CHILD_FIRST = [LINE_TABLE, LIST_TABLE] as const;

/** The number of customers the seed creates. Two: AC-5 and AC-4 both need a second buyer to own a row. */
const SEEDED_CUSTOMER_COUNT = 2;

/** The password `populate-customers.ts` sets on every seeded customer. The only fixed credential here. */
const SEEDED_CUSTOMER_PASSWORD = 'test';

/** The code of the second real channel, created once through the Admin API. */
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

/** The four error results the same four codes are generated from. */
const FEATURE_ERROR_RESULTS = [
    'ReorderListLimitError',
    'ReorderListLineNotFoundError',
    'ReorderListNameConflictError',
    'ReorderListNotFoundError',
];

/** The two root queries this feature publishes. */
const FEATURE_ROOT_QUERIES = ['activeCustomerReorderList', 'activeCustomerReorderLists'];

/** The six root mutations this feature publishes. */
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

/**
 * A field name that would carry a monetary amount, a currency or a stock figure.
 *
 * AC-2's "no entry carries a price, currency or stock field" is discharged against the INTROSPECTED SCHEMA
 * rather than by observing that a payload happened not to contain one — a field absent from a response is
 * absent because it was not selected. The pattern is deliberately broad: this feature stores, returns and
 * compares no monetary value of any kind, so ANY match on a plugin-declared type is a finding.
 */
const MONETARY_OR_STOCK_FIELD = /price|money|amount|currency|tax|stock|inventory|saleable/i;

/** The SKU prefix every bare catalogue variant this suite creates carries, so cleanup can find them all. */
const BARE_VARIANT_SKU_PREFIX = 'REORDER-READ-BARE-';

/** The repository-relative path of the compiler project asserted to FAIL, for AC-8. */
const EXHAUSTIVE_TSCONFIG = 'tsconfig.error-code-exhaustive.json';

/** The repository-relative path of the compiler project asserted to SUCCEED, for AC-8. */
const DEFAULTED_TSCONFIG = 'tsconfig.error-code-defaulted.json';

/** The TypeScript version the root manifest pins EXACTLY. AC-8 asserts the resolved compiler is this one. */
const PINNED_TYPESCRIPT_VERSION = '5.8.2';

/** A generous budget for one compiler invocation. A control value for the spawn, not a claim about timing. */
const COMPILER_INVOCATION_TIMEOUT_MS = 240_000;

// ═════════════════════════════════════════════════════════════════════════════════════════════════════
// Documents this file owns
//
// NOT ONE of the eight reorder operations is re-declared below: `./graphql/reorder-definitions` is their
// single authority and every one of them is imported from it. What is declared here is the set of SHIPPED
// PLATFORM operations this suite drives to build and inspect its own fixtures — the seeded customers, the
// second real channel, the catalogue variants, the variant mutations two of the section 7 scenarios need,
// the shipped `activeCustomer` read AC-7 is about, and the introspection AC-7 and the schema-delta
// comparison read. None of those belongs in a module whose remit is this plugin's own contract.
//
// They are plain `graphql-tag` documents with hand-written result types, for the reason the shared module
// records: no typed-document artefact can exist for this plugin's surface, and mixing two idioms in one
// suite would be worse than using one.
// ═════════════════════════════════════════════════════════════════════════════════════════════════════

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

/** The channels that exist, with the two zone identifiers `CreateChannelInput` requires. */
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

/** Creates the second real channel whose token the channel-scope cases send. */
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

/** The seeded catalogue variants, in identifier order. The minimal product source ships exactly four. */
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
 * The introspection of the booted Shop API, shaped so that ONE code path can read both it and the untouched
 * `schema-shop.json` snapshot.
 *
 * The root types are reached through `types` by name rather than through `queryType { fields }`, because the
 * standard introspection query the snapshot was produced with selects only `queryType { name }` and puts
 * every field under `types`. Reading both sides the same way is what makes the comparison a comparison
 * rather than two different readings that happen to agree.
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

// ═════════════════════════════════════════════════════════════════════════════════════════════════════
// Result shapes for the documents above, and for the introspection comparison
// ═════════════════════════════════════════════════════════════════════════════════════════════════════

/** A seeded customer as the Admin API returns it. */
interface SeededCustomer {
    id: ReorderApiId;
    emailAddress: string;
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
    createChannel: { __typename: string; id?: ReorderApiId; code?: string; token?: string };
}

/** A catalogue variant as the Admin API returns it. */
interface AdminProductVariant {
    id: ReorderApiId;
    name: string;
    sku: string;
    enabled: boolean;
    price: number;
}

interface GetVariantsQuery {
    productVariants: { totalItems: number; items: AdminProductVariant[] };
}

interface UpdateVariantsMutation {
    updateProductVariants: Array<{ id: ReorderApiId; enabled: boolean; price: number }>;
}

/** The shipped `activeCustomer` payload, at the width AC-7 selects. */
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

/** One node of an introspected type reference, to the depth {@link SHOP_SCHEMA_SHAPE} unwraps. */
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

/** One entry of a GraphQL response's top-level `errors` array, at the granularity this suite asserts. */
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

/** A seeded list together with the identifiers of the lines seeded onto it, in insertion order. */
interface SeededList {
    id: string;
    name: string;
    lineIds: string[];
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════
// Introspection helpers
//
// Every one of them is a pure function over an {@link IntrospectedSchema}, so the SAME code reads the live
// schema and the checked-in snapshot. That is the whole reason they exist: a comparison written twice is two
// readings that can disagree about what "the same signature" means.
// ═════════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Renders a type reference to its SDL spelling — `String!`, `[ReorderList!]!`, `ID`.
 *
 * One string carries the return type AND its nullability AND its list depth, which is exactly what
 * "byte-identical in return type and nullability" has to compare. Comparing the nested objects instead would
 * also compare `description` and `isDeprecated`, which the snapshot carries and this suite's introspection
 * does not select — so a documentation edit that changed no contract would fail the comparison.
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

/** The named type, or `undefined`. Used where ABSENCE is itself the thing being asserted. */
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

/** One named field of a named type, or `undefined` where the type or the field is absent. */
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

// ═════════════════════════════════════════════════════════════════════════════════════════════════════
// The instrument, the configuration and the environment
// ═════════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * The canonical query-capture instrument, installed once for the life of the server.
 *
 * It is merged onto `dbConnectionOptions.logger` by {@link queryCaptureConfig}, which is the only mechanism
 * EPIC-001 section 11.6.2 and FEATURE-001-01 section 2.6.1.1 accept. `mergeConfig` assigns a class instance
 * BY REFERENCE, so `capture.reset()` in `beforeEach` reaches the very object TypeORM holds. The window starts
 * closed on a fresh instance, so installing it for the whole run costs nothing until a test opens it.
 */
const capture = new QueryCaptureLogger();

/**
 * `testConfig()` is called HERE, at this file's top level, and nowhere else.
 *
 * Its port is `getBasePort() + <index of this file in its own directory listing>`, computed from the CALLING
 * file, so a call made from a helper under `fixtures/` would index against that directory and could collide
 * two suites on one port. No port is hard-coded anywhere in this file; the Shop API URL below is derived from
 * the very configuration the server was built from.
 *
 * `importExportOptions.importAssetsDir` is overridden because the shared configuration points it at this
 * package's own `e2e/fixtures/assets`, which this package does not ship and may not add; the seeded
 * catalogue's assets live in core's fixtures, and the shipped cross-package precedent for reaching them is
 * `packages/dashboard/e2e/global-setup.ts`.
 *
 * `apiOptions.shopListQueryLimit` is deliberately NOT overridden, so AC-3(a)'s refusal is the platform's own
 * at its shipped default of {@link SHOP_LIST_QUERY_LIMIT}.
 */
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

    /** The two seeded buyers. `[0]` acts throughout; `[1]` is the second customer AC-4 and AC-5 need. */
    let seededCustomers: SeededCustomer[];

    /** The customer every test acts as. */
    let actingCustomer: SeededCustomer;

    /** The second customer, whose rows this caller must never be able to produce. */
    let otherCustomer: SeededCustomer;

    /** The acting customer's decoded database identifier, for every raw comparison and capture predicate. */
    let actingCustomerDbId: number;

    /** The second customer's decoded database identifier. */
    let otherCustomerDbId: number;

    /** The default channel's decoded database identifier. */
    let defaultChannelDbId: number;

    /** The four seeded catalogue variants, in identifier order. */
    let catalogueVariants: AdminProductVariant[];

    /** The live Shop schema, introspected once from the booted server carrying the plugin. */
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

    // -----------------------------------------------------------------------------------------------
    // Identifiers, sessions and raw transport
    // -----------------------------------------------------------------------------------------------

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

    /** Authenticates the primary Shop client as one seeded buyer on the default channel. */
    async function authenticateAs(customer: SeededCustomer): Promise<void> {
        shopClient.setChannelToken(E2E_DEFAULT_CHANNEL_TOKEN);
        await shopClient.asUserWithCredentials(customer.emailAddress, SEEDED_CUSTOMER_PASSWORD);
        // Set again AFTER the login: the shipped client adopts the token of the single channel a login
        // reports, and this suite creates a second channel, so the token is re-asserted rather than assumed.
        shopClient.setChannelToken(E2E_DEFAULT_CHANNEL_TOKEN);
    }

    /**
     * Issues one Shop request and returns its WHOLE response envelope.
     *
     * The shipped client cannot serve the two criteria that compare envelopes: it returns `data` alone on
     * success and throws a `ClientError` when a response carries `errors`, so "these six responses are
     * indistinguishable in every observable respect" and "no error entry of any kind" are both inexpressible
     * through it. `shopClient.fetch` is the shipped escape hatch and carries the session and channel headers,
     * so the request below is the same request in every respect except that its envelope is returned intact.
     */
    async function rawShopRequest(
        document: DocumentNode,
        variables?: Record<string, unknown>,
        queryParams?: Record<string, string>,
    ): Promise<GraphQlEnvelope> {
        const suffix = queryParams
            ? `?${Object.entries(queryParams)
                  .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
                  .join('&')}`
            : '';
        const response = await shopClient.fetch(`${shopApiUrl}${suffix}`, {
            method: 'POST',
            body: JSON.stringify({ query: print(document), variables }),
        });
        return (await response.json()) as GraphQlEnvelope;
    }

    // -----------------------------------------------------------------------------------------------
    // Fixture helpers. Every one is a FUNCTION each test calls from its own body — never a leftover a
    // sibling criterion built (EPIC-001 section 11.6.1).
    // -----------------------------------------------------------------------------------------------

    /**
     * Seeds one list, optionally with lines, through the PUBLISHED mutations, and returns its identifiers.
     *
     * Line identifiers are collected from each add's own response rather than from a later read, so the order
     * they are returned in is the order they were created in — which is what makes "the first of those two
     * lines" a fact rather than an assumption, the nested default sort being ascending by creation timestamp
     * with the identifier as its tie-break.
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

    /** Seeds `count` lists named from the caller's prefix, each holding the given number of lines. */
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
     *
     * The equal-timestamp pagination case needs more rows sharing a timestamp than fit one page, and it must
     * be certain they share it rather than hoping two creations landed in the same clock second. Writing the
     * column directly is the only way to be certain; it is a plugin-owned column on rows this test created,
     * so nothing outside the plugin is disturbed.
     */
    async function setEqualCreatedAt(listIds: string[], when: Date): Promise<void> {
        await dataSource
            .createQueryBuilder()
            .update(ReorderList)
            .set({ createdAt: when })
            .whereInIds(listIds.map(decodeId))
            .execute();
    }

    /** Reads one stored `reorder_list` row, or `null` when it is gone. */
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
     * Restores every catalogue variant to the state the harness populated: enabled, and not soft-deleted.
     *
     * Idempotent and unconditional, so a test that failed part-way through cannot leave the shared catalogue
     * altered for the next one. Prices are restored by their own queued action, being per-variant values.
     */
    async function restoreAllVariants(): Promise<void> {
        await dataSource
            .createQueryBuilder()
            .update(ProductVariant)
            .set({ enabled: true, deletedAt: null })
            .where('1 = 1')
            .execute();
    }

    /**
     * Creates one bare catalogue variant directly through the repository, and returns its stored identifier.
     *
     * TWO CASES NEED A VARIANT THIS TEST ITSELF CREATED, and both are the reason this exists rather than
     * reaching for a seeded one.
     *
     * The `lineCount` repair has to be provoked by removing line rows UNDERNEATH the plugin, which the
     * cascade from `product_variant` does — `ReorderListLine.productVariantId` declares `onDelete: 'CASCADE'`.
     * A seeded variant cannot be hard-deleted: other core tables reference it without cascading, so the
     * statement is refused by a foreign key. A variant created here has no such references, so deleting it
     * removes exactly the line rows that point at it. EPIC-001 section 11.6.1's alternative is explicit —
     * either restore the core row or structure the test so the deleted row is one it created — and this is
     * that second form, which is also the only one that leaves the shared catalogue untouched.
     *
     * The nested page-size default needs more lines on ONE list than that default, and a line is unique per
     * `(list, variant)`, so it needs that many distinct variants. The seeded catalogue ships four.
     *
     * The row is deliberately minimal: no channel assignment, no price and no translation, so it is not
     * resolvable in the active channel and its `productVariant` field answers `null`. That costs nothing here
     * — no assertion below is about the variant object of a bare variant — and it keeps the fixture to one
     * statement.
     */
    async function createBareVariant(index: number): Promise<number> {
        const saved = await dataSource.getRepository(ProductVariant).save(
            new ProductVariant({
                enabled: true,
                sku: `${BARE_VARIANT_SKU_PREFIX}${index}`,
                productId: decodeId(catalogueVariants[0].id) as never,
                outOfStockThreshold: 0,
                useGlobalOutOfStockThreshold: true,
            }),
        );
        const storedId = Number(saved.id);
        expect(Number.isInteger(storedId), 'The bare variant was saved without a usable identifier').toBe(
            true,
        );
        return storedId;
    }

    /** Hard-deletes one variant row, so the cascade removes the line rows pointing at it. */
    async function hardDeleteVariant(variantDbId: number): Promise<void> {
        await dataSource.getRepository(ProductVariant).delete({ id: variantDbId as never });
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
                reorderListId: decodeId(listId) as never,
                productVariantId: variantDbId as never,
                quantity,
            })
            .execute();
    }

    /**
     * The failure message every COUNTED assertion carries: the gating reason, then the whole captured window.
     *
     * It exists so that a counted failure is self-explaining in two directions at once. The captured window
     * names the statements that were actually issued, which is what a reader needs in order to see whether the
     * number is wrong or the implementation is; and the gating reason states why the assertion is engine-scoped
     * in the first place, so a reader who meets it on the wrong engine is not left to infer that from the
     * absence of a failure elsewhere.
     */
    function countedDiagnostic(): string {
        return `Counted assertions are scoped to one engine: ${STATEMENT_COUNT_ENGINE_REASON}\n${capture.format()}`;
    }

    /** Reads the live Shop schema. Called once in `beforeAll`; the result is shared, never mutated. */
    async function introspectLiveSchema(): Promise<IntrospectedSchema> {
        const introspected = await shopClient.query<ShopSchemaShapeQuery>(SHOP_SCHEMA_SHAPE);
        return introspected.__schema;
    }

    /**
     * Runs the WORKSPACE-PINNED TypeScript compiler over one of the two compiler projects and returns its
     * exit status together with everything it wrote.
     *
     * Three rules, each closing a way this evidence could be faked. It runs `node node_modules/typescript/bin/tsc`
     * and never `npx`, which may resolve or fetch a compiler other than the one the root manifest pins exactly.
     * It names the PROJECT rather than a file, because a bare `tsc --noEmit` compiles whatever the nearest
     * ambient configuration includes rather than the single file under test. And every path is resolved from
     * `__dirname`, so the result cannot depend on the working directory vitest happened to start in.
     */
    function runPinnedCompiler(projectFileName: string): { status: number | null; output: string } {
        const repositoryRoot = path.join(__dirname, '../../..');
        const compiler = path.join(repositoryRoot, 'node_modules/typescript/bin/tsc');
        const project = path.join(__dirname, projectFileName);
        try {
            const stdout = execFileSync(process.execPath, [compiler, '--project', project, '--noEmit'], {
                cwd: repositoryRoot,
                encoding: 'utf-8',
                timeout: COMPILER_INVOCATION_TIMEOUT_MS,
            });
            return { status: 0, output: stdout };
        } catch (err: unknown) {
            // `execFileSync` throws on a non-zero exit and carries the status and both streams on the error,
            // which is the ONLY place the diagnostic text lives for the half of the pair that must fail.
            const failure = err as {
                status?: number | null;
                stdout?: string | Buffer;
                stderr?: string | Buffer;
            };
            return {
                status: failure.status ?? null,
                output: `${String(failure.stdout ?? '')}${String(failure.stderr ?? '')}`,
            };
        }
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

        // THE SECOND REAL CHANNEL, created once because it is immutable shared setup rather than any one
        // test's fixture: no test below mutates it, and the channel-scope cases SEND its real token rather
        // than mutating a variable.
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
                    // Every value below is READ OFF the default channel rather than chosen here, so the second
                    // channel differs from the first along exactly one dimension: its identity.
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

        const { productVariants } = await adminClient.query<GetVariantsQuery>(GET_VARIANTS_FOR_REORDER_READ);
        expect(
            productVariants.items.length,
            'The seeded catalogue produced fewer than the four variants this suite draws its lines from',
        ).toBeGreaterThanOrEqual(4);
        catalogueVariants = productVariants.items;

        secondShopClient = new SimpleGraphQLClient(serverConfig, shopApiUrl);

        // Introspected ONCE, from the booted server carrying the plugin. Comparing a runtime schema against
        // the untouched snapshot is the only correct way to evidence the delta: the introspection that
        // produces `schema-shop.json` declares its own configuration and never reads a plugin's, so the
        // snapshot cannot move and must be neither edited nor regenerated (AAP section 0.4.1.5).
        liveSchema = await introspectLiveSchema();

        const snapshotPath = path.join(__dirname, '../../../schema-shop.json');
        const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf-8')) as {
            data: ShopSchemaShapeQuery;
        };
        snapshotSchema = snapshot.data.__schema;
    }, TEST_SETUP_TIMEOUT_MS);

    afterAll(async () => {
        // UNCONDITIONALLY, per EPIC-001 section 11.6.1: a suite that destroys its server only on the success
        // path leaks a listening port into the next file.
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
        // Core rows this test mutated are restored FIRST and in reverse order, so a later mutation layered on
        // an earlier one unwinds in the order it was applied.
        while (restoreActions.length > 0) {
            const restore = restoreActions.pop();
            if (restore) {
                await restore();
            }
        }
        await restoreAllVariants();
        // The bare variants this test created are removed BEFORE the plugin rows, because removing them
        // cascades whatever lines still point at them and a later foreign key failure would be reported as a
        // cleanup error rather than as the deliberate cascade it is.
        await deleteBareVariants();
        await deleteAllPluginRows();
        for (const directory of temporaryDirectories) {
            await fs.remove(directory);
        }
        temporaryDirectories = [];
        // Every spy this test installed on the service is removed, so a SERVICE-CALL assertion can never
        // observe a sibling's spy or leave a wrapper on a singleton the next test uses.
        vi.restoreAllMocks();
        capture.reset();
        capture.disable();
        shopClient.setChannelToken(E2E_DEFAULT_CHANNEL_TOKEN);
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

    // ═══════════════════════════════════════════════════════════════════════════════════════════════
    // AC-1 — the collection read with no arguments
    // ═══════════════════════════════════════════════════════════════════════════════════════════════

    describe('AC-1: activeCustomerReorderLists returns the caller\u2019s own lists, newest first', () => {
        it('returns both lists newest first, ordered by createdAt DESC then id DESC, and counts only its own', async () => {
            // The ORDER OF CREATION is the fixture: the first list created must come back SECOND.
            const first = await seedList(FIRST_LIST_NAME);
            const second = await seedList(SECOND_LIST_NAME);
            const foreign = await seedListForOtherCustomer('Another buyer\u2019s list');

            // No arguments at all — the request an unpaged client actually sends.
            const { activeCustomerReorderLists } = await shopClient.query<GetActiveCustomerReorderListsQuery>(
                GET_ACTIVE_CUSTOMER_REORDER_LISTS,
            );

            // The call SUCCEEDS. The session holds only `Permission.Authenticated`; the gate marks the request
            // context and the service-layer ownership predicate is what actually scopes the answer.
            expect(activeCustomerReorderLists.totalItems).toBe(2);
            expect(activeCustomerReorderLists.items).toHaveLength(2);

            // The declared default sort is `createdAt` DESC and then `id` DESC — and the identifier half is
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

            // The second customer's list is absent from `items` AND uncounted in `totalItems`. Both halves
            // matter: a page that filtered the row out of `items` while counting it in the total would still
            // disclose that the row exists.
            expect(activeCustomerReorderLists.items.map(entry => String(entry.id))).not.toContain(foreign.id);

            // Every entry reports its viewer access through the NESTED object, and the capability list is
            // empty because no grant row can exist until list sharing ships.
            for (const entry of activeCustomerReorderLists.items) {
                expect(entry.viewerAccess.access).toBe('OWNED');
                expect(entry.viewerAccess.grantedCapabilities).toEqual([]);
                // A created list is empty, so its stored counter is exactly zero rather than merely falsy.
                expect(entry.lineCount).toBe(0);
            }
        });

        it('returns each name exactly as stored and identically under a second languageCode', async () => {
            // A name markup-significant enough that any escaping, stripping or entity-encoding would show.
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

            // Byte-for-byte as submitted, in both languages. A list name is the buyer's own string and carries
            // no translation of any kind, so the second language cannot change it.
            expect(inChannelDefault.activeCustomerReorderLists.items[0].name).toBe(hostileName);
            expect(inSecondLanguage.activeCustomerReorderLists.items[0].name).toBe(hostileName);
            // And it is the stored value rather than a rendering of it.
            expect((await readStoredList(seeded.id))?.name).toBe(hostileName);
            // The rest of the entry is language-invariant too, which is what "untranslated" means here.
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

            // THE PAGE ARGUMENTS THIS ASSERTION SENT, named: take 4 / skip 0, then take 4 / skip 4, with the
            // total order stated explicitly as `createdAt` DESC then `id` DESC — the same order the read
            // applies by default, asked for by name so the assertion cannot be about an ordering the query
            // never declared.
            const pageOne = await shopClient.query<
                GetActiveCustomerReorderListsPaginatedQuery,
                GetActiveCustomerReorderListsPaginatedQueryVariables
            >(GET_ACTIVE_CUSTOMER_REORDER_LISTS_PAGINATED, {
                take: 4,
                skip: 0,
                createdAtSort: 'DESC' as never,
                idSort: 'DESC' as never,
            });
            const pageTwo = await shopClient.query<
                GetActiveCustomerReorderListsPaginatedQuery,
                GetActiveCustomerReorderListsPaginatedQueryVariables
            >(GET_ACTIVE_CUSTOMER_REORDER_LISTS_PAGINATED, {
                take: 4,
                skip: 4,
                createdAtSort: 'DESC' as never,
                idSort: 'DESC' as never,
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

    // ═══════════════════════════════════════════════════════════════════════════════════════════════
    // AC-2 — the single-list read
    // ═══════════════════════════════════════════════════════════════════════════════════════════════

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
            // The STORED counter, arriving with the row. Exactly two, asserted as a number.
            expect(list.lineCount).toBe(2);
            // Read through the nested object, never as a bare scalar.
            expect(list.viewerAccess.access).toBe('OWNED');
            expect(list.viewerAccess.grantedCapabilities).toEqual([]);

            // `lines` is itself a paginated list, and the `options` argument on it is supplied by the
            // platform's generator rather than declared by this plugin — this document passes none, so the
            // configured nested default applies.
            expect(list.lines.totalItems).toBe(2);
            expect(list.lines.items).toHaveLength(2);
            // ASCENDING by `createdAt` with `id` ASC appended: the two lines were added in this order, so the
            // quantities are exactly 2 then 3 and the identifiers ascend.
            expect(list.lines.items.map(line => line.quantity)).toEqual([2, 3]);
            expect(decodeId(list.lines.items[1].id)).toBeGreaterThan(decodeId(list.lines.items[0].id));
            expect(list.lines.items.map(line => String(line.id))).toEqual(seeded.lineIds);

            // Each line names its variant, and each variant's name resolves against the request language
            // through the platform's own catalogue path.
            expect(String(list.lines.items[0].productVariantId)).toBe(String(catalogueVariants[0].id));
            expect(String(list.lines.items[1].productVariantId)).toBe(String(catalogueVariants[1].id));
            expect(list.lines.items[0].productVariant?.name).toBe(catalogueVariants[0].name);
            expect(list.lines.items[1].productVariant?.name).toBe(catalogueVariants[1].name);
        });

        it('publishes no price, currency or stock field on any type this feature declares', () => {
            // Discharged against the INTROSPECTED SCHEMA rather than by observing a payload that happened not
            // to carry one: a field absent from a response is absent because it was not selected, which is not
            // evidence about the contract. `ReorderListLine.productVariant` resolves to the PLATFORM's own
            // `ProductVariant` type, whose monetary fields are the platform's to publish — so the types checked
            // here are the ones this feature declares, and the relation field itself carries no such name.
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

    // ═══════════════════════════════════════════════════════════════════════════════════════════════
    // AC-3 — the page-size bounds, on both the root collection and the nested one
    // ═══════════════════════════════════════════════════════════════════════════════════════════════

    describe('AC-3: the configured page bounds hold on both reads', () => {
        it('refuses a take one greater than the Shop limit with the platform\u2019s own input error, before any row is read', async () => {
            await seedLists('Over limit', 3);

            capture.reset();
            const envelope = await capture.capture(() =>
                rawShopRequest(GET_ACTIVE_CUSTOMER_REORDER_LISTS_PAGINATED, {
                    take: SHOP_LIST_QUERY_LIMIT + 1,
                }),
            );

            // The PLATFORM's refusal, not a plugin-local one: `ListQueryBuilder` raises `UserInputError` with
            // the message key `error.list-query-limit-exceeded`, which the platform's own English catalogue
            // renders as a sentence naming the breached limit. The key itself never reaches the wire — the
            // resolved message does — so the assertion names both: the code exactly, and the limit inside the
            // rendered text.
            expect(envelope.errors, JSON.stringify(envelope)).toBeDefined();
            expect(envelope.errors).toHaveLength(1);
            expect(envelope.errors?.[0].extensions?.code).toBe('USER_INPUT_ERROR');
            expect(envelope.errors?.[0].message).toContain(String(SHOP_LIST_QUERY_LIMIT));
            expect(envelope.errors?.[0].path).toEqual(['activeCustomerReorderLists']);

            // NO PARTIAL PAGE. The field is non-null, so the error nulls the whole `data` rather than handing
            // back a truncated collection.
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
                expect(capture.writesFor(LIST_TABLE), countedDiagnostic()).toHaveLength(0);
            }
        });

        it('applies the configured default page size of 25 where the caller supplies no options at all', async () => {
            // MORE lists than the configured default, so the default is observed TRUNCATING rather than merely
            // being larger than the fixture. Every one is created through the published mutation, which is why
            // this suite configures `maxListsPerCustomer` above the default for its test deployment.
            const seeded = await seedLists('Default page', DEFAULT_LISTS_PAGE_SIZE + 1);
            expect(seeded).toHaveLength(DEFAULT_LISTS_PAGE_SIZE + 1);

            const { activeCustomerReorderLists } = await shopClient.query<GetActiveCustomerReorderListsQuery>(
                GET_ACTIVE_CUSTOMER_REORDER_LISTS,
            );

            // At most the platform's configured limit, and SPECIFICALLY at most the plugin's own stricter
            // default — asserted as the exact number, since the fixture holds one more row than that default.
            expect(activeCustomerReorderLists.items.length).toBe(DEFAULT_LISTS_PAGE_SIZE);
            expect(activeCustomerReorderLists.items.length).toBeLessThanOrEqual(SHOP_LIST_QUERY_LIMIT);
            // The page was truncated, not the data: the total still counts every row.
            expect(activeCustomerReorderLists.totalItems).toBe(DEFAULT_LISTS_PAGE_SIZE + 1);
        });

        it('applies the configured default nested page size of 50 where the caller windows no lines', async () => {
            const seeded = await seedList('Default nested page');
            // ONE MORE LINE THAN THE NESTED DEFAULT, each on its own variant because a line is unique per
            // `(list, variant)` and the seeded catalogue ships four. The rows are inserted directly and the
            // counter is set to match, so the fixture's starting state is stated rather than inferred — and
            // `lineCount` therefore agrees with reality before the read, which keeps this case about the page
            // size and not about the repair.
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

            // THREE DISTINCT FACTS, not one number under three names: the stored counter, the collection total
            // and the length of the page the caller was given. The first two agree here and the third differs,
            // which is exactly what a summary counter is for.
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
            // The refusal is attributed to the NESTED field, which is what proves the bound is enforced on the
            // nested collection rather than only on the root one.
            expect(envelope.errors?.[0].path).toEqual(['activeCustomerReorderList', 'lines']);
            // And no partial nested page reaches the client: `lines` is non-null, so its error nulls the
            // nullable parent field rather than returning a list with some of its rows.
            expect(envelope.data?.activeCustomerReorderList).toBeNull();
        });
    });

    // ═══════════════════════════════════════════════════════════════════════════════════════════════
    // AC-4 — the eight-call non-disclosure matrix
    // ═══════════════════════════════════════════════════════════════════════════════════════════════

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

            // (i) an identifier matching no row, and (ii) the second customer's list, both under the acting
            // session on the default channel.
            const unknown = await bothArgumentForms(UNKNOWN_LIST_ID);
            const otherCustomers = await bothArgumentForms(foreign.id);
            // (iv) a malformed identifier the `ID` scalar accepts as a string, so it reaches the resolver.
            const malformed = await bothArgumentForms(MALFORMED_LIST_ID);

            // (iii) the caller's OWN list, read under the SECOND CHANNEL's real token. The token is sent
            // rather than a variable mutated, and the session is unchanged: the row is inaccessible because it
            // belongs to another channel, which is a different reason from every other case and must produce
            // the same answer.
            shopClient.setChannelToken(SECOND_CHANNEL_TOKEN);
            const otherChannel = await bothArgumentForms(own.id);
            shopClient.setChannelToken(E2E_DEFAULT_CHANNEL_TOKEN);

            const sixNulls = [...unknown, ...otherCustomers, ...otherChannel];
            const expectedEnvelope: GraphQlEnvelope = { data: { activeCustomerReorderList: null } };

            // DEEP EQUALITY BETWEEN THE WHOLE ENVELOPES, and that is the assertion rather than six independent
            // null checks. A response carrying a warning extension on one path, or an `errors` array on
            // another, satisfies "each is null" while telling a caller which identifiers exist — so what is
            // compared here is every observable part of the response: the presence and value of `data`, the
            // ABSENCE of any `errors` key, and the absence of any `extensions` key.
            for (const envelope of sixNulls) {
                expect(envelope).toEqual(expectedEnvelope);
                expect(Object.keys(envelope).sort()).toEqual(['data']);
                expect(envelope.errors).toBeUndefined();
                expect(envelope.extensions).toBeUndefined();
            }
            // Equal to ONE ANOTHER as well as to the unknown-identifier answer, stated as its own assertion so
            // a future change that made one path differ fails here rather than silently.
            for (const envelope of sixNulls) {
                expect(envelope).toEqual(sixNulls[0]);
                expect(envelope).toEqual(unknown[0]);
            }

            // THE MALFORMED IDENTIFIER resolves to exactly `null` INSIDE THE RESOLVER rather than being
            // refused at schema validation: `ID` accepts a string, so the request is valid and the answer is
            // the same normalised null. A validation failure would have produced a `GRAPHQL_VALIDATION_FAILED`
            // entry and no `data` key at all, which is what the absence of `errors` here rules out.
            for (const envelope of malformed) {
                expect(envelope).toEqual(expectedEnvelope);
                expect(envelope.errors).toBeUndefined();
            }

            // And `includeShared: true` changed NONE of the eight, which is the interim truth while no share
            // row can exist: the set the non-default value asks for is empty by construction, so the value is
            // accepted rather than refused and answers identically.
            expect(unknown[1]).toEqual(unknown[0]);
            expect(otherCustomers[1]).toEqual(otherCustomers[0]);
            expect(otherChannel[1]).toEqual(otherChannel[0]);
            expect(malformed[1]).toEqual(malformed[0]);

            // The control: the acting caller's own list IS returned on its own channel, so the six nulls above
            // are a scoping result rather than a read that never worked.
            const accessible = await rawShopRequest(GET_ACTIVE_CUSTOMER_REORDER_LIST, { id: own.id });
            expect((accessible.data?.activeCustomerReorderList as { id: string } | null)?.id).toBe(own.id);
        });
    });

    // ═══════════════════════════════════════════════════════════════════════════════════════════════
    // AC-5 — the unauthenticated and cross-customer collection reads
    //
    // A READ answers with an empty collection or a null and NEVER with an error (ruling R14, the shipped read
    // convention). A WRITE is the opposite case and propagates `FORBIDDEN`; that is asserted by the create,
    // add-item and mutate suites, which own the six mutations, and deliberately not here.
    // ═══════════════════════════════════════════════════════════════════════════════════════════════

    describe('AC-5: a caller with no resolvable scope receives an empty page rather than an error', () => {
        it('returns totalItems 0 and an empty items collection with no error entry for an unauthenticated call', async () => {
            await seedList('Owned while authenticated');

            await shopClient.asAnonymousUser();
            shopClient.setChannelToken(E2E_DEFAULT_CHANNEL_TOKEN);
            const envelope = await rawShopRequest(GET_ACTIVE_CUSTOMER_REORDER_LISTS);

            // The whole envelope, because "no error entry of any kind" is a claim about the envelope and not
            // about the field.
            expect(envelope.errors, JSON.stringify(envelope)).toBeUndefined();
            expect(envelope.data).toEqual({ activeCustomerReorderLists: { totalItems: 0, items: [] } });

            // The single-list read takes the same convention: one indistinguishable null, no error.
            const single = await rawShopRequest(GET_ACTIVE_CUSTOMER_REORDER_LIST, { id: UNKNOWN_LIST_ID });
            expect(single.errors).toBeUndefined();
            expect(single.data).toEqual({ activeCustomerReorderList: null });
        });

        it('returns totalItems 0 for the second customer and never an entry belonging to the first', async () => {
            const first = await seedList('First customer\u2019s list');
            const second = await seedList('First customer\u2019s second list');

            await authenticateAs(otherCustomer);
            const envelope = await rawShopRequest(GET_ACTIVE_CUSTOMER_REORDER_LISTS);

            // The second customer's call SUCCEEDS — it is authenticated and its scope resolves — and finds
            // nothing, because it owns nothing.
            expect(envelope.errors, JSON.stringify(envelope)).toBeUndefined();
            const page = envelope.data?.activeCustomerReorderLists as {
                totalItems: number;
                items: ReorderListFieldsShape[];
            };
            expect(page.totalItems).toBe(0);
            expect(page.items).toEqual([]);
            expect(page.items.map(entry => String(entry.id))).not.toContain(first.id);
            expect(page.items.map(entry => String(entry.id))).not.toContain(second.id);

            // And the first customer's rows are still there, which is what makes the empty page above a
            // scoping result rather than a fixture that never existed.
            await authenticateAs(actingCustomer);
            const ownPage = await shopClient.query<GetActiveCustomerReorderListsQuery>(
                GET_ACTIVE_CUSTOMER_REORDER_LISTS,
            );
            expect(ownPage.activeCustomerReorderLists.totalItems).toBe(2);
        });
    });

    // ═══════════════════════════════════════════════════════════════════════════════════════════════
    // AC-6 — `includeShared` at both values, on BOTH reads
    // ═══════════════════════════════════════════════════════════════════════════════════════════════

    describe('AC-6: includeShared is accepted at both values and answers identically', () => {
        it('returns the same collection page under an omitted, a false and a true includeShared', async () => {
            await seedList(FIRST_LIST_NAME, [{ productVariantId: catalogueVariants[0].id, quantity: 2 }]);
            await seedList(SECOND_LIST_NAME, [{ productVariantId: catalogueVariants[1].id, quantity: 3 }]);

            // RECORDED BEFORE the second call is issued, so the comparison is between two observations rather
            // than between one observation and a re-reading of the same object.
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

            // THE WHOLE PAYLOAD, not the count alone: the same two entries, in the same order, matched by
            // identifier AND by name, each `OWNED` with an empty capability list.
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

            // FIELD FOR FIELD across the whole payload, the two documents declaring identical selection sets
            // precisely so that this comparison is meaningful.
            expect(explicitlyFalse.activeCustomerReorderList).toEqual(omitted.activeCustomerReorderList);
            expect(explicitlyTrue.activeCustomerReorderList).toEqual(omitted.activeCustomerReorderList);
            expect(explicitlyTrue.activeCustomerReorderList).not.toBeNull();
            // The non-default value is ACCEPTED rather than refused, which is asserted as the absence of any
            // error on a value that returns a payload: a refusal would have thrown before this line.
            expect(explicitlyTrue.activeCustomerReorderList?.viewerAccess.access).toBe('OWNED');
            expect(explicitlyTrue.activeCustomerReorderList?.lines.totalItems).toBe(2);
        });
    });

    // ═══════════════════════════════════════════════════════════════════════════════════════════════
    // AC-7 — the shipped Shop operations are unchanged
    // ═══════════════════════════════════════════════════════════════════════════════════════════════

    describe('AC-7: the existing Shop API is untouched by this plugin', () => {
        it('returns the same activeCustomer with the same fields and the same customFields value', async () => {
            const { activeCustomer } = await shopClient.query<GetActiveCustomerQuery>(
                GET_ACTIVE_CUSTOMER_FOR_REORDER_READ,
            );

            expect(activeCustomer).not.toBeNull();
            const customer = activeCustomer as ActiveCustomerShape;
            expect(String(customer.id)).toBe(String(actingCustomer.id));
            expect(customer.emailAddress).toBe(actingCustomer.emailAddress);
            // Every selected member is present, so the type neither lost a field the selection names nor
            // renamed one — a missing field would have failed validation before the resolver ran.
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
            // THE CUSTOM FIELDS VALUE IS UNCHANGED. This feature registers ZERO custom fields on any core
            // entity (ruling R1) and declares no `configuration` hook, so `Customer.customFields` carries
            // nothing this plugin put there. `null` is what the platform returns for an entity with no
            // registered custom field, and an empty object is what it returns once a config declares one —
            // either is acceptable evidence that none of this plugin's members appear, so the assertion is on
            // the ABSENCE of any reorder-shaped key rather than on which of the two empty forms arrived.
            const customFieldKeys = Object.keys(customer.customFields ?? {});
            expect(customFieldKeys.filter(key => /reorder/i.test(key))).toEqual([]);

            // And the declared signature is byte-identical to the captured pre-plugin baseline, in name,
            // arguments, argument types, return type and nullability.
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

    // ═══════════════════════════════════════════════════════════════════════════════════════════════
    // AC-8 — the `ErrorCode` growth, evidenced as a number by the two compiler projects
    //
    // The read itself returns no error member: its return type is a paginated list and a nullable object, not
    // a union, which is why the growth cannot be evidenced from a read payload and is evidenced by compilation
    // instead. Neither fixture module is IMPORTED here — importing the deliberately-failing one would couple
    // this suite's own transpile to it — so the two spawned compiler runs are the only interaction with them.
    // ═══════════════════════════════════════════════════════════════════════════════════════════════

    describe('AC-8: the four added ErrorCode members are evidenced by the pinned compiler', () => {
        it(
            'resolves the workspace-pinned TypeScript compiler and not a floating one',
            () => {
                const compiler = path.join(__dirname, '../../../node_modules/typescript/bin/tsc');
                expect(
                    fs.existsSync(compiler),
                    `The workspace compiler is absent from ${compiler}; run the workspace install before this suite`,
                ).toBe(true);
                const reported = execFileSync(process.execPath, [compiler, '--version'], {
                    encoding: 'utf-8',
                    timeout: COMPILER_INVOCATION_TIMEOUT_MS,
                }).trim();
                // The root manifest pins `typescript` EXACTLY, and `npx` is never used anywhere in this file
                // precisely because it may resolve or fetch a different compiler — so the version is asserted
                // rather than assumed.
                expect(reported).toBe(`Version ${PINNED_TYPESCRIPT_VERSION}`);
            },
            COMPILER_INVOCATION_TIMEOUT_MS,
        );

        it(
            'fails to compile the exhaustive switch, naming at least one of the four added members',
            () => {
                const { status, output } = runPinnedCompiler(EXHAUSTIVE_TSCONFIG);

                // NON-ZERO, which is the number AC-8 is about: the four added members make an exhaustive switch
                // over the widened union non-exhaustive, and the compiler says so.
                expect(status, `Expected a non-zero exit; output was:\n${output}`).not.toBe(0);
                expect(status).not.toBeNull();
                // And the diagnostic NAMES one of them, so the failure under test cannot be confused with an
                // unrelated compile error in the same project.
                const named = FEATURE_ERROR_CODES.filter(code => output.includes(code));
                expect(
                    named.length,
                    `The diagnostic named none of the four added members:\n${output}`,
                ).toBeGreaterThan(0);
                // The refusal is the exhaustiveness one specifically — an assignment to `never` — rather than a
                // missing module or a syntax error, either of which would also exit non-zero.
                expect(output, output).toContain('TS2322');
            },
            COMPILER_INVOCATION_TIMEOUT_MS,
        );

        it(
            'compiles the defaulted switch cleanly',
            () => {
                const { status, output } = runPinnedCompiler(DEFAULTED_TSCONFIG);

                // ZERO, and the same four members are in scope in this project as in the one above: the pair
                // differs only in the presence of a default branch, so a clean exit here is what makes the failure
                // above attributable to exhaustiveness rather than to the fixture being unbuildable.
                expect(status, `Expected a zero exit; output was:\n${output}`).toBe(0);
                expect(output.trim()).toBe('');
            },
            COMPILER_INVOCATION_TIMEOUT_MS,
        );
    });

    // ═══════════════════════════════════════════════════════════════════════════════════════════════
    // The schema delta, by runtime introspection of the booted server (AAP section 0.7.3, ruling R15)
    //
    // The comparison is between the LIVE schema of a server carrying this plugin and the UNTOUCHED checked-in
    // snapshot, read from disk read-only. The snapshot is never edited and never regenerated, and it cannot
    // move: the introspection that produces it declares its own configuration with `plugins: [AdminUiPlugin]`
    // and never reads a plugin's. Every number below is therefore stated as a TRANSITION — the baseline and
    // this feature's own addition — and never as a bare post-plugin total.
    // ═══════════════════════════════════════════════════════════════════════════════════════════════

    describe('the published Shop surface widens by exactly this feature\u2019s own additions', () => {
        it('transitions 19\u219221 queries, 32\u219238 mutations, 32\u219236 error codes, 31\u219235 implementors and 97\u219297 permissions', () => {
            // THE BASELINE, measured against the snapshot rather than transcribed from a ticket.
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

            // THE RUNTIME WIDTH, as baseline PLUS this feature's own additions. These are F-101's figures and
            // not EPIC-001 section 6.5's cumulative ledger for all eight features, which would be 23 / 42 / 38
            // / 101 and is what ruling R15 exists to keep out of an assertion like this one.
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

            // THE ZERO DELTA, ASSERTED RATHER THAN OMITTED. This feature registers no `PermissionDefinition`,
            // so the published enum is exactly as wide as it was — and a zero delta that is not asserted is
            // indistinguishable from one that was never checked.
            expect(sortedEnumValues(liveSchema, 'Permission')).toHaveLength(BASELINE_PERMISSION_MEMBER_COUNT);
            expect(sortedEnumValues(liveSchema, 'Permission')).toEqual(
                sortedEnumValues(snapshotSchema, 'Permission'),
            );

            // The additions are exactly the named ones, and nothing else appeared. A root field that appeared
            // and is not one of these is a platform widening, which EPIC-001 asks to be reported rather than
            // absorbed into this feature's delta.
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
            // And no baseline field was REMOVED or renamed, which the loop above cannot see on its own: a
            // renamed field would simply be absent from `live` under its old name and present under a new one,
            // and the membership comparison is what catches the second half.
            for (const name of baseline.keys()) {
                expect(live.has(name)).toBe(true);
            }

            // The two shipped order mutations gain NO argument: a custom field on `Order` or `OrderLine` would
            // widen them as a side effect, and this feature registers none.
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
            // NOTHING PRE-EXISTING WAS REMOVED OR RENAMED — the additive-only half of the same claim.
            for (const member of baseline) {
                expect(live, `The baseline ErrorCode member ${member} disappeared`).toContain(member);
            }
            // The enum is generated from the types implementing `ErrorResult`, so the four declarations are
            // asserted too rather than only their generated codes.
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
            // THE PLUGIN'S OWN DOCUMENT names neither input, and that is the load-bearing half: the plugin
            // document is merged BEFORE the generator runs, so naming a type the document does not declare is
            // an unknown-type merge failure and the server does not start. The assertion is made against the
            // document's own source text, which is the thing that gets merged.
            const documentSource = shopApiExtensions.loc?.source.body ?? '';
            expect(documentSource.length, 'The plugin SDL document carried no source text').toBeGreaterThan(
                0,
            );
            expect(documentSource).not.toContain('ReorderListListOptions');
            expect(documentSource).not.toContain('ReorderListLineListOptions');
            // Nor does it hand-write an `options` argument on either paginated field.
            expect(documentSource).not.toMatch(/lines\s*\(/);

            // THE GENERATOR'S OWN INPUT DOES EXIST, on the root collection and on the NESTED field alike, and
            // carries the four members the generator puts on every options input it derives. The type name is
            // the generator's own derivation — the row type with a trailing `List` stripped — so it is read off
            // the argument rather than restated as a literal.
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

            // The forward-compatible sharing argument is published on BOTH reads with its declared default, so
            // an already-shipped client that sends nothing keeps an owner-only page.
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
            // And the single-list read publishes NO options argument, returning one object rather than a page.
            expect((singleField.args ?? []).map(arg => arg.name).sort()).toEqual(['id', 'includeShared']);
        });
    });

    // ═══════════════════════════════════════════════════════════════════════════════════════════════
    // Statement-count discipline (EPIC-001 sections 7.7.1a and 11.6.2; FEATURE-001-01 sections 2.6.1.1,
    // 2.6.2 and 2.6.3)
    //
    // Each test below states WHICH observation boundary it is making its claim at, because conflating them is
    // what produces a brittle assertion that fails on an unrelated platform change. The counted form is gated
    // to sql.js, where statement text and count are deterministic; the BEHAVIOUR each count evidences is
    // asserted ungated in the same test and therefore runs on all four engine jobs.
    // ═══════════════════════════════════════════════════════════════════════════════════════════════

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

            // CASE 1 — an identifier matching no row.
            const absent = await readAndCount(UNKNOWN_LIST_ID);
            expect(absent.data).toEqual({ activeCustomerReorderList: null });
            if (isStatementCountEngine()) {
                // EXACTLY ONE statement against `reorder_list` — never zero. The server cannot discover a
                // row's absence without asking, so a zero-statement claim here is unpassable for a correct
                // implementation and passable only by one that answers without looking. The filter is named:
                // `reorder_list`, and the gating reason travels with any failure.
                expect(capture.count(LIST_TABLE), countedDiagnostic()).toBe(1);
                expect(capture.selectsFor(LIST_TABLE), countedDiagnostic()).toHaveLength(1);
                // And nothing was written on a path that only read.
                expect(capture.writesFor(LIST_TABLE), countedDiagnostic()).toHaveLength(0);
                expect(capture.writesFor(LINE_TABLE), countedDiagnostic()).toHaveLength(0);
                // No nested collection is reachable for a row that was not found, so zero against the child
                // table is the reachable number here.
                expect(capture.count(LINE_TABLE), countedDiagnostic()).toBe(0);
                const [statement] = capture.selectsFor(LIST_TABLE);
                // THE SCOPE IS IN THE SAME `WHERE` AS THE IDENTIFIER, as mandatory conjuncts: the acting
                // customer and the active channel beside the row's own id. A predicate carrying the id alone,
                // or carrying the three in a disjunction, would leave every row in the table reachable.
                expect(
                    whereRequiresScopedPredicates(statement, [
                        { column: 'id', relation: listAlias, value: decodeId(UNKNOWN_LIST_ID) },
                        { column: 'customerId', relation: listAlias, value: actingCustomerDbId },
                        { column: 'channelId', relation: listAlias, value: defaultChannelDbId },
                    ]),
                    capture.format(),
                ).toBe(true);
            }

            // CASE 2 — a row that exists and belongs to the second customer.
            const notOwned = await readAndCount(foreign.id);
            expect(notOwned.data).toEqual({ activeCustomerReorderList: null });
            if (isStatementCountEngine()) {
                expect(capture.count(LIST_TABLE), countedDiagnostic()).toBe(1);
                expect(capture.writesFor(LIST_TABLE), countedDiagnostic()).toHaveLength(0);
                const [statement] = capture.selectsFor(LIST_TABLE);
                expect(
                    whereRequiresScopedPredicates(statement, [
                        { column: 'id', relation: listAlias, value: foreignDbId },
                        { column: 'customerId', relation: listAlias, value: actingCustomerDbId },
                        { column: 'channelId', relation: listAlias, value: defaultChannelDbId },
                    ]),
                    capture.format(),
                ).toBe(true);
                // The statement was scoped to the ACTING customer and NOT to the row's owner, which is the
                // difference between refusing a row in the database and loading another buyer's row into
                // process memory to compare it there.
                expect(
                    whereRequiresScopedPredicates(statement, [
                        { column: 'customerId', relation: listAlias, value: otherCustomerDbId },
                    ]),
                    capture.format(),
                ).toBe(false);
            }

            // CASE 3 — the caller's OWN row, read under the second channel's real token.
            shopClient.setChannelToken(SECOND_CHANNEL_TOKEN);
            const otherChannel = await readAndCount(own.id);
            shopClient.setChannelToken(E2E_DEFAULT_CHANNEL_TOKEN);
            expect(otherChannel.data).toEqual({ activeCustomerReorderList: null });
            if (isStatementCountEngine()) {
                expect(capture.count(LIST_TABLE), countedDiagnostic()).toBe(1);
                expect(capture.writesFor(LIST_TABLE), countedDiagnostic()).toHaveLength(0);
                const [statement] = capture.selectsFor(LIST_TABLE);
                // The channel conjunct is present and carries a channel that is NOT the one the row belongs
                // to, which is why the row is unreachable.
                expect(
                    whereRequiresScopedPredicates(statement, [
                        { column: 'id', relation: listAlias, value: ownDbId },
                        { column: 'customerId', relation: listAlias, value: actingCustomerDbId },
                        { column: 'channelId', relation: listAlias },
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

            // The row is still there and still readable on its own channel, so all three nulls above are
            // scoping results rather than a fixture that was never written.
            expect(await readStoredList(own.id)).not.toBeNull();
            const accessible = await rawShopRequest(GET_ACTIVE_CUSTOMER_REORDER_LIST, { id: own.id });
            expect((accessible.data?.activeCustomerReorderList as { id: string }).id).toBe(own.id);
        });
    });

    describe('lineCount is the stored column (PLUGIN-STATEMENT boundary, exact number)', () => {
        it('costs the same statements for three lists as for four, the counter arriving with the row', async () => {
            // THREE LISTS, each holding TWO LINES.
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

            // A FOURTH LIST, with the same two lines, and the SAME request.
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
                // THE EXACT NUMBER, and its composition, named: one statement resolving the page of lists —
                // the platform computes the total locally when the page is not saturated — plus exactly two
                // resolving every entry's lines, one for the rows and one for the per-parent totals. Four
                // entries cost the same three as three entries, which is what distinguishes a counter that
                // ARRIVES WITH THE ROW from one counted per entry: a per-entry count would have grown by one
                // statement, and a grouped count alongside the page would have added a fourth.
                expect(statementsForThree, captureForThree).toBe(3);
                expect(lineStatementsForThree, captureForThree).toBe(2);
                expect(statementsForFour, countedDiagnostic()).toBe(3);
                expect(lineStatementsForFour, countedDiagnostic()).toBe(2);
                expect(statementsForFour).toBe(statementsForThree);
                // And no write was issued by either read: a collection read never repairs the counter.
                expect(capture.writesFor(LIST_TABLE), countedDiagnostic()).toHaveLength(0);
            }
        });

        it('reports a lineCount that differs from the length of the nested page it returned', async () => {
            const seeded = await seedList('Counter versus page', [
                { productVariantId: catalogueVariants[0].id, quantity: 2 },
                { productVariantId: catalogueVariants[1].id, quantity: 3 },
                { productVariantId: catalogueVariants[2].id, quantity: 4 },
            ]);

            // A NESTED WINDOW SMALLER THAN THE STORED TOTAL — take 2 of 3, with the lines' own total order
            // named so the page is deterministic: `createdAt` ASC then `id` ASC.
            const { activeCustomerReorderList } = await shopClient.query<
                GetActiveCustomerReorderListWithPagedLinesQuery,
                GetActiveCustomerReorderListWithPagedLinesQueryVariables
            >(GET_ACTIVE_CUSTOMER_REORDER_LIST_WITH_PAGED_LINES, {
                id: seeded.id,
                linesTake: 2,
                linesSkip: 0,
                linesCreatedAtSort: 'ASC' as never,
                linesIdSort: 'ASC' as never,
            });

            const list = activeCustomerReorderList as NonNullable<typeof activeCustomerReorderList>;
            // THREE DISTINCT FACTS. The stored counter is three; the collection total is three; the page is
            // two. The summary number and the page are not one number wearing two names.
            expect(list.lineCount).toBe(3);
            expect(list.lines.totalItems).toBe(3);
            expect(list.lines.items).toHaveLength(2);
            expect(list.lineCount).not.toBe(list.lines.items.length);
            // And the counter is the STORED value rather than anything derived from the page.
            expect((await readStoredList(seeded.id))?.lineCount).toBe(3);
            expect(await countStoredLines(seeded.id)).toBe(3);
        });
    });

    describe('per-page non-growth (WHOLE-REQUEST boundary, non-growth only)', () => {
        it('issues the same number of statements for a page of three lists as for a page of six', async () => {
            const seeded = await seedLists('Non growth', 6, 2);
            expect(seeded).toHaveLength(6);

            capture.reset();
            const pageOfThree = await capture.capture(() =>
                shopClient.query<
                    GetActiveCustomerReorderListsWithLinePagesQuery,
                    GetActiveCustomerReorderListsWithLinePagesQueryVariables
                >(GET_ACTIVE_CUSTOMER_REORDER_LISTS_WITH_LINE_PAGES, { take: 3, linesTake: 5 }),
            );
            const statementsForThree = capture.count(LIST_TABLE, LINE_TABLE);
            const captureForThree = countedDiagnostic();

            capture.reset();
            const pageOfSix = await capture.capture(() =>
                shopClient.query<
                    GetActiveCustomerReorderListsWithLinePagesQuery,
                    GetActiveCustomerReorderListsWithLinePagesQueryVariables
                >(GET_ACTIVE_CUSTOMER_REORDER_LISTS_WITH_LINE_PAGES, { take: 6, linesTake: 5 }),
            );
            const statementsForSix = capture.count(LIST_TABLE, LINE_TABLE);

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
                // EQUALITY ACROSS THE TWO PAGE SIZES IS THE WHOLE ASSERTION, and no exact total is asserted at
                // this boundary. Doubling the page must not add a statement: `lines`, `lineCount` and
                // `viewerAccess` are resolved once per page rather than once per entry, so a per-entry
                // resolution introduced anywhere in that chain makes these two numbers diverge.
                expect(statementsForSix, `${captureForThree}\n---\n${countedDiagnostic()}`).toBe(
                    statementsForThree,
                );
                // A guard against the assertion passing because nothing was captured at all.
                expect(statementsForThree).toBeGreaterThan(0);
            }
        });

        it('resolves viewerAccess for a whole page at zero statement cost', async () => {
            const seeded = await seedLists('Viewer access', 6);
            expect(seeded).toHaveLength(6);

            capture.reset();
            const page = await capture.capture(() =>
                shopClient.query<GetActiveCustomerReorderListsQuery>(GET_ACTIVE_CUSTOMER_REORDER_LISTS),
            );

            // Every one of the six entries reported its viewer access.
            expect(page.activeCustomerReorderLists.items).toHaveLength(6);
            for (const entry of page.activeCustomerReorderLists.items) {
                expect(entry.viewerAccess.access).toBe('OWNED');
                expect(entry.viewerAccess.grantedCapabilities).toEqual([]);
            }

            if (isStatementCountEngine()) {
                // ZERO for `viewerAccess`, expressed as the only number that can express it: the whole request
                // cost ONE statement against `reorder_list` — the page itself — and NONE against
                // `reorder_list_line`, with six entries each reporting their access. The field is derived from
                // the entry's own `customerId` against the session, so it queries nothing.
                expect(capture.count(LIST_TABLE), countedDiagnostic()).toBe(1);
                expect(capture.count(LINE_TABLE), countedDiagnostic()).toBe(0);
                expect(capture.writesFor(LIST_TABLE), countedDiagnostic()).toHaveLength(0);
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

            // CALLS, not statements. One collection read, one batched nested read for the whole page — not one
            // per entry — no single-list read, and no reconciliation: a page of lists never repairs.
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
            // ONCE, not twice: the nested page the read resolves to reconcile the counter is the page the
            // nested field resolver serves, so the request pays for it a single time.
            expect(linesSpy).toHaveBeenCalledTimes(1);
            expect(listsSpy).toHaveBeenCalledTimes(0);
            // The stored counter already agreed with the observed total, so no reconciliation was attempted.
            expect(repairSpy).toHaveBeenCalledTimes(0);
        });
    });

    describe('the lineCount compare-and-set repair (single-list read only)', () => {
        /**
         * Drives the counter stale the way the contract describes: line rows disappear UNDERNEATH the plugin.
         *
         * A bare variant is created, a line is inserted against it, the counter is set to agree with reality,
         * and then the VARIANT ROW IS HARD-DELETED directly through the repository — so the database's own
         * cascade removes the line while the service never sees it and never decrements. The variant is one
         * this test created, which is EPIC-001 section 11.6.1's second sanctioned form for a case like this:
         * a seeded variant cannot be hard-deleted at all, other core tables referencing it without cascading.
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

            // The cascade removed the line and left the counter alone, which is the state the repair exists for.
            expect(await countStoredLines(list.id)).toBe(2);
            expect((await readStoredList(list.id))?.lineCount).toBe(3);
            return { list, trueTotal: 2 };
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

            // THE FIRST READ REPORTS THE CORRECTED COUNT, in the response the caller actually received — not
            // merely in the row afterwards. That ordering is the contract: the reconciliation happens before
            // the object is exposed to the executor.
            expect(first.activeCustomerReorderList?.lineCount).toBe(trueTotal);
            expect(first.activeCustomerReorderList?.lines.totalItems).toBe(trueTotal);
            expect((await readStoredList(list.id))?.lineCount).toBe(trueTotal);

            if (isStatementCountEngine()) {
                // EXACTLY ONE repair statement, and it is a COMPARE-AND-SET: its `WHERE` carries the row id
                // together with the stale value it is replacing, so a competing writer that moved the counter
                // between the read and this statement makes it affect nothing rather than overwrite them.
                expect(firstWrites, firstCapture).toHaveLength(1);
                expect(firstWrites[0].kind, firstCapture).toBe('update');
                expect(
                    whereRequiresScopedPredicates(firstWrites[0], [
                        { column: 'id', value: decodeId(list.id) },
                        { column: 'lineCount', value: staleValue },
                    ]),
                    firstCapture,
                ).toBe(true);
                expect(capture.writesFor(LINE_TABLE), firstCapture).toHaveLength(0);
            }

            capture.reset();
            const second = await capture.capture(() =>
                shopClient.query<
                    GetActiveCustomerReorderListQuery,
                    GetActiveCustomerReorderListQueryVariables
                >(GET_ACTIVE_CUSTOMER_REORDER_LIST, { id: list.id }),
            );

            // THE SECOND READ REPORTS THE SAME COUNT AND REPAIRS NOTHING, which is what makes the repair
            // idempotent rather than a write issued on every read.
            expect(second.activeCustomerReorderList?.lineCount).toBe(trueTotal);
            if (isStatementCountEngine()) {
                expect(capture.writesFor(LIST_TABLE), countedDiagnostic()).toHaveLength(0);
                expect(capture.writesFor(LINE_TABLE), countedDiagnostic()).toHaveLength(0);
            }
        });

        it('never repairs on the collection read, which reports the stored column as it stands', async () => {
            const { list } = await seedListWithStaleCounter();
            // Restated to a value nothing could have produced, so the number the page reports can only be the
            // stored column.
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
            // THE STALE VALUE, REPORTED AS IT STANDS — and the nested page beside it showing the real total, so
            // the two are visibly different in one response and the read still did not reconcile them.
            expect(entry?.lineCount).toBe(9);
            expect(entry?.lines.totalItems).toBe(2);
            expect((await readStoredList(list.id))?.lineCount).toBe(9);

            if (isStatementCountEngine()) {
                // NOT ONE WRITE. The collection read has no observed total for each list to compare against —
                // it does not page each list's lines for that purpose — so repairing here would be a write
                // driven by a number it never established.
                expect(capture.writesFor(LIST_TABLE), countedDiagnostic()).toHaveLength(0);
            }

            // And the single-list read still repairs it, which is what proves the absence above is scoped to
            // the collection read rather than the repair being broken outright.
            const single = await shopClient.query<
                GetActiveCustomerReorderListQuery,
                GetActiveCustomerReorderListQueryVariables
            >(GET_ACTIVE_CUSTOMER_REORDER_LIST, { id: list.id });
            expect(single.activeCustomerReorderList?.lineCount).toBe(2);
            expect((await readStoredList(list.id))?.lineCount).toBe(2);
        });
    });

    // ═══════════════════════════════════════════════════════════════════════════════════════════════
    // The five scenarios of STORY-001-01-04 section 7, each its own named test
    // ═══════════════════════════════════════════════════════════════════════════════════════════════

    describe('\u00a77 scenario 1: an empty collection, and an empty list returned rather than omitted', () => {
        it('returns totalItems 0 with an empty items collection for a customer holding no list', async () => {
            const envelope = await rawShopRequest(GET_ACTIVE_CUSTOMER_REORDER_LISTS);

            // An empty COLLECTION — not `null`, and not an error. All three are distinguishable on the wire and
            // only one of them is the contract.
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

            // The list is RETURNED, with a counter of exactly zero and an empty nested page. An empty list is a
            // list, so a read that omitted it or answered `null` would be reporting that the buyer's own list
            // does not exist.
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

            // Both are CORE rows this test did not create, so both mutations are queued for restoration in the
            // same `afterEach` that deletes this test's own rows.
            await dataSource
                .createQueryBuilder()
                .update(ProductVariant)
                .set({ enabled: false })
                .where('id = :id', { id: decodeId(disabledVariant.id) })
                .execute();
            await dataSource
                .createQueryBuilder()
                .update(ProductVariant)
                .set({ deletedAt: new Date() })
                .where('id = :id', { id: decodeId(deletedVariant.id) })
                .execute();
            restoreActions.push(() => restoreAllVariants());

            const { activeCustomerReorderList } = await shopClient.query<
                GetActiveCustomerReorderListQuery,
                GetActiveCustomerReorderListQueryVariables
            >(GET_ACTIVE_CUSTOMER_REORDER_LIST, { id: seeded.id });

            const list = activeCustomerReorderList as NonNullable<typeof activeCustomerReorderList>;
            // BOTH LINES ARE STILL RETURNED. A saved list records INTENT rather than availability, so nothing
            // about the catalogue changing removes a line or moves the counter.
            expect(list.lineCount).toBe(2);
            expect(list.lines.totalItems).toBe(2);
            expect(list.lines.items).toHaveLength(2);

            const disabledLine = list.lines.items.find(
                line => String(line.productVariantId) === String(disabledVariant.id),
            );
            const deletedLine = list.lines.items.find(
                line => String(line.productVariantId) === String(deletedVariant.id),
            );

            // Each keeps its NON-NULL stored identifier and its unchanged quantity.
            expect(disabledLine?.productVariantId).toBeDefined();
            expect(deletedLine?.productVariantId).toBeDefined();
            expect(disabledLine?.quantity).toBe(2);
            expect(deletedLine?.quantity).toBe(3);

            // A DISABLED variant is still resolvable in the active channel, so its object arrives populated —
            // asserting `null` here would be asserting the opposite of the requirement.
            expect(disabledLine?.productVariant).not.toBeNull();
            expect(disabledLine?.productVariant?.name).toBe(disabledVariant.name);
            // A SOFT-DELETED variant is not, so its object resolves to `null` beside a non-null id. That
            // asymmetry is exactly why the relation is published nullable.
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

            // A CORE row this test did not create, so the original price is queued for restoration.
            const originalPrice = variant.price;
            const { updateProductVariants } = await adminClient.query<UpdateVariantsMutation>(
                UPDATE_VARIANTS_FOR_REORDER_READ,
                { input: [{ id: variant.id, price: originalPrice + 4321 }] },
            );
            expect(updateProductVariants[0].price).toBe(originalPrice + 4321);
            restoreActions.push(async () => {
                await adminClient.query<UpdateVariantsMutation>(UPDATE_VARIANTS_FOR_REORDER_READ, {
                    input: [{ id: variant.id, price: originalPrice }],
                });
            });

            const collectionAfter = await shopClient.query<GetActiveCustomerReorderListsQuery>(
                GET_ACTIVE_CUSTOMER_REORDER_LISTS,
            );
            const singleAfter = await shopClient.query<
                GetActiveCustomerReorderListQuery,
                GetActiveCustomerReorderListQueryVariables
            >(GET_ACTIVE_CUSTOMER_REORDER_LIST, { id: seeded.id });

            // NO OBSERVABLE DIFFERENCE OF ANY KIND on either read: the same payload, field for field. There is
            // no price field on either payload to differ, and nothing derived from one.
            expect(collectionAfter.activeCustomerReorderLists).toEqual(
                collectionBefore.activeCustomerReorderLists,
            );
            expect(singleAfter.activeCustomerReorderList).toEqual(singleBefore.activeCustomerReorderList);
            // Stated as the three facts a client would notice, so the comparison above cannot pass vacuously.
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

            // THE FIRST SESSION reads and RECORDS. A payload is a snapshot: this read reserved nothing, held
            // nothing and locked nothing, which is what makes the second session's write possible at all.
            const recorded = await shopClient.query<
                GetActiveCustomerReorderListQuery,
                GetActiveCustomerReorderListQueryVariables
            >(GET_ACTIVE_CUSTOMER_REORDER_LIST, { id: seeded.id });
            const recordedSnapshot = JSON.parse(
                JSON.stringify(recorded),
            ) as GetActiveCustomerReorderListQuery;
            expect(recorded.activeCustomerReorderList?.lineCount).toBe(2);

            // A SECOND, GENUINELY SEPARATE SESSION for the same customer removes one line through the
            // mutation that owns removal. Two callers rather than one client whose state was mutated.
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

            // THE FIRST SESSION RE-READS.
            const reread = await shopClient.query<
                GetActiveCustomerReorderListQuery,
                GetActiveCustomerReorderListQueryVariables
            >(GET_ACTIVE_CUSTOMER_REORDER_LIST, { id: seeded.id });

            // The RECORDED response is unchanged — it is a value the client already holds, and nothing about a
            // later write reaches back into it.
            expect(recorded).toEqual(recordedSnapshot);
            expect(recorded.activeCustomerReorderList?.lines.items).toHaveLength(2);

            // The SECOND response reflects the write: the counter is 1 and the page holds the line the other
            // session did not remove, identified BY IDENTIFIER rather than by position.
            expect(reread.activeCustomerReorderList?.lineCount).toBe(1);
            expect(reread.activeCustomerReorderList?.lines.totalItems).toBe(1);
            expect(reread.activeCustomerReorderList?.lines.items).toHaveLength(1);
            expect(String(reread.activeCustomerReorderList?.lines.items[0].id)).toBe(survivingLineId);
            expect(reread.activeCustomerReorderList?.lines.items.map(line => String(line.id))).not.toContain(
                removedLineId,
            );

            // NEITHER READ FAILED and neither returned an error result: a read observing a concurrent write is
            // an ordinary outcome rather than a conflict, which is why this scenario is not a race case.
            expect(recorded.activeCustomerReorderList).not.toBeNull();
            expect(reread.activeCustomerReorderList).not.toBeNull();
        });
    });

    describe('\u00a77 scenario 5: the channel and the language a request names', () => {
        it('answers an empty page and an exact null under the second channel\u2019s token', async () => {
            const seeded = await seedList('Channel scoped', [
                { productVariantId: catalogueVariants[0].id, quantity: 2 },
            ]);

            // The SECOND CHANNEL's real token, sent on the request. The session is unchanged.
            shopClient.setChannelToken(SECOND_CHANNEL_TOKEN);
            const collection = await rawShopRequest(GET_ACTIVE_CUSTOMER_REORDER_LISTS);
            const single = await rawShopRequest(GET_ACTIVE_CUSTOMER_REORDER_LIST, { id: seeded.id });
            shopClient.setChannelToken(E2E_DEFAULT_CHANNEL_TOKEN);

            expect(collection.errors, JSON.stringify(collection)).toBeUndefined();
            expect(collection.data).toEqual({ activeCustomerReorderLists: { totalItems: 0, items: [] } });
            expect(single.errors, JSON.stringify(single)).toBeUndefined();
            expect(single.data).toEqual({ activeCustomerReorderList: null });

            // And the same row is still there under its own channel, so the two answers above are the channel
            // conjunct working rather than the fixture missing.
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

            // A SECOND-LANGUAGE NAME for the variant, added through the Admin API so the two requests really do
            // resolve different strings — the seeded catalogue ships English alone, and two identical names
            // would make this assertion vacuous. The translation row is one this test created, so it is removed
            // in the restore queue rather than left for the next test.
            await adminClient.query<UpdateVariantsMutation>(UPDATE_VARIANTS_FOR_REORDER_READ, {
                input: [
                    {
                        id: variant.id,
                        translations: [{ languageCode: LanguageCode.de, name: germanVariantName }],
                    },
                ],
            });
            restoreActions.push(async () => {
                await dataSource
                    .createQueryBuilder()
                    .delete()
                    .from('product_variant_translation')
                    .where('languageCode = :languageCode', { languageCode: LanguageCode.de })
                    .execute();
            });

            const inEnglish = await shopClient.query<
                GetActiveCustomerReorderListQuery,
                GetActiveCustomerReorderListQueryVariables
            >(GET_ACTIVE_CUSTOMER_REORDER_LIST, { id: seeded.id }, { languageCode: LanguageCode.en });
            const inGerman = await shopClient.query<
                GetActiveCustomerReorderListQuery,
                GetActiveCustomerReorderListQueryVariables
            >(GET_ACTIVE_CUSTOMER_REORDER_LIST, { id: seeded.id }, { languageCode: LanguageCode.de });

            // THE SAME LIST, the same counter and the same line identifier under both requests.
            expect(String(inGerman.activeCustomerReorderList?.id)).toBe(seeded.id);
            expect(inGerman.activeCustomerReorderList?.lineCount).toBe(
                inEnglish.activeCustomerReorderList?.lineCount,
            );
            expect(inGerman.activeCustomerReorderList?.lineCount).toBe(1);
            expect(String(inGerman.activeCustomerReorderList?.lines.items[0].id)).toBe(
                String(inEnglish.activeCustomerReorderList?.lines.items[0].id),
            );
            expect(inGerman.activeCustomerReorderList?.lines.items[0].quantity).toBe(6);

            // THE VARIANT'S TRANSLATED NAME DIFFERS, resolving through the platform's own catalogue path.
            expect(inEnglish.activeCustomerReorderList?.lines.items[0].productVariant?.name).toBe(
                variant.name,
            );
            expect(inGerman.activeCustomerReorderList?.lines.items[0].productVariant?.name).toBe(
                germanVariantName,
            );
            expect(inGerman.activeCustomerReorderList?.lines.items[0].productVariant?.name).not.toBe(
                inEnglish.activeCustomerReorderList?.lines.items[0].productVariant?.name,
            );

            // THE STORED LIST NAME IS BYTE-IDENTICAL in both: it is the buyer's own string and carries no
            // translation, so a language cannot change it.
            expect(inEnglish.activeCustomerReorderList?.name).toBe(listName);
            expect(inGerman.activeCustomerReorderList?.name).toBe(listName);
        });
    });

    // ═══════════════════════════════════════════════════════════════════════════════════════════════
    // The empty-generation assertion this suite owns
    //
    // STORY-001-01-04 owns NO MIGRATION: every table, column, index and constraint its two reads rely on ships
    // in the single additive migration STORY-001-01-01 generates. A generated file appearing here is the signal
    // that this story has altered a mapping it does not own.
    // ═══════════════════════════════════════════════════════════════════════════════════════════════

    describe('this story owns no migration', () => {
        it('emits no migration file, the two reads having altered no mapping', async () => {
            const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'reorder-read-migration-'));
            // Queued BEFORE the call, so the directory is removed even if the assertion below fails.
            temporaryDirectories.push(outputDir);

            // THE LIVE SERVER'S OWN CONNECTION OPTIONS, and this is load-bearing rather than tidy: the sqljs
            // initializer mutates `location` on the very options object the running server was built from, so
            // passing a freshly derived configuration would open an EMPTY database, diff the entities against
            // nothing and emit the whole schema — a failure that looks like a defect in this story while being
            // an artefact of the harness.
            const generated = await generateMigration(serverConfig, {
                name: 'storyOneOhOneOhFourShouldEmitNothing',
                outputDir,
            });

            // It returns `undefined` and writes NO FILE. The platform logs "No changes in database schema were
            // found - cannot generate a migration." on this path (`packages/core/src/migrate.ts`).
            expect(generated).toBeUndefined();
            expect(await fs.readdir(outputDir)).toEqual([]);

            // TWO HONESTY CONSTRAINTS ON WHAT THIS ASSERTION EVIDENCES, stated here rather than left implicit.
            //
            // First, the schema this ran against was created by the harness's own synchronisation rather than
            // by the migration: the sql.js initializer enables synchronisation while it populates and the
            // MySQL and PostgreSQL initializers force it outright, so an empty result evidences that THIS
            // STORY'S resolver and service work introduced no mapping change — which is exactly the claim
            // STORY-001-01-04 makes — and does NOT by itself evidence that the checked-in migration matches the
            // entity declarations. That second claim belongs to the migration suite, which drives a
            // data-bearing up/down/up cycle against a schema the migration itself created.
            //
            // Second, the output directory is a temporary one OUTSIDE the repository, so nothing is ever written
            // under this package's own migrations directory and `git status --porcelain` is clean after a run
            // whatever this assertion finds.
            expect(path.isAbsolute(outputDir)).toBe(true);
            expect(outputDir.startsWith(path.join(__dirname, '..'))).toBe(false);

            // The running server is unaffected by the generation pass, asserted rather than assumed because
            // that pass loads and then RESETS the platform's module-level configuration.
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
