import { createElement, Fragment, type ReactNode } from 'react';

/**
 * @description
 * Catalog-free, runtime-only replacements for the `Trans` component and the
 * `useLingui` hook that the Seller Scoring dashboard extension uses for its
 * user-facing copy.
 *
 * ## Why this exists
 *
 * The `@vendure/dashboard` build compiles Lingui **macros** (`Trans` / the `t`
 * tagged template imported from `@lingui/react/macro`) in *generated-id* mode:
 * each message is replaced at build time with a short generated message id
 * (e.g. `UcvOnZ`) and the human-readable source text is looked up at runtime
 * from a **compiled catalog**. A plugin only gets such a catalog if it ships
 * `dashboard/i18n/*.po` files, which the dashboard's translations Vite plugin
 * discovers, compiles and merges (this is what the in-repo `reviews` plugin
 * does). This plugin intentionally ships **no** translation catalogs — the
 * feature specification requires the three dashboard surfaces and their
 * design-system components, not localisation. Without a catalog, every macro
 * message would render as its raw generated id (the score block, the Flagged
 * Sellers table headers, the Recalculate button, etc. would all display short
 * hashes instead of text).
 *
 * The dashboard's Lingui Babel transform is *import-gated*: it only processes a
 * file when that file imports from `@lingui/…/macro`. By importing `Trans` and
 * `useLingui` from **this** module instead, the plugin's dashboard components
 * opt out of the macro transform entirely and render their literal
 * source-English copy directly and deterministically — no catalog, no ids, no
 * build-pipeline coupling. Should localisation ever be required, these imports
 * can be pointed back at `@lingui/react/macro` and the matching `*.po`
 * catalogs added under `dashboard/i18n/`.
 *
 * The API surface below is intentionally limited to exactly what this plugin's
 * dashboard code uses: `<Trans>…</Trans>` with plain (already-localised) child
 * content, and `useLingui().t` used as a tagged template (with or without
 * interpolated values).
 *
 * @since 3.8.0
 */

/**
 * Renders its children verbatim. A drop-in for the Lingui `Trans` macro for
 * copy that is authored inline in the source language and needs no catalog
 * lookup. Children may be a plain string or a mix of strings and interpolated
 * nodes (e.g. `<Trans>Last calculated</Trans>` or `<Trans>Below {value}</Trans>`).
 */
export function Trans({ children }: { children?: ReactNode }): ReactNode {
    return createElement(Fragment, null, children);
}

/**
 * Tagged-template (and plain-call) message formatter. Mirrors the shape of the
 * value returned by the Lingui `useLingui` macro's `t` helper closely enough
 * for this plugin's usage: ``t`Recalculate` `` returns `"Recalculate"`, and
 * ``t`Score ${n}` `` interpolates the supplied values in order.
 */
function t(strings: TemplateStringsArray | string, ...values: unknown[]): string {
    if (typeof strings === 'string') {
        return strings;
    }
    return strings.reduce(
        (acc, part, index) => acc + part + (index < values.length ? String(values[index]) : ''),
        '',
    );
}

// A single, stable object so consumers can safely use `t` as a dependency in
// `useMemo`/`useCallback` without it changing identity between renders.
const linguiRuntime = { t } as const;

/**
 * Catalog-free replacement for the Lingui `useLingui` macro hook. Returns a
 * stable `{ t }` whose `t` formats tagged-template messages in the source
 * language.
 */
export function useLingui(): { t: typeof t } {
    return linguiRuntime;
}
