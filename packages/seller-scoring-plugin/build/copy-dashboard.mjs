/* eslint-disable no-console */
// @ts-check
/**
 * Build helper: copy the dashboard extension SOURCE into the package build output.
 *
 * WHY THIS EXISTS
 * ---------------
 * The `@vendure/dashboard` Vite plugin consumes a plugin's dashboard extension from the
 * `.tsx`/`.ts` SOURCE it discovers via the plugin's `@VendurePlugin({ dashboard })`
 * metadata — it does not consume compiled JS. In the built package, the compiled plugin
 * class lives at `lib/src/seller-scoring.plugin.js` and declares
 * `dashboard: '../dashboard/index.tsx'`, which the dashboard tooling resolves RELATIVE TO
 * THE COMPILED PLUGIN FILE, i.e. to `lib/dashboard/index.tsx`.
 *
 * `tsc -p tsconfig.build.json` compiles only the backend import graph rooted at
 * `index.ts` (it emits `lib/index.js` + `lib/src/**`). The dashboard entry is referenced
 * ONLY as a decorator string — it is never `import`ed by `index.ts` — so tsc never emits
 * it. Without this step the built/published package would omit the dashboard extension and
 * `lib/dashboard/index.tsx` would not exist, breaking the self-contained-plugin
 * requirement and the Admin dashboard surfacing deliverable.
 *
 * This script therefore copies the dashboard source tree verbatim to `lib/dashboard/**`
 * (after tsc) so the compiled decorator path resolves and the package `files`
 * whitelist (`lib/**\/*`) ships it. It uses only Node built-ins (no extra dependency) and
 * is cross-platform.
 *
 * Excluded from the copy: co-located component specs (`*.spec.tsx` / `*.spec.ts`) and the
 * dev-only `tsconfig.json` — none are needed by the dashboard build and should not be
 * shipped.
 */
import { cpSync, existsSync, statSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceDir = resolve(packageRoot, 'dashboard');
const outputDir = resolve(packageRoot, 'lib', 'dashboard');

if (!existsSync(sourceDir)) {
    console.error(`[copy-dashboard] dashboard source directory not found: ${sourceDir}`);
    process.exit(1);
}

/**
 * Filter passed to `fs.cpSync`. Directories are always traversed; individual files are
 * skipped when they are specs or the dev-only tsconfig.
 *
 * @param {string} src absolute path of the item being considered for copy
 * @returns {boolean} true to copy the item, false to skip it
 */
function shouldCopy(src) {
    if (statSync(src).isDirectory()) {
        return true;
    }
    const name = basename(src);
    if (name.endsWith('.spec.tsx') || name.endsWith('.spec.ts') || name === 'tsconfig.json') {
        return false;
    }
    return true;
}

cpSync(sourceDir, outputDir, { recursive: true, filter: shouldCopy });
console.log(`[copy-dashboard] copied dashboard extension source -> ${outputDir}`);
