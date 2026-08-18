/*
 * Shared GraphQL documents for the reorder-plugin end-to-end suites.
 *
 * THREE DECISIONS ARE RECORDED HERE SO THEY ARE NOT RE-LITIGATED.
 *
 * 1. Plain `graphql-tag` with hand-written result types, not the typed-document-builder route the
 *    two sibling `e2e/graphql` folders take. Those folders type their documents by feeding a typed
 *    document helper a generated schema-environment declaration produced out of a checked-in
 *    introspection snapshot. No such generated
 *    type can exist for this plugin's types: `schema-shop.json` is never edited and never
 *    regenerated for this feature, and the introspection that produces it declares its own config
 *    with `plugins: [AdminUiPlugin]` and never imports `packages/dev-server/dev-config.ts`
 *    [scripts/codegen/download-introspection-schema.ts]. So the plugin's object types, inputs,
 *    unions and error results are absent from the snapshot by construction, and the documents below
 *    are tagged with `graphql-tag` — the idiom the structural precedent uses
 *    [packages/dev-server/example-plugins/wishlist-plugin/api/api-extensions.ts:L1] and the one
 *    core's own e2e specs use — while their result and variables types are written out by hand at
 *    the foot of this file.
 *
 *    Hand-written does not mean hand-copied. Where a type the PLATFORM publishes is involved —
 *    `DeletionResult`, `SortOrder`, the baseline half of `ErrorCode` — it is imported from the
 *    generated SHOP module rather than transcribed, so a member the platform renames or removes
 *    breaks compilation here instead of drifting silently. Only the plugin's own types, which no
 *    generated artefact in this repository can ever carry, are written out.
 *
 * 2. The `options` argument is passed as an INLINE object literal whose leaves are core-typed
 *    variables (`Int` and `SortOrder`), and neither of the two per-row options inputs the platform
 *    derives from `ReorderListList` and `ReorderListLineList` is named anywhere in this file. The
 *    plugin's own document declares no `options` argument; the platform's list-options generator
 *    adds one to every field returning a `PaginatedList` implementor, root or nested, and owns the
 *    input types it derives [packages/core/src/api/config/generate-list-options.ts:L41-L48,
 *    L87-L99]. A document may name such an input only where the same document declares it bare,
 *    which this plugin's schema deliberately does not do
 *    [packages/reorder-plugin/src/api/api-extensions.ts]. Naming one here would couple these
 *    documents to a type this plugin does not own, so the inline form is used throughout.
 *
 *    One GraphQL coercion rule makes that form complete: an input-object field whose value is a
 *    variable the request did not provide is OMITTED from the coerced object, so
 *    `options: { take: $take }` with `$take` unsupplied coerces to `options: {}` rather than to
 *    `{ take: null }`. Passing no variable is therefore equivalent to passing an empty options
 *    object.
 *
 *    **And an empty options object receives the plugin's default page size just as an omitted
 *    argument does.** The resolvers apply it with `args.options?.take ?? <configured default>`
 *    [packages/reorder-plugin/src/api/reorder-list-shop.resolver.ts] and
 *    `supplied?.take ?? <configured default>`
 *    [packages/reorder-plugin/src/api/reorder-list-entity.resolver.ts], and `{}`, an absent argument
 *    and an explicit `take: null` all reach that expression with no page size, so all three take the
 *    default. The literal-omission documents below (`GET_ACTIVE_CUSTOMER_REORDER_LISTS` and
 *    `GET_ACTIVE_CUSTOMER_REORDER_LIST`) therefore exist for what only a document with NO argument in
 *    its text can exercise: the SCHEMA-level default of `includeShared: Boolean = false`, which the
 *    executor supplies only for an absent argument, and the argument-free request shape a client
 *    that knows nothing of paging actually sends. They are not the only route to the plugin's own
 *    page-size default, and this file must not claim they are.
 *
 * 3. This module is the single authority for these documents. A contract change must be a one-file
 *    change, so no suite may inline a copy of any document declared here.
 *
 * The published contract these documents are transcribed from is
 * [packages/reorder-plugin/src/api/api-extensions.ts], which itself transcribes
 * [tickets/EPIC-001/FEATURE-001-01-named-reorder-lists.md:§2.6] — the single authority for the
 * surface. Nothing below selects a monetary, currency or stock field, because neither plugin
 * payload carries one.
 *
 * A note on the wording above and in the comments below: several things this file must NOT contain
 * are described rather than spelled — the two per-row options inputs, the typed-document route, the
 * monetary and availability field names, and the request-deduplication key the add input does not
 * declare. That is deliberate and follows the plugin schema's own precedent
 * [packages/reorder-plugin/src/api/api-extensions.ts]: naming a forbidden symbol even in prose
 * makes the invariant "this file contains no such thing" unverifiable by search, so each is
 * described instead and every one of those searches returns nothing over this file.
 */
// The SHOP generated module, not the Admin one. These documents are executed against the Shop API, so the
// Shop schema is their authority — and the two modules are not interchangeable: their `ErrorCode` enums
// differ by 47 members between them (16 published only by the Shop API, 31 only by the Admin API), so a
// document typed against the Admin enum would accept a code the Shop API can never return and reject one it
// does. `DeletionResult` and `SortOrder` happen to carry identical members in both today, which is exactly
// why the wrong import survives review: it is right by coincidence rather than by contract, and the
// coincidence is not a property either schema promises to keep.
import type { DeletionResult, ErrorCode, SortOrder } from '@vendure/common/lib/generated-shop-types';
import gql from 'graphql-tag';

