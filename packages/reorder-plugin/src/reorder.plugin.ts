/*
 * -------------------------------------------------------------------------------------------------------
 * The ReorderPlugin class — provenance, the two deliberate departures, and the one quiet failure mode.
 * -------------------------------------------------------------------------------------------------------
 * Attribution. No user-specified rules were provided for this project: the rules document was read and
 * returned exactly that, and EPIC-001 reaches the same finding independently in its own section 11.9.
 * Nothing in this file is, or derives from, a user-specified rule, and no rule forces anything into it.
 * Every constraint stated below traces to EPIC-001 (rulings R1, R2, R3, R8, R10, R15, R19, R22, and
 * sections 7.9.2, 7.10, 11.2 and 11.5), to FEATURE-001-01, to STORY-001-01-01, or to a cited line of this
 * repository, and is attributed as such wherever it is stated. The absence of a rules document has not been
 * treated as licence to lower the bar anywhere in this file.
 *
 * WHAT THIS FILE IS. It is the plugin's single registration point and its only initialisation surface: the
 * two entities, the service, the resolved-options provider and the four Shop resolvers are registered here
 * and nowhere else, `init()` is the one place a deployment's option values enter the plugin, and the one
 * place they are validated. Every other module in this package is registered *by* this file rather than
 * registering itself.
 *
 * TWO DELIBERATE DEPARTURES FROM THE STRUCTURAL PRECEDENT. This class is modelled on the shipped wishlist
 * example plugin (`packages/dev-server/example-plugins/wishlist-plugin/wishlist.plugin.ts` L9-L16), which is
 * copied faithfully except for two things — and both exceptions are the difference between honouring
 * EPIC-001 ruling R1 and breaching it:
 *
 * 1. NO `configuration` HOOK, for any purpose. The precedent's hook (same file, L17-L26) pushes an internal
 *    `relation` custom field onto `Customer`. Ruling R1 forbids a custom field on any core entity, so
 *    ownership here is the `customerId` column on this plugin's own `reorder_list` table instead. The
 *    consequences are observable rather than stylistic: `packages/dev-server/dev-config.ts` L116
 *    `customFields: {}` stays byte-identical, and `addItemToOrder` and `adjustOrderLine` gain no argument.
 *    Nothing else in this plugin needs the hook either, because it changes no platform configuration at
 *    all — it registers no custom permission, so the published `Permission` enum stays at 97 members (R15
 *    requires that zero delta to be asserted rather than omitted); no `ScheduledTask`, no `VendureEvent`
 *    subclass, no configurable strategy and no job-queue handler (ruling R19); and no `configure` method.
 * 2. NO bare `import './types';`. The precedent's L7 import exists purely to pull in a module augmentation
 *    of `CustomCustomerFields`. There is no augmentation here — see departure 1 — so `ReorderPluginOptions`
 *    is imported as an ordinary named type and the side-effect import would be dead weight that a reader
 *    would have to prove harmless.
 *
 * TWO DIVERGENCES THIS FILE CREATES, BOTH REPORTED RATHER THAN ABSORBED. Neither is silent, because the
 * standing obligation on this work is that no deviation is silent.
 *
 * A. REQUIRED BECAME DEFAULTED. EPIC-001 section 7.10 marks `maxListsPerCustomer`, `maxLinesPerList` and
 *    `maxQuantityPerLine` "Required, no value in this set", and STORY-001-01-01 asks initialisation to fail
 *    when one is absent. This run's supplied decisions instead give 25, 200 and 999 as declared defaults to
 *    be used without substitution, so an omitted key now resolves to a default rather than failing. The
 *    values are used exactly as supplied and none is invented; the change of kind is reported in the pull
 *    request body alongside the two-key ledger divergence that `types.ts` records as conflict C-C. An
 *    EXPLICIT `undefined` or `null` is still refused — see `validateResolvedReorderPluginOptions`.
 * B. THE COMPATIBILITY RANGE IS THE EPIC'S FLOOR, NOT THE SIBLINGS' CARET. `'>=3.3.0'` is declared below,
 *    in the floor form the platform's own floor-declaring plugin uses
 *    (`packages/telemetry-plugin/src/telemetry.plugin.ts` L121), rather than the `'^3.0.0'` that five
 *    shipped plugins declare. EPIC-001 section 7.9.2 states the 3.3 floor and says the range "states that
 *    floor rather than copying `^3.0.0` unexamined", and the epic outranks a feature or story on a
 *    cross-file ruling. Stated honestly: the floor's basis in section 7.9.2 is the scheduler and its
 *    `configure` surface, and THIS FEATURE USES NEITHER — it registers no `ScheduledTask` under ruling R19
 *    and declares no `configure` method. The range is therefore declared because the epic outranks the
 *    feature on this ruling, not because any line of this package needs a mechanism introduced in 3.3. That
 *    reasoning is reported in the pull request body rather than implied by the literal.
 *
 * THE QUIETEST FAILURE MODE IN THIS FILE IS THE I18N PATH, AND IT IS HANDLED EXPLICITLY.
 * `I18nService.addTranslationFile` wraps its `readFileSync` and `JSON.parse` in a `try` whose `catch` does
 * nothing but log (`packages/core/src/i18n/i18n.service.ts`). A wrong path therefore throws nothing, fails
 * no test and boots a healthy-looking server on which all four of this plugin's message keys surface to
 * buyers as raw keys. The naive single-level path is wrong in exactly one of the two layouts this package
 * runs in, so the path is resolved against an ordered candidate list and a miss is logged loudly. See
 * `ReorderPlugin.registerTranslations`.
 *
 * THE `@since 3.8.0` TAGS BELOW ARE A DERIVATION AND ARE FLAGGED AS ONE, per EPIC-001 section 11.2. The
 * contribution guide requires new public API to carry a `@since` tag naming what will be the next minor
 * version (`CONTRIBUTING.md`), and this checkout declares 3.7.0
 * (`packages/core/package.json` L2-L3), so the next minor derives to 3.8.0. That string appears nowhere in
 * this repository and must never be presented as quoted from it. Section 11.5 forbids a hand-written
 * reference page, so the JSDoc in this file is the documentation deliverable for the plugin class.
 * -------------------------------------------------------------------------------------------------------
 */

