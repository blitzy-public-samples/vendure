/*
 * `ReorderPluginOptions` has exactly five keys, every one optional, integer, finite and at least 1, and
 * every one validated at plugin initialisation so that a malformed value fails the boot with a named error
 * identifying the offending key rather than silently degrading a bound. `init({})` is therefore valid and
 * yields the five declared defaults.
 *
 * `@since 3.8.0` on each member is a derivation rather than a quotation: the contribution guide requires a
 * new public API to name the next minor version, and this checkout declares 3.7.0 — in `lerna.json` and in
 * every workspace manifest — so 3.8.0 is the next minor and is named here on that basis. No released
 * version of this platform carries it, and nothing outside this package's own `@since` tags asserts it.
 *
 * There is no sixth key, and the absences are deliberate rather than pending. The list-name bound is not
 * configurable: it is the fixed constant `MAX_LIST_NAME_LENGTH` in `constants.ts`, equal to the `name`
 * column's declared width, so an option would carry exactly one legal value — above it a write is a
 * database error rather than a validated rejection, below it the plugin would restrict what no engine
 * restricts. Seat caps belong to the sharing feature, and retention, purge, strategy and event keys belong
 * to features that ship no disposal or instrumentation behaviour here. The identifiers those options would
 * use are written nowhere in this package, so a search for one finds nothing rather than finding a comment.
 */

/**
 * @description
 * Options that can be passed to the `.init()` static method of the ReorderPlugin.
 *
 * Every option here is a bound rather than a preference. Each one is either the value a single named
 * mutation compares against before it writes, or the page size a single named read falls back to when the
 * caller supplies no `take`. Each member therefore names the operation that consumes it, so the one place a
 * value bites is findable from the option itself.
 *
 * Every member is optional and the plugin merges the declared default for any key a deployment omits, so
 * `ReorderPlugin.init({})` is a valid call that yields exactly the documented defaults. A key that is
 * supplied is still validated, so omitting a key and supplying a malformed one are different outcomes.
 *
 * **Startup validation.** Every value is validated in `ReorderPlugin.init()` — the primary check, on the
 * input a deployment supplies — and re-asserted once more when the application bootstraps, which catches a
 * plugin registered as a bare class whose `init()` never ran the validator. Neither check is ever performed
 * per request. A value that is not an integer, is not finite, or is below one fails plugin initialisation
 * with a named configuration error identifying the offending key; `maxQuantityPerLine` additionally rejects a
 * value above the largest signed 32-bit integer, 2147483647. Initialisation fails rather than the bound
 * degrading, because a bound that silently becomes "admit everything" or "admit nothing" is worse than no
 * bound at all: nothing fails, while the guarantee the bound existed to make is gone.
 *
 * @example
 * ```ts
 * import { ReorderPlugin } from '\@vendure/reorder-plugin';
 *
 * ReorderPlugin.init({
 *   maxListsPerCustomer: 25,
 *   maxLinesPerList: 200,
 *   maxQuantityPerLine: 999,
 *   defaultReorderListsPageSize: 25,
 *   defaultReorderListLinesPageSize: 50,
 * });
 * ```
 *
 * @docsCategory core plugins/ReorderPlugin
 * @since 3.8.0
 */
export interface ReorderPluginOptions {
    /**
     * @description
     * The maximum number of reorder lists a single customer may hold in a single channel.
     *
     * Enforced by the `createReorderList` mutation, which counts and inserts inside one transaction. On
     * PostgreSQL, MySQL and MariaDB that count is taken under a pessimistic write lock on the owning
     * `Customer` row, so two concurrent creates cannot both pass a bound that admits only one of them. On
     * sql.js the lock is deliberately skipped — that driver serves a single connection, so two transactions
     * cannot interleave, and asking it for a lock raises rather than degrading. The transaction is what
     * upholds the bound on every engine; the lock is what upholds it on the three that can interleave.
     * Breaching it returns `ReorderListLimitError` carrying this value as `maxItems`. The composite unique
     * constraint on the list name is a backstop for the name race and not for this bound.
     *
     * Must be an integer, finite, and at least 1. Declared by EPIC-001 section 7.10, the single authority
     * for every configured key; owning story STORY-001-01-01.
     *
     * @default 25
     * @since 3.8.0
     */
    maxListsPerCustomer?: number;

    /**
     * @description
     * The maximum number of lines a single reorder list may hold.
     *
     * Enforced by the `addItemToReorderList` mutation only, as the `:max` parameter of the conditional
     * counter update `UPDATE reorder_list SET lineCount = lineCount + 1 WHERE id = :id AND lineCount < :max`
     * issued as the first write of that mutation's transaction. The line is inserted only when that
     * statement reports one affected row, and `ReorderListLimitError` carrying this value as `maxItems` is
     * returned when it reports none, so a single statement decides and no interleaving admits an extra line.
     *
     * `adjustReorderListLine` deliberately does **not** consult this option. It changes the quantity on a
     * line that already exists and therefore cannot breach a line-count bound, so measuring it against this
     * value would refuse a write that adds no line. An add of a variant already present is likewise not
     * refused by this bound: it accumulates onto the existing line, which adds no line either.
     *
     * This option bounds every write into the line collection; pagination, not this value, bounds every
     * read of it.
     *
     * Must be an integer, finite, and at least 1. Declared by EPIC-001 section 7.10, the single authority
     * for every configured key; owning story STORY-001-01-01.
     *
     * @default 200
     * @since 3.8.0
     */
    maxLinesPerList?: number;