// ---------------------------------------------------------------------------------------------
// Fragments
// ---------------------------------------------------------------------------------------------

/**
 * Every selectable field of `ReorderListLine`.
 *
 * `productVariant` is capped at `{ id name }` on purpose. The line stores a variant reference and
 * an integer quantity and no monetary or stock value, so selecting a monetary amount, a currency
 * code or an availability field here would be the one thing able to falsify the suites' assertion
 * that this feature's payloads carry none.
 *
 * `productVariant` is nullable in the schema while `productVariantId` is not, and the asymmetry has a
 * precise reading a future read test must not widen. The line is ALWAYS retained and the stored
 * identifier is ALWAYS non-null. `productVariant` resolves to `null` in exactly three cases, all of
 * them "not resolvable in the active channel": the variant is assigned to another channel, its row has
 * been SOFT-deleted (the platform's own variant deletion, which sets a timestamp and leaves the row in
 * place), or the channel-scoped load simply does not answer for the identifier.
 *
 * A DISABLED variant is NOT one of them and resolves normally. It is still resolvable in the channel
 * and its `enabled` value is readable on the variant type the platform already publishes, so nulling it
 * would hide a variant the contract says to return — a test expecting `null` for a disabled variant
 * would be asserting the opposite of the requirement and would pass only against a defect. Neither the
 * disabled flag nor the deletion timestamp is selected here in any case: a saved list records intent
 * rather than availability, and surfacing availability belongs to a later feature.
 */
export const REORDER_LIST_LINE_FRAGMENT = gql`
    fragment ReorderListLineFields on ReorderListLine {
        id
        createdAt
        updatedAt
        quantity
        productVariantId
        productVariant {
            id
            name
        }
    }
`;

/**
 * Every selectable field of `ReorderList` EXCEPT `lines`.
 *
 * The omission is what makes this fragment composable: a document may spread it and also select
 * its own `lines(options: { ... })` in the same selection set without a field conflict. Documents
 * that want the default, unpaged nested collection spread {@link REORDER_LIST_WITH_LINES_FRAGMENT}
 * instead.
 *
 * `lineCount` is the stored counter column and arrives with the row; it is the total number of
 * stored lines and is deliberately NOT the length of any returned `lines` page.
 */
export const REORDER_LIST_FRAGMENT = gql`
    fragment ReorderListFields on ReorderList {
        id
        createdAt
        updatedAt
        name
        lineCount
        viewerAccess {
            access
            grantedCapabilities
        }
    }
`;

/**
 * `ReorderList` including its nested `lines` page.
 *
 * The `lines` selection carries NO `options` argument, so the plugin's configured default nested
 * page size applies. A document needing an explicit nested window selects
 * {@link REORDER_LIST_FRAGMENT} and writes its own paged `lines` field instead — a fragment cannot
 * reference operation variables without becoming unusable in operations that do not declare them.
 */
export const REORDER_LIST_WITH_LINES_FRAGMENT = gql`
    fragment ReorderListWithLines on ReorderList {
        ...ReorderListFields
        lines {
            totalItems
            items {
                ...ReorderListLineFields
            }
        }
    }
    ${REORDER_LIST_FRAGMENT}
    ${REORDER_LIST_LINE_FRAGMENT}
`;

// ---------------------------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------------------------

/**
 * The canonical collection read, with NO arguments in the document text at all.
 *
 * That is the point of it, on two counts. It is the request an unpaged client actually sends, so it
 * exercises the plugin's configured default page size on the path a caller reaches by writing
 * nothing. And literal omission of `includeShared` is the ONLY way to exercise that argument's
 * schema-level default of `false`, because the executor substitutes a declared default for an absent
 * argument and not for one supplied with a value.
 *
 * What it is NOT is the only route to the page-size default: an empty `options: {}` object reaches
 * the resolver's `args.options?.take ?? <configured default>` with no page size and takes the same
 * default. A suite may use either form for that assertion; it may not claim they differ.
 */
export const GET_ACTIVE_CUSTOMER_REORDER_LISTS = gql`
    query GetActiveCustomerReorderLists {
        activeCustomerReorderLists {
            totalItems
            items {
                ...ReorderListFields
            }
        }
    }
    ${REORDER_LIST_FRAGMENT}
`;

/**
 * The canonical single-list read.
 *
 * Its root selection is deliberately invariant — `$id` is the only variable — because this is the
 * document the non-disclosure matrix uses. Every inaccessible case (absent id, another customer's
 * list, another channel's list, a malformed id, no authenticated session) must produce a `data` of
 * exactly `{ activeCustomerReorderList: null }`, deep-equal to one another and to the null returned
 * for an unknown id. Anything in the selection that could vary between calls would weaken that.
 *
 * The nested `lines` page carries no `options` argument, so this document also covers the
 * omitted-nested-page-size half of the read contract.
 */
export const GET_ACTIVE_CUSTOMER_REORDER_LIST = gql`
    query GetActiveCustomerReorderList($id: ID!) {
        activeCustomerReorderList(id: $id) {
            ...ReorderListWithLines
        }
    }
    ${REORDER_LIST_WITH_LINES_FRAGMENT}
`;

