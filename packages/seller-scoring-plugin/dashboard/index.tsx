import { defineDashboardExtension } from '@vendure/dashboard';

import { flaggedSellersList } from './flagged-sellers-list';
import { sellerScoreBlock } from './seller-score-block';
import { sellerScoreWidget } from './seller-score-widget';

/**
 * @description
 * Dashboard extension entry point for the Seller Scoring plugin. Referenced by the plugin
 * via `dashboard: '../dashboard/index.tsx'` and compiled by the `@vendure/dashboard` Vite
 * plugin. It makes a single {@link defineDashboardExtension} call that wires together the
 * three UI surfaces the plugin contributes, each defined in its own sibling module:
 *
 * - `pageBlocks: [sellerScoreBlock]` — the seller-detail performance-score block showing a
 *   seller's current composite score, the per-metric breakdown, and its history (Flow 1).
 * - `routes: [flaggedSellersList]` — the dedicated **Flagged Sellers** route: a review list
 *   of every seller currently below the configured flagging threshold (Flow 2).
 * - `widgets: [sellerScoreWidget]` — the dashboard-home summary widget surfacing the count
 *   of currently flagged sellers for at-a-glance monitoring.
 *
 * This module is intentionally wiring-only: it contains no UI markup, GraphQL, or business
 * logic — all rendering and data access live in the imported sibling definitions.
 *
 * Registration happens as a side effect of evaluating this module: `defineDashboardExtension`
 * records the surfaces in the dashboard's global registry (it returns `void`), and the
 * `@vendure/dashboard` Vite plugin loads this entry via a side-effect dynamic `import(...)`.
 * The surfaces are therefore registered on load; the default export value itself is unused.
 *
 * @since 3.8.0
 */
export default defineDashboardExtension({
    pageBlocks: [sellerScoreBlock],
    routes: [flaggedSellersList],
    widgets: [sellerScoreWidget],
});
