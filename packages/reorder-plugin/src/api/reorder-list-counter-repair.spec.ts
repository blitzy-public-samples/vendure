/*
 * -------------------------------------------------------------------------------------------------------
 * The single-list read's `lineCount` reconciliation, and the two properties that make it correct.
 * -------------------------------------------------------------------------------------------------------
 * Attribution. No user-specified rules were provided for this project. Every obligation asserted below
 * traces to FEATURE-001-01 section 2.6.2.1 (the compare-and-set repair belongs to the single-list read, the
 * FIRST such read reports the corrected count, and the collection read never repairs), to
 * STORY-001-01-04 (the per-page batching equality and the zero-statement `viewerAccess`), or to a cited line
 * of this repository.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM THE SERVICE SPECIFICATION. The service owns the statement — its
 * guard, its arithmetic and its refusal of a value the column may not hold — and `reorder-list.service.spec.ts`
 * pins all of that. What this file pins is something the service cannot see: WHEN the reconciliation happens
 * relative to GraphQL's own execution, and WHICH parent object is eligible for it. Both are properties of the
 * api layer, both are invisible in the payload of every request that has nothing to repair, and both have
 * already been got wrong once:
 *
 *   - Performing the reconciliation inside the nested `lines` resolver corrects the row but reports the stale
 *     number, because the executor completes an object's fields by walking its selection set synchronously and
 *     takes a scalar with no field resolver straight off the source object, awaiting only the promises that
 *     walk collected. The request that most needs the corrected value is exactly the one that reports the wrong
 *     one.
 *   - Deciding "was this object returned by the single-list read" from anything other than the object's own
 *     identity fails in the direction that looks like success. A licence keyed on the `RequestContext` instance
 *     is not found when a field resolver receives a different instance — the platform binds a context per
 *     handler (`packages/core/src/api/decorators/request-context.decorator.ts`) — and the required repair is
 *     then skipped in silence. A licence keyed on the row identifier is satisfied by a collection entry for the
 *     same row, which repairs on a path the contract forbids.
 *
 * Each `it` below is one of those failures, expressed as the observation that would catch it.
 */
import { Channel, ProductVariantService, RequestContext, RequestContextCacheService } from '@vendure/core';
import { DocumentNode, FragmentDefinitionNode, GraphQLResolveInfo, parse } from 'graphql';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ReorderListLine } from '../entities/reorder-list-line.entity';
import { ReorderList } from '../entities/reorder-list.entity';
import { ReorderListLinePage, ReorderListService } from '../service/reorder-list.service';
import { ResolvedReorderPluginOptions } from '../types';

import { ReorderListEntityResolver, ReorderListLinesArgs } from './reorder-list-entity.resolver';
import { ReorderListShopResolver, singleListReadMarked } from './reorder-list-shop.resolver';

const LIST_ID = 'T_1';
const CHANNEL_ID = 'T_1';
const DEFAULT_LINES_PAGE_SIZE = 50;

/** The five options as `ReorderPlugin.init()` resolves them, with the two page sizes this file depends on. */
const PLUGIN_OPTIONS: ResolvedReorderPluginOptions = {
    maxListsPerCustomer: 25,
    maxLinesPerList: 200,
    maxQuantityPerLine: 999,
    defaultReorderListsPageSize: 25,
    defaultReorderListLinesPageSize: DEFAULT_LINES_PAGE_SIZE,
};

/**
 * The subset of `ReorderListService` these resolvers reach, as spies.
 *
 * It is a double rather than the real service because what is under test is the api layer's ordering and
 * eligibility, and a real service would make every assertion below depend on a database. The service's own
 * behaviour is pinned, against its own statement journal, in `reorder-list.service.spec.ts`.
 */
interface ServiceDouble {
    getReorderList: ReturnType<typeof vi.fn>;
    getLinesForLists: ReturnType<typeof vi.fn>;
    reconcileLineCount: ReturnType<typeof vi.fn>;
    getViewerAccess: ReturnType<typeof vi.fn>;
}

/** A request context carrying an authenticated session in the active channel. */
function ctxFor(): RequestContext {
    return new RequestContext({
        apiType: 'shop',
        channel: new Channel({ id: CHANNEL_ID, code: 'default' }),
        session: { user: { id: 'T_2' } } as unknown as RequestContext['session'],
        isAuthorized: true,
        authorizedAsOwnerOnly: true,
    });
}