import { OnApplicationBootstrap } from '@nestjs/common';
import { I18nService, Logger, PluginCommonModule, Type, VendurePlugin } from '@vendure/core';
import fs from 'fs';
import path from 'path';

import { shopApiExtensions } from './api/api-extensions';
import { ReorderListEntityResolver, ReorderListLineEntityResolver } from './api/reorder-list-entity.resolver';
import { ReorderListResultResolver } from './api/reorder-list-result.resolver';
import { ReorderListShopResolver } from './api/reorder-list-shop.resolver';
import { loggerCtx, REORDER_PLUGIN_OPTIONS } from './constants';
import { ReorderListLine } from './entities/reorder-list-line.entity';
import { ReorderList } from './entities/reorder-list.entity';
import { ReorderListService } from './service/reorder-list.service';
import { ReorderPluginOptions } from './types';

/**
 * @description
 * The shape of {@link ReorderPlugin.options}: every key of {@link ReorderPluginOptions} resolved to a
 * value, because a key the caller omits takes its declared default rather than staying absent.
 *
 * The distinction from the partial a caller supplies is load-bearing rather than cosmetic: the service and
 * both entity resolvers read these values on request paths, and a type that admitted `undefined` would
 * oblige each of them to carry a fallback of its own — which is three more places for a default to live,
 * and to drift. It is exported so that a consumer holding the resolved set can name its type.
 *
 * @docsCategory core plugins/ReorderPlugin
 * @docsPage ReorderPlugin
 * @since 3.8.0
 */
export type ResolvedReorderPluginOptions = Required<ReorderPluginOptions>;

/**
 * The declared default for every option, and the single place any of these five numbers is written.
 *
 * The values are the ones this run supplies (25, 200, 999, 25, 50) and are used without substitution.
 * Typing the constant `Required<ReorderPluginOptions>` is what makes the completeness a compile-time fact:
 * adding a sixth option to the interface without a default here is a build failure rather than an
 * `undefined` discovered on a request path.
 */
const DEFAULT_REORDER_PLUGIN_OPTIONS: ResolvedReorderPluginOptions = {
    maxListsPerCustomer: 25,
    maxLinesPerList: 200,
    maxQuantityPerLine: 999,
    defaultReorderListsPageSize: 25,
    defaultReorderListLinesPageSize: 50,
};

/**
 * The lower bound shared by all five options. A bound of zero would mean "admit nothing" — a list that can
 * hold no lines, or a page that can carry no rows — which is a configuration mistake rather than a
 * deployment choice, so it is refused rather than honoured.
 */
