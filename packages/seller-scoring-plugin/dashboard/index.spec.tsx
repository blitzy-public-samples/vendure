import { describe, expect, it, vi } from 'vitest';

/**
 * Unit test for the dashboard extension entry point. `defineDashboardExtension` is stubbed
 * to echo back its argument, and the three sibling surface definitions are mocked with
 * lightweight stubs (their real behaviour is covered by their own specs), so this test
 * asserts only the wiring: that the entry registers exactly the seller-score page block,
 * the Flagged Sellers route, and the summary widget.
 */
vi.mock('@vendure/dashboard', () => ({
    defineDashboardExtension: (config: any) => config,
}));
vi.mock('./seller-score-block', () => ({ sellerScoreBlock: { id: 'seller-score' } }));
vi.mock('./flagged-sellers-list', () => ({ flaggedSellersList: { path: '/flagged-sellers' } }));
vi.mock('./seller-score-widget', () => ({ sellerScoreWidget: { id: 'flagged-sellers-widget' } }));

// eslint-disable-next-line import/first
import dashboardExtension from './index';

describe('dashboard extension entry', () => {
    it('wires the seller-score block, flagged-sellers route and summary widget', () => {
        expect(dashboardExtension).toEqual({
            pageBlocks: [{ id: 'seller-score' }],
            routes: [{ path: '/flagged-sellers' }],
            widgets: [{ id: 'flagged-sellers-widget' }],
        });
    });
});
