/*
 * The reorder-list field resolvers — provenance, and the one property that makes them correct.
 *
 * WHAT THIS FILE IS. Three field resolvers, and nothing else: `ReorderList.lines`, `ReorderList.viewerAccess`
 * and `ReorderListLine.productVariant`. They are the only published fields on the two plugin-owned types
 * that are not columns of the rows the page query already selected.
 *
 * THE ONE PROPERTY THAT MAKES THEM CORRECT. Every field here is resolved ONCE PER PAGE over the page's
 * identifier set, never once per entry (FEATURE-001-01 section 2.6.3). That is not a performance preference:
 * a per-entry resolver returns byte-identical payloads while making the request's statement count grow with
 * the page size, so no response-shaped assertion can tell the two apart. STORY-001-01-04 therefore asserts
 * the STATEMENT COUNT — captured against `reorder_list` and `reorder_list_line` for a page of three lists and
 * again for a page of six, and required to be EQUAL. Everything about the batching below exists to make that
 * equality hold rather than to save time.
 *
 * THREE SHAPES ARE FORBIDDEN HERE, AND ALL THREE RETURN THE RIGHT NUMBERS. `lineCount` is the stored column
 * on `reorder_list`, it arrives with the row, and it is the SINGLE authority for the published field, for the
 * generated filter, for the generated sort and for the atomic line bound (FEATURE-001-01 section 2.6.2). So
 * this file declares NO `lineCount` field resolver of any kind, and in particular none of:
 *
 *   1. an entry-level resolver that reads or counts line rows per entry;
 *   2. a grouped count issued alongside the page — two sources for one number is the contradiction that
 *      sub-section closes;
 *   3. the value derived from the length of a loaded `lines` relation, which fails twice over because `lines`
 *      is a bounded PAGE while `lineCount` is the stored TOTAL.
 *
 * A `SELECT COUNT(*)` per entry reports exactly what the column reports, so a payload test passes under
 * every one of them. Statement counting is what makes the claim falsifiable, and three facts stay distinct
 * because a client needs all three (STORY-001-01-04): `lineCount` is the stored total; `lines.totalItems` is
 * how many lines the list holds under the caller's filter; and `lines.items.length` is how many arrived in
 * THIS page, bounded by the generated options argument and possibly smaller than either.
 *
 * WHAT IS DELIBERATELY ABSENT, so that each absence reads as a ruling rather than as an omission. There is
 * no `options` argument declared by hand on any field and no per-row options input named anywhere — the
 * platform's list-options generator owns both, and NAMING one this plugin's document does not declare is an
 * unknown-type merge failure that stops the server from starting (EPIC-001 ruling R10;
 * `packages/core/src/api/config/generate-list-options.ts` L41-L48 walks every object type's fields, which is
 * why `ReorderList.lines` receives its argument without one being written). There is no `ListQueryBuilder`
 * injected here: the service owns the build, the declared total order, the APPENDED identifier tie-break and
 * the hand-off to the platform's own limit check — which refuses an over-limit `take` rather than reducing
 * it — so a second derivation of the sort cannot drift from the first. There is no sharing:
 * `viewerAccess` reports the truthful values while no share row can exist, and no grant roster is read,
 * declared or assumed — that is FEATURE-001-06's. And there is no availability field of this plugin's own on
 * a line: a saved list records INTENT rather than availability, so neither `deletedAt` nor `enabled` is
 * projected onto a payload here (surfacing availability is FEATURE-001-03's, resolving it FEATURE-001-04's).
 *
 * The `@since 3.8.0` tags below are a derivation rather than a quotation: this checkout declares 3.7.0 and
 * the contribution guide requires the next minor version, which the guide itself never states.
 */

import { Inject } from '@nestjs/common';
import { Args, Parent, ResolveField, Resolver } from '@nestjs/graphql';
import {
    Ctx,
    ID,
    idsAreEqual,
    ListQueryOptions,
    Logger,
    PaginatedList,
    ProductVariant,
    ProductVariantService,
    RequestContext,
    RequestContextCacheService,
    Translated,
    UserInputError,
} from '@vendure/core';
import { FieldNode, GraphQLResolveInfo, SelectionNode, valueFromASTUntyped } from 'graphql';

import { loggerCtx, REORDER_PLUGIN_OPTIONS } from '../constants';
import { ReorderListLine } from '../entities/reorder-list-line.entity';
import { ReorderList } from '../entities/reorder-list.entity';
import {
    ReorderListLinePage,
    ReorderListService,
    ReorderListViewerAccess,
    reportReorderListInternalFailure,
} from '../service/reorder-list.service';
import { ResolvedReorderPluginOptions } from '../types';

/**
 * The exact list objects the single-list read returned on the request currently in flight.
 *
 * **Object identity and module-private storage are both required, for the separate reasons below.**
 *
 * *Why identity rather than the row's identifier.* One request may legitimately carry both reads — a document
 * selecting `activeCustomerReorderList(id: 7)` beside `activeCustomerReorderLists` — and each read hydrates
 * its own object for row 7. An identifier-keyed licence is satisfied by both of them, so the collection's
 * entry would inherit the single read's licence to repair the stored counter, which FEATURE-001-01 section
 * 2.6.2.1 forbids outright. graphql-js passes a root field's resolved value through as the parent of its child
 * fields, so the object a field resolver receives IS the object the root returned and no other occurrence —
 * not even one carrying the same id — is that object.
 *
 * *Why module-private rather than the platform's request-scoped cache.* That cache is keyed on the
 * `RequestContext` INSTANCE, and a field resolver does not reliably receive the instance the root resolver
 * did: the platform binds a context per handler and a field resolver reads the shared request slot
 * (`packages/core/src/api/decorators/request-context.decorator.ts`), which in a multi-root document can hold
 * another root's context by the time the field runs. A licence written under one context and looked for under
 * another is simply absent, and the repair the contract requires would then be silently skipped — a failure in
 * the direction that looks like success. Keying the licence on the object removes the context from the question
 * altogether.
 *
 * *Why this cannot leak between requests.* Membership is held weakly, so an entry lives exactly as long as the
 * row object it describes — which is the request. No clearing is needed and none is possible to forget. The
 * plugin's own service uses the same shape for the owner scope it records against a row
 * (`RESOLVED_OWNER_SCOPES`), so this is the established mechanism in this package rather than a new one.
 */
const SINGLE_LIST_READ_OCCURRENCES = new WeakSet<ReorderList>();

/**
 * How many times the single-list read attempts its line-page pre-resolve before it gives up and fails.
 *
 * TWO, deliberately, and the number is the bound rather than the point. The pre-resolve is what lets the
 * counter be reconciled BEFORE the parent object is exposed, so a failure here cannot simply be absorbed:
 * the nested `lines` resolver would then read its own page, succeed, and repair the row in its fallback —
 * after the executor has already taken `lineCount` from the parent. The response would carry a coherent
 * page beside the stale scalar the repair had just corrected in storage, with nothing in it to say so. So a
 * transient failure — a dropped connection, a lock timeout, a momentarily exhausted pool — is given one more
 * attempt, and a failure that survives the retry is propagated already sanitised by the service.
 */
const PRE_RESOLVE_READ_ATTEMPTS = 2;

/** The request-scoped key prefix under which one page's pending line-page batch is held. */
const LINES_BATCH_KEY_PREFIX = 'ReorderListEntityResolver.linesBatch';

/** The request-scoped key under which one page's pending product-variant batch is held. */
const VARIANT_BATCH_KEY = 'ReorderListEntityResolver.productVariantBatch';

/**
 * @description
 * The arguments the platform's list-options generator supplies to the nested `ReorderList.lines` field.
 *
 * It is declared inline, and both halves of that are deliberate. **Inline**, because this plugin ships no
 * code-generated types module — the shipped reviews exemplar imports one, and there is no equivalent
 * artefact here to import. **And declared rather than untyped**, because the argument is real: the generator
 * adds an `options` argument to every field whose type implements `PaginatedList`, root or nested
 * (`packages/core/src/api/config/generate-list-options.ts` L41-L48), and a resolver that did not accept it
 * would silently ignore the page a caller asked for.
 *
 * Nothing here names a per-row options input. The GraphQL type of this argument is generated at run time
 * from the row type, and writing that generated name into either the schema document or this module would be
 * the unknown-type failure EPIC-001 ruling R10 forbids. The TypeScript shape below is the platform's own
 * {@link ListQueryOptions}, which is a different thing entirely: a compile-time description of `take`,
 * `skip`, `sort`, `filter` and `filterOperator`, not a schema declaration.
 *
 * `options` is optional AND nullable because that is what the generated argument is: a caller may omit it,
 * and a caller may pass an explicit null.
 *
 * @docsCategory core plugins/ReorderPlugin
 * @docsPage ReorderListEntityResolver
 * @since 3.8.0
 */