/**
 * The collection read carrying `includeShared` as a variable, so the argument is reachable at
 * `true` and at `false` as well as by literal omission through
 * {@link GET_ACTIVE_CUSTOMER_REORDER_LISTS}.
 *
 * The non-default value is ACCEPTED and returns the same page while no grant row can exist — the
 * shared set is empty by construction rather than withheld — so a suite asserts page equality
 * across both values rather than asserting a refusal.
 */
export const GET_ACTIVE_CUSTOMER_REORDER_LISTS_INCLUDE_SHARED = gql`
    query GetActiveCustomerReorderListsIncludeShared($includeShared: Boolean) {
        activeCustomerReorderLists(includeShared: $includeShared) {
            totalItems
            items {
                ...ReorderListFields
            }
        }
    }
    ${REORDER_LIST_FRAGMENT}
`;

/**
 * The single-list read carrying `includeShared` as a variable.
 *
 * Required because every inaccessible case is asserted under BOTH values of the argument, with the
 * responses byte-identical to each other and to the response from
 * {@link GET_ACTIVE_CUSTOMER_REORDER_LIST}. The selection set is therefore identical to that
 * document's, so a payload comparison across the two is meaningful.
 */
export const GET_ACTIVE_CUSTOMER_REORDER_LIST_INCLUDE_SHARED = gql`
    query GetActiveCustomerReorderListIncludeShared($id: ID!, $includeShared: Boolean) {
        activeCustomerReorderList(id: $id, includeShared: $includeShared) {
            ...ReorderListWithLines
        }
    }
    ${REORDER_LIST_WITH_LINES_FRAGMENT}
`;

/**
 * The collection read with explicit page arguments and an explicit total-order sort.
 *
 * Three obligations run through this one document: a paginated assertion names the page arguments
 * it sent; the default sort is a total order, proved by asking for `createdAt DESC` then `id DESC`
 * and observing a stable page across rows sharing a timestamp; and a `take` one greater than the
 * configured Shop list-query limit is refused by the platform before any row is read.
 *
 * Any subset of the four variables may be left unsupplied — an input-object field whose variable
 * was not provided is omitted from the coerced object — so `{ take: 2 }` alone yields
 * `options: { take: 2 }` with no sort and no skip.
 */
export const GET_ACTIVE_CUSTOMER_REORDER_LISTS_PAGINATED = gql`
    query GetActiveCustomerReorderListsPaginated(
        $take: Int
        $skip: Int
        $createdAtSort: SortOrder
        $idSort: SortOrder
    ) {
        activeCustomerReorderLists(
            options: { take: $take, skip: $skip, sort: { createdAt: $createdAtSort, id: $idSort } }
        ) {
            totalItems
            items {
                ...ReorderListFields
            }
        }
    }
    ${REORDER_LIST_FRAGMENT}
`;

/**
 * The collection read windowing BOTH the outer page and each entry's nested `lines` page.
 *
 * This is the per-page non-growth document: the same requested field set is sent twice, once for an
 * outer page of three lists and once for six, and the number of statements issued against
 * `reorder_list` and `reorder_list_line` must be equal across the two. Only the outer `$take`
 * changes between the calls, which is why the nested window is a separate variable.
 *
 * It is also the proof that the generator supplies `options` on a NESTED field and not only on a
 * root query.
 */
export const GET_ACTIVE_CUSTOMER_REORDER_LISTS_WITH_LINE_PAGES = gql`
    query GetActiveCustomerReorderListsWithLinePages($take: Int, $linesTake: Int) {
        activeCustomerReorderLists(options: { take: $take }) {
            totalItems
            items {
                ...ReorderListFields
                lines(options: { take: $linesTake }) {
                    totalItems
                    items {
                        ...ReorderListLineFields
                    }
                }
            }
        }
    }
    ${REORDER_LIST_FRAGMENT}
    ${REORDER_LIST_LINE_FRAGMENT}
`;

/**
 * The single-list read with an explicit window and total-order sort on the nested `lines` page.
 *
 * It carries three obligations. A nested `take` above the configured Shop limit is refused with the
 * platform's own input error and no partial nested page. The lines total order is `createdAt ASC`
 * then `id ASC`, so a page boundary cannot reorder lines sharing a timestamp. And `lineCount`,
 * `lines.totalItems` and the length of `lines.items` are all observable in one response, which is
 * what lets a suite assert that they DIFFER on a list whose stored line total exceeds the requested
 * nested page size — three distinct facts rather than one number under three names.
 *
 * Spreading {@link REORDER_LIST_FRAGMENT} rather than the with-lines fragment is deliberate: the
 * former carries no `lines` field, so this document's own paged `lines` selection is the only one.
 */
export const GET_ACTIVE_CUSTOMER_REORDER_LIST_WITH_PAGED_LINES = gql`
    query GetActiveCustomerReorderListWithPagedLines(
        $id: ID!
        $linesTake: Int
        $linesSkip: Int
        $linesCreatedAtSort: SortOrder
        $linesIdSort: SortOrder
    ) {
        activeCustomerReorderList(id: $id) {
            ...ReorderListFields
            lines(
                options: {
                    take: $linesTake
                    skip: $linesSkip
                    sort: { createdAt: $linesCreatedAtSort, id: $linesIdSort }
                }
            ) {
                totalItems
                items {
                    ...ReorderListLineFields
                }
            }
        }
    }
    ${REORDER_LIST_FRAGMENT}
    ${REORDER_LIST_LINE_FRAGMENT}
`;

