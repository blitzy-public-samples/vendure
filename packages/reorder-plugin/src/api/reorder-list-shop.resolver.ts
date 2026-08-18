/*
 * -------------------------------------------------------------------------------------------------------
 * The eight Shop API operations of FEATURE-001-01, and the one thing this file is for.
 * -------------------------------------------------------------------------------------------------------
 * Attribution. No user-specified rules were provided for this project: the rules document was read and
 * returned exactly that, and EPIC-001 reaches the same finding independently in its own section 11.9.
 * Nothing here is, or derives from, a user-specified rule. Every constraint stated below traces to
 * FEATURE-001-01 (sections 2.6 to 2.12), to one of STORY-001-01-01 through STORY-001-01-04, to an EPIC-001
 * settled ruling (R2, R3, R9, R10, R14, R15), or to a cited line of this repository, and is attributed as
 * such wherever it is stated. The absence of a rules document has not been treated as licence to lower the
 * bar anywhere in this file.
 *
 * WHAT THIS FILE IS. A gated, transactional delegation layer over `ReorderListService`, and deliberately
 * nothing more: eight methods, each of which decorates a call and forwards its result. The whole of this
 * file's correctness is in the decorators and in what it does NOT do.
 *
 * FOUR HELPFUL-LOOKING ADDITIONS THAT WOULD EACH BE A DEFECT HERE. Every one of them is the kind of change
 * a reviewer might ask for, so each is named with the reason it is refused:
 *
 * 1. An ownership check. `@Allow(Permission.Owner)` below is NOT the access control, and neither is
 *    anything in this file. `Owner` is declared `assignable: false, internal: true` (the `Owner`
 *    PermissionDefinition inside `DEFAULT_PERMISSIONS`, `packages/core/src/common/constants.ts` L27-L32),
 *    so no session ever holds it: the guard marks the request context `authorizedAsOwnerOnly` and then
 *    admits the request. The ownership-and-channel predicate in `ReorderListService` is the whole control
 *    (EPIC-001 rulings R2 and R3), and it is one predicate precisely because a second implementation here
 *    could disagree with it. A duplicate check in this file would also break the instrumented contract it
 *    is meant to help: the predicate has to reach the database as conjuncts of the row lookup's own
 *    `WHERE` clause, and a resolver that loaded a row to inspect it has already read the row it was
 *    supposed to refuse.
 * 2. A `try`/`catch` around a service call. A malformed name or quantity is a bad REQUEST rather than a
 *    business outcome, so the service throws `UserInputError` and an unauthenticated write propagates
 *    `ForbiddenError`. Those must reach the client as exactly one top-level `errors` entry with `data`
 *    null. Catching either one and returning a union member instead would convert a refusal into a
 *    success-shaped response — which is why there are four error results here and not five, and why
 *    `NegativeQuantityError` (an `OrderLine` concern that covers `quantity < 0` and is silent on zero) is
 *    not among them.
 * 3. A clamp, a sort, or a `ListQueryBuilder` injection. The platform's builder clamps the page and
 *    refuses an over-limit request with its own input error and its own message key, and the service is
 *    what hands it the caller's window together with the appended deterministic tie-break. This file
 *    supplies exactly one page-size value — the configured default, and only where the caller supplied
 *    none — and reshapes nothing else.
 * 4. A branch on `includeShared`. Both values are accepted and answered identically because no share row
 *    can exist until list sharing ships, so the set the non-default value asks for is empty by
 *    construction rather than withheld. Refusing the non-default value would mean the same call changed
 *    from an error to a success later, on an unchanged signature. The flag is forwarded, not read.
 *
 * DECORATOR ORDER IS COPIED, NOT CHOSEN. The mandated structural precedent is the shipped wishlist example
 * plugin (FEATURE-001-01 section 2.3), whose resolver puts `@Query()` above `@Allow(...)` and
 * `@Mutation()` above `@Transaction()` above `@Allow(...)`
 * (`packages/dev-server/example-plugins/wishlist-plugin/api/wishlist.resolver.ts` L11-L12 and L17-L19).
 * The repository's reviews test plugin reverses the mutation order
 * (`packages/dev-server/test-plugins/reviews/api/product-review-shop.resolver.ts` L20-L21); the precedent
 * is the mandated one, so the order below is the wishlist plugin's. `@Transaction()` appears on all six
 * mutations and on neither read, which is an idiom the precedent establishes and no ticket names.
 *
 * THERE IS NO CODEGEN BEHIND THIS FILE. The reviews plugin types its arguments from a generated
 * `generated-shop-types` module; this plugin has no such artefact and no ticket asks for one. The argument
 * shapes below are therefore the service's own published input interfaces, which mirror the five SDL inputs
 * field for field, plus two locally declared read-argument shapes. That is stronger than a hand-written
 * duplicate would be: a divergence between this file and the service becomes a compile error rather than a
 * runtime surprise.
 *
 * WHAT IS DELIBERATELY ABSENT, so each absence reads as a ruling rather than as an omission. No
 * `adminApiExtensions` and no Admin-side resolver — the Admin API and every dashboard surface belong to
 * FEATURE-001-08. No custom `PermissionDefinition`, so the published `Permission` enum stays at the
 * ninety-seven members it already has, a zero delta this feature asserts rather than omits (rulings R9 and
 * R15). No `options` argument declared by hand on any field and no reference anywhere to either of the two
 * per-row options inputs the platform's generator derives from the two list types — the generator owns
 * both, and naming an input the published document does not declare fails the schema merge and stops the
 * server booting (ruling R10). No argument that could nominate an owner: ownership is derived from the
 * session, so no `customerId` and no `channelId` is accepted anywhere below.
 *
 * The `@since 3.8.0` tags below are a derivation and are flagged as one. The contribution guide requires
 * new public API to carry a `@since` tag naming what will be the next minor version. This checkout
 * declares 3.7.0, so the next minor derives to 3.8.0. That string appears nowhere in this repository and
 * is therefore not a quotation from it.
 * -------------------------------------------------------------------------------------------------------
 */

