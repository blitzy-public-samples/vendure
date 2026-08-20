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
 * the shared configuration sets `allowOnly: true`, so one would pass CI in silence. Neither of the two
 * per-row list-options inputs the platform derives from this plugin's paginated types is declared or passed,
 * and neither is NAMED anywhere in this file — nor is an `options` argument hand-written: the platform's
 * list-options generator owns all of it, and this file asserts that ownership by reading the names the
 * generator itself produced off the introspected arguments rather than by spelling them, which is both the
 * requirement and the only way to assert their absence without supplying it.
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
 *  2. STORY-001-01-04's AC-8 expects the two compiler fixtures to compile against types REGENERATED from the
 *     rebuilt schema by the repository's own generator, and they do: AC-8 below introspects the SHOP API OF
 *     THE SERVER THIS FILE BOOTED — which carries the plugin — and runs `@graphql-codegen/cli`'s `generate()`
 *     over that live introspection under the same plugin list and configuration the repository declares for
 *     `packages/common/src/generated-shop-types.ts` (`scripts/codegen/generate-graphql-types.ts`), writing an
 *     ignored module the two compiler projects then compile against. What is NOT run is the `bun run codegen`
 *     script itself, and that is the only residue of the divergence: it writes `schema-shop.json` and
 *     `packages/common/src/generated-shop-types.ts`, neither of which may be edited or regenerated (AAP
 *     section 0.4.1.5), and the snapshot could not carry this plugin in any case because the introspection
 *     that produces it declares its own configuration with `plugins: [AdminUiPlugin]`. An earlier revision
 *     substituted a plugin-local literal union of the four added members for the generation; that made the
 *     exhaustive fixture's failure evidence of its own declaration rather than of the schema's growth, and it
 *     is gone.
 *  3. The same criterion asks for the two compiler runs to be declared as PACKAGE SCRIPTS, and they are:
 *     `typecheck:error-code-exhaustive` and `typecheck:error-code-defaulted`, one per project. Each invokes
 *     the WORKSPACE-PINNED compiler by path — `node ../../node_modules/typescript/bin/tsc` — on its own
 *     project with `--noEmit`, and the two commands are otherwise token-for-token identical, which is what
 *     makes the pair of exit statuses attributable to the projects rather than to how each was run. Nothing
 *     else stands between the script and the compiler: no wrapper, no driver and no `npx`, which may resolve
 *     or fetch a compiler other than the pinned one and would decide this criterion by whatever happened to
 *     be available.
 *     Because each fixture imports a GENERATED module — deliberately never committed, since a committed copy
 *     would let the pair compile against a stale enum — neither script is checkable outside the window in
 *     which that module exists: run on a clean checkout both fail with TS2307 instead. That is intended and
 *     it is ASSERTED rather than assumed. The generation window belongs to this file, which is what
 *     STORY-001-01-04's AC-8 asks for: the criterion below generates the module from the live schema of the
 *     server this suite booted, runs both declared scripts inside that window, and then — with the live
 *     artefact lifted into memory — runs them again with the module genuinely absent and requires each to
 *     fail with TS2307. That second half matters because the exhaustive project ALSO emits its TS2322 when
 *     the module is missing, so a TS2322 on its own would not distinguish exhaustiveness from an unresolved
 *     import; the criterion therefore requires TS2322 WITHOUT TS2307 inside the window and TS2307 outside it.
 *     This suite does not invent its own invocation either — it READS each declared command out of
 *     `packages/reorder-plugin/package.json`, asserts its shape, and then runs THAT command. The two entries
 *     sit alongside the seven the AAP names at section 0.5.2.1; that section requires those seven to exist
 *     because workspace aggregates invoke them, and neither aggregate reaches these.
 *  4. FEATURE-001-01 section 2.6.1 row 11a presupposes a plugin-owned middleware refusing a `GET` or a wrong
 *     content type. AAP section 0.2.2.5 records that this plugin registers NO middleware and declares no
 *     `configure` method, so there is nothing to assert; no such assertion is written and the divergence is
 *     recorded here rather than satisfied by testing the platform's own transport.
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
    CapturedStatement,
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

/** The package script that declares the exhaustive project's compiler run. */
const EXHAUSTIVE_SCRIPT = 'typecheck:error-code-exhaustive';

/** The package script that declares the defaulted project's compiler run. */
const DEFAULTED_SCRIPT = 'typecheck:error-code-defaulted';

/** The TypeScript version the root manifest pins EXACTLY. AC-8 asserts the resolved compiler is this one. */
const PINNED_TYPESCRIPT_VERSION = '5.8.2';

/** A generous budget for one compiler invocation. A control value for the spawn, not a claim about timing. */
const COMPILER_INVOCATION_TIMEOUT_MS = 240_000;

/**
 * Where the plugin-aware types AC-8 generates are written: the package root, not this directory.
 *
 * It is inside the package because both compiler fixtures import it by a RELATIVE specifier — that is what
 * makes the enum they compile against unambiguously the generated one, with no ambient path mapping able to
 * substitute another. It is a build product of this run rather than a checked-in artefact: git-ignores it
 * (`packages/reorder-plugin/.gitignore`), AC-8 writes it before compiling and removes it afterwards, and a
 * copy of it committed beside the fixtures would defeat the whole point, since the PROVENANCE of the enum is
 * the evidence.
 *
 * It sits OUTSIDE `e2e/` for a reason worth stating, because putting it inside looks harmless and is not.
 * `e2e-common/test-config.ts` derives each suite's server port from the INDEX of its file within its parent
 * directory — `getIndexOfTestFileInParentDir` reads the listing with `readdirSync` and takes `indexOf` — so an
 * entry that appears or disappears inside `e2e/` shifts that index, and therefore the port, for whichever
 * suites read the listing on the other side of the change. Two suites then bind the same port and one dies of
 * EADDRINUSE, which is precisely what a transient `e2e/__generated__` produced while the criteria below drove
 * the driver's generate-and-remove path repeatedly. At the package root it cannot affect that computation.
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
 * The shipped Shop read AC-7 asserts is unchanged.
 *
 * The selection is deliberately wide enough to show that the type neither gained nor lost a field a client
 * would notice, INCLUDING `customFields` — this feature registers zero custom fields on any core entity
 * (ruling R1), so that value must be exactly what it was before the plugin loaded.
 */