/** A hydrated list row carrying the given stored counter. Each call produces a DISTINCT object. */
function listRow(lineCount: number, id: string = LIST_ID): ReorderList {
    return new ReorderList({
        id,
        customerId: 'T_5',
        channelId: CHANNEL_ID,
        name: 'Weekly',
        nameKey: 'weekly',
        lineCount,
    });
}

/**
 * A page of lines as the service publishes it.
 *
 * `authoritativeTotalItems` is present only for an unfiltered request, exactly as the service behaves: a
 * filtered request counts the caller's own subset and so publishes no authoritative total. Passing that
 * faithfully is what lets the filtered cases below assert "no repair" for the reason the service gives rather
 * than for a reason this file invented.
 */
function linePage(totalItems: number, authoritativeTotalItems?: number): ReorderListLinePage {
    return {
        items: [
            new ReorderListLine({
                id: 'T_9',
                reorderListId: LIST_ID,
                productVariantId: 'T_3',
                quantity: 1,
            }),
        ],
        totalItems,
        authoritativeTotalItems,
    };
}

/**
 * A `GraphQLResolveInfo` for the FIRST root field of the given document, with its fragments indexed.
 *
 * The document is parsed rather than hand-assembled so that fragment spreads, inline fragments, aliases,
 * directives and variable-valued arguments are the real AST nodes the executor would hand a resolver. Only the
 * three members the reconciliation reads — `fieldNodes`, `fragments` and `variableValues` — are populated,
 * which is why the value is cast rather than constructed in full.
 */
function infoFor(document: string, variableValues: Record<string, unknown> = {}): GraphQLResolveInfo {
    const parsed: DocumentNode = parse(document);
    const operation = parsed.definitions.find(definition => definition.kind === 'OperationDefinition');
    if (!operation || operation.kind !== 'OperationDefinition') {
        throw new Error('The document under test declares no operation');
    }
    const rootField = operation.selectionSet.selections[0];
    if (rootField.kind !== 'Field') {
        throw new Error('The first root selection of the document under test is not a field');
    }
    const fragments: Record<string, FragmentDefinitionNode> = {};
    for (const definition of parsed.definitions) {
        if (definition.kind === 'FragmentDefinition') {
            fragments[definition.name.value] = definition;
        }
    }
    return { fieldNodes: [rootField], fragments, variableValues } as unknown as GraphQLResolveInfo;
}

/** The generator-supplied arguments of `ReorderList.lines`, built without spelling a generated input name. */
function linesArgs(options?: Record<string, unknown>): ReorderListLinesArgs {
    return { options: options as ReorderListLinesArgs['options'] };
}

/**
 * Narrows a nullable read to its value, failing the test rather than asserting through a non-null assertion.
 *
 * Every case in this file arranges a list that resolves, so a null here is a defect in the case and is worth
 * saying so out loud.
 */
function present<T>(value: T | null | undefined): T {
    if (value == null) {
        throw new Error('The single-list read returned nothing, which no case in this file arranges');
    }
    return value;
}

/** The method function a decorator wrote its metadata onto, read without holding an unbound method. */
function methodOf(target: NewableFunction, name: string): object {
    const descriptor = Object.getOwnPropertyDescriptor(target.prototype as object, name);
    if (!descriptor) {
        throw new Error(`${target.name} declares no member named ${name}`);
    }
    return descriptor.value as object;
}

/** A fresh service double whose line loads answer with an unfiltered total unless the request narrows. */
function serviceDoubleFor(row: ReorderList | null): ServiceDouble {
    return {
        getReorderList: vi.fn(() => Promise.resolve(row)),
        getLinesForLists: vi.fn(
            (_ctx: unknown, ids: Array<string | number>, options?: { filter?: unknown }) => {
                const narrowed = options?.filter != null && Object.keys(options.filter).length > 0;
                return Promise.resolve(new Map(ids.map(id => [id, linePage(1, narrowed ? undefined : 1)])));
            },
        ),
        reconcileLineCount: vi.fn((_ctx: unknown, _id: unknown, _stale: unknown, observed: number) =>
            Promise.resolve(observed),
        ),
        getViewerAccess: vi.fn(() => ({ access: 'OWNED', grantedCapabilities: [] })),
    };
}