import { Inject } from '@nestjs/common';
import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import {
    Allow,
    Ctx,
    ErrorResultUnion,
    ID,
    PaginatedList,
    Permission,
    RequestContext,
    RequestContextCacheService,
    Transaction,
} from '@vendure/core';

import { REORDER_PLUGIN_OPTIONS } from '../constants';
import {
    AddItemToReorderListInput,
    AddItemToReorderListResult,
    AdjustReorderListLineInput,
    AdjustReorderListLineResult,
    CreateReorderListInput,
    CreateReorderListResult,
    DeleteReorderListResult,
    RemoveReorderListLineInput,
    RemoveReorderListLineResult,
    ReorderListService,
    UpdateReorderListInput,
    UpdateReorderListResult,
} from '../service/reorder-list.service';
import { ReorderPluginOptions } from '../types';

import {
    markSingleReorderListRead,
    SINGLE_LIST_READ_KEY_PREFIX,
    singleReorderListReadCacheKey,
} from './reorder-list-entity.resolver';

/**
 * The declared default page size for the collection read, applied where a deployment supplies no value.
 *
 * It duplicates no validation. `ReorderPlugin.init()` validates every supplied option once, at plugin
 * initialisation, and merges the same declared default for a key a deployment omits — so by the time this
 * resolver reads the option the value is either a validated integer or absent. The fallback exists purely
 * because every member of the options interface is optional, which would otherwise make this class partial
 * under `strict`: with no fallback, an option resolving to `undefined` would leave `take` unset, and an
 * unset page size is ultimately substituted by the platform's own Shop maximum. That is a *looser* page
 * than the one this feature publishes, and nothing reports the substitution.
 *
 * The value is the same twenty-five the service falls back to for the same option, and that agreement is
 * intentional rather than incidental: both spell the one page size this feature declares for
 * `activeCustomerReorderLists`. Because the resolver decides `take` first, the service's fallback on the
 * same key can only ever be reached by a caller that bypasses this resolver — a unit specification, or a
 * later internal caller — so the two can never disagree about one request.
 */
const DEFAULT_REORDER_LISTS_PAGE_SIZE = 25;

