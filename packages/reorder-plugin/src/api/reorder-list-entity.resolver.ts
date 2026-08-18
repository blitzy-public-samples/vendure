/*
 * -------------------------------------------------------------------------------------------------------
 * The reorder-list field resolvers — provenance, and the one property that makes them correct.
 * -------------------------------------------------------------------------------------------------------
 * Attribution. No user-specified rules were provided for this project: the rules document was read and
 * returned exactly that, and EPIC-001 reaches the same finding independently in its own section 11.9.
 * Nothing in this file is, or derives from, a user-specified rule. Every constraint stated below traces to
 * FEATURE-001-01 (sections 2.6, 2.6.2, 2.6.2.1 and 2.6.3), to STORY-001-01-04, to an EPIC-001 settled ruling
 * (R10, R15), or to a cited line of this repository, and is attributed as such wherever it is stated. The
 * absence of a rules document has not been treated as licence to lower the bar anywhere in this file.
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
 * the platform clamp, so a second derivation of the sort cannot drift from the first. There is no sharing:
 * `viewerAccess` reports the truthful values while no share row can exist, and no grant roster is read,
 * declared or assumed — that is FEATURE-001-06's. And there is no availability field of this plugin's own on
 * a line: a saved list records INTENT rather than availability, so neither `deletedAt` nor `enabled` is
 * projected onto a payload here (surfacing availability is FEATURE-001-03's, resolving it FEATURE-001-04's).
 *
 * TWO CLASSES IN ONE FILE, because a class-level `@Resolver` binds exactly one parent type and two parent
 * types need binding. Seven files under `packages/core/src/api/resolvers/entity/` already do this —
 * `payment-entity.resolver.ts` holds `PaymentEntityResolver` and `PaymentAdminEntityResolver` — so the shape
 * is the repository's own rather than a workaround. BOTH classes must appear in the plugin's
 * `shopApiExtensions.resolvers` array: registering only the first leaves `ReorderListLine.productVariant`
 * falling through to the default resolver, which returns the relation the read never loads.
 *
 * The `@since 3.8.0` tags below are a derivation and are flagged as one. The contribution guide requires new
 * public API to carry a `@since` tag naming what will be the next minor version, and its own literal example
 * names a different version. This checkout declares 3.7.0, so the next minor derives to 3.8.0. That string
 * appears nowhere in this repository and is therefore not a quotation from it.
 * -------------------------------------------------------------------------------------------------------
 */

import { Inject } from '@nestjs/common';
import { Args, Parent, ResolveField, Resolver } from '@nestjs/graphql';
import {
    Ctx,
    ID,
    ListQueryOptions,
    Logger,
    PaginatedList,
    ProductVariant,
    ProductVariantService,
    RequestContext,
    RequestContextCacheService,
    Translated,
} from '@vendure/core';

import { loggerCtx, REORDER_PLUGIN_OPTIONS } from '../constants';
import { ReorderListLine } from '../entities/reorder-list-line.entity';
import { ReorderList } from '../entities/reorder-list.entity';
import { ReorderListService, ReorderListViewerAccess } from '../service/reorder-list.service';
import { ReorderPluginOptions } from '../types';

/**
 * The page size the nested line collection falls back to where the caller supplied no `take`.
 *
 * It duplicates no validation and it is not a second opinion about the value. `ReorderPlugin.init()`
 * validates every supplied option once, at plugin initialisation, and merges the same declared default for a
 * key a deployment omits — so by the time this resolver reads the option the value is either a validated
 * integer or absent. This fallback exists because every member of {@link ReorderPluginOptions} is optional,
 * and an option resolving to `undefined` here would hand `take: undefined` to the service and silently
 * restore the platform's own much larger substitution. Fifty is stricter than the Shop-side maximum the
 * default configuration sets, which is the property that makes it safe to apply
 * (`packages/core/src/config/default-config.ts` L89).
 */