function shopResolverFor(service: ServiceDouble): ReorderListShopResolver {
    return new ReorderListShopResolver(service as unknown as ReorderListService, PLUGIN_OPTIONS);
}

function entityResolverFor(service: ServiceDouble): ReorderListEntityResolver {
    return new ReorderListEntityResolver(
        service as unknown as ReorderListService,
        {} as unknown as ProductVariantService,
        new RequestContextCacheService(),
        PLUGIN_OPTIONS,
    );
}

describe('the single-list read reconciles the stored lineCount before the parent is exposed', () => {
    let service: ServiceDouble;
    let shop: ReorderListShopResolver;
    let entity: ReorderListEntityResolver;
    let row: ReorderList;

    beforeEach(() => {
        // Stored 3, observed 1: a counter that disagrees, so every ordering assertion below has something to
        // be wrong about.
        row = listRow(3);
        service = serviceDoubleFor(row);
        shop = shopResolverFor(service);
        entity = entityResolverFor(service);
    });

    it('reports the corrected count on the object it returns, not after a field has resolved', async () => {
        // The canonical document, reaching `lines` through a NESTED fragment spread - the shape this
        // package's own end-to-end read uses, and the one a walk of direct field selections would miss.
        const info = infoFor(`
            query Q($id: ID!) { activeCustomerReorderList(id: $id) { ...ListWithLines } }
            fragment ListWithLines on ReorderList { ...ListFields lines { totalItems items { id } } }
            fragment ListFields on ReorderList { id name lineCount }
        `);

        const returned = present(await shop.activeCustomerReorderList(ctxFor(), { id: LIST_ID }, info));

        // The whole of the ordering requirement: the value a synchronously-read sibling scalar would take off
        // this object is already the corrected one.
        expect(returned).toBe(row);
        expect(returned.lineCount).toBe(1);
        expect(service.reconcileLineCount).toHaveBeenCalledTimes(1);
        expect(service.getLinesForLists).toHaveBeenCalledTimes(1);
        expect(singleListReadMarked(returned)).toBe(true);
    });

    it('serves the nested field from the page it already read, issuing no second load', async () => {
        const ctx = ctxFor();
        const info = infoFor(
            `query Q($id: ID!) { activeCustomerReorderList(id: $id) { lineCount lines { totalItems } } }`,
        );

        const returned = present(await shop.activeCustomerReorderList(ctx, { id: LIST_ID }, info));
        const page = await entity.lines(ctx, returned, linesArgs());

        // Reconciling early costs the request nothing: the nested read's statements are issued once.
        expect(page.totalItems).toBe(1);
        expect(service.getLinesForLists).toHaveBeenCalledTimes(1);
        expect(service.reconcileLineCount).toHaveBeenCalledTimes(1);
    });

    it('computes the same window as the field resolver for a document written with variables', async () => {
        const ctx = ctxFor();
        const info = infoFor(
            `query Q($id: ID!, $take: Int, $order: SortOrder) {
                activeCustomerReorderList(id: $id) {
                    lineCount
                    lines(options: { take: $take, sort: { createdAt: $order } }) { totalItems }
                }
            }`,
            { id: LIST_ID, take: 2, order: 'ASC' },
        );

        const returned = present(await shop.activeCustomerReorderList(ctx, { id: LIST_ID }, info));
        await entity.lines(ctx, returned, linesArgs({ take: 2, sort: { createdAt: 'ASC' } }));

        // One load, because both sides rendered the identical window: the argument was read off the document
        // through the request's own variable values rather than reconstructed.
        expect(service.getLinesForLists).toHaveBeenCalledTimes(1);
        expect(service.getLinesForLists.mock.calls[0][2]).toEqual({ take: 2, sort: { createdAt: 'ASC' } });
        expect(returned.lineCount).toBe(1);
    });

    it('reads nothing at all when the document selects no lines field', async () => {
        const info = infoFor(`query Q($id: ID!) { activeCustomerReorderList(id: $id) { id lineCount } }`);

        const returned = present(await shop.activeCustomerReorderList(ctxFor(), { id: LIST_ID }, info));

        // No observed total exists for this request, which is the collection read's permanent position: the
        // stored counter is reported exactly as it stands.
        expect(service.getLinesForLists).not.toHaveBeenCalled();
        expect(service.reconcileLineCount).not.toHaveBeenCalled();
        expect(returned.lineCount).toBe(3);
    });

    it('reads nothing when every lines selection narrows the collection', async () => {
        const info = infoFor(`
            query Q($id: ID!) {
                activeCustomerReorderList(id: $id) {
                    lineCount
                    a: lines(options: { filter: { quantity: { eq: 2 } } }) { totalItems }
                    b: lines(options: { filter: { quantity: { eq: 7 } } }) { totalItems }
                }
            }
        `);

        const returned = present(await shop.activeCustomerReorderList(ctxFor(), { id: LIST_ID }, info));

        // A filtered total counts the caller's own subset. Writing it into `reorder_list.lineCount` would
        // replace the number the atomic line bound is enforced against with one the caller chose.
        expect(service.getLinesForLists).not.toHaveBeenCalled();
        expect(service.reconcileLineCount).not.toHaveBeenCalled();
        expect(returned.lineCount).toBe(3);
    });

    it('reads nothing for a lines selection the document excluded with @skip', async () => {
        const info = infoFor(
            `query Q($id: ID!, $skip: Boolean!) {
                activeCustomerReorderList(id: $id) { lineCount lines @skip(if: $skip) { totalItems } }
            }`,
            { id: LIST_ID, skip: true },
        );

        await shop.activeCustomerReorderList(ctxFor(), { id: LIST_ID }, info);

        // The field is not part of the request, so reading it would issue two statements nobody asked for and
        // repair from a page the response never carries.
        expect(service.getLinesForLists).not.toHaveBeenCalled();
        expect(service.reconcileLineCount).not.toHaveBeenCalled();
    });

    it('keeps working when the page it tried to pre-resolve could not be read', async () => {
        const ctx = ctxFor();
        const info = infoFor(
            `query Q($id: ID!) { activeCustomerReorderList(id: $id) { lineCount lines { totalItems } } }`,
        );
        service.getLinesForLists.mockRejectedValueOnce(new Error('the nested read failed'));

        const returned = present(await shop.activeCustomerReorderList(ctx, { id: LIST_ID }, info));

        // The read that would otherwise have succeeded is not failed for the sake of a counter it only meant
        // to tidy; the stored value is reported and the fallback repairs the row when the field resolves.
        expect(returned).toBe(row);
        expect(returned.lineCount).toBe(3);
        const page = await entity.lines(ctx, returned, linesArgs());
        expect(page.totalItems).toBe(1);
        expect(service.reconcileLineCount).toHaveBeenCalledTimes(1);
        expect(returned.lineCount).toBe(1);
    });
});

