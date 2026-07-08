import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Component tests for the dashboard-home flagged-sellers summary widget. Rendered with
 * `renderToStaticMarkup` and `vi.mock`-ed dependencies (the in-repo `page-layout.spec.tsx`
 * convention). `useQuery` is driven to each state and its options captured so the `queryFn`
 * closure can be invoked.
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
}));
vi.mock('./graphql/operations', () => ({ getFlaggedSellersDocument: { __doc: 'GetFlaggedSellers' } }));
vi.mock('@vendure/dashboard', () => ({
    Alert: ({ children, variant }: any) =>
        createElement('div', { 'data-slot': 'alert', 'data-variant': variant ?? 'default' }, children),
    AlertTitle: ({ children }: any) => createElement('div', null, children),
    AlertDescription: ({ children }: any) => createElement('div', null, children),
    Badge: ({ children, variant }: any) =>
        createElement('span', { 'data-slot': 'badge', 'data-variant': variant }, children),
    DashboardBaseWidget: ({ children, title }: any) =>
        createElement('div', { 'data-slot': 'widget', 'data-title': title }, children),
    api: { query: h.apiQuery },
}));

// eslint-disable-next-line import/first
import { sellerScoreWidget } from './seller-score-widget';

const Widget = sellerScoreWidget.component as any;
const render = () => renderToStaticMarkup(createElement(Widget, {}));

beforeEach(() => {
    h.query = { data: undefined, isPending: false, isError: false };
    h.queryOptions = undefined;
    h.apiQuery.mockReset();
});
afterEach(() => vi.clearAllMocks());

describe('sellerScoreWidget definition', () => {
    it('is a ReadSeller-gated summary widget', () => {
        expect(sellerScoreWidget.id).toBe('flagged-sellers-widget');
        expect(sellerScoreWidget.requiresPermissions).toEqual(['ReadSeller']);
        expect(sellerScoreWidget.defaultSize).toEqual({ w: 3, h: 3 });
    });
});

describe('FlaggedSellersWidgetComponent states', () => {
    it('renders a loading state while pending', () => {
        h.query = { data: undefined, isPending: true, isError: false };
        expect(render()).toContain('Loading');
    });

    it('renders a destructive error alert when the query fails (never a healthy 0)', () => {
        h.query = { data: undefined, isPending: false, isError: true };
        const html = render();
        expect(html).toContain('Unable to load flagged sellers');
        expect(html).toContain('data-variant="destructive"');
        expect(html).not.toContain('No sellers flagged');
    });

    it('renders a healthy zero-count state (secondary badge) on a successful empty response', () => {
        h.query = { data: { flaggedSellers: [] }, isPending: false, isError: false };
        const html = render();
        expect(html).toContain('No sellers flagged');
        expect(html).toContain('data-variant="secondary"');
        expect(html).toContain('>0<'); // the count badge renders 0
        expect(html).not.toContain('Unable to load flagged sellers');
    });

    it('emphasises a non-zero count with a destructive badge', () => {
        h.query = {
            data: { flaggedSellers: [{ id: 'T_1' }, { id: 'T_2' }, { id: 'T_3' }] },
            isPending: false,
            isError: false,
        };
        const html = render();
        expect(html).toContain('flagged sellers');
        expect(html).toContain('data-variant="destructive"');
        expect(html).toContain('>3<'); // the count badge renders 3
    });
});

describe('queryFn closure', () => {
    it('queries the Admin API flaggedSellers document', () => {
        render();
        h.apiQuery.mockResolvedValue({ flaggedSellers: [] });
        void h.queryOptions.queryFn();
        expect(h.apiQuery).toHaveBeenCalledWith({ __doc: 'GetFlaggedSellers' });
    });
});