// ---------------------------------------------------------------------------------------------
// Mutations
//
// Every mutation selects `__typename` first and then one inline fragment per member its union
// actually declares. Both halves matter. `__typename` is the only wire-observable evidence that
// each union's `__resolveType` returns the exact type name — the shipped `createErrorResultGuard`
// narrows on a predicate rather than on the type name, so without it a suite would have to infer
// the member from field presence. And selecting every declared member is what lets each error
// result be returned once inside `data` with its own fields populated. Union membership is exact
// and asymmetric: a fragment on a type a union does not declare fails validation.
//
// All five non-delete mutations return `ReorderList` on success — including the three that operate
// on a LINE. There is no operation whose success member is a `ReorderListLine`.
// ---------------------------------------------------------------------------------------------

/**
 * `createReorderList`. Union: `ReorderList | ReorderListNameConflictError | ReorderListLimitError`.
 *
 * No not-found member: there is no row to address. A name whose canonical form is empty or over the
 * fixed length bound is not a union member either — it is refused by a top-level `USER_INPUT_ERROR`
 * with `data` null, which is why this feature declares four error results and not five.
 */
export const CREATE_REORDER_LIST = gql`
    mutation CreateReorderList($input: CreateReorderListInput!) {
        createReorderList(input: $input) {
            __typename
            ... on ReorderList {
                ...ReorderListWithLines
            }
            ... on ReorderListNameConflictError {
                errorCode
                message
                conflictingNameKey
            }
            ... on ReorderListLimitError {
                errorCode
                message
                maxItems
            }
        }
    }
    ${REORDER_LIST_WITH_LINES_FRAGMENT}
`;

/**
 * `updateReorderList`, the rename path. Union:
 * `ReorderList | ReorderListNotFoundError | ReorderListNameConflictError`.
 *
 * No limit member: a rename creates no row, so no bound can be breached.
 */
export const UPDATE_REORDER_LIST = gql`
    mutation UpdateReorderList($input: UpdateReorderListInput!) {
        updateReorderList(input: $input) {
            __typename
            ... on ReorderList {
                ...ReorderListWithLines
            }
            ... on ReorderListNotFoundError {
                errorCode
                message
            }
            ... on ReorderListNameConflictError {
                errorCode
                message
                conflictingNameKey
            }
        }
    }
    ${REORDER_LIST_WITH_LINES_FRAGMENT}
`;

/**
 * `deleteReorderList`. Union: `DeletionResponse | ReorderListNotFoundError`.
 *
 * This is the one operation whose argument breaks the pattern: a bare `ID!`, not an input object.
 *
 * Its success member is the platform's own `DeletionResponse`, reused verbatim rather than replaced
 * by a plugin-owned deletion payload.
 *
 * `DeletionResponse.message` is selected under the alias `deletionMessage`, and the alias is
 * REQUIRED rather than cosmetic. Both members declare a `message` field, but with different
 * nullability — `String` on `DeletionResponse` and `String!` on the error result — and GraphQL's
 * overlapping-fields rule does NOT unwrap nullability before comparing: a Non-Null type paired with
 * a nullable one conflicts outright, and being inline fragments on mutually exclusive types relaxes
 * only the name-and-arguments half of the check, never the response-shape half
 * [node_modules/graphql/validation/rules/OverlappingFieldsCanBeMergedRule.js:doTypesConflict]. So
 * selecting both under one response key makes the document INVALID and the request is refused before
 * it reaches a resolver. Aliasing one of them is the remedy graphql-js itself prescribes, and the
 * alias is placed on the success branch so every error result in this file keeps an identical shape
 * and one `ReorderListNotFoundErrorShape` serves all five operations that can return it.
 */
export const DELETE_REORDER_LIST = gql`
    mutation DeleteReorderList($id: ID!) {
        deleteReorderList(id: $id) {
            __typename
            ... on DeletionResponse {
                result
                deletionMessage: message
            }
            ... on ReorderListNotFoundError {
                errorCode
                message
            }
        }
    }
`;

/**
 * `addItemToReorderList`. Union:
 * `ReorderList | ReorderListNotFoundError | ReorderListLimitError`.
 *
 * The input declares exactly three fields and carries no request-deduplication key: two deliveries
 * of one add ACCUMULATE, the delivery guarantee is at-least-once, and `adjustReorderListLine`'s
 * absolute set is the deterministic remedy. A non-positive or over-maximum quantity is a top-level
 * `USER_INPUT_ERROR` rather than a union member, and an unresolvable variant likewise.
 */
export const ADD_ITEM_TO_REORDER_LIST = gql`
    mutation AddItemToReorderList($input: AddItemToReorderListInput!) {
        addItemToReorderList(input: $input) {
            __typename
            ... on ReorderList {
                ...ReorderListWithLines
            }
            ... on ReorderListNotFoundError {
                errorCode
                message
            }
            ... on ReorderListLimitError {
                errorCode
                message
                maxItems
            }
        }
    }
    ${REORDER_LIST_WITH_LINES_FRAGMENT}
`;

/**
 * `adjustReorderListLine`, which SETS an absolute quantity rather than adding to one. Union:
 * `ReorderList | ReorderListNotFoundError | ReorderListLineNotFoundError`.
 *
 * No limit member: the line bound is enforced on the add path only, since adjusting an existing line
 * creates no row. The success member is the whole `ReorderList`, not the adjusted line.
 */