export interface ReorderListLinesArgs {
    /**
     * @description
     * The page of lines the caller asked for. Where it carries no `take`, the plugin's configured default
     * page size is applied; where it asks for more than the Shop-side maximum, the platform refuses the
     * request with its own input error, because `ignoreQueryLimits` is left false on every query this
     * plugin issues.
     *
     * @since 3.8.0
     */
    options?: ListQueryOptions<ReorderListLine> | null;
}

/**
 * @description
 * Records that the single-list read returned **this exact list object** — the first of the conjuncts that
 * admit the `lineCount` compare-and-set repair.
 *
 * **This must be called by `activeCustomerReorderList`, with the object that read returned, and by nothing
 * else.** The collection read must never repair: a page of lists pages no lines, so it has no observed total
 * to compare against, and repairing there would rewrite a counter from a number the request never established
 * (FEATURE-001-01 section 2.6.2.1).
 *
 * The licence is held against the object rather than against the row's identifier or the request context, for
 * the reasons {@link SINGLE_LIST_READ_OCCURRENCES} sets out: an identifier is shared by every occurrence of the
 * row in a document, and a context-keyed licence can be written under one handler's context and looked for
 * under another's. It is deliberately NOT inferred from the page batch holding a single parent either — a
 * collection read asking for `take: 1` is indistinguishable under that test and would repair on the collection
 * path.
 *
 * **The failure mode is safe in one direction only, which is why the mark is opt-in.** A request that never
 * marks simply never repairs — the stored counter is reported exactly as it stands, which is the collection
 * read's own documented behaviour. A request that marked wrongly would repair on a path the contract forbids.
 *
 * @param list - The list object the single-list read is about to return. It must be the object itself; a copy
 * of it, or another object carrying the same identifier, is not the same licence.
 *
 * @example
 * ```ts
 * const list = await this.reorderListService.getReorderList(ctx, id, includeShared);
 * if (list) {
 *     markSingleReorderListRead(list);
 * }
 * return list;
 * ```
 *
 * @docsCategory core plugins/ReorderPlugin
 * @docsPage ReorderListEntityResolver
 * @since 3.8.0
 */
export function markSingleReorderListRead(list: ReorderList): void {
    SINGLE_LIST_READ_OCCURRENCES.add(list);
}

/**
 * @description
 * Whether **this exact list object** was returned by the single-list read.
 *
 * The counterpart of {@link markSingleReorderListRead}, and the only sanctioned way to ask the question: it
 * tests membership of the marked object set rather than comparing identifiers, so an object the collection read
 * produced for the same row answers `false` however many times that row appears in the document — and the
 * answer does not depend on which `RequestContext` instance the asking resolver happened to receive.
 *
 * @param list - The parent object whose provenance is in question.
 *
 * @docsCategory core plugins/ReorderPlugin
 * @docsPage ReorderListEntityResolver
 * @since 3.8.0
 */
export function wasReturnedBySingleReorderListRead(list: ReorderList): boolean {
    return SINGLE_LIST_READ_OCCURRENCES.has(list);
}

/**
 * The in-flight counter repairs, one entry per list object.
 *
 * **This exists because "exactly one compare-and-set statement" is a claim about a whole request, and a
 * document may reach the repair more than once at the same time.** The root read reconciles before it exposes
 * the parent, and sibling GraphQL fields — two aliases of `lines` on the one object `activeCustomerReorderList`
 * returned — are then executed concurrently rather than in sequence. Writing the reconciled value back onto the
 * row makes a *later* resolution find stored and observed in agreement, but it cannot help a *simultaneous*
 * one: both aliases would await the same page batch, both would read the same counter, and the second would
 * reach the service while the first was still suspended on its own statement. Two conditional updates would be
 * issued where the contract permits one. Only one of them could ever affect a row, because the second finds the
 * guard value already changed — so the counter is correct either way — but the statement count is not, and that
 * count is the contract.
 *
 * It is keyed on the same object identity the licence is, and held weakly for the same reason, so it is
 * confined to the request without any clearing step. It is deliberately NOT held in the platform's
 * request-scoped cache: a gate a field resolver looks for under a different `RequestContext` instance is a gate
 * that is not there, and the second statement it exists to prevent would then be issued.
 *
 * @internal
 */
const LINE_COUNT_REPAIRS = new WeakMap<ReorderList, Promise<number>>();

/**
 * @description
 * Runs `repair` for this exact list object at most once, and returns the one result to every caller.
 *
 * **The registration is synchronous and that is the whole mechanism.** `repair` is invoked and its promise is
 * stored in the same uninterrupted run of statements, so a second caller that arrives while the first is
 * suspended finds the promise already there and awaits it instead of starting another. Reversing those two
 * steps — or placing any `await` between the lookup and the store — reopens exactly the window it closes.
 *
 * A rejected repair is deliberately left in place rather than evicted. Retrying it would issue the second
 * statement this gate exists to prevent, and every caller sharing one failure is the truthful outcome of one
 * attempt having been made.
 *
 * @param list - The list object whose repair is being gated, by identity.
 * @param repair - Starts the repair. Called at most once per list object.
 * @returns The reconciled counter value, shared by every caller for this object.
 *
 * @docsCategory core plugins/ReorderPlugin
 * @docsPage ReorderListEntityResolver
 * @since 3.8.0
 */
export function repairLineCountOnce(list: ReorderList, repair: () => Promise<number>): Promise<number> {
    const started = LINE_COUNT_REPAIRS.get(list);
    if (started !== undefined) {
        return started;
    }
    // No `await` may separate these two statements. `repair()` returns its promise synchronously, so the entry
    // is installed before control can return to the event loop and before any sibling field can observe the
    // gate as empty.
    const pending = repair();
    LINE_COUNT_REPAIRS.set(list, pending);
    return pending;
}

// The single-list read's counter reconciliation, which has to happen BEFORE the parent object is handed
// to GraphQL. This section is the whole of that mechanism, so it is documented as one.

/**
 * The name of the nested field this reconciliation reads its observed total from. It is the published field
 * name and the resolver method name, and the two must agree or the pre-resolved page is never consumed.
 */
const LINES_FIELD_NAME = 'lines';

/**
 * The nested line pages already resolved for a list object, keyed by the options they were resolved under.
 *
 * **This is what keeps the reconciliation free of an extra statement.** The single-list read resolves the
 * nested page itself, before returning the parent, because the reconciled counter has to be on the object
 * before GraphQL reads the sibling `lineCount` scalar off it. If the field resolver then loaded that same page
 * again, the request would issue the nested read's two statements twice — so the page is deposited here and the
 * field resolver serves it from the cache when it asks for the same window.
 *
 * The options key is the same {@link stableStringify} rendering the page batch uses, so a field asking for a
 * *different* window misses the cache and loads its own page, which is correct: a cached page is a cached
 * answer to one question. The map is keyed on object identity and held weakly, so it is confined to the request
 * and needs no clearing — and a collection entry for the same row, being a different object, can never read a
 * page the single read resolved.
 */
const PRE_RESOLVED_LINE_PAGES = new WeakMap<ReorderList, Map<string, ReorderListLinePage>>();

/** Deposits a page the single-list read resolved, so the nested field resolver need not load it again. */
function cacheResolvedLinePage(list: ReorderList, optionsKey: string, page: ReorderListLinePage): void {
    const pages = PRE_RESOLVED_LINE_PAGES.get(list) ?? new Map<string, ReorderListLinePage>();
    pages.set(optionsKey, page);
    PRE_RESOLVED_LINE_PAGES.set(list, pages);
}

/** The page already resolved for this exact object and this exact window, where there is one. */
function resolvedLinePage(list: ReorderList, optionsKey: string): ReorderListLinePage | undefined {
    return PRE_RESOLVED_LINE_PAGES.get(list)?.get(optionsKey);
}