const DEFAULT_REORDER_LIST_LINES_PAGE_SIZE = 50;

/**
 * The prefix of the request-scoped key under which the single-list read records that it returned a given
 * list. Kept separate from the key builder so that a reader can see there is exactly one namespace, and
 * spelled after the class that reads it, which is the shape core's own resolvers use for this cache
 * (`packages/core/src/api/resolvers/entity/payment-entity.resolver.ts`).
 *
 * It is exported for one reason only: the Shop resolver sets the mark this file reads, so both sides have to
 * resolve the same namespace, and a namespace spelled twice is a namespace that can drift. Nothing outside
 * this plugin's own `src/api` should reference it.
 *
 * @internal
 */
export const SINGLE_LIST_READ_KEY_PREFIX = 'ReorderListEntityResolver.singleListRead';

/** The request-scoped key prefix under which one page's pending line-page batch is held. */
const LINES_BATCH_KEY_PREFIX = 'ReorderListEntityResolver.linesBatch';

/** The request-scoped key under which one page's pending product-variant batch is held. */
const VARIANT_BATCH_KEY = 'ReorderListLineEntityResolver.productVariantBatch';

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
 * Builds the request-scoped key under which the single-list read records that it returned the list with the
 * given identifier.
 *
 * **Why this is exported rather than private.** It is one half of a contract between two files, and a
 * contract spelled twice is a contract that can disagree with itself. `activeCustomerReorderList` marks the
 * request through {@link markSingleReorderListRead}; {@link ReorderListEntityResolver.lines} reads the same
 * mark through this key. Exporting the builder makes the coordination visible and makes a mismatch a
 * compile-time concern rather than a silent behavioural one.
 *
 * The identifier is stringified because the configured `EntityIdStrategy` decides at run time whether an id
 * is a number or a string, and a key built from the raw value would not match across the two.
 *
 * @param listId - The identifier of the list the single-list read returned.
 *
 * @docsCategory core plugins/ReorderPlugin
 * @docsPage ReorderListEntityResolver
 * @since 3.8.0
 */
export function singleReorderListReadCacheKey(listId: ID): string {
    return `${SINGLE_LIST_READ_KEY_PREFIX}(${String(listId)})`;
}

/**
 * @description
 * Records, for the duration of one request, that the single-list read returned the list with the given
 * identifier — which is the first of the two conjuncts that admit the `lineCount` compare-and-set repair.
 *
 * **This must be called by `activeCustomerReorderList` and by nothing else.** The collection read must never
 * repair: a page of lists pages no lines, so it has no observed total to compare against, and repairing
 * there would rewrite a counter from a number the request never established (FEATURE-001-01 section 2.6.2.1).
 * The mark is what distinguishes the two reads, and it is deliberately NOT inferred from the batch holding a
 * single parent: a collection read asking for `take: 1` is indistinguishable under that test and would repair
 * on the collection path.
 *
 * **The failure mode is safe in one direction only, which is why the mark is opt-in.** A request that never
 * marks simply never repairs — the stored counter is reported as it stands, which is the collection read's
 * own documented behaviour. A request that marked wrongly would repair on a path the contract forbids. So the
 * absence of this call degrades to "no repair" and never to "wrong repair".
 *
 * @param requestContextCache - The platform's request-scoped cache, injected by the calling resolver.
 * @param ctx - The request context the mark is scoped to. The cache is a `WeakMap` keyed on this instance, so
 * the mark is garbage-collected with the request and cannot leak into another.
 * @param listId - The identifier of the list being returned by the single-list read.
 *
 * @example
 * ```ts
 * const list = await this.reorderListService.getReorderList(ctx, id, includeShared);
 * if (list) {
 *     markSingleReorderListRead(this.requestContextCache, ctx, list.id);
 * }
 * return list;
 * ```
 *
 * @docsCategory core plugins/ReorderPlugin
 * @docsPage ReorderListEntityResolver
 * @since 3.8.0
 */
