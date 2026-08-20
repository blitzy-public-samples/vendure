/**
 * The package root barrel, and the **intended** public surface of `@vendure/reorder-plugin`.
 *
 * EPIC-001 ruling R22 requires every configurable symbol of a plugin to be reachable from the package root
 * and proves it with a static import from that root rather than from a deep path, so this file — not the
 * modules beneath it — decides what a consumer can name.
 *
 * **What this file decides is the public surface, and it is deliberately no longer what decides the build
 * output.** `tsconfig.build.json` names TWO entries in its `files` array: this barrel, and the one additive
 * migration under `src/migrations/`. The second entry exists because the two decisions are different ones and
 * conflating them shipped a package whose own README promised a migration the artefact did not contain: a
 * consumer installing `@vendure/reorder-plugin` receives only `lib/**` and `i18n/**`, and with this barrel as
 * the sole compiler entry the migration was never emitted into `lib/` and therefore never published. Naming it
 * as a second root emits it to `lib/src/migrations/` and publishes it regardless of what the barrel happens to
 * import, so the artefact no longer depends on the import graph below to carry a deployment file. The class
 * itself is reachable from the root only through `reorderPluginMigrations` below — the module under
 * `src/migrations/` is not re-exported, and anything else unreachable from here is still never emitted at all.
 *
 * **"Intended" is the accurate word, and the distinction is worth stating rather than glossing.** The
 * manifest's `files` allow-list publishes the whole compiled `lib` tree and the `i18n` directory, and the
 * package declares no `exports` map, so a deep specifier that names an emitted module under `lib/src` does
 * mechanically resolve for an installed consumer. Nothing here claims it cannot. What this barrel
 * defines is the surface that is documented, tested from the root, and covered by the package's
 * compatibility guarantees: a deep import reaches an internal module that may be renamed, split or removed
 * without a breaking-change note, and is unsupported for that reason rather than because it is blocked.
 *
 * Six symbols are published, and they are named individually rather than re-exported wholesale. `export *`
 * re-exports every exported member of each module, and the modules below between them export more: it would
 * also publish `resolveReorderListNameKeyCollation` (an entity-level collation helper),
 * `ResolvedReorderPluginOptions` (the internal fully-defaulted view of the options) and the migration class's
 * own timestamped identifier. None of those is part of the contract a consumer configures the plugin
 * through, and a symbol published by accident is a symbol that cannot be changed without a breaking-change
 * note.
 *
 * What is published, and why each one is here:
 *
 * - `ReorderPlugin` — the registration surface, and the one place option values enter the plugin.
 * - `ReorderPluginOptions` — the option contract, published with `export type` because it has no runtime
 *   binding.
 * - `ReorderPluginConfigurationError` — the error `ReorderPlugin.init()` throws for an unusable option
 *   value. It is published because the plugin's own documentation gives a consumer an `instanceof` path to
 *   it and links it from `@throws`; a documented error class that cannot be named from the root would be a
 *   promise the package does not keep.
 * - `reorderPluginMigrations` — the plugin's own migration classes, for
 *   `dbConnectionOptions.migrations`. Publishing the classes rather than a path is what makes registration
 *   correct in both layouts this package runs in: TypeORM accepts a migration class wherever it accepts a
 *   glob, so a deployment needs no path arithmetic over `src/` versus `lib/src/`. The emitted files remain
 *   available at `lib/src/migrations/` for a deployment that prefers globs.
 * - `ReorderList` and `ReorderListLine` — the two entity classes, so that a deployment can query them
 *   directly through the platform's connection.
 *
 * Deliberately NOT exported, because the contract does not include them: the service, any resolver, the
 * `REORDER_PLUGIN_OPTIONS` injection token, `MAX_LIST_NAME_LENGTH`, the `shopApiExtensions` document, and
 * any strategy interface or default implementation — this feature declares none.
 *
 * Nothing under `src/` may import from this file. The barrel is the package's entry point, so an internal
 * module importing it would close a cycle through that entry point; every symbol the package needs
 * internally is reached by relative path instead, which is how its consumers already import it.
 */
import { AddReorderLists1786838400000 } from './src/migrations/1786838400000-add-reorder-lists';

export { ReorderListLine } from './src/entities/reorder-list-line.entity';
export { ReorderList } from './src/entities/reorder-list.entity';
export { ReorderPlugin, ReorderPluginConfigurationError } from './src/reorder.plugin';
export type { ReorderPluginOptions } from './src/types';

/**
 * @description
 * The migration classes that create this plugin's two tables, for `dbConnectionOptions.migrations`.
 *
 * **Register this array on every supported engine.** The class in this array does not carry SQL for one
 * engine. It describes the two tables to TypeORM's `QueryRunner` table API — `createTable` over a `Table`
 * carrying its `TableIndex`, `TableUnique`, `TableCheck` and `TableForeignKey` members — and lets the
 * configured driver render the statements, so the identifier type comes from
 * `connection.driver.normalizeType()` over the configured `EntityIdStrategy` and the table path from
 * `connection.driver.buildTableName()` rather than from a literal baked in at generation time. There is no
 * `SERIAL`, no `character varying`, no `DEFAULT now()` and no hard-coded schema anywhere in it, which is
 * what lets one class apply and revert on PostgreSQL, MySQL, MariaDB and the SQLite family alike.
 *
 * One engine-scoped shortfall survives that portability and is declared rather than hidden. The two `CHK_`
 * constraints are described on every engine, but TypeORM 0.3.28 cannot produce a `CHECK` on the MySQL
 * family: `RdbmsSchemaBuilder.createNewChecks()` returns early for it, `MysqlQueryRunner`'s four check
 * methods throw, and `MysqlQueryRunner.createTableSql` never reads `table.checks`. On MySQL and MariaDB the
 * two named checks therefore do not exist, while both `UQ_` objects and the `IDX_` objects do — under their
 * exact names, as named unique indices. No behaviour depends on a check being present: the quantity
 * invariant is carried portably by the service's `UserInputError` and the `lineCount` invariant by the
 * conditional counter update together with the compare-and-set repair. The package README records the gap
 * with its code locations, and so does the migration's own header.
 *
 * @example
 * ```ts
 * import type { VendureConfig } from '\@vendure/core';
 * import { reorderPluginMigrations } from '\@vendure/reorder-plugin';
 *
 * export const config: VendureConfig = {
 *   dbConnectionOptions: {
 *     // ...your own entries stay where they are; add the plugin's beside them
 *     migrations: [...reorderPluginMigrations],
 *   },
 *   // ...
 * };
 * ```
 *
 * Register it before the first boot of a server that has `synchronize` enabled. `runMigrations` applies
 * every pending entry in `dbConnectionOptions.migrations`, and this class refuses to record itself against
 * a shape it did not author: a schema builder that has already created the two tables leaves the migration
 * comparing what it finds against the frozen minimum instead. The package README sets that sequencing out
 * step by step, and separates applying from rolling back.
 *
 * Classes rather than a glob, deliberately: TypeORM accepts either in the same option, and a class is
 * resolved by the module system rather than by the filesystem, so one registration is correct whether the
 * package is consumed from source in a monorepo or from its published `lib/` output. A glob would have to
 * name `src/migrations/*.ts` in the first layout and `lib/src/migrations/*.js` in the second.
 *
 * The array is ordered, and TypeORM additionally orders migrations by the timestamp in each class name, so
 * spreading it beside another project's migrations cannot reorder either set.
 *
 * @docsCategory core plugins/ReorderPlugin
 * @docsPage ReorderPlugin
 * @since 3.8.0
 */
export const reorderPluginMigrations = [AddReorderLists1786838400000];