/**
 * Normalises the generator-supplied options into the window the service is asked for.
 *
 * Only `take` is touched, and only where the caller supplied none — `??` rather than `||` because a caller's
 * explicit value must survive, including a `take` of zero, and because the generated argument may arrive as
 * null as well as absent. Every other member — `skip`, `sort`, `filter`, `filterOperator` — is handed through
 * exactly as it arrived, so the caller's own paging and ordering reach the service unaltered.
 *
 * It is a module function rather than a method because **both** callers must produce the identical object: the
 * field resolver, from its coerced `@Args()`, and the single-list read, from the same argument read off the
 * document. A second copy of this normalisation could substitute a different default and the two would then
 * compute different cache keys, silently reloading the page the read had already resolved.
 */
function normaliseLinesPageOptions(
    supplied: ListQueryOptions<ReorderListLine> | null | undefined,
    defaultPageSize: number,
): ListQueryOptions<ReorderListLine> {
    const options = supplied ?? undefined;
    return {
        ...options,
        take: options?.take ?? defaultPageSize,
    };
}

/**
 * Whether these options narrow the collection, in exactly the sense the service uses when it decides whether
 * to publish {@link ReorderListLinePage.authoritativeTotalItems}.
 *
 * A `filter` object with no keys narrows nothing, so it is not narrowing here either — the service treats it
 * the same way, and the two must agree or the read would skip a reconciliation the service was willing to
 * support. A `filterOperator` alone counts, because it can only have been sent to combine filters.
 */
function narrowsTheLineCollection(options: ListQueryOptions<ReorderListLine>): boolean {
    const filter = options.filter;
    const hasFilter = filter != null && Object.keys(filter).length > 0;
    return hasFilter || options.filterOperator != null;
}

/**
 * Reads the `if` argument of a `@skip` or `@include` directive on a selection, and says whether that selection
 * is excluded from the response.
 *
 * It exists so that this reconciliation cannot resolve a page for a field the executor will never run: a
 * `lines` selection under `@skip(if: true)` is not part of the request, and reading it would issue two
 * statements nobody asked for and repair a counter from a page the response never carries.
 */
function isExcludedByDirective(selection: SelectionNode, variableValues: Record<string, unknown>): boolean {
    for (const directive of selection.directives ?? []) {
        const name = directive.name.value;
        if (name !== 'skip' && name !== 'include') {
            continue;
        }
        const condition = directive.arguments?.find(argument => argument.name.value === 'if');
        if (!condition) {
            continue;
        }
        const value = valueFromASTUntyped(condition.value, variableValues);
        if ((name === 'skip' && value === true) || (name === 'include' && value === false)) {
            return true;
        }
    }
    return false;
}

/**
 * Collects **every** executable `lines` field the document selected on this list, in document order,
 * resolving fragment spreads and inline fragments.
 *
 * **Both fragment forms are required rather than defensive.** This plugin's own end-to-end documents reach
 * `lines` through a nested fragment spread — a fragment that spreads a second fragment and then selects the
 * field — so a walk that only inspected direct field selections would find nothing on the canonical read and
 * the reconciliation would never run.
 *
 * **Every occurrence is collected rather than the first one returned, and that is a correctness requirement
 * rather than completeness for its own sake.** GraphQL aliases let one document select `lines` more than once
 * with different arguments, and the two may disagree about whether they narrow the collection:
 * `filtered: lines(options: { filter: … }) { … }` followed by `all: lines { … }` is a valid document. A walk
 * that stopped at the first match would hand the caller of this function a filtered window, the pre-parent
 * reconciliation would decline it — correctly, since a filtered total counts the caller's own subset — and the
 * *unfiltered* alias would then reach the field resolver's fallback, repairing the row only after the executor
 * had already taken the sibling `lineCount` scalar. That is precisely the stale-first-response defect the
 * pre-parent reconciliation exists to remove, reintroduced through an alias. So the whole selection set is
 * walked and {@link selectedUnfilteredLinesPageOptions} picks from what it finds.
 *
 * A field reached through two spreads of the same fragment is collected twice. That is harmless: the caller
 * only ever uses the first window it accepts, and two spreads of one fragment describe the identical window.
 */
function collectLinesSelections(
    selections: readonly SelectionNode[],
    info: GraphQLResolveInfo,
    collected: FieldNode[],
): void {
    for (const selection of selections) {
        if (isExcludedByDirective(selection, info.variableValues)) {
            continue;
        }
        if (selection.kind === 'Field') {
            if (selection.name.value === LINES_FIELD_NAME) {
                collected.push(selection);
            }
            continue;
        }
        if (selection.kind === 'FragmentSpread') {
            const fragment = info.fragments[selection.name.value];
            if (fragment) {
                collectLinesSelections(fragment.selectionSet.selections, info, collected);
            }
            continue;
        }
        collectLinesSelections(selection.selectionSet.selections, info, collected);
    }
}

/**
 * Every member of an untyped literal whose value is `undefined`, removed — recursively.
 *
 * It exists because `valueFromASTUntyped` keeps a key whose variable was not supplied and gives it the value
 * `undefined`, whereas the executor's own input coercion OMITS the key. That distinction decides whether a
 * window counts as narrowing and what cache key it renders to, so the two spellings of one request must not
 * disagree — see {@link linesSelectionPageOptions}.
 *
 * Array elements are recursed into but never dropped: removing one would shift every later index, which is a
 * different value rather than the same value with an absent member.
 */
function withoutAbsentMembers(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(element => withoutAbsentMembers(element));
    }
    if (value === null || typeof value !== 'object') {
        return value;
    }
    return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
            .filter(([, member]) => member !== undefined)
            .map(([key, member]) => [key, withoutAbsentMembers(member)]),
    );
}

/**
 * The window one `lines` selection asked for, normalised to the object the field resolver will compute for the
 * same selection.
 *
 * **The argument is read off the document rather than reconstructed, and absent members are then stripped so
 * that it matches what the executor coerces.** `valueFromASTUntyped` resolves literals and variables through
 * the request's own variable values, but for a member whose variable was NOT supplied it keeps the key and
 * gives it the value `undefined` — `keyValMap` sets every field it walks, and a missing variable resolves to
 * `undefined` rather than being skipped. Typed input coercion does the opposite: it OMITS the field entirely
 * (`valueFromAST` continues past a field whose variable is missing, applying the field's default if it has
 * one). So a window written `lines(options: { filter: { quantity: $unset } })` read untyped, with `$unset` not
 * supplied, is `{ filter: { quantity: undefined } }` — a filter with one key — while the argument the field
 * resolver receives is `{ filter: {} }`, a filter with none. Left to disagree, that costs two things silently:
 * `narrowsTheLineCollection` would count the request as narrowing and suppress the counter reconciliation the
 * request is entitled to, and the two spellings would stringify to different cache keys, so the nested
 * resolver would reload the page already resolved for it. {@link withoutAbsentMembers} closes the gap by
 * recursively stripping absent members, which is exactly the omission the executor performs.
 *
 * **Coercing through the declared input type is not available here, for a measured reason.** Reading the
 * generated argument's type off `info.schema` and calling `valueFromAST` requires `isObjectType` and the type
 * predicates inside `valueFromAST` to recognise objects the SERVER built. In this repository's end-to-end
 * environment they do not: two copies of `graphql` are resolvable at run time, and graphql-js raises
 * `Cannot use GraphQLObjectType "ReorderList" from another module or realm.` rather than returning false. The
 * two approaches are in any case equivalent for this argument, because the generated list-options input
 * declares no field default — `generateListOptions` builds `skip`, `take`, `sort`, `filter` and
 * `filterOperator` with descriptions and types only — so there is no default for typed coercion to apply that
 * the strip would miss.
 *
 * A non-object argument value is ignored rather than trusted: the generated input type makes that unreachable
 * through a valid document, and a resolver is not the place to re-litigate what the schema already refuses.
 */