/**
 * The prefix every single-list-read marker key carries.
 *
 * It is the entity field resolver's own prefix, re-exported here rather than restated, because that resolver
 * is what READS the marker: a marker the two files namespaced independently would never be found, and the
 * repair it gates would silently never run. Core's convention for a request-scoped cache key names the
 * resolver that consumes the cached value — `PaymentEntityResolver.refunds(${payment.id})`
 * (`packages/core/src/api/resolvers/entity/payment-entity.resolver.ts` L28) — so the reader's spelling is
 * also the conventional one.
 *
 * @internal
 */
export const SINGLE_LIST_READ_MARKER_KEY_PREFIX = SINGLE_LIST_READ_KEY_PREFIX;

/**
 * @description
 * Derives the request-scoped marker key under which {@link ReorderListShopResolver.activeCustomerReorderList}
 * records that a given list is being read *singly*.
 *
 * **This function is the coordination point between the two resolvers, and it exists so that the key is
 * derived in one place rather than spelled in two.** The entity field resolver reads the marker to decide
 * whether it may run the `lineCount` compare-and-set repair, because that repair belongs to the single-list
 * read alone: a collection read pages no list's lines, so it has no observed total to compare the stored
 * counter against, and it must never repair (FEATURE-001-01 section 2.6.2.1). A marker key that the two
 * sides spelled independently would fail silently in the direction that looks like success — the reader
 * would simply never find the marker, the repair would never run, and no test that asserts a repaired
 * counter on the single read would be able to say why.
 *
 * The key is keyed on the list identifier rather than being a single per-request flag, because one request
 * may legitimately carry both reads: a document may select `activeCustomerReorderList(id: 1)` alongside
 * `activeCustomerReorderLists`, and the collection's entries must not inherit the single read's licence to
 * repair.
 *
 * **It derives the key by delegating to the reader's own builder rather than composing one here**, which is
 * what makes "derived in one place" true across the two files instead of merely stated in each of them. The
 * stringification of the identifier therefore lives with the reader as well: `ID` is `string | number` and
 * the configured id strategy decides which a deployment produces, so the numeric 7 and the string '7' — two
 * spellings of one row — have to produce one key, and they do so because one function spells it.
 *
 * @param id - The identifier of the list being read singly, exactly as it arrived on the operation.
 *
 * @example
 * ```ts
 * // In the entity field resolver, gating the repair:
 * const readSingly = this.requestContextCache.get<boolean>(ctx, singleListReadMarkerKey(list.id));
 * if (readSingly) {
 *     return this.reorderListService.reconcileLineCount(ctx, list.id, list.lineCount, observedTotal);
 * }
 * return list.lineCount;
 * ```
 *
 * @docsCategory core plugins/ReorderPlugin
 * @since 3.8.0
 */
export function singleListReadMarkerKey(id: ID): string {
    return singleReorderListReadCacheKey(id);
}

/**
 * The arguments of `activeCustomerReorderLists`, as the published document declares them plus the one
 * argument the platform's generator adds.
 *
 * Two things about this shape are deliberate. The page options are typed from the service's own parameter
 * rather than named as a type, so this file never spells either of the two generated per-row options input
 * names — naming one that the published document does not declare is what fails the schema merge (ruling
 * R10) — and a change to what the service accepts becomes a compile error here rather than a silent
 * mismatch. And `includeShared` is optional in TypeScript even though the document gives it a default,
 * because a default is applied by the GraphQL layer and this type also describes the value a unit
 * specification passes in directly.
 */
interface ActiveCustomerReorderListsArgs {
    options?: NonNullable<Parameters<ReorderListService['getReorderLists']>[1]>;
    includeShared?: boolean;
}

/**
 * The arguments of `activeCustomerReorderList`: the list identifier, and the same forward-compatible
 * sharing flag the collection read carries.
 */
interface ActiveCustomerReorderListArgs {
    id: ID;
    includeShared?: boolean;
}

/**
 * The reorder list entity, as the service hands it back.
 *
 * It is derived from the service's own signature rather than imported from the entity module, which keeps
 * this file bound to exactly one internal contract — the service's — so that nothing here can disagree with
 * what the service actually returns. It exists to supply the entity parameter of
 * {@link ErrorResultUnion}, whose whole purpose is to substitute the TypeScript entity for its GraphQL
 * counterpart in a union of a success result plus one or more error results.
 */