const MIN_OPTION_VALUE = 1;

/**
 * The largest signed 32-bit integer, and the additional ceiling on `maxQuantityPerLine` only.
 *
 * It is not a round number chosen for tidiness. `addItemToReorderList` ACCUMULATES onto an existing line's
 * quantity, the column it accumulates into is a 32-bit `int`, and the GraphQL `Int` the value is published
 * as is a signed 32-bit integer, so a bound above this range would admit a resulting quantity that neither
 * the column nor the published type can represent (EPIC-001 section 7.10; FEATURE-001-01 section 2.11).
 * Refusing it at initialisation converts a driver-level overflow on some future request into a startup
 * failure naming the offending key.
 */
const MAX_SIGNED_32_BIT_INTEGER = 2147483647;

/**
 * The keys validated at initialisation, in the order they are validated.
 *
 * The order is deliberate and is part of the contract: validation reports the FIRST offending key and stops,
 * because a message naming several keys at once makes a per-key assertion ambiguous and leaves a reader
 * guessing which value the server actually rejected. Declaring the list as `ReadonlyArray<keyof
 * ResolvedReorderPluginOptions>` also means a new option cannot be added to the interface and silently left
 * unvalidated — the array is the checklist, and it is type-checked against the interface it walks.
 */
const VALIDATED_OPTION_KEYS: ReadonlyArray<keyof ResolvedReorderPluginOptions> = [
    'maxListsPerCustomer',
    'maxLinesPerList',
    'maxQuantityPerLine',
    'defaultReorderListsPageSize',
    'defaultReorderListLinesPageSize',
];

/**
 * The language this plugin ships a message catalogue for. One locale, deliberately: no other translation
 * exists in this package, and registering a key for a locale with no catalogue behind it would surface the
 * key itself to a buyer in that locale rather than a sentence.
 */
const I18N_LANGUAGE_KEY = 'en';

/**
 * The candidate locations of the message catalogue, resolved against this module's own directory and tried
 * in this order.
 *
 * TWO ENTRIES BECAUSE THIS MODULE RUNS FROM TWO DIFFERENT DEPTHS, and the naive single-level path is wrong
 * in one of them:
 *
 * - Compiled from source, this module sits at `<pkg>/src/reorder.plugin.ts`, so `__dirname` is `<pkg>/src`
 *   and `'../i18n/en.json'` is correct. This is the layout the dev server, the unit run and every
 *   end-to-end suite execute in.
 * - Built for publication, `tsconfig.build.json` compiles the root `index.ts` into `outDir: "./lib"`, so
 *   the emitted module is `<pkg>/lib/src/reorder.plugin.js`, `__dirname` is `<pkg>/lib/src`, and
 *   `'../i18n/en.json'` resolves to a `<pkg>/lib/i18n` directory that does not exist while
 *   `'../../i18n/en.json'` is correct. The same arithmetic is why the shipped email plugin reaches its own
 *   package root with `path.join(__dirname, '../..')` from a module under `src`
 *   (`packages/email-plugin/src/dev-mailbox.ts` L23).
 *
 * The first entry additionally covers the case where a future build step copies the catalogue into `lib/`
 * beside the compiled module, so the list needs no third entry to be exhaustive over the layouts that can
 * actually occur.
 */
const I18N_RESOURCE_CANDIDATE_PATHS: readonly string[] = [
    path.join('..', 'i18n', `${I18N_LANGUAGE_KEY}.json`),
    path.join('..', '..', 'i18n', `${I18N_LANGUAGE_KEY}.json`),
];

/**
 * @description
 * Thrown when {@link ReorderPlugin.init} is given an option value the plugin cannot use.
 *
 * It is a distinct, exported class rather than a bare `Error` for two reasons. A caller — or a test — can
 * discriminate a configuration mistake from any other startup failure with `instanceof`, and the offending
 * key is available as data on {@link ReorderPluginConfigurationError.optionKey} rather than only as prose
 * inside a message that would then have to be parsed. The message names the key as well, so a stack trace
 * alone is enough to act on.
 *
 * Throwing at all is the point. EPIC-001 section 7.10 fixes the behaviour for every option in the ledger:
 * the plugin fails to start, with a named configuration error identifying the offending key, because a
 * bound that silently degrades to "admit everything" or "admit nothing" is worse than no bound — nothing
 * fails, while the guarantee the bound existed to make is gone.
 *
 * @example
 * ```ts
 * try {
 *   ReorderPlugin.init({ maxLinesPerList: 0 });
 * } catch (e) {
 *   if (e instanceof ReorderPluginConfigurationError) {
 *     // e.optionKey === 'maxLinesPerList'
 *   }
 * }
 * ```
 *
 * @docsCategory core plugins/ReorderPlugin
 * @docsPage ReorderPlugin
 * @since 3.8.0
 */