/*
 * Aliases are what make "does this document narrow the collection" a question about the WHOLE selection set.
 * GraphQL lets one document select `lines` more than once with different arguments, so a filtered occurrence
 * and an unfiltered one can sit side by side. A reconciliation that inspected only the first occurrence would
 * decline a filtered one - correctly, in isolation - and the unfiltered alias behind it would then establish
 * the true total in the field resolver, repairing the row after the executor had already taken `lineCount`.
 * That is the stale-first-response defect reintroduced through an alias, and these are the cases that catch it.
 */
describe('an unfiltered lines window is found wherever in the selection set it appears', () => {
    let service: ServiceDouble;
    let shop: ReorderListShopResolver;
    let entity: ReorderListEntityResolver;
    let row: ReorderList;

    beforeEach(() => {
        row = listRow(3);
        service = serviceDoubleFor(row);
        shop = shopResolverFor(service);
        entity = entityResolverFor(service);
    });

    it('reconciles from a later unfiltered alias when the FIRST alias is filtered', async () => {
        const info = infoFor(`
            query Q($id: ID!) {
                activeCustomerReorderList(id: $id) {
                    lineCount
                    filtered: lines(options: { filter: { quantity: { eq: 2 } } }) { totalItems }
                    all: lines { totalItems }
                }
            }
        `);

        const returned = present(await shop.activeCustomerReorderList(ctxFor(), { id: LIST_ID }, info));

        // The corrected value is on the object BEFORE it is returned, even though the document's first
        // occurrence of `lines` narrows.
        expect(returned.lineCount).toBe(1);
        expect(service.reconcileLineCount).toHaveBeenCalledTimes(1);
        // And the window pre-resolved is the UNFILTERED one, carrying no filter of the caller's.
        expect(service.getLinesForLists).toHaveBeenCalledTimes(1);
        expect(service.getLinesForLists.mock.calls[0][2]).toEqual({ take: DEFAULT_LINES_PAGE_SIZE });
    });

    it('serves the unfiltered alias from the cache and lets the filtered alias load its own page', async () => {
        const ctx = ctxFor();
        const info = infoFor(`
            query Q($id: ID!) {
                activeCustomerReorderList(id: $id) {
                    lineCount
                    filtered: lines(options: { filter: { quantity: { eq: 2 } } }) { totalItems }
                    all: lines { totalItems }
                }
            }
        `);

        const returned = present(await shop.activeCustomerReorderList(ctx, { id: LIST_ID }, info));

        // Asserted BEFORE either field resolves, which is the discriminating observation: a request that
        // reconciled only in the field resolver's fallback would still end up with the corrected value, but not
        // yet - and the executor takes `lineCount` off this object at exactly this point.
        expect(returned.lineCount).toBe(1);
        expect(service.getLinesForLists).toHaveBeenCalledTimes(1);

        // The executor then resolves both aliases; each computes its own window.
        const filtered = await entity.lines(ctx, returned, linesArgs({ filter: { quantity: { eq: 2 } } }));
        const all = await entity.lines(ctx, returned, linesArgs());

        expect(filtered.totalItems).toBe(1);
        expect(all.totalItems).toBe(1);
        // Two loads in total: the pre-resolved unfiltered page, plus the filtered alias's own. The unfiltered
        // alias added none, having been served from the cache.
        expect(service.getLinesForLists).toHaveBeenCalledTimes(2);
        // And exactly one compare-and-set for the request: the filtered alias publishes no authoritative
        // total, so it cannot repair, and the unfiltered one was already reconciled before the parent was
        // exposed.
        expect(service.reconcileLineCount).toHaveBeenCalledTimes(1);
        expect(returned.lineCount).toBe(1);
    });

    it('finds an unfiltered alias that a filtered one precedes inside a fragment', async () => {
        const info = infoFor(`
            query Q($id: ID!) { activeCustomerReorderList(id: $id) { ...Windows } }
            fragment Windows on ReorderList {
                lineCount
                narrowed: lines(options: { filter: { quantity: { eq: 2 } } }) { totalItems }
                ...Whole
            }
            fragment Whole on ReorderList { whole: lines { totalItems } }
        `);

        const returned = present(await shop.activeCustomerReorderList(ctxFor(), { id: LIST_ID }, info));

        expect(returned.lineCount).toBe(1);
        expect(service.getLinesForLists).toHaveBeenCalledTimes(1);
        expect(service.getLinesForLists.mock.calls[0][2]).toEqual({ take: DEFAULT_LINES_PAGE_SIZE });
        expect(service.reconcileLineCount).toHaveBeenCalledTimes(1);
    });

    it('finds an unfiltered alias inside an inline fragment behind a filtered one', async () => {
        const info = infoFor(`
            query Q($id: ID!) {
                activeCustomerReorderList(id: $id) {
                    lineCount
                    narrowed: lines(options: { filterOperator: OR }) { totalItems }
                    ... on ReorderList { whole: lines(options: { take: 5 }) { totalItems } }
                }
            }
        `);

        const returned = present(await shop.activeCustomerReorderList(ctxFor(), { id: LIST_ID }, info));

        // A `filterOperator` alone counts as narrowing - it can only have been sent to combine filters - so
        // the first occurrence is declined and the inline fragment's window is the one used.
        expect(returned.lineCount).toBe(1);
        expect(service.getLinesForLists).toHaveBeenCalledTimes(1);
        expect(service.getLinesForLists.mock.calls[0][2]).toEqual({ take: 5 });
    });

    it('passes over an unfiltered alias the document skipped and uses the next one', async () => {
        const info = infoFor(
            `query Q($id: ID!, $skip: Boolean!) {
                activeCustomerReorderList(id: $id) {
                    lineCount
                    hidden: lines(options: { take: 7 }) @skip(if: $skip) { totalItems }
                    shown: lines(options: { take: 9 }) { totalItems }
                }
            }`,
            { id: LIST_ID, skip: true },
        );

        const returned = present(await shop.activeCustomerReorderList(ctxFor(), { id: LIST_ID }, info));

        // The skipped occurrence is not part of the request, so its window must not be the one pre-resolved -
        // that would load a page the response never carries and leave the executed alias to repair too late.
        expect(service.getLinesForLists).toHaveBeenCalledTimes(1);
        expect(service.getLinesForLists.mock.calls[0][2]).toEqual({ take: 9 });
        expect(returned.lineCount).toBe(1);
    });

    it('honours @include(if: false) the same way, taking the alias that will actually run', async () => {
        const info = infoFor(
            `query Q($id: ID!, $withNarrowed: Boolean!) {
                activeCustomerReorderList(id: $id) {
                    lineCount
                    excluded: lines(options: { take: 3 }) @include(if: $withNarrowed) { totalItems }
                    included: lines(options: { take: 4 }) { totalItems }
                }
            }`,
            { id: LIST_ID, withNarrowed: false },
        );

        const returned = present(await shop.activeCustomerReorderList(ctxFor(), { id: LIST_ID }, info));

        expect(service.getLinesForLists).toHaveBeenCalledTimes(1);
        expect(service.getLinesForLists.mock.calls[0][2]).toEqual({ take: 4 });
        expect(returned.lineCount).toBe(1);
    });

    it('issues one compare-and-set when two unfiltered aliases ask for different windows', async () => {
        const ctx = ctxFor();
        const info = infoFor(`
            query Q($id: ID!) {
                activeCustomerReorderList(id: $id) {
                    lineCount
                    first: lines(options: { take: 2 }) { totalItems }
                    second: lines(options: { take: 6 }) { totalItems }
                }
            }
        `);

        const returned = present(await shop.activeCustomerReorderList(ctx, { id: LIST_ID }, info));
        await entity.lines(ctx, returned, linesArgs({ take: 2 }));
        await entity.lines(ctx, returned, linesArgs({ take: 6 }));

        // Which unfiltered window is chosen cannot change the reconciled value, because every unfiltered
        // window reports the same unfiltered total. The second alias loads its own page and then finds stored
        // and observed already in agreement, so it issues no further statement.
        expect(returned.lineCount).toBe(1);
        expect(service.reconcileLineCount).toHaveBeenCalledTimes(1);
        expect(service.getLinesForLists).toHaveBeenCalledTimes(2);
    });
});