    /**
     * @description
     * The maximum quantity any single reorder list line may carry.
     *
     * Enforced by both `addItemToReorderList` and `adjustReorderListLine`, and in both cases applied to the
     * **resulting** quantity rather than to the increment: an add of one onto a line already at the maximum
     * is refused even though the increment itself is one. The refusal is a `UserInputError` carrying the
     * over-maximum message key rather than `ReorderListLimitError`, because no line-count bound has been
     * breached — a malformed quantity is a bad request, not a business outcome.
     *
     * Must be an integer, finite, at least 1, and no greater than the largest signed 32-bit integer,
     * 2147483647. That ceiling is load-bearing rather than decorative: `addItemToReorderList` accumulates
     * onto an existing line, the column it accumulates into is a 32-bit `int`, and the GraphQL `Int` the
     * value is published as is a signed 32-bit integer, so a bound above that range would admit an
     * accumulation that neither the column nor the published type can represent. It is the one key in this
     * interface carrying an upper bound as well as a lower one.
     *
     * Declared by EPIC-001 section 7.10, the single authority for every configured key; owning story
     * STORY-001-01-01.
     *
     * @default 999
     * @since 3.8.0
     */
    maxQuantityPerLine?: number;

    /**
     * @description
     * The page size the `activeCustomerReorderLists` query applies where a caller supplies no `take`.
     *
     * The value is stricter than the platform's own fallback rather than looser, which is what keeps the
     * published contract intact: `apiOptions.shopListQueryLimit` defaults to 100 and `ListQueryBuilder`
     * substitutes that maximum when no page size is supplied, so a default of 25 still satisfies the
     * requirement that an omitted page size return at most the configured limit rather than every row.
     * `ignoreQueryLimits` remains false on every query, so a caller asking for more than the platform limit
     * is refused by the platform rather than by plugin code.
     *
     * Must be an integer, finite, at least 1, and **no greater than the running server's own
     * `apiOptions.shopListQueryLimit`** (100 unless your configuration lowers it). That upper bound is not a
     * style preference: the value is applied as the `take` of a Shop list query, and the platform refuses a
     * larger page outright rather than clamping it, so a page size above the limit would make every read
     * that omits `take` fail. It is therefore checked when the plugin is bootstrapped into a server, and a
     * server whose limit is below this value fails to start with a named error rather than starting and then
     * failing every such read.
     *
     * @default 25
     * @since 3.8.0
     */
    defaultReorderListsPageSize?: number;

    /**
     * @description
     * The page size the nested `ReorderList.lines` field applies where a caller supplies no `take`.
     *
     * The field returns a paginated list, so the platform's list-options generator supplies its `options`
     * argument and the same Shop-side limit governs it: a supplied `take` above the limit is REFUSED, not
     * reduced to fit. This value is only the fallback applied when that argument carries no page size, and
     * at 50 it is stricter than the platform's `shopListQueryLimit` default of 100, so a client that omits
     * the argument entirely still receives a bounded page rather than every line of the list. `lineCount`
     * remains on the parent type for a client that needs only a summary and no page of lines at all.
     *
     * Must be an integer, finite, at least 1, and **no greater than the running server's own
     * `apiOptions.shopListQueryLimit`**, for the reason given on `defaultReorderListsPageSize`: the nested
     * read goes through the same builder, so the same refusal applies to a value above the limit.
     *
     * @default 50
     * @since 3.8.0
     */
    defaultReorderListLinesPageSize?: number;
}

/**
 * @description
 * The resolved form of {@link ReorderPluginOptions}: every key present, and none of them writable.
 *
 * It is a derived alias of the interface above rather than a second options contract, and it is the type
 * every consumer of the `REORDER_PLUGIN_OPTIONS` provider names. Both halves of it are load-bearing.
 *
 * **Required, because a caller's partial object is not what a consumer receives.** `ReorderPlugin.init()`
 * merges the declared default for every key a deployment omits and validates the whole result before it is
 * stored, so what reaches the service and the two API-layer resolvers is always complete. Typing that
 * hand-over as the optional interface would have obliged each consumer to carry a fallback of its own — a
 * default restated in three more places, each free to drift from the one the plugin actually merged.
 *
 * **Readonly, because the values have already been validated.** A consumer holding a mutable reference
 * could lower a bound after startup validation had passed on it, which is the one failure mode worse than a
 * wrong bound: nothing reports it, while the guarantee the bound existed to make is gone. The plugin freezes
 * the object it hands out, and this type is what makes an attempt to write to it a compile error rather than
 * a silent no-op or a run-time surprise.
 *
 * It is deliberately **not** re-exported from the package root: a deployment configures
 * {@link ReorderPluginOptions}, and the resolved set is what this plugin's own modules pass between
 * themselves.
 *
 * @docsCategory core plugins/ReorderPlugin
 * @since 3.8.0
 */
export type ResolvedReorderPluginOptions = Readonly<Required<ReorderPluginOptions>>;