function linesSelectionPageOptions(
    linesSelection: FieldNode,
    info: GraphQLResolveInfo,
    defaultPageSize: number,
): ListQueryOptions<ReorderListLine> {
    const argument = linesSelection.arguments?.find(node => node.name.value === 'options');
    const supplied = argument
        ? withoutAbsentMembers(valueFromASTUntyped(argument.value, info.variableValues))
        : undefined;
    const options =
        supplied != null && typeof supplied === 'object' && !Array.isArray(supplied)
            ? (supplied as ListQueryOptions<ReorderListLine>)
            : undefined;
    return normaliseLinesPageOptions(options, defaultPageSize);
}

/**
 * The window of an executable, **unfiltered** `lines` selection on the field being resolved, or `undefined`
 * where the document selected no such window.
 *
 * **It searches for an unfiltered window rather than inspecting one candidate**, because whether the request
 * can reconcile the counter at all is a property of the whole selection set and not of whichever occurrence
 * appears first. A document may narrow one alias and leave another whole; if any executable occurrence is
 * unfiltered then this request does establish the list's true line count, and the reconciliation must therefore
 * happen here, before the parent is exposed. Returning `undefined` — which suppresses the reconciliation
 * entirely — is reserved for the two cases where no such total exists: no `lines` field is selected at all, or
 * every occurrence of it narrows the collection.
 *
 * The first unfiltered occurrence in document order is the one returned. Which one that is cannot change the
 * reconciled value, because every unfiltered window reports the same unfiltered total whatever its `take`,
 * `skip` or `sort`; it only decides which page is pre-resolved and therefore which alias is served from the
 * cache. A second unfiltered alias asking for a different window loads its own page and then finds stored and
 * observed already in agreement, so it issues no second compare-and-set.
 *
 * @param info - The resolve info of the field whose selection set is being inspected.
 * @param defaultPageSize - The plugin's configured nested page size, applied where the document supplied no
 * `take`, so that this window is the same one the field resolver will compute.
 */
function selectedUnfilteredLinesPageOptions(
    info: GraphQLResolveInfo,
    defaultPageSize: number,
): ListQueryOptions<ReorderListLine> | undefined {
    const selections = info.fieldNodes.flatMap(node => node.selectionSet?.selections ?? []);
    const linesSelections: FieldNode[] = [];
    collectLinesSelections(selections, info, linesSelections);
    for (const linesSelection of linesSelections) {
        const options = linesSelectionPageOptions(linesSelection, info, defaultPageSize);
        if (!narrowsTheLineCollection(options)) {
            return options;
        }
    }
    return undefined;
}

/**
 * @description
 * Reconciles a stale stored `lineCount` on the object the single-list read is about to return, **before** that
 * object is handed to GraphQL — and leaves the page it read behind for the nested field resolver.
 *
 * **The ordering is the whole point of this function, and getting it wrong is invisible in the payload of every
 * request that has nothing to repair.** GraphQL completes an object's fields by walking its selection set
 * synchronously: a scalar with no field resolver is read off the source object during that walk, and only the
 * promises the walk collected are awaited afterwards. So a reconciliation that happens inside the `lines`
 * resolver — however correctly it then writes the value back onto the row — happens after the executor has
 * already taken `lineCount`, and the response reports the stale number while the database row has been
 * corrected. The request that most needs the corrected value is exactly the one that reports the wrong one.
 * FEATURE-001-01 section 2.6.2.1 requires the **first** single-list read to report the corrected count, so the
 * reconciliation is performed here, where the parent has not yet been exposed.
 *
 * **It reads the page the document asked for, and nothing it was not asked for.** Where the document selects no
 * `lines` field this function issues nothing at all: without an observed total there is nothing to compare the
 * stored counter against, which is the same position the collection read is permanently in. Where the document
 * *narrows* the nested collection, it likewise issues nothing — a filtered total counts the caller's own subset,
 * and writing it into `reorder_list.lineCount` would replace the number the atomic line bound is enforced
 * against with one the caller chose.
 *
 * **"Narrows" is decided over the whole selection set, not over one occurrence of the field.** GraphQL aliases
 * let a document select `lines` twice with different arguments — `filtered: lines(options: { filter: … })`
 * beside `all: lines` — and if the first occurrence were taken as the answer, a filtered alias written first
 * would suppress the reconciliation while the unfiltered alias behind it went on to establish the true total.
 * The row would then be repaired in the field resolver's fallback, after the executor had taken `lineCount`,
 * which is the stale-first-response defect this function exists to remove. So
 * {@link selectedUnfilteredLinesPageOptions} searches every executable occurrence and this function declines
 * only when none of them is unfiltered.
 *
 * **It costs no statement that the request was not going to issue anyway.** The page it resolves is deposited
 * against the parent object under the window it was resolved for, and the nested field resolver serves that
 * cached page instead of loading its own — so the nested read's two statements are issued once, here, rather
 * than once here and once there.
 *
 * **A failure to pre-resolve is retried once and then propagates**, and the ordering is why. A forgiven
 * failure does not produce an error, it produces a WRONG ANSWER: the parent goes out unreconciled, the
 * executor has already taken `lineCount` off it by the time the field resolver's fallback repairs the row,
 * and the response reports the stale number as though it were current — the very ordering
 * FEATURE-001-01 section 2.6.2.1 exists to forbid. So a transient failure is retried
 * ({@link PRE_RESOLVE_READ_ATTEMPTS} attempts) and a failure that survives the retry fails the read. The one
 * exception is a `UserInputError`: it is not retried and not raised from here, because it is a statement about
 * the caller's own nested arguments and the nested field meets it on its own path, under its own field error.
 *
 * The platform's own resolvers use this shape: the Shop products resolver inspects its `info`, pre-starts the
 * query a field resolver will need and caches the result for it
 * (`packages/core/src/api/resolvers/shop/shop-products.resolver.ts`).
 *
 * @param reorderListService - The service that owns both the nested read and the compare-and-set statement.
 * @param ctx - The request context of the root read.
 * @param list - The exact object the single-list read is about to return.
 * @param info - The root field's resolve info, from which the nested window is read.
 * @param defaultLinesPageSize - The plugin's configured nested page size.
 *
 * @docsCategory core plugins/ReorderPlugin
 * @docsPage ReorderListEntityResolver
 * @since 3.8.0
 */