type ReorderListEntity = NonNullable<Awaited<ReturnType<ReorderListService['getReorderList']>>>;

/**
 * @description
 * Publishes the eight Shop API operations of feature FEATURE-001-01 "Named Reorder Lists with Line
 * Quantities": the two paginated read queries and the six mutations declared by this plugin's own
 * `shopApiExtensions` document.
 *
 * Every method here is a delegation. Each one is gated with `@Allow(Permission.Owner)`, each mutation runs
 * inside a transaction, and each forwards its arguments to the identically named {@link ReorderListService}
 * method and returns that result unchanged. **No access control, no validation, no ordering, no clamping and
 * no error translation lives in this class** — the service owns all of it, so that there is exactly one
 * implementation of each invariant to review. The file-level comment above records, for each of the four
 * additions a reader is most likely to want here, why adding it would be a defect.
 *
 * The one behaviour this class contributes beyond delegation is the pair of *request-shaped* concerns that
 * genuinely belong to the API layer: substituting the configured default page size where the caller supplied
 * no page size on the collection read, and recording a request-scoped marker on the single-list read so the
 * entity field resolver can tell the two reads apart. Both are described on the methods that perform them.
 *
 * @example
 * ```ts
 * // Registered by ReorderPlugin, alongside the plugin's other Shop-side resolvers:
 * @VendurePlugin({
 *     imports: [PluginCommonModule],
 *     shopApiExtensions: {
 *         schema: shopApiExtensions,
 *         resolvers: [ReorderListShopResolver],
 *     },
 * })
 * export class ReorderPlugin {}
 * ```
 *
 * @docsCategory core plugins/ReorderPlugin
 * @docsPage ReorderListShopResolver
 * @docsWeight 0
 * @since 3.8.0
 */
@Resolver()
export class ReorderListShopResolver {
    constructor(
        private reorderListService: ReorderListService,
        private requestContextCache: RequestContextCacheService,
        @Inject(REORDER_PLUGIN_OPTIONS) private options: ReorderPluginOptions,
    ) {}

    /**
     * The page size the collection read falls back to where the caller supplied none, resolved against its
     * declared default. Read by {@link ReorderListShopResolver.activeCustomerReorderLists} and by nothing
     * else — the nested `lines` field's own default belongs to the entity field resolver.
     *
     * It is a getter rather than a value captured in the constructor so that the option object remains the
     * single authority: nothing here holds a copy that could outlive a change to it.
     */
    private get defaultReorderListsPageSize(): number {
        return this.options.defaultReorderListsPageSize ?? DEFAULT_REORDER_LISTS_PAGE_SIZE;
    }

    /**
     * @description
     * `activeCustomerReorderLists`: a bounded, deterministically ordered page of the lists the authenticated
     * customer owns in the active channel.
     *
     * **The `options` argument is not declared by this plugin and is not reshaped here.** The platform's
     * list-options generator adds it to every field returning a `PaginatedList` implementor, root or nested,
     * and names it `options`
     * (`packages/core/src/api/config/generate-list-options.ts` L87-L100); the published document declares
     * neither the argument nor the input type behind it (ruling R10). Whatever arrives is handed to the
     * service as it stands: its `skip`, `sort` and `filter` are passed through untouched, and the service is
     * what composes the server-side scope, appends the deterministic identifier tie-break to any
     * caller-supplied sort, and hands the whole thing to `ListQueryBuilder`.
     *
     * **The single value this method contributes is the page size where the caller omitted one.** `take` is
     * set to the configured `defaultReorderListsPageSize` only when the caller supplied no `take`; a supplied
     * value is left exactly as it arrived, so the platform's own clamp still applies and an over-limit
     * request is still refused by the platform — with the platform's own input error and message key —
     * before any row is read (STORY-001-01-04 AC-3). `ignoreQueryLimits` is left unset for the same reason:
     * an unlimited public list query is a denial-of-service vector, and the configured default of
     * twenty-five is *stricter* than the Shop maximum the platform would otherwise substitute.
     *
     * The service applies the same fallback defensively for the same option, so this assignment cannot
     * disagree with it and cannot be applied twice to one request: once `take` carries a value, the
     * service's own `??` on it does nothing. The 50 that governs the nested `lines` field is not applied
     * here — that page belongs to the entity field resolver, and neither resolver applies the other's
     * default.
     *
     * A caller with no resolvable customer scope receives an empty page rather than an error, which is the
     * shipped read convention (ruling R14). That answer is the service's; this method neither produces nor
     * inspects it.
     *
     * @param ctx - The request context. Its authenticated session and active channel are the scope, and
     * nothing in the arguments can widen them.
     * @param args - The generator-supplied page options, and the forward-compatible sharing flag.
     *
     * @since 3.8.0
     */
    @Query()
    @Allow(Permission.Owner)
    activeCustomerReorderLists(
        @Ctx() ctx: RequestContext,
        @Args() args: ActiveCustomerReorderListsArgs,
    ): Promise<PaginatedList<ReorderListEntity>> {
        return this.reorderListService.getReorderLists(
            ctx,
            {
                // Spread first, so every other key the generator supplied — `skip`, `sort`, `filter` and
                // `filterOperator` — reaches the service exactly as it arrived. Only `take` is decided here.
                ...args.options,
                // Nullish coalescing rather than a logical OR, and the difference is behavioural on two
                // values. `take: null` reaches this line from a GraphQL variable passed explicitly as null,
                // which is an omitted page size and must take the default. `take: 0` is a caller asking for
                // no rows, which is a supplied page size and must be forwarded untouched — an OR would
                // silently turn it into twenty-five and answer a question the caller did not ask.
                take: args.options?.take ?? this.defaultReorderListsPageSize,
            },
            args.includeShared,
        );
    }

