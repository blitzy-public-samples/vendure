/**
 * The package root barrel, and the whole of `@vendure/reorder-plugin`'s public surface.
 *
 * EPIC-001 ruling R22 requires every configurable symbol of a plugin to be reachable from the package root
 * and proves it with a static import from that root rather than from a deep path, so this file — not the
 * modules beneath it — decides what a consumer can name. `tsconfig.build.json` compiles `files: ["./index.ts"]`,
 * which makes the decision doubly consequential: anything unreachable from here is never emitted into `lib/`
 * at all.
 *
 * Exactly four symbols are published, and they are named individually rather than re-exported wholesale.
 * `export *` re-exports every exported member of each module, and the four modules below between them export
 * seven: alongside the four intended symbols it would also publish `resolveReorderListNameKeyCollation`
 * (an entity-level collation helper), `ResolvedReorderPluginOptions` (the internal fully-defaulted view of
 * the options) and `ReorderPluginConfigurationError` (the startup validator's error class). None of the three
 * is part of the contract a consumer configures the plugin through, and a symbol published by accident is a
 * symbol that cannot be changed without a breaking-change note.
 *
 * Deliberately NOT exported, because the contract does not include them: the service, any resolver, the
 * `REORDER_PLUGIN_OPTIONS` injection token, `MAX_LIST_NAME_LENGTH`, the `shopApiExtensions` document, the
 * migration, and any strategy interface or default implementation — this feature declares none.
 *
 * Nothing under `src/` may import from this file. The barrel is the build entry, so an internal module
 * importing it would close a cycle through the package's own entry point; every symbol the package needs
 * internally is reached by relative path instead, which is how its consumers already import it.
 */
export { ReorderListLine } from './src/entities/reorder-list-line.entity';
export { ReorderList } from './src/entities/reorder-list.entity';
export { ReorderPlugin } from './src/reorder.plugin';
export type { ReorderPluginOptions } from './src/types';