export const ADJUST_REORDER_LIST_LINE = gql`
    mutation AdjustReorderListLine($input: AdjustReorderListLineInput!) {
        adjustReorderListLine(input: $input) {
            __typename
            ... on ReorderList {
                ...ReorderListWithLines
            }
            ... on ReorderListNotFoundError {
                errorCode
                message
            }
            ... on ReorderListLineNotFoundError {
                errorCode
                message
            }
        }
    }
    ${REORDER_LIST_WITH_LINES_FRAGMENT}
`;

/**
 * `removeReorderListLine`. Union:
 * `ReorderList | ReorderListNotFoundError | ReorderListLineNotFoundError`.
 *
 * The success member is the whole `ReorderList`, so the same response carries the decremented
 * `lineCount` and the shortened `lines` page — which is what lets one assertion cover both.
 */
export const REMOVE_REORDER_LIST_LINE = gql`
    mutation RemoveReorderListLine($input: RemoveReorderListLineInput!) {
        removeReorderListLine(input: $input) {
            __typename
            ... on ReorderList {
                ...ReorderListWithLines
            }
            ... on ReorderListNotFoundError {
                errorCode
                message
            }
            ... on ReorderListLineNotFoundError {
                errorCode
                message
            }
        }
    }
    ${REORDER_LIST_WITH_LINES_FRAGMENT}
`;

// ---------------------------------------------------------------------------------------------
// Result and variables types
//
// Hand-written, for the reason the header records: no generator can produce them while the
// introspection snapshot these documents run against is never regenerated for this plugin. Naming
// follows the convention the repository's generated types already use — `<OperationName>Query` /
// `<OperationName>QueryVariables` and `<OperationName>Mutation` / `<OperationName>MutationVariables`
// — so a suite reads them the way it reads a generated type.
//
// Scalars are mapped exactly as the platform's own generated types map them: `ID` is
// `string | number`, `Int` is `number`, `String` is `string`, `Boolean` is `boolean`, and `DateTime`
// arrives as an ISO-8601 string over JSON.
//
// Supply them at the call site — `SimpleGraphQLClient.query<T, V>` accepts a plain `DocumentNode`
// with explicit type arguments, so these documents need no typed-document wrapper.
// ---------------------------------------------------------------------------------------------

/** The GraphQL `ID` scalar, mapped as the platform's generated types map it. */
export type ReorderApiId = string | number;

/** The GraphQL `DateTime` scalar as it arrives over JSON. */
export type ReorderApiDateTime = string;

/** The members of the plugin-declared `ReorderListAccess` enum. */
export type ReorderListAccessValue = 'OWNED' | 'SHARED';

/** The members of the plugin-declared `ReorderListCapability` enum. */
export type ReorderListCapabilityValue = 'READ' | 'APPLY_TO_ORDER';

/**
 * `ReorderList.viewerAccess`.
 *
 * While this feature is the whole of the delivery, `access` can only be `OWNED` and
 * `grantedCapabilities` can only be empty — a grant row cannot exist until a later feature creates
 * the table. Both are still typed at their full declared width, because the field is published now
 * precisely so that feature adds rows rather than shape.
 */
export interface ReorderListViewerAccessShape {
    access: ReorderListAccessValue;
    grantedCapabilities: ReorderListCapabilityValue[];
}

/** The capped `productVariant` selection {@link REORDER_LIST_LINE_FRAGMENT} makes. */
export interface ReorderListLineProductVariantShape {
    id: ReorderApiId;
    name: string;
}

/**
 * The shape {@link REORDER_LIST_LINE_FRAGMENT} returns.
 *
 * `productVariant` is nullable and `productVariantId` is not, and that asymmetry is the contract: a
 * line whose variant is no longer resolvable in the active channel — another channel's, soft-deleted, or
 * simply unanswered by the channel-scoped load — keeps its stored identifier so a buyer can still see and
 * remove it. A merely DISABLED variant remains resolvable and arrives populated; see
 * {@link REORDER_LIST_LINE_FRAGMENT} for why that distinction is load-bearing rather than pedantic.
 */
export interface ReorderListLineFieldsShape {
    id: ReorderApiId;
    createdAt: ReorderApiDateTime;
    updatedAt: ReorderApiDateTime;
    quantity: number;
    productVariantId: ReorderApiId;
    productVariant: ReorderListLineProductVariantShape | null;
}

/**
 * The shape {@link REORDER_LIST_FRAGMENT} returns — every `ReorderList` field except `lines`.
 *
 * `lineCount` is the stored total number of lines. It is not `lines.totalItems` and it is not the
 * length of `lines.items`; the three are distinct facts and a list whose stored total exceeds a
 * requested nested page size makes them differ.
 */
export interface ReorderListFieldsShape {
    id: ReorderApiId;
    createdAt: ReorderApiDateTime;
    updatedAt: ReorderApiDateTime;
    name: string;
    lineCount: number;
    viewerAccess: ReorderListViewerAccessShape;
}

/** A page of list lines, as `ReorderList.lines` returns it. */
export interface PaginatedReorderListLines {
    items: ReorderListLineFieldsShape[];
    totalItems: number;
}

/** The shape {@link REORDER_LIST_WITH_LINES_FRAGMENT} returns. */
export interface ReorderListWithLinesShape extends ReorderListFieldsShape {
    lines: PaginatedReorderListLines;
}

