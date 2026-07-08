import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Component tests for the seller-detail performance-score block. The real component is
 * rendered with `renderToStaticMarkup` (the lightweight, `@testing-library`-free
 * convention used by the in-repo `packages/dashboard/**\/page-layout.spec.tsx`) and its
 * dependencies are stubbed with `vi.mock`. `@tanstack/react-query`'s `useQuery` is driven
 * to each state (pending / error / null-score / scored / flagged) and the query options
 * are captured so the `queryFn` closure can be invoked directly.
 */
// All mutable state referenced inside `vi.mock` factories must live in a `vi.hoisted`
// block: `vi.mock` calls are hoisted above ordinary top-level declarations, so a plain
// `const`/`let` would be in its temporal dead zone when the factory first runs.
const h = vi.hoisted(() => ({
    query: { data: undefined as any, isPending: false, isError: false },
    queryOptions: null as any,
    apiQuery: vi.fn(),
}));

vi.mock('@tanstack/react-query', () => ({
    useQuery: (opts: any) => {
        h.queryOptions = opts;
        return h.query;
    },
}));
vi.mock('@lingui/react/macro', () => ({
    Trans: ({ children }: any) => createElement('span', null, children),
    useLingui: () => ({ t: (s: any) => (Array.isArray(s) ? s.join('') : s) }),
}));
vi.mock('@/graphql/operations', () => ({ getSellerScoreDocument: { __doc: 'GetSellerScore' } }));
vi.mock('recharts', () => {
    const P = ({ children }: any) => createElement('div', null, children);
    return { CartesianGrid: P, Line: P, LineChart: P, XAxis: P, YAxis: P };
});
vi.mock('@vendure/dashboard', () => {
    const Passthrough = ({ children }: any) => createElement('div', null, children);
    return {
        Alert: ({ children, variant }: any) =>
            createElement('div', { 'data-slot': 'alert', 'data-variant': variant ?? 'default' }, children),
        AlertTitle: ({ children }: any) => createElement('div', { 'data-slot': 'alert-title' }, children),
        AlertDescription: ({ children }: any) => createElement('div', null, children),
        Badge: ({ children, variant }: any) =>
            createElement('span', { 'data-slot': 'badge', 'data-variant': variant }, children),
        Progress: ({ value }: any) => createElement('div', { 'data-slot': 'progress', 'data-value': value }),
        Tabs: Passthrough,
        TabsContent: Passthrough,
        TabsList: Passthrough,
        TabsTrigger: Passthrough,
        ChartContainer: Passthrough,
        ChartTooltip: Passthrough,
        ChartTooltipContent: Passthrough,
        useLocalFormat: () => ({ formatDate: (d: any) => `DATE(${String(d)})` }),
        api: { query: h.apiQuery },
    };
});

// eslint-disable-next-line import/first
import { sellerScoreBlock } from './seller-score-block';

const Block = sellerScoreBlock.component as any;
const render = (ctx: any) => renderToStaticMarkup(createElement(Block, { context: ctx }));
const withSeller = { entity: { id: 'T_1' } };

beforeEach(() => {
    h.query = { data: undefined, isPending: false, isError: false };
    h.queryOptions = undefined;
    h.apiQuery.mockReset();
});
afterEach(() => vi.clearAllMocks());

describe('sellerScoreBlock definition', () => {
    it('targets the seller-detail page in the side column', () => {
        expect(sellerScoreBlock.id).toBe('seller-score');
        expect(sellerScoreBlock.location?.pageId).toBe('seller-detail');
        expect(sellerScoreBlock.location?.column).toBe('side');
    });
});