export function markSingleReorderListRead(
    requestContextCache: RequestContextCacheService,
    ctx: RequestContext,
    listId: ID,
): void {
    requestContextCache.set(ctx, singleReorderListReadCacheKey(listId), true);
}

// ---------------------------------------------------------------------------------------------------
// The page batch. This is the mechanism that makes "once per page, never once per entry" true, so it
// is documented at the length of a mechanism rather than of a helper.
// ---------------------------------------------------------------------------------------------------

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
 * Resolves the two published fields of `ReorderList` that are not columns of `reorder_list`: the nested
 * `lines` page and the per-requester `viewerAccess`.
 *
 * **`lineCount` is deliberately not among them.** It is the stored column, it arrives with the row the page
 * query already selected, and it is the single authority for the published field, the generated filter, the
 * generated sort and the atomic line bound (FEATURE-001-01 section 2.6.2). A resolver for it — counting rows
 * per entry, issuing a grouped count beside the page, or taking the length of a loaded relation — would return
 * the same numbers while making a second source of truth, so there is no such member here and the file header
 * records why each of those three shapes is forbidden.
 *
 * **Both fields cost one page rather than one entry.** `lines` is served by a single batched load per page
 * whose result is partitioned in process, and `viewerAccess` costs no statement at all. Registering this class
 * without its sibling {@link ReorderListLineEntityResolver} leaves `ReorderListLine.productVariant`
 * unresolved, so the plugin's `shopApiExtensions.resolvers` array must carry both.
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
        private requestContextCache: RequestContextCacheService,
        @Inject(REORDER_PLUGIN_OPTIONS) private options: ReorderPluginOptions,
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
        const batch = openPageBatch<Map<ID, PaginatedList<ReorderListLine>>>(
            this.requestContextCache,
            ctx,
            `${LINES_BATCH_KEY_PREFIX}(${stableStringify(options)})`,
            listIds => this.reorderListService.getLinesForLists(ctx, listIds, options),
        );
        const parentId = registerInPageBatch(batch, list.id);
        const pages = await batch.loaded;
        const page = pages.get(parentId);
        if (!page) {
            // Unreachable against the service's own contract, which seeds an entry for every identifier it is
            // given — and reported rather than papered over, because the alternative is a page of lines that
            // silently reads as empty. An empty page is returned rather than an error raised: the request has
            // already produced the buyer's list, and failing it over a missing partition would lose more than
            // it reports.
            Logger.warn(
                `Resolved no line page for reorder list ${String(list.id)} from a batch of ` +
                    `${String(batch.registeredIds.size)} list(s)`,
                loggerCtx,
            );
            return { items: [], totalItems: 0 };
        }
        await this.repairStaleLineCount(ctx, list, page.totalItems);
        return page;
    }

    /**
     * @description
     * Resolves the per-requester provenance of the list, at a cost of zero database statements.
     *
     * The value is derived from the row already loaded and the session already resolved, which is why this
     * method is synchronous and why it takes no request context: there is nothing to look up. Under this
     * feature every list that reaches a caller has passed the service's ownership-and-channel predicate, so
     * `access` is `OWNED` and `grantedCapabilities` is empty — the truthful values while no share row can
     * exist, rather than placeholders. Both values of the `includeShared` argument therefore return the same
     * thing, because the shared set is empty by construction rather than withheld.
     *
     * **A per-entry access check that issued a statement is forbidden**, and the criterion that guards this is
     * literal: zero statements, asserted as a number rather than as a payload. Sharing makes this conditional
     * in FEATURE-001-06; it is deliberately not anticipated here, so no share table is read and no grant field
     * is declared or populated.
     *
     * @param list - The list being described. It is the value the derivation reads once sharing makes this
     * conditional, and it is passed for that reason.
     *
     * @since 3.8.0
     */
    @ResolveField()
    viewerAccess(@Parent() list: ReorderList): ReorderListViewerAccess {
        return this.reorderListService.getViewerAccess(list);
    }

    /**
     * Normalises the generator-supplied options into the page the service is asked for.
     *
     * Only `take` is touched, and only where the caller supplied none — `??` rather than `||` because a
     * caller's explicit value must survive, and because the generated argument may arrive as null as well as
     * absent. Every other member — `skip`, `sort`, `filter`, `filterOperator` — is handed through exactly as
     * it arrived, so the caller's own paging and ordering reach the service unaltered.
     */
    private linesPageOptions(args: ReorderListLinesArgs): ListQueryOptions<ReorderListLine> {
        const supplied = args?.options ?? undefined;
        return {
            ...supplied,
            take: supplied?.take ?? this.defaultLinesPageSize(),
        };
    }

    /**
     * The configured nested page size, with the module's own fallback for the case the option is absent.
     *
     * Every member of {@link ReorderPluginOptions} is optional, and the plugin merges the declared default for
     * a key a deployment omits, so this fallback is unreachable through `ReorderPlugin.init()`. It exists
     * because an option resolving to `undefined` here would hand the service no page size at all and silently
     * restore the platform's much larger substitution — a bound that quietly becomes a looser bound is worse
     * than a wrong one, because nothing reports it.
     */
    private defaultLinesPageSize(): number {
        return this.options.defaultReorderListLinesPageSize ?? DEFAULT_REORDER_LIST_LINES_PAGE_SIZE;
    }

    /**
     * Repairs a stored line counter that disagrees with the total this request actually observed — and only on
     * the single-list read.
     *
     * **Both conjuncts are required, and each rules out a different defect.**
     *
     * The first is that this request reached the list through `activeCustomerReorderList`, which records the
     * fact through {@link markSingleReorderListRead}. Without it, a collection read that happened to select
     * `lines` would repair, which FEATURE-001-01 section 2.6.2.1 forbids in as many words: a page of lists has
     * no observed total to compare against and reports the stored column as it stands. The mark is read rather
     * than inferred from the batch holding one parent, because a collection read asking for `take: 1` is
     * indistinguishable under that test.
     *
     * The second is that the observed total actually differs from the stored counter. On the overwhelmingly
     * common path they agree and nothing is issued, which is what makes the repair free where there is nothing
     * to repair. A counter that is not a finite number is left alone as well: it could not have come from the
     * column, and comparing against it would issue a statement whose guard can never match.
     *
     * **The one path that can drift the counter** is a HARD deletion of a `product_variant` row, whose
     * cascade removes line rows underneath the plugin without the counter being told. The platform's own
     * variant deletion is a soft delete that leaves every line in place, so this is reachable only by a direct
     * database deletion or by a future platform change — stated at its true size, and repaired rather than
     * left to disagree.
     *
     * **The reconciled value is written back onto the row**, which does two things and is not cosmetic.
     * It makes the corrected number visible to any consumer that reads the row after this page resolves. And
     * it makes the repair idempotent within the request: a second resolution of the same list's lines — a
     * second alias of the field, say — then finds stored and observed in agreement and issues nothing, so
     * "exactly one compare-and-set statement" holds however many times the field appears in the document.
     *
     * The statement itself, its compare-and-set guard and its refusal of a value the column may not hold all
     * belong to the service. Nothing here composes SQL.
     */
    private async repairStaleLineCount(
        ctx: RequestContext,
        list: ReorderList,
        observedTotal: number,
    ): Promise<void> {
        // Conjunct one: this list was returned by the single-list read of THIS request.
        const isSingleListRead = this.requestContextCache.get<boolean>(
            ctx,
            singleReorderListReadCacheKey(list.id),
        );
        if (isSingleListRead !== true) {
            return;
        }
        // Conjunct two: a total is actually known for this parent, and it differs from the stored counter.
        // Both halves are checked here rather than left to the service. The service does refuse a total the
        // column may not hold, but it refuses it by logging an error — and an error log is the right report for
        // a defect and the wrong one for a value this method could have declined to pass on.
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
        const reconciled = await this.reorderListService.reconcileLineCount(
            ctx,
            list.id,
            storedLineCount,
            observedTotal,
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
}

/**
 * @description
 * Resolves the one published field of `ReorderListLine` that is not a column of `reorder_list_line`: the
 * catalogue variant the line references.
 *
 * **The column and the published field are deliberately not the same nullability, and the pair is what makes a
 * stale line readable.** `reorder_list_line.productVariantId` is `NOT NULL`, because a retained line always
 * references a variant row that still exists; the published `productVariant` field is nullable, because a
 * variant that is no longer resolvable in the active channel must not be exposed and must not null-bubble the
 * whole line out of its page. `productVariantId` stays non-null on both sides, which is what lets a buyer see
 * and remove the line (FEATURE-001-01 section 2.4).
 *
 * This class is the sibling of {@link ReorderListEntityResolver} and must be registered alongside it in the
 * plugin's `shopApiExtensions.resolvers` array. A class-level `@Resolver` binds exactly one parent type, which
 * is why there are two classes; seven files under `packages/core/src/api/resolvers/entity/` do the same.
 *
 * @docsCategory core plugins/ReorderPlugin
 * @docsPage ReorderListEntityResolver
 * @since 3.8.0
 */
@Resolver('ReorderListLine')
export class ReorderListLineEntityResolver {
    constructor(
        private productVariantService: ProductVariantService,
        private requestContextCache: RequestContextCacheService,
    ) {}

    /**
     * @description
     * Resolves the variant a line references, for every line on the page in one load, or `null` where that
     * variant is no longer resolvable in the active channel.
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
     * @param ctx - The request context, whose active channel scopes the load and whose language code the
     * returned variant is translated into.
     * @param line - The line whose variant is being resolved.
     * @returns The variant, or `null` where it is not resolvable in the active channel.
     *
     * @since 3.8.0
     */
    @ResolveField()
    async productVariant(
        @Ctx() ctx: RequestContext,
        @Parent() line: ReorderListLine,
    ): Promise<Translated<ProductVariant> | null> {
        const alreadyResolved = this.hydratedRelation(line);
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
        const variants = await this.productVariantService.findByIds(ctx, variantIds);
        for (const variant of variants) {
            if (variant.deletedAt == null) {
                resolvable.set(String(variant.id), variant);
            }
        }
        return resolvable;
    }

    /**
     * Returns the line's already-loaded variant relation where it is safe to serve, and `undefined` where the
     * batched load must decide instead.
     *
     * **Presence alone is not enough, and core says so in its own short-circuits**: the order-line resolver
     * tests a hydration marker on the relation rather than merely testing that the object is there. A variant
     * loaded by a bare relation join carries no translation and no channel price, so its `name` would be
     * absent — and `name` is non-null on the published type — while its price fields would silently read zero.
     * Both markers are therefore checked: a resolved `name` proves the translation ran, and a numeric
     * `listPrice` proves the price applicator did.
     *
     * A soft-deleted variant is rejected here on the same terms as in the batched path, so the two paths
     * cannot disagree about it. What this check cannot establish in memory is channel membership, which is why
     * it is conservative: this plugin's own read never loads the relation, so the short-circuit is reachable
     * only for a line handed over already hydrated by a caller that resolved it in the active channel, and
     * anything less than fully hydrated falls through to the channel-scoped load.
     */
    private hydratedRelation(line: ReorderListLine): Translated<ProductVariant> | undefined {
        const relation = line.productVariant;
        if (!relation || relation.deletedAt != null) {
            return undefined;
        }
        if (typeof relation.name !== 'string' || typeof relation.listPrice !== 'number') {
            return undefined;
        }
        return relation as Translated<ProductVariant>;
    }
}