describe('eligibility for the repair is decided by object identity', () => {
    let service: ServiceDouble;
    let shop: ReorderListShopResolver;
    let entity: ReorderListEntityResolver;
    let row: ReorderList;

    beforeEach(() => {
        row = listRow(3);
        service = serviceDoubleFor(row);
        shop = shopResolverFor(service);
        entity = entityResolverFor(service);
    });

    it('never licenses or repairs an object the collection read produced', async () => {
        // Same row identifier, different object - which is what a page of lists hydrates.
        const collectionEntry = listRow(3);

        const page = await entity.lines(ctxFor(), collectionEntry, linesArgs());

        expect(page.totalItems).toBe(1);
        expect(singleListReadMarked(collectionEntry)).toBe(false);
        expect(service.reconcileLineCount).not.toHaveBeenCalled();
        expect(collectionEntry.lineCount).toBe(3);
    });

    it('does not depend on which RequestContext instance the field resolver receives', async () => {
        const rootCtx = ctxFor();
        const fieldCtx = ctxFor();
        // No `lines` selection, so nothing is pre-resolved and the field resolver takes the fallback - the
        // path on which a context-keyed licence would have been looked for and not found.
        const info = infoFor(`query Q($id: ID!) { activeCustomerReorderList(id: $id) { id lineCount } }`);

        const returned = present(await shop.activeCustomerReorderList(rootCtx, { id: LIST_ID }, info));
        await entity.lines(fieldCtx, returned, linesArgs());

        expect(service.reconcileLineCount).toHaveBeenCalledTimes(1);
        expect(returned.lineCount).toBe(1);
    });

    it('issues one compare-and-set for concurrent fallback resolutions of one object', async () => {
        const ctx = ctxFor();
        const info = infoFor(`query Q($id: ID!) { activeCustomerReorderList(id: $id) { id lineCount } }`);
        const returned = present(await shop.activeCustomerReorderList(ctx, { id: LIST_ID }, info));

        // Two sibling fields of one object, started together as the executor starts them.
        await Promise.all([
            entity.lines(ctx, returned, linesArgs()),
            entity.lines(ctx, returned, linesArgs()),
        ]);

        expect(service.reconcileLineCount).toHaveBeenCalledTimes(1);
        expect(returned.lineCount).toBe(1);
    });

    it('carries no licence, gate or cached page from one request into the next', async () => {
        const document = `query Q($id: ID!) { activeCustomerReorderList(id: $id) { lineCount lines { totalItems } } }`;

        // Request one: a stale row, reconciled and repaired once.
        const first = listRow(3);
        service.getReorderList.mockResolvedValueOnce(first);
        await shop.activeCustomerReorderList(ctxFor(), { id: LIST_ID }, infoFor(document));
        expect(first.lineCount).toBe(1);
        expect(service.reconcileLineCount).toHaveBeenCalledTimes(1);

        // Request two: a DIFFERENT object for the same row, now storing the corrected value. It inherits
        // nothing, is reconciled on its own merits, and issues no repair because the counter now agrees.
        const second = listRow(1);
        service.getReorderList.mockResolvedValueOnce(second);
        const returned = present(
            await shop.activeCustomerReorderList(ctxFor(), { id: LIST_ID }, infoFor(document)),
        );
        expect(returned).toBe(second);
        expect(second.lineCount).toBe(1);
        expect(service.reconcileLineCount).toHaveBeenCalledTimes(1);
        expect(singleListReadMarked(second)).toBe(true);

        // Its nested field is served from ITS OWN pre-resolved page - a third context instance and a
        // different resolver instance, because the cache is keyed on the row object and on nothing else.
        const page = await entityResolverFor(service).lines(ctxFor(), second, linesArgs());
        expect(page.totalItems).toBe(1);
        expect(service.getLinesForLists).toHaveBeenCalledTimes(2);
    });

    it('licenses nothing when the read resolves to null', async () => {
        const nullService = serviceDoubleFor(null);
        const nullShop = shopResolverFor(nullService);
        const info = infoFor(
            `query Q($id: ID!) { activeCustomerReorderList(id: $id) { lineCount lines { totalItems } } }`,
        );

        const returned = await nullShop.activeCustomerReorderList(ctxFor(), { id: LIST_ID }, info);

        // A null result licenses nothing because there is no object to license, and nothing is read.
        expect(returned).toBeNull();
        expect(nullService.getLinesForLists).not.toHaveBeenCalled();
        expect(nullService.reconcileLineCount).not.toHaveBeenCalled();
    });
});