describe('SellerScoreBlockComponent states', () => {
    it('renders nothing for the create/new page (no seller id)', () => {
        const html = render({ entity: undefined });
        expect(html).toBe('');
    });

    it('renders nothing when the entity id is the literal "new"', () => {
        const html = render({ entity: { id: 'new' } });
        expect(html).toBe('');
    });

    it('renders a loading state while the query is pending', () => {
        h.query = { data: undefined, isPending: true, isError: false };
        expect(render(withSeller)).toContain('Loading');
    });

    it('renders a destructive error alert when the query fails (distinct from no-orders)', () => {
        h.query = { data: undefined, isPending: false, isError: true };
        const html = render(withSeller);
        expect(html).toContain('Unable to load performance score');
        expect(html).toContain('data-variant="destructive"');
        expect(html).not.toContain('no orders in the last 90 days');
    });

    it('renders the explicit null-score notice (never 0) for a seller with no orders', () => {
        h.query = { data: { sellerScore: null }, isPending: false, isError: false };
        const html = render(withSeller);
        expect(html).toContain('No score yet');
        expect(html).toContain('no orders in the last 90 days');
        expect(html).not.toContain('Unable to load performance score');
        // Default (non-destructive) variant — visually distinct from the error alert.
        expect(html).toContain('data-variant="default"');
    });

    it('renders a non-flagged score with breakdown, history chart and last-calculated time', () => {
        h.query = {
            data: {
                sellerScore: {
                    id: 'T_9',
                    sellerId: 'T_1',
                    score: 85,
                    fulfillmentSla: 0.8,
                    cancellationReturnRate: 0.1,
                    lastCalculatedAt: '2024-06-01T00:00:00.000Z',
                    flagged: false,
                    seller: { id: 'T_1', name: 'Acme' },
                    history: [
                        {
                            id: 'T_1',
                            score: 80,
                            fulfillmentSla: 0.75,
                            cancellationReturnRate: 0.15,
                            calculatedAt: '2024-05-01T00:00:00.000Z',
                        },
                    ],
                },
            },
            isPending: false,
            isError: false,
        };
        const html = render(withSeller);
        expect(html).toContain('85.0'); // formatScore
        expect(html).toContain('Composite score');
        expect(html).toContain('80.0%'); // fulfillmentSla via formatFractionAsPercent
        expect(html).toContain('10.0%'); // cancellationReturnRate
        expect(html).toContain('Last calculated');
        expect(html).toContain('DATE('); // formatDate used by chart + last-calculated
        // Non-flagged → secondary badge, no destructive flag alert.
        expect(html).toContain('data-variant="secondary"');
        expect(html).not.toContain('flagged for review');
    });

    it('renders the flagged treatment (destructive badge + flag alert) when flagged', () => {
        h.query = {
            data: {
                sellerScore: {
                    id: 'T_9',
                    sellerId: 'T_1',
                    score: 40,
                    fulfillmentSla: 0.5,
                    cancellationReturnRate: 0.4,
                    lastCalculatedAt: null,
                    flagged: true,
                    seller: null,
                    history: [],
                },
            },
            isPending: false,
            isError: false,
        };
        const html = render(withSeller);
        expect(html).toContain('40.0');
        expect(html).toContain('flagged for review');
        expect(html).toContain('data-variant="destructive"');
        // lastCalculatedAt null → "Never calculated"; empty history → "No history yet".
        expect(html).toContain('Never calculated');
        expect(html).toContain('No history yet');
    });
});

describe('defensive coalescing on a scored seller', () => {
    it('renders 0% metric bars for null fractions and no-history for an absent history', () => {
        h.query = {
            data: {
                sellerScore: {
                    id: 'T_9',
                    sellerId: 'T_1',
                    score: 50,
                    // Nullable per the schema: MetricBar must coalesce these to 0 (not crash).
                    fulfillmentSla: null,
                    cancellationReturnRate: null,
                    lastCalculatedAt: '2024-06-01T00:00:00.000Z',
                    flagged: false,
                    seller: { id: 'T_1', name: 'Acme' },
                    // Absent history exercises the `score.history ?? []` nullish coalescing.
                    history: undefined,
                },
            },
            isPending: false,
            isError: false,
        };
        const html = render(withSeller);
        expect(html).toContain('50.0');
        // Both metric bars coalesce a null fraction to 0.0%.
        expect(html).toContain('0.0%');
        // Undefined history → empty → "No history yet".
        expect(html).toContain('No history yet');
    });
});

describe('queryFn closure', () => {
    it('queries the Admin API with the seller id and returns the narrowed shape', async () => {
        h.query = { data: undefined, isPending: true, isError: false };
        render(withSeller);
        const expected = { sellerScore: { id: 'T_9', sellerId: 'T_1', score: 85 } };
        h.apiQuery.mockResolvedValue(expected);

        const result = await h.queryOptions.queryFn();

        expect(h.apiQuery).toHaveBeenCalledWith({ __doc: 'GetSellerScore' }, { sellerId: 'T_1' });
        expect(result).toEqual(expected);
        expect(h.queryOptions.enabled).toBe(true);
    });

    it('short-circuits to a null score when no seller id is present', async () => {
        render({ entity: undefined });
        const result = await h.queryOptions.queryFn();

        expect(result).toEqual({ sellerScore: null });
        expect(h.apiQuery).not.toHaveBeenCalled();
        expect(h.queryOptions.enabled).toBe(false);
    });
});
