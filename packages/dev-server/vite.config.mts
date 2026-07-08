import { vendureDashboardPlugin } from '@vendure/dashboard/vite';
import path from 'path';
import { pathToFileURL } from 'url';
import { defineConfig } from 'vite';

// Workspace (monorepo) root — two levels up from packages/dev-server.
const repoRoot = path.resolve(__dirname, '../..');

export default defineConfig({
    base: '/dashboard/',
    build: {
        outDir: './dist/dashboard',
    },
    plugins: [
        vendureDashboardPlugin({
            vendureConfigPath: pathToFileURL('./dev-config.ts'),
            api: {
                host: 'http://localhost',
                port: Number(process.env.API_PORT) || 3000,
            },
            gqlOutputPath: path.resolve(__dirname, './graphql/'),
            // Monorepo path handling. The dev-server config lives at
            // packages/dev-server/dev-config.ts and imports workspace plugins (e.g. the
            // Seller Performance Scoring plugin) by RELATIVE path from sibling packages
            // such as packages/seller-scoring-plugin. By raising `sourceRoot` to the
            // workspace root, the dashboard compiler preserves each source file's path
            // relative to that root, so a sibling plugin's compiled output lands UNDER the
            // temporary output directory and is therefore discovered (its dashboard
            // extension gets bundled). `getCompiledConfigPath` mirrors this layout so the
            // compiled dev-config.js is still located during the config-load phase.
            // See the PathAdapter docs (@vendure/dashboard/vite) for monorepo guidance.
            pathAdapter: {
                sourceRoot: repoRoot,
                getCompiledConfigPath: ({ inputRootDir, outputPath, configFileName }) =>
                    path.join(outputPath, path.relative(repoRoot, inputRootDir), configFileName),
            },
        }),
    ],
});