export class ReorderPluginConfigurationError extends Error {
    /**
     * @description
     * The single option key that was rejected. Validation stops at the first offender, so this names one
     * key and never a set of them.
     *
     * @since 3.8.0
     */
    readonly optionKey: keyof ReorderPluginOptions;

    constructor(optionKey: keyof ReorderPluginOptions, requirement: string, received: unknown) {
        super(
            `ReorderPlugin configuration is invalid: the "${optionKey}" option ${requirement}, ` +
                `but received ${describeRejectedValue(received)}. ` +
                `Correct the value passed to ReorderPlugin.init() — the plugin will not start until it is valid.`,
        );
        // Set explicitly rather than inherited, so that the class name survives in `error.name` and in any
        // serialised form of the error, both of which a test may assert on.
        this.name = 'ReorderPluginConfigurationError';
        this.optionKey = optionKey;
        // Restores the prototype chain when this class is transpiled to a target that treats `super()` as
        // returning a fresh object, which is what keeps `instanceof` reliable across the compiler and the
        // SWC transform the unit run uses.
        Object.setPrototypeOf(this, ReorderPluginConfigurationError.prototype);
    }
}

/**
 * Renders a rejected value for the error message.
 *
 * Every branch produces a string, which is required rather than tidy: the repository's lint configuration
 * forbids interpolating a non-string into a template literal, and `String(value)` alone would render `null`
 * and the string `'null'` identically — collapsing the very distinction a reader needs in order to tell a
 * missing value from a mistyped one.
 */
function describeRejectedValue(value: unknown): string {
    if (typeof value === 'string') {
        return `the string "${value}"`;
    }
    if (typeof value === 'number') {
        // `String(NaN)` is 'NaN' and `String(Infinity)` is 'Infinity', both of which read correctly here.
        return `the number ${String(value)}`;
    }
    if (value === null) {
        return 'null';
    }
    if (value === undefined) {
        return 'undefined';
    }
    if (typeof value === 'boolean' || typeof value === 'bigint' || typeof value === 'symbol') {
        return `a ${typeof value} (${String(value)})`;
    }
    return `a value of type ${typeof value}`;
}

/**
 * @description
 * Validates a fully resolved option set and returns it unchanged, or throws
 * {@link ReorderPluginConfigurationError} naming the first key it cannot accept.
 *
 * The rule applied to all five keys is the same — an integer, finite, and at least
 * {@link MIN_OPTION_VALUE} — and `maxQuantityPerLine` additionally may not exceed
 * {@link MAX_SIGNED_32_BIT_INTEGER}. `Number.isInteger` is the test rather than truthiness or a `parseInt`
 * round trip, because it is false for `NaN`, for both infinities, for a fractional value and for every
 * non-number, which is exactly the set to refuse; `parseInt('25 lists')` would return 25 and admit rubbish.
 *
 * An EXPLICIT `undefined` or `null` reaches this function and is refused. That is deliberate: a key omitted
 * altogether resolves to its declared default, whereas a key present with no usable value is a mistake at
 * the call site — typically an expression that evaluated to nothing — and silently substituting a bound for
 * it would hide the mistake behind a working server.
 *
 * @since 3.8.0
 */