export async function reconcileSingleReorderListRead(
    reorderListService: ReorderListService,
    ctx: RequestContext,
    list: ReorderList,
    info: GraphQLResolveInfo,
    defaultLinesPageSize: number,
): Promise<void> {
    const options = selectedUnfilteredLinesPageOptions(info, defaultLinesPageSize);
    if (!options) {
        // No UNFILTERED window is selected anywhere in this field's selection set — either no `lines` field at
        // all, or every occurrence of it narrows the collection — so no observed total is available to this
        // request, there is nothing to reconcile against and nothing is read. The stored counter is reported
        // exactly as it stands. Note that the search is over EVERY occurrence, not the first: an alias that
        // narrows must not be allowed to suppress a reconciliation a sibling alias entitles this request to.
        return;
    }
    // THE READ IS RETRIED ONCE, AND A SECOND FAILURE IS PROPAGATED. Neither half of that is a preference.
    //
    // Swallowing the failure and letting the parent through produces a WRONG ANSWER rather than an error. The
    // nested `lines` resolver reads its own page when this request cached none, and if THAT read succeeds it
    // repairs the row — but by then GraphQL has already resolved `lineCount` from this parent object, so the
    // response goes out carrying a coherent page beside the stale scalar the repair has just corrected in
    // storage. The row ends up right and the answer the buyer received stays wrong. A repair that can only run
    // after the parent is exposed is exactly the ordering this function exists to prevent.
    //
    // So the parent is never exposed on an unreconciled path: a transient failure is given one more attempt
    // ({@link PRE_RESOLVE_READ_ATTEMPTS}) and a failure that survives it is propagated. What propagates is
    // already sanitised — the service classifies and logs it under its own correlation id and re-raises an
    // internal error carrying no driver text, no SQL fragment and no constraint name — so the client receives
    // one top-level `errors` entry rather than a payload that looks right and is not. That is the same
    // treatment the failed repair below receives, and for the same reason.
    let page: ReorderListLinePage | undefined;
    for (let attempt = 0; ; attempt++) {
        try {
            const pages = await reorderListService.getLinesForLists(ctx, [list.id], options);
            page = pages.get(list.id);
            break;
        } catch (error) {
            if (error instanceof UserInputError) {
                // THE ONE FAILURE CLASS THAT BELONGS TO THE NESTED FIELD, left there deliberately. A
                // `UserInputError` is attributable to the request's own arguments — an over-limit nested
                // `take`, refused by the platform's own `parseTakeSkipParams` — so retrying it only repeats
                // it, and raising it from the parent would report the nested collection's bound at the root's
                // path when the error's path is the only proof the bound is enforced on the nested collection
                // at all. It also cannot produce the hazard the retry exists for: a deterministic refusal of
                // the same arguments fails in the nested resolver too, so no response goes out carrying a
                // reconciled row behind a stale scalar. Nothing is reconciled and nothing is cached, so the
                // nested resolver reads for itself and meets the same refusal.
                Logger.verbose(
                    `The line-page window requested of reorder list ${String(list.id)} was refused as ` +
                        'malformed, so its counter is reported as stored and the refusal is left to the ' +
                        'nested field it belongs to',
                    loggerCtx,
                );
                return;
            }
            if (attempt >= PRE_RESOLVE_READ_ATTEMPTS - 1) {
                Logger.warn(
                    `Could not pre-resolve the line page of reorder list ${String(list.id)} for its counter ` +
                        `reconciliation after ${String(PRE_RESOLVE_READ_ATTEMPTS)} attempt(s); the read is ` +
                        'failing rather than answering with a counter it could not reconcile',
                    loggerCtx,
                );
                throw error;
            }
            Logger.warn(
                `Retrying the pre-resolve of the line page of reorder list ${String(list.id)} for its ` +
                    'counter reconciliation',
                loggerCtx,
            );
        }
    }
    if (!page) {
        // ★ UNREACHABLE AGAINST THE SERVICE'S CONTRACT — WHICH IS WHY IT FAILS CLOSED RATHER THAN RETURNING.
        // `getLinesForLists` seeds an entry for every identifier it is given, so a missing entry means that
        // contract has been broken inside this plugin. Returning here would answer the request with the
        // stored counter and no reconciliation, which is indistinguishable from the ordinary
        // no-unfiltered-window path — so an internal defect would surface as a plausible NUMBER on a
        // successful response, and a buyer would be told a `lineCount` this request had reason to doubt.
        // Wrong data that looks right is the one outcome worth failing a read for, so the request fails with
        // the plugin's own sanitised internal error and the defect reaches a log instead of a buyer.
        throw reportReorderListInternalFailure(
            'A line page pre-resolve resolved no partition for the list it was resolved for, which the ' +
                'service contract makes unreachable',
        );
    }
    // AND THE REPAIR PRECEDES THE CACHING, which is the other half of the same finding. Caching first left the
    // nested field resolver holding a page it would serve happily while the compare-and-set that was supposed
    // to correct the counter had rejected — the request then succeeded, reported the stale number, and the
    // rejection reached nobody. Reconciling first means a rejection propagates out of this function to the
    // root resolver with the service's own sanitised message, and no cached page exists for anything to fall
    // back to. On the ordinary path the repair resolves and the page is cached exactly as before.
    await repairStaleLineCount(reorderListService, ctx, list, page.authoritativeTotalItems);
    cacheResolvedLinePage(list, stableStringify(options), page);
}

/**
 * Repairs a stored line counter that disagrees with the total this request actually observed — and only for the
 * object the single-list read returned, and only from a total that is the list's whole, unfiltered line count.
 *
 * **Four conjuncts are required, and each rules out a different defect.**
 *
 * The first is that THIS PARENT OBJECT is the one `activeCustomerReorderList` returned, recorded through
 * {@link markSingleReorderListRead} and tested through {@link wasReturnedBySingleReorderListRead}. Without it, a
 * collection read that happened to select `lines` would repair, which FEATURE-001-01 section 2.6.2.1 forbids in
 * as many words: a page of lists has no observed total to compare against and reports the stored column as it
 * stands. The test is on object identity rather than on the row identifier, because one document may select both
 * reads and the same row then arrives twice in one request as two separately loaded objects.
 *
 * The second is that a total is available **and unfiltered**. The caller passes
 * {@link ReorderListLinePage.authoritativeTotalItems}, which the service publishes only for a request that
 * applied no `filter` and no `filterOperator`; a filtered request therefore passes `undefined` and nothing is
 * issued. That conjunct closes a real escalation rather than a theoretical one: the published `totalItems`
 * counts the lines matching the caller's own filter, so filtering a full list down to nothing and writing that
 * count into `reorder_list.lineCount` would zero the very counter the atomic line bound is enforced against,
 * after which `maxLinesPerList` bounds nothing.
 *
 * The third is that the observed total actually differs from the stored counter, and that both are values the
 * column can hold. On the overwhelmingly common path they agree and nothing is issued, which is what makes the
 * repair free where there is nothing to repair.
 *
 * The fourth is that no repair for this object is already under way — {@link repairLineCountOnce} both answers
 * that and starts the repair when the answer is no, in one synchronous step, so sibling fields awaiting the same
 * object share one statement.
 *
 * **The reconciled value is written back onto the row**, so every consumer that reads the object afterwards —
 * including the executor, when this runs before the parent is exposed — sees the corrected number. The
 * statement itself, its compare-and-set guard and its refusal of a value the column may not hold all belong to
 * the service; nothing here composes SQL.
 */
async function repairStaleLineCount(
    reorderListService: ReorderListService,
    ctx: RequestContext,
    list: ReorderList,
    observedTotal: number | undefined,
): Promise<void> {
    // Conjunct one: THIS OBJECT was returned by the single-list read.
    if (!wasReturnedBySingleReorderListRead(list)) {
        return;
    }
    // Conjunct two: an unfiltered total was established for this parent at all. `undefined` is the service's
    // way of saying "this request narrowed the collection, so it does not know the list's line count", and it
    // is answered by leaving the stored column exactly as it stands.
    if (observedTotal === undefined) {
        return;
    }
    // Conjunct three: the total differs from the stored counter, and both are values the column can hold. Both
    // halves are checked here rather than left to the service. The service does refuse a total the column may
    // not hold, but it refuses it by logging an error — and an error log is the right report for a defect and
    // the wrong one for a value this function could have declined to pass on.
    const storedLineCount = list.lineCount;
    if (typeof storedLineCount !== 'number' || !Number.isFinite(storedLineCount)) {
        return;
    }
    if (!Number.isSafeInteger(observedTotal) || observedTotal < 0) {
        return;
    }
    if (storedLineCount === observedTotal) {
        return;
    }
    // Conjunct four: no repair for THIS OBJECT is already under way. The gate both answers that and starts the
    // repair when the answer is no, in one synchronous step — see {@link repairLineCountOnce}.
    // THE PARENT OBJECT IS PASSED, NOT ITS IDENTIFIER, and that is a scoping decision rather than a
    // convenience. The object is what carries the owner scope the row was actually read under, so handing it
    // over is what lets the service build the repair's `WHERE` with the acting customer and the active channel
    // on it, and refuse the write outright for a row whose provenance does not match this request. An
    // identifier alone would leave the statement addressing whichever row bore that id — and ids are
    // sequential under the default id strategy.
    const reconciled = await repairLineCountOnce(list, () =>
        reorderListService.reconcileLineCount(ctx, list, storedLineCount, observedTotal),
    );
    if (reconciled !== storedLineCount) {
        Logger.debug(
            `Reconciled lineCount on reorder list ${String(list.id)} from ${String(storedLineCount)} ` +
                `to ${String(reconciled)}`,
            loggerCtx,
        );
    }
    list.lineCount = reconciled;
}

// The page batch. This is the mechanism that makes "once per page, never once per entry" true, so it
// is documented at the length of a mechanism rather than of a helper.

/**
 * One page's worth of pending identifiers, together with the single promise that will deliver the loaded
 * result to every field resolver that registered against it.
 *
 * `registeredIds` is keyed on the STRINGIFIED identifier and holds the identifier value that was actually
 * registered. Both halves matter. The string key de-duplicates across the two forms the configured
 * `EntityIdStrategy` may produce, so the same row cannot be loaded twice in one batch; the stored value is
 * what gets passed to the loader and is therefore what the loader's result is keyed on, so a lookup by the
 * canonical value cannot miss on a numeric-versus-string mismatch.
 */
interface PendingPageBatch<T> {
    /** Stringified identifier to the identifier value registered for it, in registration order. */
    readonly registeredIds: Map<string, ID>;
    /** The one in-flight load serving every registrant of this batch. */
    readonly loaded: Promise<T>;
}

