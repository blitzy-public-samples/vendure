import gql from 'graphql-tag';

/*
 * eslint max-len is suspended for the SDL document below, and re-enabled immediately after it.
 *
 * Two of the contract's field descriptions are longer than the 170-character limit — the one
 * explaining why `productVariant` is nullable and the one explaining why a single not-found result
 * covers four distinct conditions. They are reproduced here exactly as the feature contract writes
 * them [tickets/EPIC-001/FEATURE-001-01-named-reorder-lists.md:L221,L255], because a description
 * string is part of the published schema: a client reads it through introspection.
 *
 * Reflowing either one into a GraphQL block string is not a way out. A block string's value is
 * computed line by line and joined with newlines, so `"""a\nb"""` is the string "a\nb" whereas
 * `"a b"` is "a b" — the published description would change, which is precisely what may not
 * happen. Shortening them would change it too. So the line length is not negotiable and the rule
 * is suspended over the one region where it conflicts with the contract, following the same
 * mechanism the platform uses where a line cannot be shortened
 * [packages/core/src/config/catalog/collection-filter.ts:L20].
 *
 * The suspension is deliberately opened before the doc block rather than between the doc block and
 * the declaration, so that nothing separates the JSDoc from the symbol it documents and the
 * `@since` tag still reaches the generated declaration file.
 */
/* eslint-disable max-len */
/**
 * @description
 * The Shop API extensions published by the ReorderPlugin, and the plugin's **published contract**: every
 * other file in the plugin implements what the document below declares.
 *
 * It is transcribed from the feature contract's own SDL block
 * [tickets/EPIC-001/FEATURE-001-01-named-reorder-lists.md:L153-L315], which is the single authority for this
 * surface and outranks any story ticket that disagrees with it. Everything is additive: no existing Shop API
 * type, field, argument, return type or nullability is declared, altered or shadowed, no custom permission is
 * registered, and no Admin API extension is published here — the Admin API and every dashboard surface belong
 * to FEATURE-001-08. What the document declares, what it deliberately omits, and why, is stated inside it
 * beside the declarations concerned.
 *
 * Two rules bind a CLIENT of this contract, and neither is visible in the SDL:
 *
 * - **`deleteReorderList` requires one of its two `message` selections to be aliased.** Its success member is
 *   the platform's own `DeletionResponse`, whose `message` is a nullable `String`
 *   [packages/core/src/api/schema/common/common-types.graphql:L64-L67], while every error result below
 *   declares `message: String!`. Selecting `message` unaliased on BOTH members under one response key is
 *   invalid: GraphQL's overlapping-fields rule compares response shapes without unwrapping nullability, and
 *   inline fragments on mutually exclusive types relax only the name-and-arguments half of that check
 *   [node_modules/graphql/validation/rules/OverlappingFieldsCanBeMergedRule.js:doTypesConflict], so the
 *   request is refused with `GRAPHQL_VALIDATION_FAILED` before any resolver runs. Alias one branch — the
 *   plugin's own shared documents alias the success one
 *   [packages/reorder-plugin/e2e/graphql/reorder-definitions.ts]. Neither nullability may be "corrected"
 *   instead: `DeletionResponse` is a published platform type reused verbatim by ruling, and `ErrorResult`
 *   fixes `message: String!` on every implementor.
 * - **Keep a `default` branch when switching on `ErrorCode`.** That enum is generated from every type
 *   implementing `ErrorResult` [packages/core/src/api/config/generate-error-code-enum.ts:L11-L19], so the four
 *   members these error results add are a widening that later features widen further.
 *
 * The `@since` value below is a **derivation, not a quotation**: it applies the contribution guide's
 * next-minor rule [CONTRIBUTING.md:§New features] to this checkout's declared version 3.7.0
 * [packages/core/package.json:L2-L3]. The guide never states `3.8.0`, so the value must not be presented as
 * quoted from it.
 *
 * @since 3.8.0
 */
