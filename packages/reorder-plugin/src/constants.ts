/**
 * Module-level constants for `@vendure/reorder-plugin`.
 *
 * This module has no imports, by design. It is read by the plugin class, by the reorder-list
 * service and by the pure name-canonicalisation helpers, so keeping it dependency-free guarantees
 * that none of those modules can form an import cycle through it, and that a unit specification can
 * import a single value without pulling the platform in behind it. Every shipped first-party plugin
 * declares its constants the same way — see `packages/harden-plugin/src/constants.ts`.
 */

/**
 * @description
 * The logger context supplied to every `Logger` call this plugin makes. A stable context string is
 * what lets an operator filter the server log down to this plugin's output, and what lets them raise
 * or lower the log level for this plugin alone without touching the rest of the server.
 *
 * The value is the plugin class name, with no suffix and no surrounding brackets, which is the
 * convention each shipped first-party plugin follows in its own `src/constants.ts`.
 *
 * @example
 * ```ts
 * Logger.warn(`Repaired a stale lineCount on reorder list ${String(listId)}`, loggerCtx);
 * ```
 *
 * @docsCategory core plugins/ReorderPlugin
 * @since 3.8.0
 */
export const loggerCtx = 'ReorderPlugin';

/**
 * @description
 * The dependency-injection token that the validated {@link ReorderPluginOptions} are bound to.
 * `ReorderPlugin.init()` captures and validates the options, the plugin registers them as a provider
 * against this token, and each consumer reads them by injecting it.
 *
 * @example
 * ```ts
 * constructor(@Inject(REORDER_PLUGIN_OPTIONS) private options: ReorderPluginOptions) {}
 * ```
 *
 * It is a `Symbol` rather than a string so that the token cannot collide with one declared by
 * another plugin — a string token is only as unique as its spelling, whereas every `Symbol()` call
 * produces a distinct value. This too is the convention across the shipped first-party plugins. The
 * symbol's description is deliberately identical to the exported identifier, so that a provider
 * resolution failure names the constant a developer then has to go and find.
 *
 * That spelling is load-bearing. The provider registration and every injection site must name this
 * exact identifier, and a mismatch between them is not reported where it is written: it surfaces at
 * server start as an unresolved-dependency failure from the Nest injector.
 *
 * @docsCategory core plugins/ReorderPlugin
 * @since 3.8.0
 */
export const REORDER_PLUGIN_OPTIONS = Symbol('REORDER_PLUGIN_OPTIONS');

/**
 * @description
 * The maximum number of characters a reorder list name may contain, measured on its canonical form
 * — that is, after leading and trailing whitespace has been removed and internal whitespace runs
 * have been collapsed. A name whose canonical form is longer is refused as a malformed request, and
 * no row is written for it.
 *
 * This is a constant rather than a plugin option, and that is deliberate. 191 is not a product
 * judgement about how long a list name ought to be; it is an engine ceiling. Both `name` and
 * `nameKey` on the `reorder_list` table are declared `varchar(191)`, and `nameKey` participates in
 * the composite unique index over `(customerId, channelId, nameKey)`. 191 is the width at which a
 * four-byte UTF-8 index stays inside the key-size limit on the MySQL and MariaDB engines that the
 * project's existing end-to-end jobs exercise.
 *
 * A configurable bound above the column width would convert a validation failure a buyer can act on
 * into an opaque driver error, and a bound below it would restrict what no engine restricts. The
 * option would therefore carry exactly one legal value — the column's own width — and an option with
 * one legal value offers a deployment nothing except a way to break itself.
 *
 * One number consequently serves three places: this validation bound, the two `varchar(191)` columns
 * created by the additive migration, and the boundary the unit specification asserts at 190, 191 and
 * 192 characters. Changing it means changing both columns in a further migration; there is no
 * `maxListNameLength` option to change instead.
 *
 * @docsCategory core plugins/ReorderPlugin
 * @since 3.8.0
 */
export const MAX_LIST_NAME_LENGTH = 191;