/**
 * A promise that settles after the current synchronous execution AND the microtask queue it produced have
 * both finished — which is the window in which a whole page's field resolvers register.
 *
 * **Why this exact scheduling.** GraphQL's executor walks a page's entries synchronously: for a list field it
 * iterates every item and, for each, invokes every selected field's resolver, collecting the promises and
 * awaiting them only once the walk is complete. So every entry on the page has registered by the time this
 * turn's microtask queue drains, and a flush scheduled here sees the whole page rather than one entry. The
 * two-step form — resolve a promise, then `process.nextTick` from inside its callback — is the same scheduling
 * a batching loader uses, and the ordering it buys is what matters: Node drains the microtask queue before
 * running a tick callback enqueued from within it, so registrations that arrive through a promise chain in
 * this turn still make the batch.
 *
 * **The failure mode if the window were wrong is visible rather than silent**, which is the property that
 * makes this safe to rely on: a flush that fired too early would simply load fewer identifiers and issue more
 * statements, which is precisely what STORY-001-01-04's equal-statement-count assertion across a page of three
 * and a page of six lists detects. It cannot deadlock, because the flush is scheduled by the clock of the
 * event loop and never by a count of expected registrants.
 */
function afterMicrotaskQueueDrains(): Promise<void> {
    return Promise.resolve().then(
        () =>
            new Promise<void>(resolve => {
                process.nextTick(() => resolve());
            }),
    );
}

/**
 * Returns the batch open for `key` on this request, opening one if there is none.
 *
 * The batch lives in the platform's request-scoped cache, which is a `WeakMap` keyed on the
 * {@link RequestContext} instance, so it is confined to one request and is garbage-collected with it —
 * a module-level map would leak across requests and, worse, could serve one buyer's page from another's.
 *
 * **The batch is CLOSED before its loader is called**, by clearing the cache entry. That is what keeps the
 * batch key the page rather than the request: a resolver registering after the flush — the next page in the
 * same document, or a nested page reached through this one — opens a fresh batch and gets a fresh statement,
 * rather than joining a batch whose result has already been computed. Nothing is memoised across batches, so
 * no page can be served a result assembled before a mutation in the same request.
 */
function openPageBatch<T>(
    requestContextCache: RequestContextCacheService,
    ctx: RequestContext,
    key: string,
    load: (ids: ID[]) => Promise<T>,
): PendingPageBatch<T> {
    const open = requestContextCache.get<PendingPageBatch<T>>(ctx, key);
    if (open) {
        return open;
    }
    const registeredIds = new Map<string, ID>();
    const batch: PendingPageBatch<T> = {
        registeredIds,
        loaded: afterMicrotaskQueueDrains().then(() => {
            // Clearing the entry closes this batch. The cache treats a falsy value as absent, so this is the
            // delete the service does not expose, and the next registration opens a new batch.
            requestContextCache.set(ctx, key, undefined);
            return load(Array.from(registeredIds.values()));
        }),
    };
    requestContextCache.set(ctx, key, batch);
    return batch;
}

/**
 * Adds one identifier to an open batch and returns the canonical value the loader will be keyed on.
 *
 * Registering the same row twice — two aliases of the same field, or one list reached through both reads in a
 * single document — yields the value registered first, so the batch holds each row exactly once and the
 * loader is asked for it exactly once.
 */
function registerInPageBatch<T>(batch: PendingPageBatch<T>, id: ID): ID {
    const key = String(id);
    const canonical = batch.registeredIds.get(key);
    if (canonical != null) {
        return canonical;
    }
    batch.registeredIds.set(key, id);
    return id;
}

/**
 * Renders a value as a stable string, so that two callers asking for the SAME page of lines share one batch
 * and two callers asking for DIFFERENT pages never do.
 *
 * Object keys are sorted, so a batch key does not depend on the order a client happened to write the fields
 * of the options input; `undefined` members are dropped, so an explicitly-absent member reads the same as an
 * omitted one; and a `Date` is rendered by its instant rather than by its (empty) enumerable properties,
 * which is the one case where the obvious implementation would silently merge two different filters into one
 * batch and hand a caller the wrong window.
 */
function stableStringify(value: unknown): string {
    if (value === undefined) {
        return 'undefined';
    }
    if (value === null || typeof value !== 'object') {
        return JSON.stringify(value);
    }
    if (value instanceof Date) {
        return JSON.stringify(value.toISOString());
    }
    if (Array.isArray(value)) {
        return `[${value.map(entry => stableStringify(entry)).join(',')}]`;
    }
    const members = Object.entries(value as Record<string, unknown>)
        .filter(([, member]) => member !== undefined)
        .sort(([left], [right]) => {
            if (left === right) {
                return 0;
            }
            return left < right ? -1 : 1;
        })
        .map(([key, member]) => `${JSON.stringify(key)}:${stableStringify(member)}`);
    return `{${members.join(',')}}`;
}

/**
 * @description
 * Resolves the three published fields of this plugin's two types that are not columns of their own rows: the
 * nested `ReorderList.lines` page, the per-requester `ReorderList.viewerAccess`, and the catalogue variant a
 * `ReorderListLine` references. Each is served once per page rather than once per entry, and `viewerAccess`
 * costs no statement at all.
 *
 * @docsCategory core plugins/ReorderPlugin
 * @docsPage ReorderListEntityResolver
 * @docsWeight 0
 * @since 3.8.0
 */
@Resolver('ReorderList')
export class ReorderListEntityResolver {
    constructor(
        private reorderListService: ReorderListService,
        private productVariantService: ProductVariantService,
        private requestContextCache: RequestContextCacheService,
        @Inject(REORDER_PLUGIN_OPTIONS) private options: ResolvedReorderPluginOptions,
    ) {}