/** A page of lists whose entries carry no nested `lines` selection. */
export interface PaginatedReorderLists {
    items: ReorderListFieldsShape[];
    totalItems: number;
}

/** A page of lists whose entries each carry their own nested `lines` page. */
export interface PaginatedReorderListsWithLines {
    items: ReorderListWithLinesShape[];
    totalItems: number;
}

/**
 * The success member of all five non-delete mutation unions.
 *
 * It is a `ReorderList` even for the three operations that address a LINE, which is why the
 * `__typename` literal below is the discriminant for every one of them.
 */
export interface ReorderListSuccessShape extends ReorderListWithLinesShape {
    __typename: 'ReorderList';
}

/*
 * The error-code vocabulary, and why it is written out rather than borrowed whole.
 *
 * The published field is `errorCode: ErrorCode!`, and the runtime enum is generated from every type
 * implementing `ErrorResult` — so the four members this plugin's error results contribute exist only in
 * the rebuilt runtime schema and never in the checked-in snapshot the generated enum comes from. Typing
 * the field as the imported enum alone would therefore make the very comparison a suite has to write
 * impossible to express.
 *
 * Typing it as bare `string` was the other wrong answer, and it is the one that costs something: it
 * accepts every misspelling. `expect(result.errorCode).toBe('REORDER_LIST_NOTFOUND_ERROR')` would compile
 * and fail at run time with a message about a value rather than about a name, and — worse — a suite
 * asserting the WRONG code on a correct response would compile too and pass, because both sides of the
 * comparison are just strings.
 *
 * So the width is stated exactly: the 32 members the Shop API publishes today, widened by the four this
 * plugin adds, with each error result pinned to the single literal it can actually carry. A typo is a
 * compile error, an Admin-only code is a compile error, and an assertion that names another error's code is
 * a compile error.
 */

/**
 * The `ErrorCode` each of this plugin's four error results carries, keyed on the `__typename` that carries
 * it, and spelled as the platform's generator derives them: the declared type name, upper-snake-cased.
 *
 * It is one table rather than four independent literals so that each name is written exactly once. The four
 * error shapes below index into it, the union beneath it is derived from it, and a code paired with the wrong
 * `__typename` is therefore not expressible — where four loose literals would let a shape carry another
 * error's code, or a misspelling of its own, with nothing to contradict it.
 */
export interface ReorderPluginErrorCodeByTypename {
    ReorderListNotFoundError: 'REORDER_LIST_NOT_FOUND_ERROR';
    ReorderListNameConflictError: 'REORDER_LIST_NAME_CONFLICT_ERROR';
    ReorderListLimitError: 'REORDER_LIST_LIMIT_ERROR';
    ReorderListLineNotFoundError: 'REORDER_LIST_LINE_NOT_FOUND_ERROR';
}

/** The four `ErrorCode` members this plugin's SDL contributes, derived from the table above. */
export type ReorderPluginErrorCode = ReorderPluginErrorCodeByTypename[keyof ReorderPluginErrorCodeByTypename];

/**
 * Every `ErrorCode` a Shop response can carry once this plugin is registered: the published Shop baseline
 * plus the four above.
 *
 * The arithmetic this expresses is the one the compiler fixtures evidence — 32 published members plus 4
 * plugin-declared members — and it is additive, so no existing member is removed or renamed.
 *
 * The baseline half is written `` `${ErrorCode}` `` rather than `ErrorCode` because these are WIRE values.
 * The field arrives inside parsed JSON as a plain string, and a string enum member is not assignable from a
 * plain string in TypeScript, so the bare enum would type-check only against `ErrorCode.MEMBER` references
 * and would reject the very literal a response carries. The template-literal form widens the enum to the
 * union of its member VALUES — still exactly the 32 the Shop API publishes, so a member the platform renames
 * or removes still breaks this type, which is the property worth keeping.
 */
export type ReorderShopErrorCode = `${ErrorCode}` | ReorderPluginErrorCode;

/** `ReorderListNotFoundError`: absent, another customer's, another channel's, or not shared. */
export interface ReorderListNotFoundErrorShape {
    __typename: 'ReorderListNotFoundError';
    errorCode: ReorderPluginErrorCodeByTypename['ReorderListNotFoundError'];
    message: string;
}

/** `ReorderListNameConflictError`, carrying the canonical key that collided. */
export interface ReorderListNameConflictErrorShape {
    __typename: 'ReorderListNameConflictError';
    errorCode: ReorderPluginErrorCodeByTypename['ReorderListNameConflictError'];
    message: string;
    conflictingNameKey: string;
}

/** `ReorderListLimitError`, carrying the breached maximum. */
export interface ReorderListLimitErrorShape {
    __typename: 'ReorderListLimitError';
    errorCode: ReorderPluginErrorCodeByTypename['ReorderListLimitError'];
    message: string;
    maxItems: number;
}

/** `ReorderListLineNotFoundError`: the addressed line is absent from the addressed list. */
export interface ReorderListLineNotFoundErrorShape {
    __typename: 'ReorderListLineNotFoundError';
    errorCode: ReorderPluginErrorCodeByTypename['ReorderListLineNotFoundError'];
    message: string;
}