function validateResolvedReorderPluginOptions(
    options: ResolvedReorderPluginOptions,
): ResolvedReorderPluginOptions {
    for (const key of VALIDATED_OPTION_KEYS) {
        // Widened deliberately: the compiler believes this is a `number`, and the whole purpose of the
        // check is to hold at run time when a JavaScript caller, an environment variable or a JSON
        // configuration file has supplied something else.
        const value: unknown = options[key];

        if (!Number.isInteger(value)) {
            throw new ReorderPluginConfigurationError(
                key,
                'must be a finite integer (no fractional value, NaN, Infinity, null, undefined or non-numeric type)',
                value,
            );
        }
        // Narrowed by the guard above, which is true only for a finite integer `number`.
        const intValue = value as number;
        if (intValue < MIN_OPTION_VALUE) {
            throw new ReorderPluginConfigurationError(
                key,
                `must be at least ${String(MIN_OPTION_VALUE)}`,
                value,
            );
        }
        if (key === 'maxQuantityPerLine' && intValue > MAX_SIGNED_32_BIT_INTEGER) {
            throw new ReorderPluginConfigurationError(
                key,
                `must not exceed ${String(MAX_SIGNED_32_BIT_INTEGER)}, the largest signed 32-bit integer, ` +
                    'because the quantity column it guards is a 32-bit int and the published GraphQL Int is ' +
                    'a signed 32-bit integer',
                value,
            );
        }
    }
    return options;
}

/**
 * @description
 * The ReorderPlugin adds named, multiple reorder lists — each line carrying a positive integer quantity —
 * to the Vendure Shop API.
 *
 * A reorder list is a saved, named selection of product variants that a buyer curates and returns to. The
 * plugin publishes eight Shop operations: two paginated reads, `activeCustomerReorderLists` and
 * `activeCustomerReorderList`; three list-level mutations, `createReorderList`, `updateReorderList` and
 * `deleteReorderList`; and three line-level mutations, `addItemToReorderList`, `adjustReorderListLine` and
 * `removeReorderListLine`.
 *
 * Three properties of that surface are worth knowing before using it:
 *
 * - **Ownership is enforced in the service layer, not by the permission gate.** Every operation is
 *   annotated `\@Allow(Permission.Owner)`, which marks the request context and admits the request; the
 *   three-way predicate over the authenticated customer, the active channel and the addressed row is what
 *   actually protects one buyer's lists from another's. A single-list read that is absent, another
 *   customer's or another channel's returns the same `null`, so the read cannot be used to enumerate.
 * - **Both reads are bounded and deterministically ordered.** Lists are ordered by creation timestamp
 *   descending and lines ascending, each tie-broken by identifier so that a page boundary cannot reorder
 *   rows sharing a timestamp, and a caller who supplies no page size receives the configured default rather
 *   than every row.
 * - **A malformed quantity or list name is a bad request, not a business outcome.** It is refused with a
 *   top-level `USER_INPUT_ERROR` carrying one of this plugin's own message keys, while genuine domain
 *   outcomes arrive as union members: `ReorderListNotFoundError`, `ReorderListNameConflictError`,
 *   `ReorderListLimitError` and `ReorderListLineNotFoundError`.
 *
 * The plugin registers **no** custom field on any core entity and **no** custom permission, so no existing
 * published contract changes shape when it is installed.
 *
 * ## Installation
 *
 * `yarn add \@vendure/reorder-plugin`
 *
 * or
 *
 * `npm install \@vendure/reorder-plugin`
 *
 * Then add the `ReorderPlugin`, calling the `.init()` method with {@link ReorderPluginOptions}:
 *
 * @example
 * ```ts
 * import { ReorderPlugin } from '\@vendure/reorder-plugin';
 *
 * const config: VendureConfig = {
 *   // ...
 *   plugins: [
 *     ReorderPlugin.init({
 *       // The maximum number of lists one customer may hold in one channel.
 *       maxListsPerCustomer: 25,
 *       // The maximum number of lines one list may hold.
 *       maxLinesPerList: 200,
 *       // The maximum quantity one line may carry, applied to the RESULTING quantity.
 *       maxQuantityPerLine: 999,
 *       // The page size `activeCustomerReorderLists` uses when the caller supplies no `take`.
 *       defaultReorderListsPageSize: 25,
 *       // The page size the nested `ReorderList.lines` field uses when the caller supplies no `take`.
 *       defaultReorderListLinesPageSize: 50,
 *     }),
 *   ],
 * };
 * ```
 *
 * Every option is optional and merges over the default shown above, so `ReorderPlugin.init({})` — and
 * registering the bare `ReorderPlugin` class — both yield exactly those five values. A value that is
 * supplied but unusable is a different matter: it fails plugin initialisation immediately with a
 * {@link ReorderPluginConfigurationError} naming the offending key, rather than degrading the bound.
 *
 * ## Database migration
 *
 * This plugin defines two new database entities, `ReorderList` and `ReorderListLine`, which become the
 * `reorder_list` and `reorder_list_line` tables. Adding the plugin to your `VendureConfig` is therefore not
 * sufficient on its own: **generate and run a migration** so those tables, their indices and their named
 * constraints exist before the first request arrives. No existing table is altered and no column is added
 * to one — every foreign key points from this plugin's tables to core tables — so the migration is purely
 * additive and reverses cleanly.
 *
 * ## Localisation
 *
 * The plugin registers an English message catalogue for its four input-error keys during
 * `onApplicationBootstrap`. The catalogue is merged into the platform's own `error` namespace, so nothing
 * shipped by core is overwritten.
 *
 * @docsCategory core plugins/ReorderPlugin
 * @docsPage ReorderPlugin
 * @docsWeight 0
 * @since 3.8.0
 */