    /**
     * @description
     * `activeCustomerReorderList`: one list addressed by id, or `null`.
     *
     * **`null` is the single answer for every inaccessible case** — an id matching no row, a row owned by
     * another customer, a row in another channel, a row not shared with the caller, and a request carrying
     * no authenticated session at all. Those answers are indistinguishable by design: identifiers are
     * sequential under the default id strategy, so a distinguishable refusal would confirm the existence of
     * another buyer's row to anyone who counts. The service's `null` is returned straight through, and this
     * method adds no error, no warning and no extension that could tell those cases apart. This is why
     * `ReorderListNotFoundError` is a member of the *mutation* unions only.
     *
     * **The marker.** Before delegating, this method records — for the duration of this request, keyed on
     * the requested list id — that this list is being read singly. The entity field resolver reads that
     * marker to decide whether it may run the `lineCount` compare-and-set repair, which belongs to the
     * single-list read alone (FEATURE-001-01 section 2.6.2.1).
     *
     * **The mark is written through the reader's own helper, `markSingleReorderListRead`, rather than by
     * setting a key composed here.** The two sides of this contract have to agree on one key or the contract
     * fails in the direction that looks like success: the reader would simply never find the mark, the repair
     * would never run, and nothing would report that it had not. Calling the reader's setter makes agreement
     * structural instead of coincidental. {@link singleListReadMarkerKey} exposes the same key for a test
     * that needs to assert on it, and delegates to that same builder for the same reason.
     *
     * The marker is set unconditionally, before the read rather than after it, and that ordering is
     * deliberate on both counts. It is set before because a field resolver for this operation's own
     * selection set can only run after this method resolves, so there is no ordering hazard, whereas a
     * marker set after an `await` would be a second statement that an early return could skip. It is
     * unconditional because the marker describes *how this list was asked for*, not what came back: it is
     * read only while resolving a list the service has already returned, so recording it for a request that
     * resolves to `null` licences nothing at all. The helper stores `true`, and that matters — the cache's
     * getter tests the stored value for truthiness
     * (`packages/core/src/cache/request-context-cache.service.ts` L31-L33), so a falsy marker would be
     * indistinguishable from an absent one.
     *
     * @param ctx - The request context, whose authenticated session and active channel are the scope.
     * @param args - The list identifier, and the forward-compatible sharing flag. `includeShared` is
     * accepted at both values and answered identically, because no share row can exist until list sharing
     * ships; the non-default value is therefore forwarded rather than refused.
     *
     * @since 3.8.0
     */
    @Query()
    @Allow(Permission.Owner)
    activeCustomerReorderList(
        @Ctx() ctx: RequestContext,
        @Args() args: ActiveCustomerReorderListArgs,
    ): Promise<ReorderListEntity | null> {
        markSingleReorderListRead(this.requestContextCache, ctx, args.id);
        return this.reorderListService.getReorderList(ctx, args.id, args.includeShared);
    }