    /**
     * @description
     * Resolves a page of the list's lines, for the whole page of lists in one load.
     *
     * **The `options` argument is the generator's, not this plugin's.** Neither the schema document nor this
     * module declares an `options` argument or names a per-row options input: the platform adds one to every
     * field whose type implements `PaginatedList`, nested fields included
     * (`packages/core/src/api/config/generate-list-options.ts` L41-L48), and naming a generated input the
     * document does not declare would stop the server from starting (EPIC-001 ruling R10). What this method
     * does with the argument is normalise one member of it and hand the rest through untouched.
     *
     * **This is the single place the nested default page size is applied.** Where the caller supplied no
     * `take`, {@link ReorderPluginOptions.defaultReorderListLinesPageSize} is substituted, so a client that
     * omits the argument entirely still receives a bounded page rather than every line of the list. The
     * collection read's own default belongs to the query resolver and is not applied here; nothing else about
     * the argument is rewritten. `ignoreQueryLimits` is left false throughout, so a `take` above the
     * Shop-side maximum is refused by the platform with the platform's own error rather than being quietly
     * clamped by plugin code — and the substituted default is stricter than that maximum, which is what makes
     * substituting it safe.
     *
     * **The sort is not re-implemented here.** The service owns the `ListQueryBuilder` call, the declared
     * total order for lines — creation timestamp ascending, tie-broken by identifier — and the appending of
     * that tie-break to any caller-supplied sort. A second derivation of the order in this file could drift
     * from the first, and a drifting order across a page boundary is exactly the defect the total order
     * exists to prevent.
     *
     * **One load per page, whatever the page holds.** Every entry on the page registers its identifier in one
     * request-scoped batch, the batch is loaded once, and each entry reads its own partition out of the
     * result. The service's load is two statements — the per-parent window and the grouped totals — and
     * neither depends on how many parents the page carries, which is the equality STORY-001-01-04 asserts
     * across a page of three lists and a page of six.
     *
     * @param ctx - The request context, whose active channel and authenticated session scope the read.
     * @param list - The list whose lines are being resolved. Its `lineCount` is read only as the guard of the
     * compare-and-set repair described below, never as the source of the returned page's `totalItems`.
     * @param args - The generator-supplied arguments for this field.
     * @returns The page of lines for this list. A list with no lines resolves to an empty page rather than to
     * null, so a caller never has to distinguish "no lines" from "not resolved".
     *
     * @since 3.8.0
     */
    @ResolveField()
    async lines(
        @Ctx() ctx: RequestContext,
        @Parent() list: ReorderList,
        @Args() args: ReorderListLinesArgs,
    ): Promise<PaginatedList<ReorderListLine>> {
        const options = this.linesPageOptions(args);
        const optionsKey = stableStringify(options);
        const preResolved = resolvedLinePage(list, optionsKey);
        if (preResolved) {
            // The single-list read already resolved exactly this window for exactly this object, before it
            // returned the parent, so that the counter it reconciled from that page was on the object before
            // GraphQL read the sibling `lineCount` scalar off it. Serving that page here is what keeps the
            // reconciliation free of a second nested read: the two statements were issued once, there.
            // Its counter has already been reconciled, so nothing is repaired again.
            return preResolved;
        }
        const batch = openPageBatch<Map<ID, ReorderListLinePage>>(
            this.requestContextCache,
            ctx,
            `${LINES_BATCH_KEY_PREFIX}(${optionsKey})`,
            listIds => this.reorderListService.getLinesForLists(ctx, listIds, options),
        );
        const parentId = registerInPageBatch(batch, list.id);
        const pages = await batch.loaded;
        const page = pages.get(parentId);
        if (!page) {
            // ★ UNREACHABLE AGAINST THE SERVICE'S CONTRACT, AND IT FAILS CLOSED. `getLinesForLists` seeds an
            // entry for every identifier registered in the batch, so a missing partition means that contract
            // has been broken inside this plugin. Returning `{ items: [], totalItems: 0 }` would publish
            // "this list has no lines" — a statement about the buyer's own data that this request has no
            // evidence for, and which a client cannot tell apart from a genuinely empty list. It would also
            // suppress the reconciliation below, leaving a stored counter to be reported beside a fabricated
            // empty page. An internal defect must not be converted into plausible incorrect data, so the
            // field fails with the plugin's own sanitised internal error and the detail goes to the log.
            throw reportReorderListInternalFailure(
                `Resolved no line page for a reorder list from a batch of ` +
                    `${String(batch.registeredIds.size)} list(s), which the service contract makes ` +
                    'unreachable',
            );
        }
        // THE FALLBACK RECONCILIATION, and it is a fallback rather than the primary path. The single-list read
        // reconciles before it exposes the parent, which is the only ordering under which the response can
        // report the corrected counter, and it caches the page it read — so this is reached only where that
        // read could not resolve the window (a nested selection it did not recognise, or a pre-resolve that
        // failed). Repairing here still corrects the row for every later reader, which is the outcome
        // FEATURE-001-01 section 2.6.2.1 asks for; what it cannot correct is the number this response already
        // reported, and that is precisely why the primary path exists.
        //
        // The UNFILTERED total is passed, and never `page.totalItems`. The service publishes the former only on
        // a request that narrowed nothing, so a filtered request passes `undefined` and no repair is attempted.
        await repairStaleLineCount(this.reorderListService, ctx, list, page.authoritativeTotalItems);
        return page;
    }

    /**
     * @description
     * Resolves the per-requester provenance of the list, at a cost of zero database statements.
     *
     * The value is derived rather than asserted, from three things the request already established: the owner
     * scope the row was actually read under, the row's own owning customer and channel, and this request's own
     * active channel and session. All three are already in memory, which is why the derivation costs no
     * statement — and the request context is passed for exactly that reason, as the third of the three inputs
     * rather than as something to look anything up with. Under this feature every list that reaches a caller has
     * passed the service's ownership-and-channel predicate, so `access` is `OWNED` and `grantedCapabilities` is
     * empty; those are the truthful values while no share row can exist, rather than placeholders, and both
     * values of the `includeShared` argument return the same thing because the shared set is empty by
     * construction rather than withheld.
     *
     * **A per-entry access check that issued a statement is forbidden**, and the criterion that guards this is
     * literal: zero statements, asserted as a number rather than as a payload. Sharing makes this conditional
     * in FEATURE-001-06; it is deliberately not anticipated here, so no share table is read and no grant field
     * is declared or populated.
     *
     * @param ctx - The request context whose active channel and session the row's recorded provenance is checked
     * against.
     * @param list - The list being described, and the object its recorded provenance is keyed on.
     *
     * @since 3.8.0
     */
    @ResolveField()
    viewerAccess(@Ctx() ctx: RequestContext, @Parent() list: ReorderList): ReorderListViewerAccess {
        return this.reorderListService.getViewerAccess(ctx, list);
    }

    /**
     * Normalises the generator-supplied arguments into the window the service is asked for.
     *
     * It delegates to {@link normaliseLinesPageOptions} rather than performing the substitution here, because
     * the single-list read has to compute the identical window from the same argument read off the document: the
     * two windows are compared as cache keys, and a second copy of this normalisation could drift from the
     * first and silently reload a page that had already been resolved.
     */
    private linesPageOptions(args: ReorderListLinesArgs): ListQueryOptions<ReorderListLine> {
        return normaliseLinesPageOptions(args?.options, this.defaultLinesPageSize());
    }

    /**
     * The configured nested page size, read straight from the injected options and restating nothing.
     *
     * The provider supplies {@link ResolvedReorderPluginOptions}: every key present, validated in
     * `ReorderPlugin.init()` and re-asserted at application bootstrap — never per request — and frozen. A
     * `?? 50` here would be a second executable copy of a number the plugin
     * already declares — unreachable through `ReorderPlugin.init()`, and therefore untested and free to drift
     * from the value the server is actually running on. Fifty is stricter than the Shop-side maximum the
     * default configuration sets, which is the property that makes applying it safe
     * (`packages/core/src/config/default-config.ts` L89).
     */
    private defaultLinesPageSize(): number {
        return this.options.defaultReorderListLinesPageSize;
    }

    /**
     * @description
     * Resolves the variant a `ReorderListLine` references, for every line on the page in one load, or `null`
     * where that variant is no longer resolvable in the active channel.
     *
     * **This member belongs to a different parent type from the two above it, so `@ResolveField` must stay
     * ABOVE `@Resolver` on it, and reversing them fails silently.** A class-level `@Resolver('ReorderList')`
     * binds `lines` and `viewerAccess`; this method rebinds itself to `ReorderListLine` with a method-level
     * `@Resolver`, which the framework prefers over the class-level one
     * (`@nestjs/graphql/dist/utils/extract-metadata.util.js` reads `RESOLVER_TYPE` from the method first and
     * only then from the class, and drops a method entirely unless `RESOLVER_PROPERTY` is set, which only
     * `@ResolveField` sets). The order is the hazard: the method form of `@Resolver(name)` writes both
     * `RESOLVER_TYPE` and `RESOLVER_NAME` to `name` while `@ResolveField(propertyName)` writes `RESOLVER_NAME`
     * to `propertyName`, they contend for the same key, and decorators apply bottom-up so the topmost writes
     * last. Reversed, the map becomes `{ ReorderListLine: { ReorderListLine: fn } }` — a field named after the
     * type and no `productVariant` resolver at all, so the field falls through to the default resolver and
     * returns the relation this plugin's read never loads. Nothing about that fails at build time.
     *
     * **The column and the published field are deliberately not the same nullability, and the pair is what
     * makes a stale line readable.** `reorder_list_line.productVariantId` is `NOT NULL`, because a retained line
     * always references a variant row that still exists; the published `productVariant` field is nullable,
     * because a variant that is no longer resolvable in the active channel must not be exposed and must not
     * null-bubble the whole line out of its page. `productVariantId` stays non-null on both sides, which is what
     * lets a buyer see and remove the line (FEATURE-001-01 section 2.4).
     *
     * **Three cases resolve to `null`, and each is a case the buyer must still be able to act on.** A variant
     * assigned to another channel is not returned by the channel-scoped load. A variant whose row has been
     * SOFT-deleted — the platform's own variant deletion, which sets a timestamp and leaves the row and every
     * line in place — is screened out here. And an identifier the load simply does not answer for takes the
     * same path. In all three the line entry is still returned, carrying its populated `productVariantId` and
     * its unchanged quantity, which is exactly why the field is nullable.
     *
     * **A DISABLED variant is not one of those cases and resolves normally.** A disabled variant is still
     * resolvable in the channel and its `enabled` value is readable on the variant type the platform already
     * publishes, so nulling it here would hide a variant the contract says to return (STORY-001-01-04). Neither
     * the disabled flag nor the deletion timestamp is read as a precondition of the query, and neither is
     * projected onto this plugin's payload as a field of its own: a saved list records intent rather than
     * availability, and this payload carries no availability field at all. Surfacing availability is
     * FEATURE-001-03's work and resolving it is FEATURE-001-04's.
     *
     * **One load per page, not one per entry.** Every line on the page registers its variant identifier in a
     * single request-scoped batch, de-duplicated, and the batch is loaded once through the channel-scoped
     * accessor. The load returns translated variants with channel prices applied, so nothing is re-translated
     * here: the variant's `name` renders in the language the request resolved from the channel.
     *
     * **The active channel decides in every case, including the one that skips the load.** An already-hydrated
     * relation is served only where this request can prove the variant is in the active channel from what was
     * actually loaded onto it; everything else — a relation that is not hydrated, not translated, not priced,
     * soft-deleted, or whose channel membership cannot be established — goes through the channel-scoped batch,
     * which is what makes the short-circuit unable to change an answer. See
     * {@link ReorderListEntityResolver.hydratedRelation}.
     *
     * @param ctx - The request context, whose active channel scopes the load and whose language code the
     * returned variant is translated into.
     * @param line - The line whose variant is being resolved.
     * @returns The variant, or `null` where it is not resolvable in the active channel.
     *
     * @since 3.8.0
     */
    @ResolveField('productVariant')
    @Resolver('ReorderListLine')
    async productVariant(
        @Ctx() ctx: RequestContext,
        @Parent() line: ReorderListLine,
    ): Promise<Translated<ProductVariant> | null> {
        const alreadyResolved = this.hydratedRelation(ctx, line);
        if (alreadyResolved) {
            return alreadyResolved;
        }
        const batch = openPageBatch<Map<string, Translated<ProductVariant>>>(
            this.requestContextCache,
            ctx,
            VARIANT_BATCH_KEY,
            variantIds => this.loadVariantsInChannel(ctx, variantIds),
        );
        registerInPageBatch(batch, line.productVariantId);
        const variants = await batch.loaded;
        return variants.get(String(line.productVariantId)) ?? null;
    }