describe('the per-page contracts the reconciliation must not have disturbed', () => {
    async function linesForPageOf(size: number): Promise<{ loads: number; repairs: number }> {
        const service = serviceDoubleFor(null);
        const entity = entityResolverFor(service);
        const ctx = ctxFor();
        const parents = Array.from({ length: size }, (_unused, index) =>
            listRow(1, `T_${String(index + 1)}`),
        );

        // Started synchronously for the whole page, exactly as the executor starts them.
        await Promise.all(parents.map(parent => entity.lines(ctx, parent, linesArgs())));

        return {
            loads: service.getLinesForLists.mock.calls.length,
            repairs: service.reconcileLineCount.mock.calls.length,
        };
    }

    it('loads one page of lines per page of lists, whatever the page holds', async () => {
        const three = await linesForPageOf(3);
        const six = await linesForPageOf(6);

        expect(three.loads).toBe(1);
        expect(six.loads).toBe(1);
        // Equal, not merely small: this is the assertion STORY-001-01-04 makes across a page of three lists
        // and a page of six.
        expect(six.loads).toBe(three.loads);
    });

    it('repairs no counter from the collection path, at either page size', async () => {
        const three = await linesForPageOf(3);
        const six = await linesForPageOf(6);

        expect(three.repairs).toBe(0);
        expect(six.repairs).toBe(0);
    });

    it('resolves viewerAccess without reading anything', () => {
        const service = serviceDoubleFor(null);
        const entity = entityResolverFor(service);

        const access = entity.viewerAccess(ctxFor(), listRow(1));

        expect(access).toEqual({ access: 'OWNED', grantedCapabilities: [] });
        expect(service.getViewerAccess).toHaveBeenCalledTimes(1);
        expect(service.getLinesForLists).not.toHaveBeenCalled();
        expect(service.reconcileLineCount).not.toHaveBeenCalled();
    });
});