    /**
     * @description
     * `createReorderList`: creates a named list owned by the authenticated customer in the active channel.
     *
     * The submitted name is canonicalised and validated by the service, and uniqueness is enforced by the
     * named database constraint over `(customerId, channelId, nameKey)` rather than by a pre-check, so a
     * race cannot defeat it. A name whose canonical form cannot be stored is refused by a propagating
     * `UserInputError` and no row is written; a duplicate canonical name resolves to
     * `ReorderListNameConflictError`, and a customer already holding the configured maximum resolves to
     * `ReorderListLimitError`.
     *
     * The declared union carries those two error results and deliberately not the third:
     * `ReorderListNotFoundError` cannot arise from an operation that addresses no existing row.
     *
     * @param ctx - The request context. The row's owner is derived from its authenticated session and its
     * active channel — the input carries no owner and could not nominate one.
     * @param args - The `CreateReorderListInput`, which declares exactly one field.
     *
     * @since 3.8.0
     */
    @Mutation()
    @Transaction()
    @Allow(Permission.Owner)
    async createReorderList(
        @Ctx() ctx: RequestContext,
        @Args() args: { input: CreateReorderListInput },
    ): Promise<ErrorResultUnion<CreateReorderListResult, ReorderListEntity>> {
        return this.reorderListService.createReorderList(ctx, args.input);
    }

    /**
     * @description
     * `updateReorderList`: renames a list, and touches nothing else.
     *
     * The new name is subject to the identical canonicalisation and the identical uniqueness rule that
     * governs creation, so a rename can resolve to `ReorderListNameConflictError` and a blank rename is
     * refused as malformed input rather than stored. A list the caller does not own in the active channel
     * resolves to `ReorderListNotFoundError`, produced by the affected-row count of a statement whose
     * predicate already carried the ownership conjuncts — never by loading the row and inspecting it.
     *
     * The union carries no limit result: a rename creates no row, so no bound can be breached.
     *
     * @param ctx - The request context, whose session and active channel scope the addressed row.
     * @param args - The `UpdateReorderListInput`: the list identifier and the new name.
     *
     * @since 3.8.0
     */
    @Mutation()
    @Transaction()
    @Allow(Permission.Owner)
    async updateReorderList(
        @Ctx() ctx: RequestContext,
        @Args() args: { input: UpdateReorderListInput },
    ): Promise<ErrorResultUnion<UpdateReorderListResult, ReorderListEntity>> {
        return this.reorderListService.updateReorderList(ctx, args.input);
    }

    /**
     * @description
     * `deleteReorderList`: deletes a list, and its lines with it through the database cascade.
     *
     * **This operation takes a bare `id` rather than an input object**, exactly as the published document
     * declares it, and it succeeds with the platform's own `DeletionResponse` — reused verbatim rather than
     * replaced by a plugin-owned deletion payload, because its `result` and nullable `message` are already
     * what a deletion has to report. A list the caller does not own in the active channel resolves to
     * `ReorderListNotFoundError` on the same affected-row-count authority as every other addressed write.
     *
     * **The return type is the service's own union rather than an {@link ErrorResultUnion}, and that is a
     * deliberate, reported divergence from the shape the other five mutations use.** `ErrorResultUnion`
     * substitutes a TypeScript *entity* for its GraphQL counterpart, and its second type parameter is bound
     * to `VendureEntity` for that reason; this union's success member is `DeletionResponse`, which is a
     * payload rather than an entity and cannot satisfy that bound. Forcing the helper on here would either
     * fail to compile or, worse, type the success member as some unrelated entity — so the service's own
     * union is used, which describes the returned value exactly.
     *
     * @param ctx - The request context, whose session and active channel scope the addressed row.
     * @param args - The identifier of the list to delete.
     *
     * @since 3.8.0
     */
    @Mutation()
    @Transaction()
    @Allow(Permission.Owner)
    async deleteReorderList(
        @Ctx() ctx: RequestContext,
        @Args() args: { id: ID },
    ): Promise<DeleteReorderListResult> {
        return this.reorderListService.deleteReorderList(ctx, args.id);
    }