/**
 * The platform's `DeletionResponse`, reused verbatim as the delete path's success member.
 *
 * The response key is `deletionMessage` rather than `message` because {@link DELETE_REORDER_LIST}
 * aliases the field. `DeletionResponse.message` is nullable while every error result's is non-null,
 * and the overlapping-fields rule rejects that pair under a shared response key — so the alias is
 * what makes the document valid at all. It stays nullable here: the platform populates it when the
 * result is `NOT_DELETED` and leaves it null otherwise.
 */
export interface DeletionResponseShape {
    __typename: 'DeletionResponse';
    result: DeletionResult;
    deletionMessage: string | null;
}

/*
 * The six result unions. Membership is exact and asymmetric, and mirrors the published contract
 * member for member: the name conflict appears on exactly the two operations that write a name, the
 * line-not-found on exactly the two that address a line, and the limit on exactly the two that can
 * breach a bound.
 */

/** `createReorderList`. */
export type CreateReorderListResultShape =
    | ReorderListSuccessShape
    | ReorderListNameConflictErrorShape
    | ReorderListLimitErrorShape;

/** `updateReorderList`. */
export type UpdateReorderListResultShape =
    | ReorderListSuccessShape
    | ReorderListNotFoundErrorShape
    | ReorderListNameConflictErrorShape;

/** `deleteReorderList`. */
export type DeleteReorderListResultShape = DeletionResponseShape | ReorderListNotFoundErrorShape;

/** `addItemToReorderList`. */
export type AddItemToReorderListResultShape =
    | ReorderListSuccessShape
    | ReorderListNotFoundErrorShape
    | ReorderListLimitErrorShape;

/** `adjustReorderListLine`. */
export type AdjustReorderListLineResultShape =
    | ReorderListSuccessShape
    | ReorderListNotFoundErrorShape
    | ReorderListLineNotFoundErrorShape;

/** `removeReorderListLine`. */
export type RemoveReorderListLineResultShape =
    | ReorderListSuccessShape
    | ReorderListNotFoundErrorShape
    | ReorderListLineNotFoundErrorShape;

// ---------------------------------------------------------------------------------------------
// Input types, mirroring the published inputs field for field
// ---------------------------------------------------------------------------------------------

/** `CreateReorderListInput`. */
export interface CreateReorderListInputShape {
    name: string;
}

/** `UpdateReorderListInput`. */
export interface UpdateReorderListInputShape {
    id: ReorderApiId;
    name: string;
}

/**
 * `AddItemToReorderListInput` — exactly three fields.
 *
 * There is no request-deduplication key and there is no fourth field. Two deliveries of one add
 * accumulate, the delivery guarantee is at-least-once, and `adjustReorderListLine` is the
 * deterministic remedy because it sets an absolute quantity rather than adding to one.
 */
export interface AddItemToReorderListInputShape {
    reorderListId: ReorderApiId;
    productVariantId: ReorderApiId;
    quantity: number;
}

/** `AdjustReorderListLineInput`. The quantity is absolute, not a delta. */
export interface AdjustReorderListLineInputShape {
    reorderListId: ReorderApiId;
    lineId: ReorderApiId;
    quantity: number;
}

/** `RemoveReorderListLineInput`. */
export interface RemoveReorderListLineInputShape {
    reorderListId: ReorderApiId;
    lineId: ReorderApiId;
}

// ---------------------------------------------------------------------------------------------
// Per-document result and variables types
//
// One pair per document, and each variables type lists exactly the variables its document declares
// and nothing else. `GET_ACTIVE_CUSTOMER_REORDER_LISTS` declares none, so it has no variables type.
// ---------------------------------------------------------------------------------------------

/** {@link GET_ACTIVE_CUSTOMER_REORDER_LISTS}. */
export interface GetActiveCustomerReorderListsQuery {
    activeCustomerReorderLists: PaginatedReorderLists;
}

/** {@link GET_ACTIVE_CUSTOMER_REORDER_LIST}. The field is nullable for every inaccessible case. */
export interface GetActiveCustomerReorderListQuery {
    activeCustomerReorderList: ReorderListWithLinesShape | null;
}

/** Variables of {@link GET_ACTIVE_CUSTOMER_REORDER_LIST}. */
export interface GetActiveCustomerReorderListQueryVariables {
    id: ReorderApiId;
}

/** {@link GET_ACTIVE_CUSTOMER_REORDER_LISTS_INCLUDE_SHARED}. */
export interface GetActiveCustomerReorderListsIncludeSharedQuery {
    activeCustomerReorderLists: PaginatedReorderLists;
}

/**
 * Variables of {@link GET_ACTIVE_CUSTOMER_REORDER_LISTS_INCLUDE_SHARED}.
 *
 * Optional, so the same document also covers the variable-unsupplied case, in which the schema
 * default applies.
 *
 * **`| null` as well as optional, because the document declares the variable as `Boolean` and not as
 * `Boolean!`.** These types are handwritten in place of generated ones, so they earn their keep only by
 * representing exactly what each document accepts: a nullable variable may legitimately be sent as an
 * explicit `null`, and that is a materially different request from omitting it — an omitted variable lets the
 * field's declared default apply, while an explicit `null` is a supplied value that does not. A type
 * admitting only `?: boolean` would make the second case a compile error in a suite that needs to assert it,
 * which is the one thing these types exist to prevent.
 */
export interface GetActiveCustomerReorderListsIncludeSharedQueryVariables {
    includeShared?: boolean | null;
}