/*
 * The resolve-info parameter is the one signature change the reconciliation required, and a parameter
 * decorator that landed on the wrong index would bind a resolver's arguments to the wrong values at run time
 * while compiling perfectly. These read the metadata the decorators actually wrote: `@nestjs/common` and
 * `@nestjs/graphql` share one parameter bag, defined on the CLASS and keyed by method name, whose own keys are
 * `<paramtype>:<index>`. The paramtype is a `GqlParamtype` ordinal for the graphql decorators, and a
 * uid-prefixed `__customRouteArgs__` token for anything built with `createParamDecorator` - which is how
 * Vendure's own `@Ctx()` is built.
 */
describe('the resolver parameter bindings the reconciliation depends on', () => {
    const PARAM_ARGS = '__routeArguments__';
    const RESOLVER_TYPE = 'graphql:resolver_type';
    const RESOLVER_PROPERTY = 'graphql:resolve_property';
    const PARAMTYPE_NAMES: Record<string, string> = {
        '0': 'parent',
        '1': 'context',
        '2': 'info',
        '3': 'args',
    };

    function bindingsOf(target: NewableFunction, method: string): string[] {
        const declared: Record<string, { index: number }> =
            (Reflect.getMetadata(PARAM_ARGS, target, method) as Record<string, { index: number }>) ?? {};
        return Object.entries(declared)
            .sort(([, left], [, right]) => left.index - right.index)
            .map(([key, entry]) => {
                const paramtype = key.slice(0, key.lastIndexOf(':'));
                const named = paramtype.includes('__customRouteArgs__')
                    ? 'ctx'
                    : (PARAMTYPE_NAMES[paramtype] ?? paramtype);
                return `${String(entry.index)}:${named}`;
            });
    }

    it('binds ctx, args and info on the single-list read, in that order', () => {
        expect(bindingsOf(ReorderListShopResolver, 'activeCustomerReorderList')).toEqual([
            '0:ctx',
            '1:args',
            '2:info',
        ]);
        expect(
            Reflect.getMetadata(
                RESOLVER_TYPE,
                methodOf(ReorderListShopResolver, 'activeCustomerReorderList'),
            ),
        ).toBe('Query');
    });

    it('leaves the collection read and every mutation on two bindings', () => {
        for (const method of [
            'activeCustomerReorderLists',
            'createReorderList',
            'updateReorderList',
            'deleteReorderList',
            'addItemToReorderList',
            'adjustReorderListLine',
            'removeReorderListLine',
        ]) {
            expect(bindingsOf(ReorderListShopResolver, method)).toEqual(['0:ctx', '1:args']);
        }
        expect(
            Reflect.getMetadata(RESOLVER_TYPE, methodOf(ReorderListShopResolver, 'createReorderList')),
        ).toBe('Mutation');
    });

    it('keeps the entity resolver field bindings, including its second parent type', () => {
        expect(bindingsOf(ReorderListEntityResolver, 'lines')).toEqual(['0:ctx', '1:parent', '2:args']);
        expect(bindingsOf(ReorderListEntityResolver, 'viewerAccess')).toEqual(['0:ctx', '1:parent']);
        expect(bindingsOf(ReorderListEntityResolver, 'productVariant')).toEqual(['0:ctx', '1:parent']);
        expect(
            Reflect.getMetadata(RESOLVER_PROPERTY, methodOf(ReorderListEntityResolver, 'productVariant')),
        ).toBe(true);
        expect(
            Reflect.getMetadata(RESOLVER_TYPE, methodOf(ReorderListEntityResolver, 'productVariant')),
        ).toBe('ReorderListLine');
        expect(Reflect.getMetadata(RESOLVER_TYPE, ReorderListEntityResolver)).toBe('ReorderList');
    });

    it('declares no field resolver for lineCount, which is the stored column', () => {
        expect(Reflect.getMetadata(PARAM_ARGS, ReorderListEntityResolver, 'lineCount')).toBeUndefined();
        expect(Object.getOwnPropertyNames(ReorderListEntityResolver.prototype)).not.toContain('lineCount');
    });
});
