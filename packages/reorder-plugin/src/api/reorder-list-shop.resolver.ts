/*
 * The eight Shop API operations of FEATURE-001-01, and the narrow set of things this file is for.
 *
 * WHAT THIS FILE IS. A gated, transactional boundary over `ReorderListService`. It divides cleanly, and the
 * division is worth stating precisely because the rule below is easier to check against a specific claim than
 * against a general one.
 *
 * The SIX MUTATIONS are pure delegates. Each decorates a call, forwards its arguments to the identically named
 * service method and returns that result untouched; the whole of their correctness is in the decorators and in
 * what they do NOT do.
 *
 * The TWO QUERIES each additionally carry one request-shaped concern, because each concern is a property of the
 * request rather than of the domain and so has nowhere else to live:
 *
 *   - `activeCustomerReorderLists` normalises its two arguments at the boundary before delegating. It
 *     substitutes the configured default page size where the caller supplied none — distinguishing an
 *     explicitly null `take` from a `take` of zero, which are different requests — and resolves
 *     `includeShared` to the boolean the published default means, since an explicit null receives no declared
 *     default. Every other member of the generated options argument is passed through exactly as it arrived.
 *   - `activeCustomerReorderList` reconciles the returned list's stored `lineCount` against the total this
 *     request observes: it marks the object it is about to return, pre-resolves the unfiltered `lines` window
 *     the document selected, repairs the row and writes the reconciled value onto the object — all BEFORE it
 *     returns that object. The ordering is a requirement rather than a convenience, because GraphQL takes a
 *     sibling scalar off the source object during its synchronous selection-set walk, so a reconciliation
 *     landing any later corrects the row while the response still reports the stale number. See that method's
 *     own documentation, and the mechanism it borrows from `ReorderListEntityResolver`.
 *
 * Neither query weakens the rule below, and that is the point of naming exactly what they do: **no ownership
 * decision, no domain validation, no ordering, no clamping, no error translation and no payload assembly
 * happens anywhere in this file.** Page-size substitution decides a default the plugin declares, not a limit —
 * a `take` above the Shop-side maximum is still refused by the platform, because `ignoreQueryLimits` is left
 * false. And the counter statement, its compare-and-set guard and the nested page both of them read all belong
 * to the service.
 *
 * FOUR HELPFUL-LOOKING ADDITIONS THAT WOULD EACH BE A DEFECT HERE. Each is named with the reason it is
 * refused:
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
 * mutations and on neither read, which is an idiom the precedent establishes and no ticket names. Five of the
 * six take the decorator's default `'auto'` mode; `addItemToReorderList` declares `'manual'`, because it is the
 * one operation that RETRIES and a retry nested inside an already-open transaction is a savepoint rather than a
 * fresh transaction. That method's own documentation gives the whole reasoning and the engine behaviour it
 * turns on.
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
 * new public API to carry a `@since` tag naming what will be the next minor version, and its own example
 * names a different one. This checkout declares 3.7.0, so the next minor derives to 3.8.0 — computed from
 * that declared version plus the guide's rule, and never a quotation from the guide, which does not state
 * the value. The authoritative tickets record the same derivation.
 */

import { Inject } from '@nestjs/common';
import { Args, Info, Mutation, Query, Resolver } from '@nestjs/graphql';
import {
    Allow,
    Ctx,
    ErrorResultUnion,
    ID,
    PaginatedList,
    Permission,
    RequestContext,
    Transaction,
} from '@vendure/core';
import { GraphQLResolveInfo } from 'graphql';

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
import { ResolvedReorderPluginOptions } from '../types';

import {
    markSingleReorderListRead,
    reconcileSingleReorderListRead,
    wasReturnedBySingleReorderListRead,
} from './reorder-list-entity.resolver';

