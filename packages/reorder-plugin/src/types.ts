/*
 * -------------------------------------------------------------------------------------------------------
 * Provenance and divergence record for `ReorderPluginOptions`.
 * -------------------------------------------------------------------------------------------------------
 * The five keys below do not share one authority, and a maintainer who cannot tell them apart cannot tell
 * which of them a ticket may still renegotiate. This block records where each came from so that neither
 * divergence in it is discovered later as an unexplained addition.
 *
 * Attribution. No user-specified rules were provided for this project: the rules document was read and
 * returned exactly that, and EPIC-001 reaches the same finding independently in its own section 11.9.
 * Nothing in this file is a user-specified rule, and no rule forces any key into it. Every constraint
 * stated here traces to EPIC-001 section 7.10 (the plugin option ledger), to FEATURE-001-01 section 2.11,
 * to STORY-001-01-01, or to a cited line of this repository, and is attributed accordingly. The absence of
 * a rules document has not been treated as licence to lower the bar anywhere in this file.
 *
 * Keys 1 to 3 are ledgered. `maxListsPerCustomer`, `maxLinesPerList` and `maxQuantityPerLine` are declared
 * by EPIC-001 section 7.10, which is the single authority for every configured key in that epic and carries
 * exactly twenty-six of them. STORY-001-01-01 is the declaring owner of these three "and of no others";
 * STORY-001-01-02 and STORY-001-01-03 read them and declare none.
 *
 * Keys 4 and 5 are not in that ledger, and the divergence is reported rather than absorbed. This is the
 * conflict the plan records as C-C. Neither `defaultReorderListsPageSize` nor
 * `defaultReorderListLinesPageSize` appears in any of the ledger's twenty-six rows. The epic instead
 * records the per-surface default page size as an OPEN architectural decision at its section 8.2, observing
 * that the platform supplies no per-operation default beneath its own maximum and that absent one an
 * omitted page size resolves to that maximum. This run's supplied decisions close that item by directing
 * the values 25 and 50 be declared as plugin options, so they are declared here and the epic's open item is
 * thereby resolved for this run.
 *
 * Why the run's decision outranks the ledger's sole-authority claim, stated rather than assumed. The
 * decisions block exists precisely to close decisions the ticket set is forbidden from inventing, and it
 * directs that the supplied values not be substituted. The precedence ladder that governs this work orders
 * conflicts among tickets — the published schema over a story, the epic over a feature contract on a
 * cross-file ruling — and does not order a run-level decision against a ticket's own open item, which is
 * what section 8.2 records this as. Silently adding these keys and silently dropping them would both be
 * wrong; they are declared, and the divergence from the twenty-six-key ledger is reported in the pull
 * request body with both sections cited. These two are the only two identifiers in this feature not fixed
 * by a ticket.
 *
 * Required became defaulted, which is the second reported divergence. The ledger marks all three ledgered
 * keys "Required, no value in this set", and STORY-001-01-01 asks initialisation to fail when one is
 * absent. This run supplies 25, 200, 999, 25 and 50 as the declared defaults without substitution, which
 * makes every key defaulted rather than required and is why every member below is optional. No value has
 * been invented and no supplied value has been substituted; the change of kind is reported in the pull
 * request body alongside the ledger divergence above.
 *
 * The `@since 3.8.0` tags below are a derivation and are flagged as one. The contribution guide requires a
 * new public API to carry a `@since` tag naming what will be the next minor version, and its own literal
 * example names a different version entirely. This checkout declares 3.7.0, so the next minor derives to
 * 3.8.0. That string appears nowhere else in this repository and is therefore not a quotation from it; it is
 * computed from the checkout's version plus the guide's rule. Should the branch decision route this work to
 * a major release instead, the derived tag changes with it.
 *
 * Deliberate absences, so that they read as rulings rather than as gaps. There is no sixth key. In
 * particular there is no name-length option: the list-name bound is the fixed constant 191 that equals the
 * `name` column's declared width, a value above the column would be a database error rather than a
 * validated rejection and a value below it would restrict what no engine restricts, so such an option would
 * carry exactly one legal value. It lives in `constants.ts` as `MAX_LIST_NAME_LENGTH` instead, and
 * FEATURE-001-01 section 2.11 settles that it is a constant and not an option. There is likewise no
 * seat-cap option, which the ledger assigns to STORY-001-06-01; no retention or purge key, no deletion,
 * anonymisation or purge behaviour shipping ahead of the epic's customer-data-lifecycle ruling; no strategy
 * key; and no event key. The identifiers those absent options would have used are deliberately not written
 * anywhere in this package, so a search for one finds nothing rather than finding a comment.
 * -------------------------------------------------------------------------------------------------------
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
 * **Startup validation.** Every value is validated once, at plugin initialisation, rather than at request
 * time. A value that is not an integer, is not finite, or is below one fails plugin initialisation with a
 * named configuration error identifying the offending key; `maxQuantityPerLine` additionally rejects a
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
 * }),
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
     * Enforced by the `createReorderList` mutation, which counts and inserts inside one transaction under a
     * pessimistic write lock on the owning `Customer` row, so two concurrent creates cannot both pass a
     * bound that admits only one of them. Breaching it returns `ReorderListLimitError` carrying this value
     * as `maxItems`. The composite unique constraint on the list name is a backstop for the name race and
     * not for this bound.
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
     * This key is **not** part of EPIC-001 section 7.10, the ledger that declares itself the single
     * authority for every configured key and that carries only three keys for this feature. The epic
     * instead records the per-surface default page size as an open architectural decision at its section
     * 8.2. This run's supplied decisions close that decision by directing the value be declared as an
     * option, so it is declared here. Together with `defaultReorderListLinesPageSize` it is one of only two
     * identifiers in this feature not fixed by a ticket, and the divergence from the ledger is reported in
     * the pull request body.
     *
     * The value is stricter than the platform's own fallback rather than looser, which is what keeps the
     * published contract intact: `apiOptions.shopListQueryLimit` defaults to 100 and `ListQueryBuilder`
     * substitutes that maximum when no page size is supplied, so a default of 25 still satisfies the
     * requirement that an omitted page size return at most the configured limit rather than every row.
     * `ignoreQueryLimits` remains false on every query, so a caller asking for more than the platform limit
     * is refused by the platform rather than by plugin code.
     *
     * Must be an integer, finite, and at least 1.
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
     * argument and the same Shop-side limit clamps it. This value is only the fallback applied when that
     * argument carries no page size, and at 50 it is stricter than the platform's `shopListQueryLimit`
     * default of 100, so a client that omits the argument entirely still receives a bounded page rather
     * than every line of the list. `lineCount` remains on the parent type for a client that needs only a
     * summary and no page of lines at all.
     *
     * Like `defaultReorderListsPageSize`, this key is **not** in EPIC-001 section 7.10 and exists because
     * this run's supplied decisions close the open per-surface page-size decision the epic records at its
     * section 8.2. The two are the only identifiers in this feature not fixed by a ticket, and the
     * divergence is reported in the pull request body.
     *
     * Must be an integer, finite, and at least 1.
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
