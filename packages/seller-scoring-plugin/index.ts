/**
 * @vendure/seller-scoring-plugin
 *
 * Public API entry point (package barrel) for the Seller Performance Scoring plugin.
 *
 * This file is the module resolved by the package `main`/`types` fields
 * (`lib/index.js` / `lib/index.d.ts` after build) and is the single import
 * surface consumers use, e.g.:
 *
 * ```ts
 * import { SellerScoringPlugin } from '@vendure/seller-scoring-plugin';
 *
 * // ...
 * SellerScoringPlugin.init({ slaHours: 48, flaggingThreshold: 70 });
 * ```
 *
 * It contains only `export *` re-exports (no runtime logic), mirroring the
 * barrel convention used by Vendure's official plugins. The plugin's React
 * dashboard extension (`./dashboard/index.tsx`) is intentionally NOT re-exported
 * here: it is a separate compilation target referenced via the plugin's
 * `dashboard` metadata and is not part of the Node/TypeScript public API.
 */
export * from './src/constants';
export * from './src/entities/seller-score-snapshot.entity';
export * from './src/entities/seller-score.entity';
export * from './src/seller-scoring.plugin';
export * from './src/services/seller-scoring.service';
export * from './src/types';