/*
 * WHY THE SINGLE-LIST-READ LICENCE IS NOT A CACHE KEY. It is module-private state in the entity resolver,
 * keyed on the object the read returned, and this file marks it by calling that resolver's own setter rather
 * than by writing a key both files would have to spell. The platform's request-scoped cache is keyed on the
 * `RequestContext` INSTANCE, and a field resolver does not reliably receive the instance a root resolver did —
 * the platform binds a context per handler and a field resolver reads the shared request slot
 * (`packages/core/src/api/decorators/request-context.decorator.ts`), which in a multi-root document can hold
 * another root's context by the time the field runs. A licence written under one context and looked for under
 * another is simply absent, and the repair FEATURE-001-01 section 2.6.2.1 requires would then be skipped
 * silently. Object identity removes the context from the question, and is strictly narrower besides: a
 * collection entry for the same row is a different object and can never inherit the licence.
 */

/**
 * @description
 * Whether the given list object is the one {@link ReorderListShopResolver.activeCustomerReorderList} returned
 * on this request — the licence the `lineCount` compare-and-set repair requires.
 *
 * **This function is the coordination point between the two resolvers, and it exists so that the question is
 * asked in one place rather than answered independently in two.** The repair belongs to the single-list read
 * alone: a collection read pages no list's lines, so it has no observed total to compare the stored counter
 * against, and it must never repair (FEATURE-001-01 section 2.6.2.1). A licence the two sides resolved
 * differently would fail silently in the direction that looks like success — the reader would simply never find
 * it, the repair would never run, and no test asserting a repaired counter on the single read could say why.
 *
 * **The licence is held against the returned OBJECT — not against the row's identifier, and not against the
 * request context.** One request may legitimately carry both reads: a document may select
 * `activeCustomerReorderList(id: 1)` alongside `activeCustomerReorderLists`, each read hydrating its own object
 * for row 1, and an identifier-keyed licence is satisfied by both, so the collection's entry would inherit the
 * single read's licence to write. A context-keyed licence fails the other way: a field resolver does not
 * reliably receive the `RequestContext` instance the root resolver did, so the licence could be looked for under
 * another root's context and never found. Membership of a module-private set of returned objects is satisfied by
 * exactly one object and depends on no context at all.
 *
 * It delegates to the reader's own predicate rather than reimplementing the lookup, which is what makes "asked
 * in one place" true across the two files instead of merely stated in each of them.
 *
 * @param list - The list object whose provenance is in question.
 *
 * @example
 * ```ts
 * // Asserting, from a specification, that the single read licensed the object it returned:
 * const list = await shopResolver.activeCustomerReorderList(ctx, { id }, info);
 * expect(singleListReadMarked(list!)).toBe(true);
 * ```
 *
 * @docsCategory core plugins/ReorderPlugin
 * @since 3.8.0
 */
export function singleListReadMarked(list: ReorderListEntity): boolean {
    return wasReturnedBySingleReorderListRead(list);
}

/**
 * The arguments of `activeCustomerReorderLists`, as the published document declares them plus the one
 * argument the platform's generator adds.
 *
 * Three things about this shape are deliberate. The page options are typed from the service's own parameter
 * rather than named as a type, so this file never spells either of the two generated per-row options input
 * names — naming one that the published document does not declare is what fails the schema merge (ruling
 * R10) — and a change to what the service accepts becomes a compile error here rather than a silent
 * mismatch. And `includeShared` is optional in TypeScript even though the document gives it a default,
 * because a default is applied by the GraphQL layer and this type also describes the value a unit
 * specification passes in directly.
 *
 * **And both admit explicit `null` as well as absence, which is what the published contract actually
 * allows.** Neither argument is non-null in the document, so a client may send either as a literal `null` or
 * as a variable whose value is `null`, and a `null` argument arrives in the args object as `null` — it is not
 * normalised to `undefined` and does not trigger the declared default, which applies only to an argument that
 * was omitted. A type declaring these `?: T` alone therefore describes a subset of what the schema accepts,
 * and every consumer of it is written against a narrower contract than the one clients hold. Admitting `null`
 * here and normalising at the two call sites below is what keeps the boundary type honest.
 */