@VendurePlugin({
    imports: [PluginCommonModule],
    entities: [ReorderList, ReorderListLine],
    providers: [
        ReorderListService,
        {
            provide: REORDER_PLUGIN_OPTIONS,
            // A factory rather than `useValue`, so that the provider reads whatever `init()` resolved
            // instead of capturing the static at decorator-evaluation time — which runs when this module
            // is first imported, before any deployment has had the chance to call `init()`.
            useFactory: () => ReorderPlugin.options,
        },
    ],
    shopApiExtensions: {
        schema: shopApiExtensions,
        // FOUR classes, and every one of them is load-bearing. `ReorderListShopResolver` serves the eight
        // operations. `ReorderListEntityResolver` and `ReorderListLineEntityResolver` are two classes
        // rather than one because a class-level `@Resolver(name)` binds exactly one parent type: the first
        // resolves `ReorderList.lines` and `ReorderList.viewerAccess`, the second resolves
        // `ReorderListLine.productVariant`, and dropping either leaves its fields unresolved.
        // `ReorderListResultResolver` carries the six `__resolveType` field resolvers required by EPIC-001
        // ruling R8; without it every one of this plugin's unions is unresolvable, which surfaces on the
        // first mutation a client executes rather than at boot.
        resolvers: [
            ReorderListShopResolver,
            ReorderListEntityResolver,
            ReorderListLineEntityResolver,
            ReorderListResultResolver,
        ],
        // No `scalars`: the document declares no custom scalar.
    },
    // Declared rather than omitted, because omission is a silent degradation rather than a neutral choice:
    // the platform logs a single informational line for a plugin with no range and fails on nothing
    // (`packages/core/src/bootstrap.ts` L335-L338), whereas a declared range is enforced and a server that
    // does not satisfy it refuses to start (same file, L340-L349). The floor form — rather than the
    // `'^3.0.0'` five shipped plugins declare — follows EPIC-001 section 7.9.2 and matches
    // `packages/telemetry-plugin/src/telemetry.plugin.ts` L121. Kept as a plain string literal so that a
    // test can read it from the plugin metadata and substitute an unsatisfiable one.
    compatibility: '>=3.3.0',
})
export class ReorderPlugin implements OnApplicationBootstrap {
    /**
     * @description
     * The resolved, validated options in force for this plugin.
     *
     * It is `Required<ReorderPluginOptions>` rather than the partial a caller supplies, and it is
     * pre-seeded with the declared defaults, so it is fully populated from the moment this module is
     * imported. Two things follow. Registering the bare `ReorderPlugin` class without calling `init()` is a
     * valid installation that runs on the documented defaults instead of reading `undefined` on a request
     * path. And the service and both resolvers can read every key directly, which is what keeps the
     * defaults declared in one place rather than restated at each point of use.
     *
     * @since 3.8.0
     */
    static options: ResolvedReorderPluginOptions = { ...DEFAULT_REORDER_PLUGIN_OPTIONS };

    /** @internal */
    constructor(private i18nService: I18nService) {}