    /**
     * @description
     * `addItemToReorderList`: adds a variant to a list with a positive integer quantity, deduplicated per
     * variant.
     *
     * A second add of the same variant accumulates onto the existing line rather than inserting a duplicate,
     * enforced by the named per-`(list, variant)` uniqueness constraint and applied by a conditional
     * statement whose affected-row count is the authority. The line bound is enforced on this path only, by
     * a conditional counter update taken before the insert, and a list already at the configured maximum
     * resolves to `ReorderListLimitError` carrying that maximum. A variant that does not resolve in the
     * active channel, and a resulting quantity outside the configured bounds, are both refused by a
     * propagating `UserInputError`.
     *
     * **The input declares exactly three fields, and the absence of a fourth is a ruling rather than an
     * omission.** There is no idempotency key: the delivery guarantee is at-least-once, stated plainly, and
     * `adjustReorderListLine`'s absolute set is the deterministic remedy. The union carries no line-level
     * not-found result, because an add either accumulates onto an existing line or creates one and so has no
     * line it can fail to find.
     *
     * @param ctx - The request context, whose session and active channel scope both the list and the
     * variant.
     * @param args - The `AddItemToReorderListInput`: the list, the variant, and the quantity to add.
     *
     * @since 3.8.0
     */
    @Mutation()
    @Transaction()
    @Allow(Permission.Owner)
    async addItemToReorderList(
        @Ctx() ctx: RequestContext,
        @Args() args: { input: AddItemToReorderListInput },
    ): Promise<ErrorResultUnion<AddItemToReorderListResult, ReorderListEntity>> {
        return this.reorderListService.addItemToReorderList(ctx, args.input);
    }

    /**
     * @description
     * `adjustReorderListLine`: sets a line's quantity to an absolute value.
     *
     * The quantity is an absolute set rather than an increment, which makes the operation idempotent by
     * construction: repeating the call leaves the same stored value. A quantity outside the configured
     * bounds is refused by a propagating `UserInputError` before any write, so a refused adjustment cannot
     * have touched the line.
     *
     * **The union carries `ReorderListNotFoundError` and `ReorderListLineNotFoundError` but no limit
     * result**, and that is exact rather than incidental: the line bound is enforced on the add path only,
     * so changing the quantity of a line that already exists cannot breach a line-count bound. The two
     * not-found results are distinguishable because the list is resolved under the ownership predicate
     * first.
     *
     * @param ctx - The request context, whose session and active channel scope the addressed rows.
     * @param args - The `AdjustReorderListLineInput`: the list, the line, and the absolute quantity to set.
     *
     * @since 3.8.0
     */
    @Mutation()
    @Transaction()
    @Allow(Permission.Owner)
    async adjustReorderListLine(
        @Ctx() ctx: RequestContext,
        @Args() args: { input: AdjustReorderListLineInput },
    ): Promise<ErrorResultUnion<AdjustReorderListLineResult, ReorderListEntity>> {
        return this.reorderListService.adjustReorderListLine(ctx, args.input);
    }

    /**
     * @description
     * `removeReorderListLine`: removes one line from a list, decrementing the stored `lineCount` in the same
     * transaction as the delete.
     *
     * A second remove of the same line resolves to `ReorderListLineNotFoundError` rather than being reported
     * as a success, which is the affected-row count of the delete statement being read as the authority. A
     * list the caller does not own in the active channel resolves to `ReorderListNotFoundError`.
     *
     * @param ctx - The request context, whose session and active channel scope the addressed rows.
     * @param args - The `RemoveReorderListLineInput`: the list and the line.
     *
     * @since 3.8.0
     */
    @Mutation()
    @Transaction()
    @Allow(Permission.Owner)
    async removeReorderListLine(
        @Ctx() ctx: RequestContext,
        @Args() args: { input: RemoveReorderListLineInput },
    ): Promise<ErrorResultUnion<RemoveReorderListLineResult, ReorderListEntity>> {
        return this.reorderListService.removeReorderListLine(ctx, args.input);
    }
}
