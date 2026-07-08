import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Component tests for the dedicated **Flagged Sellers** route and its data table.
 * Rendered with `renderToStaticMarkup` and `vi.mock`-ed dependencies (the in-repo
 * `page-layout.spec.tsx` convention). A `DataTable` stub invokes every column's `cell`
 * renderer (and the per-row action's `onClick`) so the column closures — score/metric
 * formatting, the seller-name fallback, the last-calculated branch, and the Recalculate
 * mutation trigger — are all exercised. React Query is mocked via `vi.hoisted` holders so
 * each spec can drive the query/mutation state and invoke the captured callbacks.
 */
const h = vi.hoisted(() => ({
    query: { data: undefined as any, isPending: false, isError: false },
    mutationPending: false,
    queryOpts: null as any,
    mutationOpts: null as any,
    mutate: vi.fn(),
    invalidate: vi.fn(),
    apiQuery: vi.fn(),
    apiMutate: vi.fn(),
    toastSuccess: vi.fn(),
    toastError: vi.fn(),
}));

vi.mock('@tanstack/react-query', () => ({
    useQuery: (opts: any) => {
        h.queryOpts = opts;
        return h.query;
    },
    useMutation: (opts: any) => {
        h.mutationOpts = opts;
        return { mutate: h.mutate, isPending: h.mutationPending };
    },
    useQueryClient: () => ({ invalidateQueries: h.invalidate }),
}));
vi.mock('@lingui/react/macro', () => ({
    Trans: ({ children }: any) => createElement('span', null, children),
    useLingui: () => ({ t: (s: any) => (Array.isArray(s) ? s.join('') : s) }),
}));
vi.mock('sonner', () => ({ toast: { success: h.toastSuccess, error: h.toastError } }));
vi.mock('@/graphql/operations', () => ({
    getFlaggedSellersDocument: { __doc: 'GetFlaggedSellers' },
    recalculateSellerScoreDocument: { __doc: 'RecalculateSellerScore' },
}));
vi.mock('@vendure/dashboard', () => {
    const Passthrough = ({ children }: any) => createElement('div', null, children);
    return {
        Alert: ({ children, variant }: any) =>
            createElement('div', { 'data-slot': 'alert', 'data-variant': variant ?? 'default' }, children),
        AlertTitle: ({ children }: any) => createElement('div', null, children),
        AlertDescription: ({ children }: any) => createElement('div', null, children),
        Badge: ({ children, variant }: any) =>
            createElement('span', { 'data-slot': 'badge', 'data-variant': variant }, children),
        Button: ({ children, onClick, disabled }: any) =>
            createElement('button', { onClick, disabled: disabled ? 'true' : undefined }, children),
        Progress: ({ value }: any) => createElement('div', { 'data-slot': 'progress', 'data-value': value }),
        Page: Passthrough,
        PageBlock: Passthrough,
        PageTitle: Passthrough,
        useLocalFormat: () => ({ formatDate: (d: any) => `DATE(${String(d)})` }),
        api: { query: h.apiQuery, mutate: h.apiMutate },
        // Render header + every cell for every row, exercising all column closures. Any
        // returned cell element carrying an `onClick` (the Recalculate action) is invoked
        // so its handler closure is covered too.
        DataTable: ({ columns, data, isLoading }: any) =>
            createElement(
                'div',
                { 'data-slot': 'data-table', 'data-loading': String(isLoading) },
                ...columns.map((col: any, ci: number) =>
                    createElement(
                        'div',
                        { key: `h-${ci}`, 'data-slot': 'header' },
                        typeof col.header === 'string' ? col.header : null,
                    ),
                ),
                ...data.flatMap((rowData: any, ri: number) =>
                    columns.map((col: any, ci: number) => {
                        const cellEl =
                            typeof col.cell === 'function' ? col.cell({ row: { original: rowData } }) : null;
                        if (cellEl && cellEl.props && typeof cellEl.props.onClick === 'function') {
                            cellEl.props.onClick();
                        }
                        return createElement('div', { key: `${ri}-${ci}` }, cellEl);
                    }),
                ),
            ),
    };
});

// eslint-disable-next-line import/first
import { flaggedSellersList } from './flagged-sellers-list';

const Route = flaggedSellersList.component as any;
const render = () => renderToStaticMarkup(createElement(Route, {}));

const ROWS = [
    {
        id: 'T_1',
        sellerId: 'T_1',
        seller: { id: 'T_1', name: 'Acme' },
        score: 40,
        fulfillmentSla: 0.5,
        cancellationReturnRate: null, // metricToPercent null → 0
        lastCalculatedAt: '2024-06-01T00:00:00.000Z',
        flagged: true,
    },
    {
        id: 'T_2',
        sellerId: 'T_2',
        seller: null, // → sellerId fallback
        score: null, // → '—'
        fulfillmentSla: 1.5, // metricToPercent > 100 → clamp 100
        cancellationReturnRate: -0.5, // metricToPercent < 0 → clamp 0
        lastCalculatedAt: null, // → "Never"
        flagged: true,
    },
];

beforeEach(() => {
    h.query = { data: undefined, isPending: false, isError: false };
    h.mutationPending = false;
    h.queryOpts = null;
    h.mutationOpts = null;
    h.mutate.mockReset();
    h.invalidate.mockReset();
    h.apiQuery.mockReset();
    h.apiMutate.mockReset();
    h.toastSuccess.mockReset();
    h.toastError.mockReset();
});
afterEach(() => vi.clearAllMocks());

describe('flaggedSellersList route definition', () => {
    it('is mounted at /flagged-sellers with a ReadSeller-gated nav item', () => {
        expect(flaggedSellersList.path).toBe('/flagged-sellers');
        expect(flaggedSellersList.navMenuItem?.requiresPermission).toEqual(['ReadSeller']);
        expect(flaggedSellersList.navMenuItem?.url).toBe('/flagged-sellers');
    });

    it('exposes a breadcrumb loader', () => {
        // `DashboardRouteDefinition.loader` is a TanStack Router union (a loader function OR
        // a loader object), so narrow to the callable arm via `typeof` before invoking it.
        const loader = flaggedSellersList.loader;
        expect(typeof loader === 'function' ? loader({} as any) : undefined).toEqual({
            breadcrumb: 'Flagged sellers',
        });
    });
});

describe('FlaggedSellersTable states', () => {
    it('renders the healthy empty state on a successful empty response', () => {
        h.query = { data: { flaggedSellers: [] }, isPending: false, isError: false };
        const html = render();
        expect(html).toContain('No sellers are currently flagged');
        expect(html).not.toContain('Unable to load flagged sellers');
    });

    it('renders a destructive error alert with a Refresh action when the query fails', () => {
        h.query = { data: undefined, isPending: false, isError: true };
        const html = render();
        expect(html).toContain('Unable to load flagged sellers');
        expect(html).toContain('data-variant="destructive"');
        expect(html).toContain('Refresh');
        expect(html).not.toContain('No sellers are currently flagged');
    });

    it('renders the data table (loading) while the query is pending', () => {
        h.query = { data: undefined, isPending: true, isError: false };
        const html = render();
        expect(html).toContain('data-slot="data-table"');
        expect(html).toContain('data-loading="true"');
    });

    it('renders a row per flagged seller and exercises every column cell renderer', () => {
        h.query = { data: { flaggedSellers: ROWS }, isPending: false, isError: false };
        const html = render();
        // Column headers.
        expect(html).toContain('Seller');
        expect(html).toContain('Current score');
        expect(html).toContain('Fulfillment SLA');
        expect(html).toContain('Cancellation / return rate');
        expect(html).toContain('Last calculated');
        expect(html).toContain('Actions');
        // seller name and sellerId fallback.
        expect(html).toContain('Acme');
        expect(html).toContain('T_2');
        // score formatting and the null '—'.
        expect(html).toContain('40.0');
        expect(html).toContain('—');
        // metricToPercent: 0.5 → 50.0%, null → 0.0%, 1.5 clamps to 100.0%, -0.5 clamps to 0.0%.
        expect(html).toContain('50.0%');
        expect(html).toContain('100.0%');
        expect(html).toContain('0.0%');
        // last-calculated present (formatted) and the null "Never" branch.
        expect(html).toContain('DATE(');
        expect(html).toContain('Never');
        // per-row Recalculate action.
        expect(html).toContain('Recalculate');
        // The stub invoked each action cell's onClick → recalculate.mutate({ sellerId }).
        expect(h.mutate).toHaveBeenCalledWith({ sellerId: 'T_1' });
        expect(h.mutate).toHaveBeenCalledWith({ sellerId: 'T_2' });
    });
});

describe('recalculate mutation wiring', () => {
    beforeEach(() => {
        h.query = { data: { flaggedSellers: ROWS }, isPending: false, isError: false };
        render(); // triggers useQuery + useMutation, capturing their options
    });

    it('mutationFn calls the Admin API recalculate mutation with the variables', async () => {
        h.apiMutate.mockResolvedValue({ recalculateSellerScore: { id: 'T_1' } });
        await h.mutationOpts.mutationFn({ sellerId: 'T_1' });
        expect(h.apiMutate).toHaveBeenCalledWith({ __doc: 'RecalculateSellerScore' }, { sellerId: 'T_1' });
    });

    it('onSuccess toasts success and invalidates the flagged-sellers query', () => {
        h.mutationOpts.onSuccess();
        expect(h.toastSuccess).toHaveBeenCalledTimes(1);
        expect(h.invalidate).toHaveBeenCalledWith({ queryKey: ['flaggedSellers'] });
    });

    it('onError toasts a failure message', () => {
        h.mutationOpts.onError();
        expect(h.toastError).toHaveBeenCalledTimes(1);
    });

    it('the list query loads via api.query(getFlaggedSellersDocument)', () => {
        h.apiQuery.mockResolvedValue({ flaggedSellers: [] });
        void h.queryOpts.queryFn();
        expect(h.apiQuery).toHaveBeenCalledWith({ __doc: 'GetFlaggedSellers' });
    });
});