interface ActiveCustomerReorderListsArgs {
    options?: NonNullable<Parameters<ReorderListService['getReorderLists']>[1]> | null;
    includeShared?: boolean | null;
}

/**
 * The arguments of `activeCustomerReorderList`: the list identifier, and the same forward-compatible
 * sharing flag the collection read carries, admitting explicit `null` for the reason above.
 */
interface ActiveCustomerReorderListArgs {
    id: ID;
    includeShared?: boolean | null;
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
 * Quantities": the two read queries — one returning a paginated collection of lists, one returning a single
 * nullable list whose nested `lines` field is paginated — and the six mutations declared by this plugin's own
 * `shopApiExtensions` document.
 *
 * Every method is gated with `@Allow(Permission.Owner)`, every mutation runs inside a transaction, and every
 * method calls the identically named {@link ReorderListService} method. **No access control, no domain
 * validation, no ordering, no clamping, no error translation and no payload assembly lives in this class** —
 * the service owns all of it, so each invariant has exactly one implementation. The file-level comment above
 * records why each of four plausible additions here would be a defect.
 *
 * **The six mutations are pure delegates**: each forwards its arguments and returns the service's result
 * untouched.
 *
 * **The two queries each carry one request-shaped behaviour in addition to delegating**, because each is a
 * property of the request rather than of the domain:
 *
 *   - {@link ReorderListShopResolver.activeCustomerReorderLists} normalises its arguments before delegating —
 *     substituting the configured default page size where the caller supplied none, and resolving
 *     `includeShared` to the boolean the published default means. Both matter because an explicitly null
 *     argument is a distinct value from an omitted one and receives no declared default. Every other member of
 *     the generated options argument reaches the service exactly as it arrived, and the substituted default is
 *     stricter than the Shop-side maximum the platform still enforces.
 *   - {@link ReorderListShopResolver.activeCustomerReorderList} records — against the object it is returning,
 *     so that a collection entry for the same row cannot be mistaken for it — that this list was read singly,
 *     and then reconciles that list's stored line counter **before the object is returned**. A reconciliation
 *     landing after the executor has taken the sibling scalar corrects the row while the response still reports
 *     the stale number, which is why the ordering rather than the arithmetic is what this method contributes.
 *
 * Each behaviour is described in full on the method that performs it, and neither decides anything the service
 * owns: the counter statement, its compare-and-set guard and the nested page they both read are all the
 * service's.
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
        @Inject(REORDER_PLUGIN_OPTIONS) private options: ResolvedReorderPluginOptions,
    ) {}

    /**
     * The page size the collection read applies where the caller supplied none. Read by
     * {@link ReorderListShopResolver.activeCustomerReorderLists} and by nothing else — the nested `lines`
     * field's own default belongs to the entity field resolver.
     *
     * It reads the injected option and restates nothing: the provider supplies
     * {@link ResolvedReorderPluginOptions}, so the key is present, validated and frozen by the time this
     * class exists. A `?? 25` here would be a second executable copy of a number the plugin already
     * declares — unreachable through `ReorderPlugin.init()`, and free to drift from the value the server is
     * running on. It stays a getter rather than a value captured in the constructor so that the injected
     * object remains the single authority and nothing here holds a copy of it.
     */
    private get defaultReorderListsPageSize(): number {
        return this.options.defaultReorderListsPageSize;
    }

    /**
     * The nested page size the single-list read hands to its counter reconciliation, so that the window it
     * resolves is the window {@link ReorderListEntityResolver.lines} will ask for.
     *
     * **This is not a second place the nested default is applied.** The substitution itself lives in the entity
     * field resolver's own normaliser, which both callers share; this getter only supplies the same injected
     * value to it. Reading it from {@link ResolvedReorderPluginOptions} rather than restating `50` is what keeps
     * the two windows identical — a literal here would be unreachable through `ReorderPlugin.init()`, untested,
     * and free to drift from the value the server is running on, and a drift would silently make the read
     * resolve one page and the field resolver load another.
     */
    private get defaultReorderListLinesPageSize(): number {
        return this.options.defaultReorderListLinesPageSize;
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
     * The service applies the same option for the same purpose on the same path, so this assignment cannot
     * disagree with it and cannot be applied twice to one request: both read one injected value, and once
     * `take` carries a value the service's own `??` on it does nothing. The 50 that governs the nested
     * `lines` field is not applied here — that page belongs to the entity field resolver, and neither
     * resolver applies the other's default.
     *
     * A caller with no resolvable customer scope receives an empty page rather than an error, which is the
     * shipped read convention (ruling R14). That answer is the service's; this method neither produces nor
     * inspects it.
     *
     * @param ctx - The request context. Its authenticated session and active channel are the scope, and
     * nothing in the arguments can widen them.
     * @param args - The generator-supplied page options, and the forward-compatible sharing flag. Either may
     * arrive as an explicit `null` rather than absent — a `null` argument is a distinct value from an omitted
     * one and does not receive the document's declared default — so both are normalised here.
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
            // Normalised at the boundary rather than passed through. A client may send this argument as an
            // explicit `null`, which is not the same value as an omitted argument and does not receive the
            // document's declared default, so the service is handed the boolean the contract means in both
            // cases. `=== true` rather than a coercion, so nothing but the literal true widens the read.
            args.includeShared === true,
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
     * **The licence.** After the read resolves, this method records — against the **exact object** the service
     * returned — that this list was read singly. That is the licence the `lineCount` compare-and-set repair
     * requires, and the repair belongs to the single-list read alone (FEATURE-001-01 section 2.6.2.1).
     *
     * **The mark is written through the reader's own helper, `markSingleReorderListRead`, rather than by
     * composing state here.** The two sides of this contract have to agree or it fails in the direction that
     * looks like success: the reader would simply never find the mark, the repair would never run, and nothing
     * would report that it had not. Calling the reader's setter makes agreement structural instead of
     * coincidental. {@link singleListReadMarked} exposes the same question for a specification that needs to
     * assert on it, and delegates to the same predicate for the same reason.
     *
     * **The licence is set AFTER the read and only for a non-null result, and both halves are load-bearing.**
     * Marking before the read means marking something that has not been returned yet, so the only thing
     * available to mark is the requested identifier — and an identifier is shared by every object carrying it.
     * A document may select `activeCustomerReorderList(id: 7)` beside `activeCustomerReorderLists`, in which
     * case the collection also hydrates an object for row 7; an identifier-keyed licence is satisfied by that
     * object too, and the collection's entry then repairs a counter on a path the contract forbids. Awaiting
     * the result and marking the object itself makes the licence unforgeable: exactly one object in the request
     * carries it, and a `null` result licenses nothing because there is no object to license.
     *
     * **The counter is reconciled HERE, before the object is returned, and that ordering is a requirement
     * rather than an optimisation.** GraphQL completes an object's fields by walking its selection set
     * synchronously, reading a scalar with no field resolver straight off the source object; only the promises
     * that walk collected are awaited afterwards. A reconciliation performed inside the nested `lines` resolver
     * therefore lands after the executor has already taken `lineCount`, so the row would be corrected while the
     * response still reported the stale number — on precisely the first read the contract requires to report the
     * corrected one. Reconciling before returning removes the race: the value is on the object before the
     * executor can see it. The nested page this reconciliation reads is cached against the object, so the
     * `lines` field serves it rather than loading it again, and the request pays for it once.
     *
     * **It is driven by the document rather than by an assumption.** `info` is what says whether the caller
     * selected `lines` at all and with which window — no selection means no observed total and so nothing to
     * reconcile from, which is the same position the collection read is permanently in. The platform's own
     * resolvers read `info` for exactly this purpose, pre-starting a query a field resolver will need and
     * caching the result for it (`packages/core/src/api/resolvers/shop/shop-products.resolver.ts`).
     *
     * @param ctx - The request context, whose authenticated session and active channel are the scope.
     * @param args - The list identifier, and the forward-compatible sharing flag. `includeShared` is
     * accepted at both values and answered identically, because no share row can exist until list sharing
     * ships; the non-default value is therefore forwarded rather than refused.
     * @param info - The resolve info of this field, read only to discover the nested `lines` window the document
     * asked for. Nothing is resolved from it and no selection is rewritten.
     *
     * @since 3.8.0
     */
    @Query()
    @Allow(Permission.Owner)
    async activeCustomerReorderList(
        @Ctx() ctx: RequestContext,
        @Args() args: ActiveCustomerReorderListArgs,
        @Info() info: GraphQLResolveInfo,
    ): Promise<ReorderListEntity | null> {
        // `includeShared` is normalised at the boundary for the reason the collection read states: an
        // explicitly `null` argument is a distinct value from an omitted one and receives no declared default.
        const list = await this.reorderListService.getReorderList(ctx, args.id, args.includeShared === true);
        if (list) {
            // The licence first, because the reconciliation below tests it.
            markSingleReorderListRead(list);
            // Then the reconciliation, and BEFORE this method returns — see the note above on why the ordering
            // is the whole of the fix. It issues nothing where the document selected no `lines` field or
            // narrowed the nested collection. Where it does run, it fails closed: a nested page it could not
            // read is retried once and then propagates, and a counter repair that was attempted and FAILED
            // propagates too, already sanitised by the service. Both for the same reason — forgiving either
            // produces a response carrying a stale `lineCount` with no indication of it, which is a wrong
            // answer rather than an error. The single exception is a `UserInputError` about the caller's own
            // nested arguments, which is left for the nested field to raise on its own path.
            await reconcileSingleReorderListRead(
                this.reorderListService,
                ctx,
                list,
                info,
                this.defaultReorderListLinesPageSize,
            );
        }
        return list;
    }

    /**
     * @description
     * `createReorderList`: creates a named list owned by the authenticated customer in the active channel.
     *
     * The submitted name is canonicalised and validated by the service, which pre-checks the canonical key
     * advisorily and leaves the named database constraint over `(customerId, channelId, nameKey)` as the
     * authority, so a race cannot defeat it. A name whose canonical form cannot be stored is refused by a
     * propagating `UserInputError` and no row is written; a duplicate canonical name resolves to
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
     * refused as malformed input rather than stored.
     *
     * A list the caller does not own in the active channel resolves to `ReorderListNotFoundError`, and the
     * service produces it in two distinct places for two distinct reasons — neither of which is a row loaded
     * and then inspected. A caller who may not have the row is refused by the transaction's FIRST statement, a
     * scoped `SELECT` carrying the identifier together with the acting customer and the active channel, so the
     * refusal issues no `UPDATE` at all. Only once that read has admitted the row is the conditional write
     * issued, still carrying the same ownership conjuncts, and its affected-row count is then the authority for
     * the admitted path: zero means the row left this caller's scope between the two statements, and is
     * reported as the same normalised not-found.
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
     * what a deletion has to report. A list the caller does not own in the active channel — and a list already
     * deleted by an earlier request — resolves to `ReorderListNotFoundError`, refused by the transaction's
     * first statement: a scoped `SELECT` carrying the identifier, the acting customer and the active channel,
     * which returns no rows and leaves no `DELETE` issued on that caller's behalf. The delete itself runs only
     * on the admitted path, still fully scoped, and its affected-row count remains the authority there.
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
     * statement whose affected-row count is the authority.
     *
     * **`AddItemToReorderListResult` carries exactly three members: `ReorderList`,
     * `ReorderListNotFoundError` and `ReorderListLimitError`.** A list the caller does not own in the active
     * channel — and an id that names no list at all — resolves to `ReorderListNotFoundError`. The line bound
     * is enforced on this path only, by a conditional counter update taken before the insert, so a list
     * already at the configured maximum resolves to `ReorderListLimitError` carrying that maximum as
     * `maxItems`. The union carries no line-level not-found result, because an add either accumulates onto an
     * existing line or creates one and so has no line it can fail to find.
     *
     * **A malformed request is not a union member.** A quantity that is not a positive integer, a resulting
     * quantity above `maxQuantityPerLine`, and a variant that does not resolve in the active channel are each
     * refused by a propagating `UserInputError`, which reaches the client as one top-level `errors` entry
     * with `extensions.code` exactly `USER_INPUT_ERROR`, `data` null and no row written. Each carries one of
     * this plugin's own message keys: `error.reorder-list-line-quantity-must-be-positive`,
     * `error.reorder-list-line-quantity-above-maximum` (interpolating `max`) and
     * `error.reorder-list-variant-not-found` (interpolating `id`) respectively.
     *
     * **The input declares exactly three fields, and the absence of a fourth is a ruling rather than an
     * omission.** There is no idempotency key: the delivery guarantee is at-least-once, stated plainly, and
     * `adjustReorderListLine`'s absolute set is the deterministic remedy.
     *
     * **THE ONE MUTATION HERE THAT DECLARES `'manual'`, AND WHY IT MUST.** Every other mutation on this
     * resolver runs one transaction and is decorated `@Transaction()`, whose `'auto'` mode opens that
     * transaction before the resolver body runs. This operation runs a BOUNDED RETRY — a concurrent request can
     * create the very line this call was about to create, or remove the line it had just resolved, and in both
     * cases the contract's answer is to redo the operation with the other request's row visible rather than to
     * report an error. Under `'auto'` the service's own `connection.withTransaction` would INHERIT the
     * already-open transaction, and TypeORM opens a nested one as a savepoint
     * (`QueryRunner.startTransaction` issues `SAVEPOINT typeorm_N` once `transactionDepth` is above zero;
     * every driver family this plugin supports declares `transactionSupport = 'nested'`). A savepoint retry is
     * not a retry of the kind this operation needs, for two reasons that are properties of the engines rather
     * than of this code: `ROLLBACK TO SAVEPOINT` on InnoDB does NOT release the row locks taken after the
     * savepoint, and the transaction's REPEATABLE READ snapshot outlives it — so the second attempt would
     * inherit the first attempt's locks and its stale view of the very row it is retrying because of.
     *
     * `'manual'` removes both. The interceptor still creates the query runner, attaches it to the context and
     * still rolls back on an uncaught error, but it starts no transaction — so each attempt's
     * `withTransaction` opens a REAL one at depth zero, and committing or rolling it back releases every lock
     * and every snapshot it took. That is what lets the ordinary path lock as little as it does: the retry
     * needs nothing carried over, so no attempt has to lock defensively for the benefit of the next one. The
     * service is the component that opens and closes each transaction, which is the arrangement `'manual'`
     * exists for, and it wraps every write without exception.
     *
     * @param ctx - The request context, whose session and active channel scope both the list and the
     * variant.
     * @param args - The `AddItemToReorderListInput`: the list, the variant, and the quantity to add.
     *
     * @since 3.8.0
     */
    @Mutation()
    @Transaction('manual')
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
     * construction: repeating the call leaves the same stored value.
     *
     * **`AdjustReorderListLineResult` carries exactly three members: `ReorderList`,
     * `ReorderListNotFoundError` and `ReorderListLineNotFoundError` — and no limit result.** That is exact
     * rather than incidental: the line bound is enforced on the add path only, so changing the quantity of a
     * line that already exists cannot breach a line-count bound. The two not-found results are
     * distinguishable because the list is resolved under the ownership predicate first.
     *
     * **A malformed quantity is not a union member.** A value that is not a positive integer, or that
     * exceeds `maxQuantityPerLine`, is refused by a propagating `UserInputError` before any write — one
     * top-level `errors` entry whose `extensions.code` is exactly `USER_INPUT_ERROR`, with `data` null —
     * carrying `error.reorder-list-line-quantity-must-be-positive` or
     * `error.reorder-list-line-quantity-above-maximum` (interpolating `max`) respectively. A refused
     * adjustment cannot have touched the line.
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