/** {@link GET_ACTIVE_CUSTOMER_REORDER_LIST_INCLUDE_SHARED}. */
export interface GetActiveCustomerReorderListIncludeSharedQuery {
    activeCustomerReorderList: ReorderListWithLinesShape | null;
}

/**
 * Variables of {@link GET_ACTIVE_CUSTOMER_REORDER_LIST_INCLUDE_SHARED}.
 *
 * `id` is required and non-nullable because the document declares `$id: ID!`; `includeShared` admits `null`
 * as well as absence because the document declares it `Boolean`. The asymmetry is the document's, not a
 * choice made here.
 */
export interface GetActiveCustomerReorderListIncludeSharedQueryVariables {
    id: ReorderApiId;
    includeShared?: boolean | null;
}

/** {@link GET_ACTIVE_CUSTOMER_REORDER_LISTS_PAGINATED}. */
export interface GetActiveCustomerReorderListsPaginatedQuery {
    activeCustomerReorderLists: PaginatedReorderLists;
}

/**
 * Variables of {@link GET_ACTIVE_CUSTOMER_REORDER_LISTS_PAGINATED}.
 *
 * Every one is optional: an options field whose variable is unsupplied is omitted from the coerced
 * object, so any subset may be sent.
 *
 * Every one also admits `null`, all four being declared nullable by the document. The two are not
 * interchangeable and the difference is visible in the coerced input object: an unsupplied variable causes
 * its field to be omitted from `options` altogether, whereas a variable supplied as `null` produces the field
 * present and null — which for `take` is what reaches the plugin's default-page-size fallback and for a sort
 * key is what leaves the entry ordering unspecified. Both are legitimate requests a suite may need to send.
 */
export interface GetActiveCustomerReorderListsPaginatedQueryVariables {
    take?: number | null;
    skip?: number | null;
    createdAtSort?: SortOrder | null;
    idSort?: SortOrder | null;
}

/** {@link GET_ACTIVE_CUSTOMER_REORDER_LISTS_WITH_LINE_PAGES}. */
export interface GetActiveCustomerReorderListsWithLinePagesQuery {
    activeCustomerReorderLists: PaginatedReorderListsWithLines;
}

/**
 * Variables of {@link GET_ACTIVE_CUSTOMER_REORDER_LISTS_WITH_LINE_PAGES}.
 *
 * Both are optional and both admit `null`, matching the document's two nullable `Int` declarations.
 */
export interface GetActiveCustomerReorderListsWithLinePagesQueryVariables {
    take?: number | null;
    linesTake?: number | null;
}

/** {@link GET_ACTIVE_CUSTOMER_REORDER_LIST_WITH_PAGED_LINES}. */
export interface GetActiveCustomerReorderListWithPagedLinesQuery {
    activeCustomerReorderList: ReorderListWithLinesShape | null;
}

/**
 * Variables of {@link GET_ACTIVE_CUSTOMER_REORDER_LIST_WITH_PAGED_LINES}.
 *
 * `id` is required and non-nullable, the document declaring `$id: ID!`. The four nested-window variables are
 * optional and admit `null`, all four being declared nullable, so a suite can send the nested page window
 * omitted, explicitly null, or valued.
 */
export interface GetActiveCustomerReorderListWithPagedLinesQueryVariables {
    id: ReorderApiId;
    linesTake?: number | null;
    linesSkip?: number | null;
    linesCreatedAtSort?: SortOrder | null;
    linesIdSort?: SortOrder | null;
}

/** {@link CREATE_REORDER_LIST}. */
export interface CreateReorderListMutation {
    createReorderList: CreateReorderListResultShape;
}

/** Variables of {@link CREATE_REORDER_LIST}. */
export interface CreateReorderListMutationVariables {
    input: CreateReorderListInputShape;
}

/** {@link UPDATE_REORDER_LIST}. */
export interface UpdateReorderListMutation {
    updateReorderList: UpdateReorderListResultShape;
}

/** Variables of {@link UPDATE_REORDER_LIST}. */
export interface UpdateReorderListMutationVariables {
    input: UpdateReorderListInputShape;
}

/** {@link DELETE_REORDER_LIST}. */
export interface DeleteReorderListMutation {
    deleteReorderList: DeleteReorderListResultShape;
}

/** Variables of {@link DELETE_REORDER_LIST}. A bare id, not an input object. */
export interface DeleteReorderListMutationVariables {
    id: ReorderApiId;
}

/** {@link ADD_ITEM_TO_REORDER_LIST}. */
export interface AddItemToReorderListMutation {
    addItemToReorderList: AddItemToReorderListResultShape;
}

/** Variables of {@link ADD_ITEM_TO_REORDER_LIST}. */
export interface AddItemToReorderListMutationVariables {
    input: AddItemToReorderListInputShape;
}

/** {@link ADJUST_REORDER_LIST_LINE}. */
export interface AdjustReorderListLineMutation {
    adjustReorderListLine: AdjustReorderListLineResultShape;
}

/** Variables of {@link ADJUST_REORDER_LIST_LINE}. */
export interface AdjustReorderListLineMutationVariables {
    input: AdjustReorderListLineInputShape;
}

/** {@link REMOVE_REORDER_LIST_LINE}. */
export interface RemoveReorderListLineMutation {
    removeReorderListLine: RemoveReorderListLineResultShape;
}

/** Variables of {@link REMOVE_REORDER_LIST_LINE}. */
export interface RemoveReorderListLineMutationVariables {
    input: RemoveReorderListLineInputShape;
}