/**
 * The two halves of the `viewerAccess` cost pair: the SAME collection read, selected once without the field
 * and once with it.
 *
 * They are written out here rather than assembled from the shared fragment because the only difference
 * between them has to be the one field under test. "Zero cost" is a statement about a DELTA — what selecting
 * the field adds to the request — and a delta needs both halves of the pair to exist. Asserting a total
 * instead only says what one request cost, which is satisfied by an implementation whose per-entry lookup is
 * already inside that total.
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
    /** The variant's OWNING product, whose identifier is a `product` row's and not a `product_variant` row's. */
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
    /**
     * The stored identifier of the second channel THIS SUITE created.
     *
     * Kept because a channel-scope assertion has to name the channel the request actually acted in. Requiring
     * only that the predicate carry something other than the default channel's identifier is satisfied by any
     * value at all — including one belonging to no channel — so the exact identifier is what makes the claim
     * about scoping rather than about inequality.
     */
    let secondChannelDbId: number;

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
    ): Promise<GraphQlEnvelope> {
        const response = await shopClient.fetch(shopApiUrl, {
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
     * every row in the database rather than the two the catalogue-moved scenario touches: a variant the seed
     * had legitimately disabled would be silently enabled, and a defect elsewhere that disabled or
     * soft-deleted a variant it should not have would be quietly repaired between tests instead of failing
     * something. The second captured only `enabled` and `deletedAt`, so the compensating write put those two
     * back and advanced the row's `updatedAt` on its way — restoring the columns under test while changing
     * one that was not, and reporting success either way.
     */
    async function captureVariantAvailability(externalVariantId: ReorderApiId): Promise<void> {
        const variantId = decodeId(externalVariantId);
        const captured = await captureCoreRows('product_variant', 'captured_row.id = :variantId', {
            variantId,
        });
        expect(captured.rows, `No product_variant row with id ${String(variantId)} to capture`).toHaveLength(
            1,
        );
    }

    /** The table a variant's per-language name lives in, addressed directly because no entity is imported. */
    const VARIANT_TRANSLATION_TABLE = 'product_variant_translation';

    /**
     * Captures the exact `(baseId, languageCode)` translation row — or the fact that there is none — and
     * queues its exact restoration before the caller writes.
     *
     * BOTH HALVES OF THAT MATTER, and an earlier revision had neither. The registration has to happen before
     * the mutation: a write that commits and then throws — or anything throwing between the write and a later
     * registration — leaves the row changed with nothing queued to put it back, and every following test in
     * the file then runs against a catalogue this one modified. And the restoration has to branch on what was
     * there: deleting the pair unconditionally is correct only if this suite created it, so a fixture that
     * already carried a translation for that language would have it removed rather than restored, silently,
     * with the test reporting success either way. The general capture does both — it re-writes a captured row
     * column for column and DELETES a row that appeared where the capture found none — and then asserts which
     * of the two it did.
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
     * A linear teardown stops at the first failure, stranding every later stage — the restoration of a core row
     * a test changed, the bare variants, the plugin rows, the temporary directories, the spies installed on a
     * singleton service, the client's channel token — so one broken test leaves the next running against state
     * it never established, and a stranded spy is observed by a sibling's SERVICE-CALL assertion. Collecting the
     * failures and raising them once at the end keeps the diagnosis and loses none of the cleanup.
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
        /*
         * The OWNING PRODUCT'S identifier, read from the catalogue rather than derived from a variant's.
         * `ProductVariant.productId` is a foreign key into `product`, so passing a `product_variant`
         * identifier there is only ever right by coincidence — it succeeds exactly when the two sequences
         * happen to overlap, and it silently attaches the fixture to the wrong product (or is refused by the
         * foreign key) the moment they do not.
         */
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
        // The row genuinely points at the product that was asked for, so the fixture is attached where it
        // says it is rather than wherever an overlapping identifier happened to land.
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

    /**
     * EVERY statement the captured window issued against the database, excluding transaction control.
     *
     * This is the WHOLE-REQUEST boundary's own instrument, and it is deliberately UNFILTERED. Filtering to the
     * plugin's own two tables is what makes the boundary's claim vacuous: a resolver that loaded a variant, a
     * customer or a channel once per entry would add no statement against `reorder_list` or
     * `reorder_list_line` at all, so the two page sizes would report identical numbers while the request they
     * describe grew with the page. Growth anywhere in the request is the thing this boundary detects, so
     * everything the request issued is what it counts.
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
    /**
     * Generates plugin-aware Shop types from the LIVE schema of the server this file booted, and returns the
     * `ErrorCode` members the generator derived.
     *
     * This is what makes AC-8's evidence about the schema rather than about the fixtures. Both halves of the
     * compiler pair import the module written here, so the enum they switch over is whatever the running
     * server publishes — nothing in either fixture declares a member, and nothing in this file hands the
     * generator a member either.
     *
     * Three choices in it are load-bearing.
     *
     * The INTROSPECTION is the repository's own: `getIntrospectionQuery({ inputValueDeprecation: true })`,
     * the same call the repository's download step makes
     * (`scripts/codegen/download-introspection-schema.ts`), issued against this server's Shop API and written
     * out in the same whole-result shape the checked-in snapshot uses, so the generator receives exactly the
     * kind of input it receives in a real codegen run.
     *
     * The GENERATOR is the repository's own too — `@graphql-codegen/cli`'s `generate()` — under the same
     * plugin list and the same configuration the repository declares for
     * `packages/common/src/generated-shop-types.ts` (`scripts/codegen/generate-graphql-types.ts`): the
     * `eslint-disable` prelude, the `typescript` plugin, `enumValues: 'keep'`, `strict`, the `Money` and `ID`
     * scalar mappings and `maybeValue: 'T'`. Reproducing the configuration rather than importing that script
     * is deliberate: the script writes the checked-in snapshot and the checked-in generated module as a side
     * effect of running, and neither may be touched.
     *
     * The OUTPUT is a build product. It is written before the two compilations and removed after them, and it
     * is git-ignored, because a checked-in copy would let the pair compile against a stale enum — which is
     * precisely the failure mode this replaces.
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
        expect(fs.existsSync(directory), `${directory} survived being detached`).toBe(false);
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
     * Runs the command a package script declares, exactly as declared.
     *
     * Only the interpreter is substituted — `node` on a script line resolves through whatever is on the path,
     * and the running Node is the one this suite is accountable for. Every other token, including the pinned
     * compiler's path, the `-p` project selector and `--noEmit`, is the script's own, and the working
     * directory is the package directory so each relative path resolves exactly as it would for whoever typed
     * the script name. No environment variable is injected and no argument is added: what runs here is the
     * command a maintainer runs.
     */
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
        expect(createChannel.token, JSON.stringify(createChannel)).toBe(SECOND_CHANNEL_TOKEN);
        expect(createChannel.id, JSON.stringify(createChannel)).toBeDefined();
        secondChannelDbId = decodeId(createChannel.id as ReorderApiId);
        // Two DIFFERENT channels, stated rather than assumed: every channel-scope assertion below rests on it.
        expect(secondChannelDbId).not.toBe(defaultChannelDbId);

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
        // EVERY STAGE RUNS, whatever any of them does, and the failures are reported once at the end.
        //
        // Core rows this test mutated are restored FIRST and in reverse order, so a later mutation layered on
        // an earlier one unwinds in the order it was applied. The bare variants this test created are removed
        // BEFORE the plugin rows, because removing them cascades whatever lines still point at them and a later
        // foreign key failure would be reported as a cleanup error rather than as the deliberate cascade it is.
        // Every spy installed on the singleton service is removed, so a SERVICE-CALL assertion can never observe
        // a sibling's spy — and because that removal is a stage of its own it now happens even when an earlier
        // stage fails.
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
            ...directories.map(directory => ({
                what: `temporary directory ${directory}`,
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
            // Seeded WHILE AUTHENTICATED and its identifier kept, because the single-read half below has to
            // address a row that genuinely exists and genuinely belongs to somebody.
            const owned = await seedList('Owned while authenticated');
            // The control, taken before the session is dropped: this row is readable by its owner, so the null
            // the anonymous caller receives below is a scoping result rather than a row that was never there.
            const ownerView = await rawShopRequest(GET_ACTIVE_CUSTOMER_REORDER_LIST, { id: owned.id });
            expect((ownerView.data?.activeCustomerReorderList as { id: string } | null)?.id).toBe(owned.id);

            await shopClient.asAnonymousUser();
            shopClient.setChannelToken(E2E_DEFAULT_CHANNEL_TOKEN);
            const envelope = await rawShopRequest(GET_ACTIVE_CUSTOMER_REORDER_LISTS);

            // The whole envelope, because "no error entry of any kind" is a claim about the envelope and not
            // about the field.
            expect(envelope.errors, JSON.stringify(envelope)).toBeUndefined();
            expect(envelope.data).toEqual({ activeCustomerReorderLists: { totalItems: 0, items: [] } });

            /*
             * THE SINGLE-LIST READ ADDRESSES THE EXISTING, OWNED ROW — not an identifier nothing was ever
             * stored under. An implementation that leaks any row it can find to a caller with no session
             * answers an unknown identifier with null just as correctly as a scoped one does, so an unknown
             * identifier evidences nothing about scoping at all: the null it produces is indistinguishable
             * from the null a total absence of authorization would produce. Reading the row that exists is
             * the only form of this assertion an unscoped implementation fails.
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
            /*
             * THE CUSTOM FIELDS VALUE IS UNCHANGED, and "unchanged" is asserted as the COMPLETE shape rather
             * than as the absence of reorder-shaped keys. This feature registers ZERO custom fields on any
             * core entity (ruling R1) and declares no `configuration` hook, so the value carries no registered
             * field at all — not merely no field whose name happens to mention this feature. A filter for
             * reorder-shaped names is passed by an arbitrary new custom field registered by anything at all,
             * which is exactly the regression this criterion exists to catch: a plugin that widened a core
             * entity under a name of its own choosing would be invisible to it.
             */
            /*
             * The one key the value does carry is the PLATFORM'S OWN and is not a custom field: the generated
             * custom-field resolver spreads the entity's `customFields` and then attaches `__entityId__` set to
             * the entity's identifier, so that a relation-typed custom field could be resolved from it
             * (`packages/core/src/api/config/generate-resolvers.ts`). It is present on every entity the platform
             * generates that resolver for, plugin or no plugin, so the exact expected shape is that marker and
             * nothing besides — asserted as an equality over the WHOLE key set.
             */
            expect(
                Object.keys(customer.customFields ?? {}).sort(),
                `Customer.customFields carried ${JSON.stringify(customer.customFields)}`,
            ).toEqual(['__entityId__']);
            // And the marker really is the marker — the acting customer's own stored identifier — rather than a
            // key that merely happens to be spelled that way.
            expect(Number((customer.customFields as Record<string, unknown>).__entityId__)).toBe(
                actingCustomerDbId,
            );

            /*
             * AND THE COMPLETE DECLARED SHAPE OF `Customer` MATCHES THE UNTOUCHED BASELINE, field for field
             * and signature for signature. This is the structural half of the same claim, and it is compared
             * against `schema-shop.json` — which cannot have moved, because the introspection that produces it
             * declares its own configuration and never reads the dev-server config. A registered custom field
             * changes `customFields` from the scalar the baseline publishes into a generated object type
             * carrying members, so the signature comparison sees it whatever the field is called.
             */
            expect(fieldSignaturesOf(liveSchema, 'Customer')).toEqual(
                fieldSignaturesOf(snapshotSchema, 'Customer'),
            );

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
        let generatedErrorCodeMembers: string[];

        /*
         * The generation runs ONCE for the whole criterion, before either project is compiled, because both
         * projects compile against the same module and the arithmetic asserted below is a property of that one
         * generation. It is a `beforeAll` scoped to this describe rather than to the file so that no other
         * criterion pays for it, and its output is removed in the matching `afterAll` — the module is a build
         * product of this run and a checked-in copy would let the pair compile against a stale enum.
         */
        beforeAll(async () => {
            const generated = await generatePluginAwareShopTypes();
            generatedErrorCodeMembers = generated.members;
            expect(fs.existsSync(generated.modulePath)).toBe(true);
        }, COMPILER_INVOCATION_TIMEOUT_MS);

        afterAll(() => {
            removeGeneratedShopTypes();
        });

        it('generates the ErrorCode enum from the live schema, 32 baseline members widening to 36', () => {
            /*
             * THE PROVENANCE ASSERTION, and the reason the two compile statuses below mean anything. The enum
             * the fixtures switch over was derived by the repository's own generator from the LIVE schema of
             * the server this file booted, so its membership is a measurement of what the running server
             * publishes. Nothing in either fixture declares a member and nothing in this file supplies one to
             * the generator.
             *
             * Stated as a transition (ruling R15): the baseline width, this feature's own four additions, and
             * the total — with the four named individually, and with every baseline member read off the
             * UNTOUCHED checked-in snapshot and required to still be present, so the widening is proved
             * additive rather than merely larger.
             */
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
            // And the additions are EXACTLY those four — no fifth member arrived from anywhere.
            expect(generated.filter(member => !baseline.includes(member))).toEqual(
                [...FEATURE_ERROR_CODES].sort(),
            );
        });

        it('declares each compiler project as its own package script, pinned and identical but for the project', () => {
            /*
             * THE INVOCATION SURFACE, ASSERTED RATHER THAN ASSUMED. STORY-001-01-04's AC-8 asks for two
             * compiler PROJECTS driven by two package SCRIPTS; a suite that shelled out to its own command
             * line would satisfy the compiler half while leaving the declared half absent, and nothing would
             * say so. Each script is therefore read out of the manifest and required to be a DIRECT
             * invocation of the workspace-pinned compiler on its own project with `--noEmit`: nothing stands
             * between the script and `tsc`, and `npx` appears nowhere, because it may resolve or fetch a
             * compiler other than the pinned one and would decide this criterion by whatever happened to be
             * available.
             *
             * The strongest assertion here is the last of the command ones: with each script's own project
             * path blanked out, the two token lists must be IDENTICAL. That is what makes the pair of exit
             * statuses evidence at all. Two scripts differing in a flag, a compiler path or an extra argument
             * could exit zero and non-zero for a reason having nothing to do with exhaustiveness, and every
             * other assertion in this criterion would still hold.
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
                // The compiler is named BY PATH into the workspace's own tree, and that path is really there.
                expect(
                    path.normalize(String(tokens[1])),
                    `"${declaration.script}" must name the workspace-pinned compiler by path`,
                ).toBe(pinnedCompiler);
                expect(
                    fs.existsSync(path.join(__dirname, '..', String(tokens[1]))),
                    `"${declaration.script}" points at ${String(tokens[1])}, which does not exist`,
                ).toBe(true);
                // `-p` names THIS project and no other, and the project file sits beside the fixtures.
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
                // Nothing is emitted, and nothing is resolved through npx.
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

            /*
             * AND EACH PROJECT IS A SINGLE-FILE PROJECT NAMING ITS OWN HALF OF THE PAIR, extending the
             * repository root configuration so that `strict` is inherited rather than redeclared. Without
             * this a project could quietly widen to a directory and compile files nobody is asserting
             * anything about, or both projects could name the same fixture — which would make the two
             * statuses impossible rather than merely uninformative.
             */
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
                const { status, output } = runDeclaredCompilerScript(EXHAUSTIVE_SCRIPT);

                // NON-ZERO, which is the number AC-8 is about: the four members the LIVE schema added to the
                // generated enum make an exhaustive switch over it non-exhaustive, and the compiler says so.
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
                // AND NOT AN UNRESOLVED IMPORT. This is the load-bearing half: with the generated module
                // absent the compiler emits TS2307 AND this same TS2322, because an unresolved import still
                // leaves `code` typed by name rather than as `never`. A TS2322 on its own would therefore be
                // satisfied by a checkout in which nothing generated the module at all. The criterion below
                // drives that absent case deliberately and requires the TS2307 there.
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

                // ZERO, and the same generated enum — the same four added members and all 32 baseline ones — is
                // in scope in this project as in the one above: the pair differs only in the presence of a
                // default branch, so a clean exit here is what makes the failure above attributable to
                // exhaustiveness rather than to the fixture, or the generated module, being unbuildable.
                expect(status, `Expected a zero exit; output was:\n${output}`).toBe(0);
                // AND NO DIAGNOSTIC OF ANY KIND. The driver reports its own success on this path, so the
                // property that matters is not silence but the absence of a compiler diagnostic — a clean
                // exit accompanied by an `error TS…` line would mean the status had been decided elsewhere.
                expect(output, output).not.toContain('error TS');
            },
            COMPILER_INVOCATION_TIMEOUT_MS,
        );

        it(
            'is checkable only inside the generation window, and proves it by failing with TS2307 outside it',
            () => {
                /*
                 * WHY THE TWO STATUSES ABOVE ARE ATTRIBUTABLE TO EXHAUSTIVENESS AND NOTHING ELSE.
                 *
                 * Each fixture imports the module the `beforeAll` of this criterion generated from the live
                 * schema of the server this suite booted, and that module is a build product that is never
                 * committed — a committed copy would let the pair compile against a stale enum, which is the
                 * failure mode the generation exists to remove. So on a clean checkout, where nothing has
                 * booted a server, neither declared script can resolve it. That is intended rather than a
                 * defect, and it is exactly why the generation window belongs to this file.
                 *
                 * It is ASSERTED rather than left implicit, because leaving it implicit would hollow out the
                 * exhaustive half of the pair. Run with the module ABSENT, the exhaustive project emits
                 * TS2307 *and* its TS2322 — an unresolved import still leaves `code` typed by name rather
                 * than as `never` — so a criterion that only looked for TS2322 would pass against a
                 * completely broken checkout and prove nothing. The pairing that does mean something is
                 * therefore: INSIDE the window, TS2322 and no TS2307, which the criterion above asserts;
                 * OUTSIDE it, TS2307 from BOTH halves, including the one whose entire contract is to exit
                 * zero, which is asserted here.
                 *
                 * The live artefacts are lifted into memory and written back in the `finally`, so the
                 * criteria around this one keep the module they were written against.
                 */
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
                        // And the module it could not find is THE generated one, so a TS2307 raised by some
                        // unrelated broken import cannot stand in for this evidence.
                        expect(
                            output,
                            `"${script}" did not name the generated module in its refusal:\n${output}`,
                        ).toContain(GENERATED_SHOP_TYPES_FILE.replace(/\.ts$/, ''));
                    }
                    // And neither run created anything of its own on the way to failing: the scripts are a
                    // `--noEmit` compiler invocation and nothing else, with no wrapper that could write.
                    expect(
                        fs.existsSync(directory),
                        `${directory} was recreated by a run that had no module to compile against`,
                    ).toBe(false);
                } finally {
                    reattachGeneratedShopTypes(detached);
                }
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
            /*
             * THE GENERATOR'S OWN INPUTS ARE READ FIRST, from the introspected schema, and their names are
             * never spelled in this file. The generator derives one options input per paginated row type — the
             * row type with a trailing `List` stripped, plus `ListOptions` — and the derived name is taken off
             * the argument it generated rather than restated as a literal. That is the requirement as well as
             * the technique: the two derived identifiers may not be declared or even NAMED anywhere, so a test
             * that typed them out to assert their absence would itself be the thing it was checking for.
             */
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

            /*
             * THE PLUGIN'S OWN DOCUMENT NAMES NEITHER OF THEM, and that is the load-bearing half: the plugin
             * document is merged BEFORE the generator runs, so naming a type the document does not declare is
             * an unknown-type merge failure and the server does not start. The assertion is made against the
             * document's own source text — the thing that actually gets merged — and against the names the
             * generator just produced, so it is stronger than a literal pair as well as free of them: whatever
             * the generator derives is what the document is checked for.
             */
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
            // Nor does it hand-write an `options` argument on either paginated field.
            expect(documentSource).not.toMatch(/lines\s*\(/);

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
                /*
                 * The channel conjunct carries THE SECOND CHANNEL'S OWN IDENTIFIER — the channel the
                 * `vendure-token` header selected — and not merely some value that differs from the default's.
                 * "Not the default" is satisfied by any value whatsoever, including one belonging to no
                 * channel at all, so it evidences inequality rather than scoping. Naming the exact identifier
                 * is what makes this an assertion that the read was scoped to the channel the request acted
                 * in, which is the reason the row is unreachable.
                 */
                expect(
                    whereRequiresScopedPredicates(statement, [
                        { column: 'id', relation: listAlias, value: ownDbId },
                        { column: 'customerId', relation: listAlias, value: actingCustomerDbId },
                        { column: 'channelId', relation: listAlias, value: secondChannelDbId },
                    ]),
                    capture.format(),
                ).toBe(true);
                // And it is NOT the channel the row belongs to, which is the other half of the same fact.
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
                linesCreatedAtSort: SortOrder.ASC,
                linesIdSort: SortOrder.ASC,
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

            /*
             * ONE WARM-UP REQUEST, OUTSIDE BOTH WINDOWS. The comparison below counts every statement the
             * request issued, including the platform's own session and channel resolution, and some of that is
             * memoised per process on first use. Without a warm-up the first measured window would carry those
             * one-off statements and the second would not, so the two numbers would differ for a reason that
             * has nothing to do with the page size. Warming first makes the difference between the two windows
             * attributable to the only thing that differs between them.
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
                 * EQUALITY ACROSS THE TWO PAGE SIZES IS THE WHOLE ASSERTION, and no exact total is asserted at
                 * this boundary. Doubling the page must not add a statement ANYWHERE in the request: `lines`,
                 * `lineCount` and `viewerAccess` are resolved once per page rather than once per entry, so a
                 * per-entry resolution introduced anywhere in that chain — including one that touches only
                 * core tables — makes these two numbers diverge.
                 */
                expect(
                    statementsForSix,
                    `${captureForThree}\n---\n${wholeRequestDiagnostic('page of six')}`,
                ).toBe(statementsForThree);
                // A guard against the assertion passing because nothing was captured at all, stated at both
                // the whole-request and the plugin-statement boundary so a silent window is caught either way.
                expect(statementsForThree).toBeGreaterThan(0);
                expect(pluginStatementsForThree).toBeGreaterThan(0);
                expect(pluginStatementsForSix).toBe(pluginStatementsForThree);
            }
        });

        it('resolves viewerAccess for a whole page at zero statement cost', async () => {
            const seeded = await seedLists('Viewer access', 6);
            expect(seeded).toHaveLength(6);

            // The warm-up, for the same reason the non-growth comparison above needs one: the delta below is
            // over ALL statements, and one-off memoised platform lookups would otherwise land in whichever
            // window ran first.
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

            // BOTH HALVES ANSWERED THE SAME PAGE, so the delta is attributable to the field and not to the
            // page. And the second half really did select it: every one of the six entries reported its access,
            // which is what stops a zero delta from being the delta of a field nobody asked for.
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
                 * ZERO COST, EXPRESSED AS A ZERO DELTA OVER EVERY STATEMENT THE TWO REQUESTS ISSUED. Selecting
                 * the field added nothing, anywhere — not one statement against the plugin's tables and not one
                 * against `customer`, `channel`, `session` or any other core table. The earlier form of this
                 * assertion counted one statement against `reorder_list` and none against `reorder_list_line`,
                 * which a per-entry `customer` lookup satisfies exactly: it adds six statements the filter
                 * cannot see. A delta over the unfiltered set is the only shape of this claim that such an
                 * implementation fails.
                 */
                expect(
                    statementsWith,
                    `${captureWithout}\n---\n${wholeRequestDiagnostic('with viewerAccess')}`,
                ).toBe(statementsWithout);
                // And the request that carries the field is still the shape this feature promises: one page
                // statement, no nested read for a selection that names no lines, and no write.
                expect(capture.count(LIST_TABLE), countedDiagnostic()).toBe(1);
                expect(capture.count(LINE_TABLE), countedDiagnostic()).toBe(0);
                expect(capture.writesFor(LIST_TABLE), countedDiagnostic()).toHaveLength(0);
                // A guard against a zero delta produced by an empty window.
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

            // Both are CORE rows this test did not create, so each one's exact prior state is captured and its
            // restoration queued BEFORE it is changed — not a blanket repair of the catalogue afterwards.
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

            // A CORE ROW THIS TEST DID NOT CREATE. Two things are deliberate about the order below, and both
            // are corrections of how this read once worked.
            //
            // FIRST, THE PRICE IS READ NOW RATHER THAN TAKEN FROM THE FIXTURE. `catalogueVariants` was captured
            // in `beforeAll`; restoring to a value read then would write back a figure that need not still be
            // current, which is a contamination dressed as a cleanup.
            //
            // SECOND, THE RESTORATION IS QUEUED BEFORE THE WRITE, NOT AFTER IT. Queuing it afterwards leaves a
            // window in which the write has landed and nothing will undo it: any assertion between the two —
            // including the one on the mutation's own response — throws straight past the registration, so
            // `afterEach` has nothing to run and every later test inherits a core row this one changed. The
            // window is closed by making the queue entry precede the statement it compensates for, so there is
            // no ordering of failures in which the row is left modified.
            const [{ price: originalPrice }] = (
                await adminClient.query<GetVariantsQuery>(GET_VARIANTS_FOR_REORDER_READ)
            ).productVariants.items.filter(candidate => candidate.id === variant.id);
            expect(originalPrice, 'the variant whose price this scenario moves was not found').toBeTypeOf(
                'number',
            );
            const changedPrice = originalPrice + 4321;
            // EVERY COLUMN of both core rows this holds — the variant row, and the `product_variant_price`
            // rows that are where a price actually lives — captured before the write. Restoring by issuing the
            // inverse Admin mutation would put the NUMBER back and advance the `updatedAt` of both rows while
            // doing so, leaving the next test reading rows that are not the rows that were there.
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
            // AND THE DELTA IS REAL, established by an INDEPENDENT read rather than by the mutation's own
            // reply: a scenario named "a price changed" whose price did not change would assert nothing, and
            // the writing operation is the one witness that cannot establish that it wrote.
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

            // THE PRIOR STATE, READ AND ITS RESTORATION QUEUED BEFORE ANYTHING IS WRITTEN. Both halves are
            // load-bearing. Registering after the mutation would leave the row changed with nothing queued to
            // put it back if the write committed and then something threw — and every following test in this
            // file would run against a catalogue this one had modified. Reading first is what lets the
            // restoration branch correctly: this fixture ships English alone, so the expectation is that there
            // is no German row and the restoration is a delete, but a fixture that already carried one would
            // have it PUT BACK rather than deleted. Which of the two happened is asserted rather than assumed.
            const priorGerman = await captureVariantTranslation(variant.id, LanguageCode.de);
            expect(
                priorGerman.row,
                'the seeded catalogue is expected to ship English alone; if that changes, the restoration ' +
                    'below puts the prior row back rather than deleting it, and this expectation is what ' +
                    'records which of the two this run took',
            ).toBeUndefined();

            // A SECOND-LANGUAGE NAME for the variant, added through the Admin API so the two requests really do
            // resolve different strings — two identical names would make this assertion vacuous.
            await adminClient.query<UpdateVariantsMutation>(UPDATE_VARIANTS_FOR_REORDER_READ, {
                input: [
                    {
                        id: variant.id,
                        translations: [{ languageCode: LanguageCode.de, name: germanVariantName }],
                    },
                ],
            });

            // AND THE SECOND LANGUAGE REALLY IS THERE NOW, established by an independent read rather than by
            // the mutation's own reply: a scenario named "two languages" whose second language was not written
            // would assert nothing, and the writing operation is the one witness that cannot establish that it
            // wrote.
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
        it('emits no migration file against a schema the checked-in migration created', async () => {
            const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'reorder-read-migration-'));
            // Queued BEFORE the call, so the directory is removed even if the assertion below fails.
            temporaryDirectories.push(outputDir);
            const snapshotDir = await fs.mkdtemp(path.join(os.tmpdir(), 'reorder-read-schema-'));
            temporaryDirectories.push(snapshotDir);

            // WHAT THE GENERATOR IS POINTED AT IS THE MIGRATION'S OWN OUTPUT, which is the whole point of this
            // assertion rather than a refinement of it. `generateMigration` forces `synchronize: false` and
            // `migrationsRun: false` on the connection it opens (`packages/core/src/migrate.ts`), so it diffs
            // the entity declarations against whatever schema is already in the database — and under every
            // initializer this suite can run, that schema was built by SYNCHRONISING those same declarations.
            // An empty result against it would be reported whether the checked-in migration is faithful,
            // broken or absent. So the two plugin tables are dropped and recreated by the artefact first, and
            // the diff is taken against that.
            await rebuildPluginSchemaFromCheckedInMigration();

            // THE GENERATOR'S OWN DECISION INPUT, read from the running server's connection, because that is
            // where the diagnostic lives: `generateMigration` writes a file if and only if this log's
            // `upQueries` is non-empty, so naming the offending statements turns a bare `undefined`
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
            // `undefined` and writes NO FILE; the platform logs "No changes in database schema were found -
            // cannot generate a migration." on this path (`packages/core/src/migrate.ts`).
            const generated = await generateMigration(
                await generatorConfigAgainstMigratedSchema(snapshotDir),
                {
                    name: 'storyOneOhOneOhFourShouldEmitNothing',
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

            // The output directory is a temporary one OUTSIDE the repository, so nothing is ever written under
            // this package's own migrations directory and `git status --porcelain` is clean after a run
            // whatever this assertion finds.
            expect(path.isAbsolute(outputDir)).toBe(true);
            expect(outputDir.startsWith(path.join(__dirname, '..'))).toBe(false);

            // The running server is unaffected by the generation pass, asserted rather than assumed because
            // that pass loads and then RESETS the platform's module-level configuration. The two tables are
            // empty at this point, the rebuild having dropped and recreated them, so this also proves the
            // migration's own output accepts the writes this story reads back.
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

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
// THE CORRELATED-OWNERSHIP VERIFIER, TESTED AS THE LOAD-BEARING INSTRUMENT IT IS
//
// Every assertion in this file that a `reorder_list_line` write is scoped to its owner is decided by
// `whereRequiresCorrelatedOwnership`: a line row stores its parent's identifier, a variant reference and a
// quantity, so the acting customer and the active channel can only reach the statement through a sub-query
// over the parent table (FEATURE-001-01 §2.11). If that parser certifies a statement which does not really
// scope the row, every suite trusting it passes while the write reaches rows nobody owns — and it passes
// silently, because nothing else is looking. A verifier is worth only what its own negative cases prove,
// and those cases have to be COMMITTED to prove anything twice: a check performed once by hand cannot fail
// when a later edit weakens the parser.
//
// IT LIVES HERE RATHER THAN IN A FILE OF ITS OWN, AND THAT IS AN INVENTORY DECISION RATHER THAN A
// PREFERENCE. AAP §0.5.1.8 enumerates six end-to-end suites for this package and `e2e/fixtures/query-capture.ts`
// as a fixture module with no specification of its own, so a seventh discovered `*.e2e-spec.ts` widens the
// frozen evidence set whatever it contains. These cases are therefore folded into the suite whose numbers
// depend on the parser most — every statement-count claim below reads it — wrapped in one `describe` so its
// fixtures and constants stay in their own scope. They need none of the machinery around them: the module
// under test is pure, importing `typeorm` types only, reaching no database and starting no server.
//
// The statements are the REAL renderings, not invented SQL. The PostgreSQL, MySQL/MariaDB and sql.js forms
// were taken from what TypeORM 0.3.28 actually emits for `ReorderListService.ownedListExistsClause()` on
// each engine: `$n` and double-quoted identifiers on PostgreSQL, positional `?` and backticks on the MySQL
// family, and inline numeric literals with an empty parameter array on sql.js. Each is fed through
// `QueryCaptureLogger` exactly as a suite would receive it, so the capture path is exercised alongside the
// parser and the dialect is read from the runner's own connection rather than passed in beside it.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════

describe('the query-capture instrument this suite measures with', () => {
    /**
     * The correlated-ownership verifier, tested as the load-bearing instrument it is.
     *
     * ★ **WHY THIS SPEC EXISTS.** Every future assertion that a `reorder_list_line` write is scoped to its
     * owner is decided by
     * {@link whereRequiresCorrelatedOwnership}: a line row stores its parent's identifier, a variant reference
     * and a quantity, so the acting customer and the active channel can only reach the statement through a
     * sub-query over the parent table (FEATURE-001-01 §2.11). If this parser certifies a statement that does
     * not really scope the row, every suite that trusts it passes while the write reaches rows nobody owns —
     * and it passes silently, because nothing else in the suite is looking. A verifier is therefore only worth
     * what its own negative cases prove, and those cases have to be COMMITTED to prove anything twice: a check
     * performed once by hand cannot fail when a later edit weakens the parser.
     *
     * ★ **WHICH RUNNER EXECUTES IT, AND WHY THAT ONE.** The `e2e-spec` suffix places this file in the
     * end-to-end run [e2e-common/vitest.config.mts:L7], which is the runner that owns everything under
     * `e2e/`. The package's unit run reaches into `src` and nowhere else
     * [packages/reorder-plugin/vitest.config.mts], matching the sibling that states the same boundary
     * [packages/create/vitest.config.mts:L8]; a `.spec.ts` sitting here would breach that boundary, which is
     * exactly what it did until this file was renamed. Nothing is lost by the move and nothing extra is
     * required by it: the module under test is pure — it imports `typeorm` types only, reaches no database
     * and starts no server — so it needs none of the machinery the end-to-end configuration supplies, and
     * the e2e run applies the same `unplugin-swc` decorator transform the unit run does.
     *
     * ★ **AN ADDITION TO THE PLANNED FILE SET, DECLARED HERE.** AAP §0.5.1.8 enumerates
     * `e2e/fixtures/query-capture.ts` as a fixture module and enumerates no spec for it; this file is
     * therefore an addition rather than a planned artefact, admitted by the in-scope pattern
     * `packages/reorder-plugin/e2e/fixtures/*.ts` (AAP §0.6.1.2) and declared under §0.8.2's
     * no-silent-deviation obligation. It is kept because an instrument whose negative cases are not
     * committed protects nothing against a later edit, and it is a fixture spec rather than a seventh
     * end-to-end suite: it boots no server, opens no database, seeds nothing and destroys nothing.
     *
     * **The statements are the real renderings**, not invented SQL. The PostgreSQL, MySQL/MariaDB and sql.js
     * forms below were taken from what TypeORM 0.3.28 actually emits for
     * `ReorderListService.ownedListExistsClause()` on each engine: `$n` and double-quoted identifiers on
     * PostgreSQL, positional `?` and backticks on the MySQL family, and inline numeric literals with an empty
     * parameter array on sql.js. Each is fed through {@link QueryCaptureLogger} exactly as a suite would
     * receive it, so the capture path is exercised alongside the parser and the dialect is read from the
     * runner's own connection rather than passed in beside it.
     */

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
     *
     * The runner is the smallest object the logger reads — `connection.options.type` for the dialect and
     * `isTransactionActive` for the transaction flag — and it is cast rather than constructed because
     * TypeORM's `QueryRunner` is a large interface and none of the rest of it is consulted.
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
                // ★ THE FORM A DEPLOYMENT WITH `dbConnectionOptions.schema` ACTUALLY RECEIVES. The service
                // builds the sub-query's relation from `metadata.tablePath` rather than from `tableName`, so
                // under a configured schema it arrives qualified — which is a tenant-isolation requirement
                // rather than a spelling choice, because the driver never issues `SET search_path` from that
                // option (`node_modules/typeorm/driver/postgres/PostgresDriver.js:L266-L281`) and a bare
                // relation would resolve through the session's own path into another schema. This instrument
                // decides every line-write ownership assertion in this package, so it has to certify the
                // qualified form: were it to refuse it, those assertions would fail closed on precisely the
                // deployment whose isolation matters most, and the failure would look like a scope defect.
                const statement = postgresAdjust(
                    'EXISTS (SELECT 1 FROM "tenant_schema"."reorder_list" "owned_list_scope" ' +
                        'WHERE "owned_list_scope"."id" = "reorderListId" ' +
                        'AND "owned_list_scope"."customerId" = $4 AND "owned_list_scope"."channelId" = $5)',
                );

                expect(whereRequiresCorrelatedOwnership(statement, ownedLineScope())).toBe(true);
            });

            it('still refuses a qualified relation whose final segment is the wrong table', () => {
                // The control on the case above, and the reason it is not a loophole: the relation is read as
                // its LAST segment, so a schema named after the parent table cannot smuggle a sub-query over
                // some other relation past the check.
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
                // The type forbids this, which is the first line of defence; the cast is the point of the test.
                // A suite compiled against an earlier shape, a plain-JavaScript caller, or a fixture identifier
                // that was never assigned can all present a predicate with no value — and the general predicate
                // helper reads an absent value as "require only that this column is compared", which certifies a
                // sub-query whose tenant parameters are bound the wrong way round.
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
                // Every other part of the requirement is met: the right table, a real correlation, and both
                // scope comparisons bound to the right values. `COUNT(*)` without a `GROUP BY` still returns one
                // row — `0` — when nothing matched, so the `EXISTS` is true for a line nobody owns and the write
                // it guards reaches the whole table.
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
                // `ol.id = $3` names whichever list that parameter carries. It is not a correlation at all, and a
                // statement addressing the line by its own identifier then reaches a line of any list.
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

                // Both of the others refuse the sub-query, deliberately and correctly for what each claims: one
                // recognises only `column <op> operand` as a comparison, and the other blanks any parenthesised
                // SELECT before it looks for a column name. Neither can state the claim a line write makes, which
                // is why the correlated helper exists — and why a suite must not fall back to them.
                expect(
                    whereRequiresScopedPredicates(statement, [
                        { column: 'customerId', value: CUSTOMER_ID },
                        { column: 'channelId', value: CHANNEL_ID },
                    ]),
                ).toBe(false);
                expect(whereMentionsColumns(statement, ['customerId'])).toBe(false);

                // What they DO answer for is the row's own identifier, which the correlated helper does not
                // assert — so a complete line-write claim uses both.
                expect(whereMentionsColumns(statement, ['id', 'reorderListId'])).toBe(true);
                expect(whereRequiresCorrelatedOwnership(statement, ownedLineScope())).toBe(true);
            });
        });
    });

    describe('the diagnostic dump, which must not publish what it captured', () => {
        /**
         * A value shaped like the one that makes this a security property rather than a preference: the
         * platform's own session token, which every authenticated request looks a session up by.
         *
         * It is built from fragments so that this file cannot match itself: the cases below assert that a
         * string is ABSENT from a dump, and a literal spelling of it here would be present in the very
         * source the reader is reading. (The suite's own consistency guards scan file text for exactly this
         * reason.)
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
            expect(logger.statements).toHaveLength(2);
            return logger;
        }

        it('describes a bound value and an inline literal instead of rendering either', () => {
            // ★ WHY THIS IS A SECURITY PROPERTY AND NOT A FORMATTING PREFERENCE. The instrument is attached
            // to the whole connection, so it captures the platform's statements as well as the plugin's —
            // including the session look-up an authenticated request performs, whose value is the caller's
            // credential. Sixty-eight assertion sites in this package pass `capture.format()` as their
            // failure message, and a failure message goes into the run's log: on continuous integration that
            // log is readable by everyone who can see the build. A dump that renders values therefore turns
            // any flaky count assertion into a credential disclosure.
            const dump = captureTokenBearingStatement().format();

            expect(dump, 'the dump must not contain the value it captured').not.toContain(TOKEN);
            // The SHAPE survives, because that is what a reader diagnosing a count actually needs.
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

            // And the capture itself was never altered by either rendering.
            expect(logger.statements[0].parameters).toEqual([TOKEN]);
        });

        it('fails closed on a literal it cannot see the end of', () => {
            // A truncated statement, or one whose quoting this scanner cannot read, must not fall back to
            // printing the remainder. Everything from the opening quote onwards is replaced.
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
            // so an unredacted error line would publish what the parameter list no longer does. The
            // constraint NAME survives, which is what the suites that assert on a violation actually read.
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
            // And the error is still the driver's own text under the opt-in, so an investigation loses
            // nothing.
            expect(logger.format(undefined, { revealValues: true })).toContain(`Duplicate entry '${TOKEN}'`);
        });

        it('consumes an escaped quote inside a literal rather than ending the literal early', () => {
            // Both conventions the target engines use, so a value containing a quote is still consumed whole:
            // a scanner that ended the literal at the escape would render the rest of the value as SQL.
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