    /**
     * @description
     * Initialises the plugin with the given options and returns the plugin class for the `plugins` array.
     *
     * Each supplied key overrides its declared default and each omitted key takes it, so a partial call is
     * valid and `init({})` yields the documented defaults. The merged result is then validated in full
     * BEFORE it is stored: a rejected call throws {@link ReorderPluginConfigurationError} naming the first
     * unusable key and leaves {@link ReorderPlugin.options} exactly as it was, so a failed initialisation
     * cannot leave the plugin holding a value it has already refused.
     *
     * Validation happens here rather than on first use because the required behaviour is that the plugin
     * fails to *start* (EPIC-001 section 7.10). A bound checked lazily would let a misconfigured server
     * boot, report itself healthy, and only refuse — or wrongly admit — a request some time later.
     *
     * @example
     * ```ts
     * ReorderPlugin.init({ maxListsPerCustomer: 25, maxLinesPerList: 200, maxQuantityPerLine: 999 })
     * ```
     *
     * @param options - Any subset of {@link ReorderPluginOptions}; every omitted key takes its declared
     * default.
     * @returns The `ReorderPlugin` class, for inclusion in the `plugins` array of your `VendureConfig`.
     * @throws {@link ReorderPluginConfigurationError} if any resolved value is not a finite integer of at
     * least 1, or if `maxQuantityPerLine` exceeds the largest signed 32-bit integer.
     *
     * @since 3.8.0
     */
    static init(options: ReorderPluginOptions = {}): Type<ReorderPlugin> {
        // Spread order matters: the caller's keys win over the defaults. An explicitly-supplied
        // `undefined` therefore survives the merge and is refused by validation, which is the intended
        // difference between omitting a key and supplying nothing for it.
        const resolved = validateResolvedReorderPluginOptions({
            ...DEFAULT_REORDER_PLUGIN_OPTIONS,
            ...options,
        });
        ReorderPlugin.options = resolved;
        return ReorderPlugin;
    }

    /**
     * @description
     * Registers this plugin's message catalogue once the application has bootstrapped, and re-asserts that
     * the options in force are still usable.
     *
     * @since 3.8.0
     */
    onApplicationBootstrap(): void {
        // Cheap defence in depth: `options` is a mutable static, so this proves the values the server is
        // about to serve requests with are the values initialisation approved. Five integer comparisons,
        // and a failure here still prevents the server from reaching a ready state.
        validateResolvedReorderPluginOptions(ReorderPlugin.options);
        this.registerTranslations();
    }

    /**
     * Loads the English message catalogue for this plugin's four input-error keys.
     *
     * `addTranslationFile` cannot report a failure to its caller — it catches everything and logs
     * (`packages/core/src/i18n/i18n.service.ts`) — so a path that does not exist would produce a running
     * server whose error messages are raw keys, with nothing failing anywhere to say so. The path is
     * therefore resolved against the `I18N_RESOURCE_CANDIDATE_PATHS` list above, which covers both layouts
     * this module runs from, and an exhausted candidate list is logged as an error naming every path tried
     * so that the silent failure becomes a visible one.
     *
     * It never throws. A missing catalogue degrades four messages to their keys, which is not a reason to
     * refuse to serve an otherwise healthy server — and unlike a bad bound, it cannot admit or refuse
     * anything it should not.
     */
    private registerTranslations(): void {
        const candidates = I18N_RESOURCE_CANDIDATE_PATHS.map(relativePath =>
            path.resolve(__dirname, relativePath),
        );
        const resourceFile = candidates.find(candidate => isReadableFile(candidate));

        if (resourceFile === undefined) {
            Logger.error(
                `Could not locate the ${I18N_LANGUAGE_KEY} i18n resource file for the ReorderPlugin. ` +
                    `The following paths were tried, in order: ${candidates.join(', ')}. ` +
                    `This plugin's error messages will surface as raw message keys until the file is reachable.`,
                loggerCtx,
            );
            return;
        }

        this.i18nService.addTranslationFile(I18N_LANGUAGE_KEY, resourceFile);
        Logger.verbose(
            `Registered the ${I18N_LANGUAGE_KEY} i18n resource file from ${resourceFile}`,
            loggerCtx,
        );
    }
}

/**
 * Whether the given path is an existing, readable regular file.
 *
 * A directory at the candidate path would satisfy `existsSync` and then fail inside
 * `addTranslationFile` with nothing but that service's own log line to show for it, so the check is for a
 * regular file specifically. Any filesystem error — a permission denial, a broken symlink, a path that
 * disappears between the two calls — is answered `false` rather than propagated, because a candidate that
 * cannot be read is simply not the candidate, and the caller's exhausted-list branch already reports it.
 */
function isReadableFile(candidatePath: string): boolean {
    try {
        if (!fs.statSync(candidatePath).isFile()) {
            return false;
        }
        fs.accessSync(candidatePath, fs.constants.R_OK);
        return true;
    } catch {
        return false;
    }
}