export const shopApiExtensions = gql`
    # NOTHING below references a type this document does not declare, and NOTHING below
    # declares an \`options\` argument. That is this document's CHOICE between the two routes
    # ruling R10 permits, and not the only route that builds: the shipped exemplar declares
    # such an input and builds [packages/dev-server/test-plugins/reviews/api/api-extensions.ts:L39-L45].
    # The rule is narrower: the plugin's document is merged into the schema FIRST
    # [packages/core/src/api/config/get-final-vendure-schema.ts:L99] and the list-options generator
    # runs AFTER it [packages/core/src/api/config/get-final-vendure-schema.ts:L100], so a document
    # may not NAME a per-row options input it does not itself declare — that is the unknown-type
    # failure. A document MAY declare the input bare and name it as the argument, and the generator
    # then merges its own fields into that declaration
    # [packages/core/src/api/config/generate-list-options.ts:L83].
    # This document needs no extra filter key, so it declares neither input and lets the generator
    # add the argument to every field returning a PaginatedList implementor, root or nested
    # [packages/core/src/api/config/generate-list-options.ts:L41-L48] and
    # [packages/core/src/api/config/generate-list-options.ts:L87-L99].
    extend type Query {
        "Lists the authenticated customer can see in the active channel. Owner-only by default."
        activeCustomerReorderLists(includeShared: Boolean = false): ReorderListList!

        """
        One list by id. NULL -- never an error -- when it is absent, another customer's, another
        channel's, not shared with the caller, shared under a grant that is not ACTIVE, shared with a
        seat whose group membership has ended, or requested without an authenticated session. Every one
        of those cases returns the SAME null, which is what makes the read non-enumerable.
        includeShared carries the SAME default as the collection query, and the default is owner-only:
        with it false or omitted, a list the caller merely holds a grant on is null. With it true, a
        grant is considered -- and admitted only under all four conjuncts of FEATURE-001-06's predicate
        at the moment of the request: an ACTIVE grant, live group membership, a capability covering the
        read, and the active channel. An earlier revision published this field twice, once with the
        argument and once without it while considering a grant BY DEFAULT; the implicit form is withdrawn
        because opt-in is what keeps an already-shipped client's page owner-only.
        """
        activeCustomerReorderList(id: ID!, includeShared: Boolean = false): ReorderList
    }

    extend type Mutation {
        createReorderList(input: CreateReorderListInput!): CreateReorderListResult!
        updateReorderList(input: UpdateReorderListInput!): UpdateReorderListResult!
        deleteReorderList(id: ID!): DeleteReorderListResult!
        addItemToReorderList(input: AddItemToReorderListInput!): AddItemToReorderListResult!
        adjustReorderListLine(input: AdjustReorderListLineInput!): AdjustReorderListLineResult!
        removeReorderListLine(input: RemoveReorderListLineInput!): RemoveReorderListLineResult!
    }

    type ReorderList implements Node {
        id: ID!
        createdAt: DateTime!
        updatedAt: DateTime!
        name: String!
        "Denormalised counter column on reorder_list, not a derived value: total stored lines, NOT the size of the page below. See section 2.4."
        lineCount: Int!
        "Paginated. The generator supplies this field's \`options\` argument."
        lines: ReorderListLineList!

        "Per-requester, therefore nested: it is not a column and may not enter generated sort or filter inputs."
        viewerAccess: ReorderListViewerAccess!
    }

    type ReorderListViewerAccess {
        "OWNED when the caller owns the row; SHARED when the caller reaches it through a grant."
        access: ReorderListAccess!
        "Non-empty only when access is SHARED. Populated by FEATURE-001-06; always [] until then."
        grantedCapabilities: [ReorderListCapability!]!
    }

    type ReorderListLine implements Node {
        id: ID!
        createdAt: DateTime!
        updatedAt: DateTime!
        # TRANSCRIBED VERBATIM from FEATURE-001-01 section 2.6, which is the single authority for this
        # contract: a description is introspectable, so it is part of the published surface and is quoted
        # rather than improved. One nuance the contract's wording leaves open is recorded here, in a
        # comment the schema does not publish, so that the published text stays the ticket's own. Of the
        # two states the sentence names, only a soft-deleted variant actually yields null. A variant that
        # is merely DISABLED resolves normally and carries enabled: false for a client to read, because
        # a saved list records intent rather than availability and this payload adds no availability
        # field of its own. A variant belonging to another channel, and a stored identifier that answers
        # to nothing, resolve to null for the same reason a soft-deleted one does: they are not
        # resolvable in the active channel.
        "NULLABLE, and that is a contract rather than an oversight: a line whose variant has been soft-deleted or disabled since it was saved is RETAINED, and a non-null field would have to expose a withdrawn catalogue object or null-bubble the whole line out of the page. Null means the variant is no longer resolvable in the active channel."
        productVariant: ProductVariant
        "NON-NULL always. The stored identifier survives the variant becoming unresolvable, which is what lets a buyer see and remove the stale line."
        productVariantId: ID!
        quantity: Int!
    }

    type ReorderListList implements PaginatedList {
        items: [ReorderList!]!
        totalItems: Int!
    }

    type ReorderListLineList implements PaginatedList {
        items: [ReorderListLine!]!
        totalItems: Int!
    }

    # NEITHER of the two per-row options inputs the generator derives from the two list types above
    # is declared or even named here: both are generated at run time from their target types
    # [packages/core/src/api/config/generate-list-options.ts:L31-L60]. What fails the build is naming
    # one that this document does not declare, because the merge happens before the generator runs
    # [packages/core/src/api/config/get-final-vendure-schema.ts:L99-L100] — declaring it bare and
    # naming it is the other route ruling R10 permits, and is not taken here.

    enum ReorderListAccess {
        OWNED
        SHARED
    }

    """
    Declared here because ReorderListViewerAccess references it in batch B1. FEATURE-001-06
    gives its members meaning; it declares neither the enum nor the field.
    """
    enum ReorderListCapability {
        READ
        APPLY_TO_ORDER
    }

    # The four error results this feature owns, declared field-by-field. A union member that is
    # only named is an unknown-type build failure, and the ErrorCode enum grows from these
    # declarations rather than from union membership [packages/core/src/api/config/generate-error-code-enum.ts:L11-L19].
    "Returned when a reorder list addressed by id is absent, owned by another customer, in another channel, or not shared with the caller. One result for all four, deliberately."
    type ReorderListNotFoundError implements ErrorResult {
        errorCode: ErrorCode!
        message: String!
    }

    "Returned when the canonical form of the supplied name is already held by this customer in this channel."
    type ReorderListNameConflictError implements ErrorResult {
        errorCode: ErrorCode!
        message: String!
        "The canonical nameKey that collided. Echoes the caller's own input; discloses no other row."
        conflictingNameKey: String!
    }

    """
    Returned when a write would take a customer over maxListsPerCustomer, a list over maxLinesPerList, or a
    list past the seats-per-list maximum FEATURE-001-06 enforces on the same conditional-counter pattern.
    """
    type ReorderListLimitError implements ErrorResult {
        errorCode: ErrorCode!
        message: String!
        "The breached maximum, in the same shape OrderLimitError carries its own."
        maxItems: Int!
    }

    "Returned when a line addressed by id is absent from the addressed list."
    type ReorderListLineNotFoundError implements ErrorResult {
        errorCode: ErrorCode!
        message: String!
    }

    input CreateReorderListInput {
        name: String!
    }
    input UpdateReorderListInput {
        id: ID!
        name: String!
    }
    input AddItemToReorderListInput {
        reorderListId: ID!
        productVariantId: ID!
        quantity: Int!
    }
    # THIS INPUT DECLARES NO IDEMPOTENCY KEY, AND THE ABSENCE IS A RULING RATHER THAN AN OMISSION. An
    # earlier revision declared an optional \`idempotencyKey\` here, then withdrew it, then restored it on the
    # ground that section 2.4 had grown a store for the claim. THAT GROUND IS FALSE against section 2.4 as
    # it stands: \`reorder_list_line\` declares exactly five members and carries no claim column, and this
    # epic's seven-table inventory holds no row in which a claim could be recorded
    # [tickets/EPIC-001-reorder-and-replenishment.md:§7.8 The Seven Plugin-Owned Tables]. Accepting an
    # argument with no storage behind it advertises a replay guarantee that cannot be kept, which is worse
    # than making no guarantee at all -- so the argument stays withdrawn rather than the columns returning.
    # Section 2.11 states the behaviour that replaces it: two deliveries of one add ACCUMULATE, the
    # delivery guarantee is at-least-once and is stated as such, and \`adjustReorderListLine\` is the
    # deterministic remedy because it SETS an absolute quantity rather than adding to one. The replay claim
    # that does exist in this epic belongs to the reorder attempt rather than to a list line
    # [tickets/EPIC-001/FEATURE-001-07-reorder-instrumentation.md:§2.4 Named Entities Touched].
    input AdjustReorderListLineInput {
        reorderListId: ID!
        lineId: ID!
        quantity: Int!
    }
    input RemoveReorderListLineInput {
        reorderListId: ID!
        lineId: ID!
    }

    # The six result unions, each carrying the exact membership its own operation can produce.
    #
    # DeleteReorderListResult reuses the platform's own DeletionResponse verbatim rather than
    # declaring a plugin-owned deletion payload, and that reuse has ONE consequence a client must
    # know before writing the document: DeletionResponse declares message as a NULLABLE String
    # [packages/core/src/api/schema/common/common-types.graphql:L64-L67], while every error result
    # above declares message: String!. Selecting message on BOTH members of this union under a
    # single response key is therefore an INVALID document rather than merely an unusual one — the
    # overlapping-fields rule compares response shapes without unwrapping nullability, and inline
    # fragments on mutually exclusive types relax only the name-and-arguments half of that check
    # [node_modules/graphql/validation/rules/OverlappingFieldsCanBeMergedRule.js:doTypesConflict] —
    # so the request is refused with GRAPHQL_VALIDATION_FAILED before any resolver runs. Alias one
    # of the two, as this plugin's own shared documents do on the success branch:
    #     ... on DeletionResponse { result deletionMessage: message }
    #     ... on ReorderListNotFoundError { errorCode message }
    # Changing either nullability instead is not available: DeletionResponse is a published platform
    # type and ErrorResult fixes message: String! on every implementor, so either edit would break
    # the additive-only guarantee this document is bound by.
    union CreateReorderListResult = ReorderList | ReorderListNameConflictError | ReorderListLimitError
    union UpdateReorderListResult = ReorderList | ReorderListNotFoundError | ReorderListNameConflictError
    union DeleteReorderListResult = DeletionResponse | ReorderListNotFoundError
    union AddItemToReorderListResult = ReorderList | ReorderListNotFoundError | ReorderListLimitError
    union AdjustReorderListLineResult = ReorderList | ReorderListNotFoundError | ReorderListLineNotFoundError
    union RemoveReorderListLineResult = ReorderList | ReorderListNotFoundError | ReorderListLineNotFoundError
`;
/* eslint-enable max-len */