    /**
     * Loads one page's worth of variants in the active channel, keyed on the stringified identifier and with
     * the soft-deleted ones removed.
     *
     * **The screen is required rather than defensive.** The channel-scoped batch accessor does not filter the
     * deletion timestamp — only the single-row accessor does, through an explicit `deletedAt IS NULL`
     * predicate — so a batched load will happily return a soft-deleted variant
     * (`packages/core/src/service/services/product-variant.service.ts`). Screening here is what makes the
     * batched path agree with the published contract: a soft-deleted variant is not resolvable, so its line's
     * `productVariant` is null.
     *
     * The map is keyed on the stringified identifier because the configured `EntityIdStrategy` decides whether
     * an id is a number or a string, and a lookup by the raw value would miss across the two.
     *
     * **The load sits inside a sanitisation boundary, and the collaborator is the reason.** This is the one
     * place in this file that calls out to a platform service, and that service composes and executes its own
     * statement: a driver failure raised inside it arrives carrying the SQL it was running, the schema and
     * column names it touched, sometimes the conflicting values, and a frame list of absolute build paths.
     * Left unhandled it reaches the platform's exception filter, which publishes the message to the caller
     * under `INTERNAL_SERVER_ERROR` and logs the stack. So the failure is classified by shape, logged with a
     * correlation id and nothing of its own, and re-raised as the plugin's one generic internal error with its
     * frames replaced — the same treatment the service gives every unclassified failure of its own, through
     * the same helper so there is one message and one log shape rather than two.
     *
     * Nothing is swallowed: the request still fails. What changes is that it fails with a sentence that says
     * nothing about the server.
     */
    private async loadVariantsInChannel(
        ctx: RequestContext,
        variantIds: ID[],
    ): Promise<Map<string, Translated<ProductVariant>>> {
        const resolvable = new Map<string, Translated<ProductVariant>>();
        if (variantIds.length === 0) {
            // No identifier registered means no statement issued. Reached only if a batch is opened and
            // nothing joins it, which the caller's own registration makes impossible; it costs one comparison
            // to be certain the empty case cannot become a query for nothing.
            return resolvable;
        }
        let variants: Array<Translated<ProductVariant>>;
        try {
            variants = await this.productVariantService.findByIds(ctx, variantIds);
        } catch (err: unknown) {
            // The diagnostic is fixed text plus a count this file computed. The caught value is classified by
            // the helper and then discarded; none of it is logged and none of it is published.
            throw reportReorderListInternalFailure(
                'Resolving the product variants of a reorder list line page failed for a page of ' +
                    `${String(variantIds.length)} variant identifier(s)`,
                err,
            );
        }
        for (const variant of variants) {
            if (variant.deletedAt == null) {
                resolvable.set(String(variant.id), variant);
            }
        }
        return resolvable;
    }

    /**
     * Returns the line's already-loaded variant relation where **this request can prove it is serveable**, and
     * `undefined` where the channel-scoped batched load must decide instead.
     *
     * **Presence alone is not enough, and core says so in its own short-circuits**: the order-line resolver
     * tests a hydration marker on the relation rather than merely testing that the object is there. A variant
     * loaded by a bare relation join carries no translation and no channel price, so its `name` would be
     * absent — and `name` is non-null on the published type — while its price fields would silently read zero.
     *
     * **Active-channel membership is proved here rather than assumed, and that is the whole reason this
     * method takes a context.** A hydrated relation arrives from whoever loaded it, and "it is loaded" says
     * nothing about which channel it was loaded in — a plain relation join is not channel-scoped at all. A
     * short-circuit that trusted hydration alone would therefore return, to a request on channel B, a variant
     * that belongs only to channel A: an authorization decision taken by the absence of a check
     * (CWE-863), and one that no payload assertion distinguishes from the correct answer. So the relation is
     * served only when its **loaded** `channels` collection contains the request's active channel; the
     * comparison is the platform's own `idsAreEqual`, because the configured `EntityIdStrategy` decides
     * whether an identifier arrives as a number or a string and `===` is wrong across the two.
     *
     * Four conditions consequently have to hold, and failing any of them falls through to
     * {@link ReorderListEntityResolver.loadVariantsInChannel}, which resolves through the platform's
     * channel-scoped accessor: the relation is present; it is not soft-deleted (rejected here on the same
     * terms as in the batched path, so the two cannot disagree); it is translated and priced (a resolved
     * `name` proves the translation ran and a numeric `listPrice` proves the price applicator did); and its
     * loaded channel set contains `ctx.channelId`. A relation whose `channels` were never loaded is
     * *unverifiable* rather than invalid, so it takes the same fall-through — which is what makes this
     * short-circuit an optimisation that cannot change an answer.
     *
     * This plugin's own read never loads the relation, so in practice the short-circuit serves only a line
     * handed over already hydrated by another integration; the checks are what stop such a line from
     * publishing something this request may not see.
     */
    private hydratedRelation(
        ctx: RequestContext,
        line: ReorderListLine,
    ): Translated<ProductVariant> | undefined {
        const relation = line.productVariant;
        if (!relation || relation.deletedAt != null) {
            return undefined;
        }
        if (typeof relation.name !== 'string' || typeof relation.listPrice !== 'number') {
            return undefined;
        }
        if (!this.isLoadedInActiveChannel(ctx, relation)) {
            return undefined;
        }
        return relation as Translated<ProductVariant>;
    }

    /**
     * Whether a hydrated variant's **loaded** channel set demonstrably contains the request's active channel.
     *
     * `false` covers both "loaded, and not in this channel" and "not loaded, so unknown", and the two are
     * deliberately answered the same way: the caller's only use for this predicate is to decide whether it may
     * skip the channel-scoped load, and both answers mean it may not. Nothing is inferred from a missing
     * relation, and no statement is issued to find out — asking the database here would be the per-entry read
     * the batched path exists to avoid.
     */
    private isLoadedInActiveChannel(ctx: RequestContext, variant: ProductVariant): boolean {
        const channels = variant.channels;
        if (!Array.isArray(channels) || channels.length === 0) {
            return false;
        }
        return channels.some(channel => channel != null && idsAreEqual(channel.id, ctx.channelId));
    }
}
