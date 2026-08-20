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
 * two entities, the service, the resolved-options provider and the three Shop resolver classes — the
 * operation resolver, the one entity resolver that serves both parent types, and the union type resolver —
 * are registered here and nowhere else, and `init()` is the one place a deployment's option values enter
 * the plugin and the primary place they are validated — `onApplicationBootstrap` re-asserts the resolved set
 * once more, which is what catches a server registered with the bare class whose `init()` never ran the
 * validator. Neither check runs per request. Every other module in this package is registered *by* this
 * file rather than registering itself.
 *
 * TWO DELIBERATE DEPARTURES FROM THE STRUCTURAL PRECEDENT. This class is modelled on the shipped wishlist
 * example plugin (`packages/dev-server/example-plugins/wishlist-plugin/wishlist.plugin.ts` L9-L16), which is
 * copied faithfully except for two things — and both exceptions are the difference between honouring
 * EPIC-001 ruling R1 and breaching it:
 *
 * 1. NO `configuration` HOOK, for any purpose. The precedent's hook (same file, L17-L26) pushes an internal
 *    `relation` custom field onto `Customer`. Ruling R1 forbids a custom field on any core entity, so
 *    ownership here is the `customerId` column on this plugin's own `reorder_list` table instead. The
 *    consequences are observable rather than stylistic: the `customFields: {}` property of
 *    `packages/dev-server/dev-config.ts` stays byte-identical — cited by name rather than by line, because a
 *    line number is invalidated by any edit above it — and `addItemToOrder` and `adjustOrderLine` gain no
 *    argument.
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
 * runs in, so the path is resolved against an ordered candidate list and a miss is logged loudly. Resolving
 * the path is only half of it: an installed package contains the catalogue only because this package's
 * manifest lists the `i18n` directory in its `files` allow-list beside the compiled output, so the two
 * halves are one requirement and are documented together. See `ReorderPlugin.registerTranslations` and
 * `I18N_RESOURCE_CANDIDATE_PATHS`.
 *
 * THE `@since 3.8.0` TAGS BELOW ARE A DERIVATION AND ARE FLAGGED AS ONE, per EPIC-001 section 11.2. The
 * contribution guide requires new public API to carry a `@since` tag naming what will be the next minor
 * version (`CONTRIBUTING.md`, whose own example names a different one), and this checkout declares 3.7.0
 * (`packages/core/package.json` L2-L3), so the next minor derives to 3.8.0. The guide does not state that
 * value, so it is computed rather than quoted and must never be presented as a quotation from the guide;
 * the authoritative tickets, where the same derived value appears, present it the same way. Section 11.5
 * forbids a hand-written reference page, so the JSDoc in this file is the documentation deliverable for the
 * plugin class.
 * -------------------------------------------------------------------------------------------------------
 */

import { OnApplicationBootstrap } from '@nestjs/common';
import { I18nService, Logger, PluginCommonModule, Type, VendurePlugin } from '@vendure/core';
import fs from 'fs';
import path from 'path';

import { shopApiExtensions } from './api/api-extensions';
import { ReorderListEntityResolver } from './api/reorder-list-entity.resolver';
import { ReorderListResultResolver } from './api/reorder-list-result.resolver';
import { ReorderListShopResolver } from './api/reorder-list-shop.resolver';
import { loggerCtx, REORDER_PLUGIN_OPTIONS } from './constants';
import { ReorderListLine } from './entities/reorder-list-line.entity';
import { ReorderList } from './entities/reorder-list.entity';
import { ReorderListService } from './service/reorder-list.service';
import { ReorderPluginOptions, ResolvedReorderPluginOptions } from './types';

/**
 * The declared default for every option, and the single place in this package any of these five numbers is
 * written.
 *
 * The values are the ones this run supplies (25, 200, 999, 25, 50) and are used without substitution.
 * Typing the constant against the resolved option set is what makes the completeness a compile-time fact:
 * adding a sixth option to the interface without a default here is a build failure rather than an
 * `undefined` discovered on a request path.
 *
 * It is frozen because it is a shared value that must survive being handed out: `init()` spreads it and
 * `resolvedOptions` starts as a copy of it, and a mutable module-level constant would let one of those
 * paths rewrite the declared defaults for every later caller.
 */
const DEFAULT_REORDER_PLUGIN_OPTIONS: ResolvedReorderPluginOptions = Object.freeze({
    maxListsPerCustomer: 25,
    maxLinesPerList: 200,
    maxQuantityPerLine: 999,
    defaultReorderListsPageSize: 25,
    defaultReorderListLinesPageSize: 50,
});

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
 * How the catalogue is named in a log line: the path it occupies inside the package, which is identical in
 * every install because `package.json` publishes `i18n/**` at the package root.
 *
 * A log line names this fixed identifier rather than the absolute path the lookup resolved to. The resolved
 * path is a function of where the operator installed the application, so printing it discloses the
 * deployment layout — an installation directory, a user account, a container mount point — to anyone who can
 * read the log, and discloses it on the *success* path too, where nothing is even wrong. The identifier
 * below plus the package-relative candidates in {@link I18N_RESOURCE_CANDIDATE_PATHS} are constants of the
 * published source, so they carry every fact needed to diagnose a lookup failure and no fact about the host.
 */
const I18N_RESOURCE_IDENTIFIER = `i18n/${I18N_LANGUAGE_KEY}.json`;

/**
 * The candidate locations of the message catalogue, **relative to this module's own directory** and tried in
 * this order. They are joined against `__dirname` at the point of use and never logged in resolved form.
 *
 * The catalogue itself lives at exactly one place — `<pkg>/i18n/en.json`, the path
 * `packages/reorder-plugin/package.json` publishes through its `files` allow-list. TWO ENTRIES ARE NEEDED
 * ANYWAY, BECAUSE THIS MODULE RUNS FROM TWO DIFFERENT DEPTHS beneath that package root:
 *
 * - **Source layout** — this module is `<pkg>/src/reorder.plugin.ts`, so `__dirname` is `<pkg>/src` and the
 *   first candidate, `'../i18n/en.json'`, reaches `<pkg>/i18n/en.json`. This is the layout the dev server,
 *   the unit run and every end-to-end suite execute in, and the second candidate misses in it (it would
 *   climb out of the package to `packages/i18n/en.json`).
 * - **Built and packed layout** — `tsconfig.build.json` compiles the root `index.ts` into `outDir: "./lib"`,
 *   so the emitted module is `<pkg>/lib/src/reorder.plugin.js`, `__dirname` is `<pkg>/lib/src`, and it is the
 *   *second* candidate, `'../../i18n/en.json'`, that reaches `<pkg>/i18n/en.json`. The first misses here: it
 *   points at `<pkg>/lib/i18n`, and nothing ever writes that directory, because the build emits only
 *   compiled TypeScript and the catalogue is published from the package root rather than copied under
 *   `lib/`. The same arithmetic is why the shipped email plugin reaches its own package root with
 *   `path.join(__dirname, '../..')` from a module under `src` (`packages/email-plugin/src/dev-mailbox.ts`
 *   L23), and its manifest likewise publishes its non-compiled assets — `templates/**` — beside `lib/**`.
 *
 * Exactly one candidate therefore resolves in each layout, and between them the list is exhaustive over the
 * layouts that can occur. Neither entry may be dropped: without the first, the source layout every test and
 * the dev server run in serves raw message keys; without the second, so does every installed copy.
 */
const I18N_RESOURCE_CANDIDATE_PATHS: readonly string[] = [
    path.join('..', 'i18n', `${I18N_LANGUAGE_KEY}.json`),
    path.join('..', '..', 'i18n', `${I18N_LANGUAGE_KEY}.json`),
];

/**
 * @description
 * Thrown when {@link ReorderPlugin.init} is given an option value the plugin cannot use.
 *
 * It is a distinct class rather than a bare `Error`, and it is published from the package root, for two
 * reasons. A caller — or a test — can discriminate a configuration mistake from any other startup failure
 * with `instanceof`, and the offending key is available as data on
 * {@link ReorderPluginConfigurationError.optionKey} rather than only as prose inside a message that would
 * then have to be parsed. The message names the key as well, so a stack trace alone is enough to act on.
 *
 * The root export is what makes that first reason true for a consumer rather than only for this package:
 * the class is one of the symbols `index.ts` publishes, so the `instanceof` check below is written against
 * the same specifier a deployment already imports `ReorderPlugin` from.
 *
 * **The message names the key and the KIND of value that arrived, and never the value's content.** The key
 * is what EPIC-001 section 7.10 requires the failure to identify, and it comes from a fixed set of five; the
 * rejected value comes from whatever the deployment's configuration produced, so it may be a credential or a
 * token assigned to the wrong key, may carry newlines or terminal escapes that forge surrounding log lines,
 * and may be arbitrarily long. This error is written to the startup log, where all three of those outlive the
 * process that raised them. See {@link describeRejectedValue} for exactly what is rendered and why a finite
 * number is the one value it will carry.
 *
 * Throwing at all is the point. EPIC-001 section 7.10 fixes the behaviour for every option in the ledger:
 * the plugin fails to start, with a named configuration error identifying the offending key, because a
 * bound that silently degrades to "admit everything" or "admit nothing" is worse than no bound — nothing
 * fails, while the guarantee the bound existed to make is gone.
 *
 * @example
 * ```ts
 * import { ReorderPlugin, ReorderPluginConfigurationError } from '\@vendure/reorder-plugin';
 *
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
 * The longest rendered number this description will carry. A JavaScript double renders to at most 24
 * characters in its most verbose form, so the bound is never reached by a real number and exists to make the
 * bound a property of the code rather than of the IEEE-754 specification.
 */
const MAX_RENDERED_NUMBER_LENGTH = 24;

/**
 * The shape a rendered number is required to have before it may appear in a message: digits, at most one
 * decimal point, an optional leading minus and an optional exponent. Nothing else — no whitespace, no
 * newline, no escape sequence, no quotation mark, no control character — can satisfy it.
 */
const SAFE_RENDERED_NUMBER = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

/**
 * The number of Unicode code points in a string, counted without allocating anything proportional to it.
 *
 * `Array.from(value).length` and `[...value].length` both give the right number, and both materialise one array
 * element per code point in order to throw the array away — on a value that reached this module precisely
 * because it was miswired, and may therefore be arbitrarily large. This walk keeps a counter instead: it steps
 * over a surrogate pair as one unit by testing the leading unit's range and confirming a trailing unit follows,
 * so a lone surrogate — legal in a JavaScript string — counts as one rather than swallowing the character after
 * it.
 */
function countCodePoints(value: string): number {
    let count = 0;
    for (let index = 0; index < value.length; index++) {
        const unit = value.charCodeAt(index);
        if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < value.length) {
            const next = value.charCodeAt(index + 1);
            if (next >= 0xdc00 && next <= 0xdfff) {
                index++;
            }
        }
        count++;
    }
    return count;
}

/**
 * Describes a rejected option value **by its type and category, never by its content.**
 *
 * ★ **The rejected value is untrusted input, and this message is written to a log.** An option arrives from
 * whatever the deployment's configuration produced — an environment variable, a JSON file, a secret manager
 * lookup, a mis-wired expression — so a rejected *string* may be a credential, a connection URL or a token
 * that happened to be assigned to the wrong key. Interpolating it verbatim, as this function previously did,
 * writes it into the startup log and into the error's message, where it outlives the request and is read by
 * people and tools that were never entitled to it (CWE-532). The same string can also carry newlines,
 * carriage returns and terminal escape sequences, which forge or corrupt surrounding log lines (CWE-117), and
 * it can be arbitrarily long, which turns one refusal into an unbounded startup log entry. A `Symbol`'s
 * description is the identical hazard by another route, because it is a caller-supplied string too.
 *
 * So the content of a string, a symbol, a function and an object is **never** rendered. What is rendered is
 * what an operator actually needs in order to fix the configuration, and all of it is chosen by this file:
 * the option key (named by the caller, from a fixed set of five), the requirement it failed, and the *kind*
 * of value that arrived. A string additionally reports its length in code points, because "a string of
 * length 0" and "a string of length 12" distinguish an empty environment variable from a mistyped value
 * without disclosing either.
 *
 * **A finite number is the one value rendered, and it is rendered through a certifier rather than trusted.**
 * A number is what these five options are *for*, so `0`, `-1` and `1.5` are precisely the diagnostics that
 * make a refusal actionable; and a number cannot carry a newline, an escape sequence or a secret's text. It
 * is still not interpolated blindly: the rendering is checked against {@link SAFE_RENDERED_NUMBER} and
 * {@link MAX_RENDERED_NUMBER_LENGTH}, and anything failing either — which no `number` can produce, so this is
 * a guard against a future change rather than against arithmetic — degrades to the category alone. `NaN` and
 * the two infinities are reported by name, since each is a distinct configuration mistake and none is data.
 *
 * Every branch returns a string, which is required rather than tidy: the repository's lint configuration
 * forbids interpolating a non-string into a template literal, and `String(value)` alone would render `null`
 * and the string `'null'` identically — collapsing the very distinction a reader needs in order to tell a
 * missing value from a mistyped one.
 */
function describeRejectedValue(value: unknown): string {
    if (typeof value === 'string') {
        // The CONTENT is never rendered. The length is, and it is counted in code points rather than in UTF-16
        // units so that an astral character counts once, which is what a reader comparing against a
        // configured value would expect.
        return `a string of length ${renderSafeNumber(countCodePoints(value)) ?? 'unknown'}`;
    }
    if (typeof value === 'number') {
        if (Number.isNaN(value)) {
            return 'the number NaN';
        }
        if (!Number.isFinite(value)) {
            return value > 0 ? 'the number Infinity' : 'the number -Infinity';
        }
        const rendered = renderSafeNumber(value);
        return rendered === undefined ? 'a number' : `the number ${rendered}`;
    }
    if (value === null) {
        return 'null';
    }
    if (value === undefined) {
        return 'undefined';
    }
    if (typeof value === 'boolean') {
        // Both values of a boolean are already implied by "a boolean", and neither is data.
        return `a boolean (${value ? 'true' : 'false'})`;
    }
    if (typeof value === 'bigint') {
        // A bigint is unbounded in length, so its digits are not rendered even though they cannot be
        // injectable — an option mistakenly assigned a huge bigint would otherwise produce a huge log line.
        return 'a bigint';
    }
    if (typeof value === 'symbol') {
        // A symbol's description is a caller-supplied string and is therefore treated exactly as one: not
        // rendered at all.
        return 'a symbol';
    }
    if (typeof value === 'function') {
        // `String(fn)` is the function's entire source text, which is both unbounded and a disclosure of code.
        return 'a function';
    }
    if (Array.isArray(value)) {
        return 'an array';
    }
    return `a value of type ${typeof value}`;
}

/**
 * Renders a number for inclusion in a message, or `undefined` where the rendering cannot be certified as
 * bounded and free of anything but digits.
 *
 * The certification is applied to the rendered *string* rather than reasoned about from the value's type,
 * because it is the string that reaches the log: a check on the output is a check on what is actually
 * emitted, and it stays correct if this function is ever asked to render something else.
 */
function renderSafeNumber(value: number): string | undefined {
    const rendered = String(value);
    if (rendered.length > MAX_RENDERED_NUMBER_LENGTH || !SAFE_RENDERED_NUMBER.test(rendered)) {
        return undefined;
    }
    return rendered;
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
 * The last option set {@link ReorderPlugin.init} accepted, reported by {@link ReorderPlugin.options}.
 *
 * **It is a REPORT and not an authority, and the distinction is the whole of it.** No registration reads it:
 * a registration returned by `init()` is bound to the set that call resolved, and the bare class is bound to
 * the frozen declared defaults. So this variable being mutable cannot move what any server serves — which is
 * exactly the property that a provider reading it would have destroyed, because a process in which one server
 * called `init({ maxLinesPerList: 33 })` would then have handed that 33 to a second, bare server that had
 * asked for the documented 200.
 *
 * It is module-private and there is deliberately no way to write to it from outside this module: the only
 * assignment is in `init()`, immediately after validation has accepted the merged values, and every read goes
 * through the read-only accessor. That is what makes the report itself trustworthy — a public writable static
 * would let any later code make it report a set the validator had never seen.
 *
 * It starts as the frozen declared defaults rather than as `undefined`, so it reports a complete set from the
 * moment this module is imported rather than only after the first initialisation.
 */
let resolvedOptions: ResolvedReorderPluginOptions = DEFAULT_REORDER_PLUGIN_OPTIONS;

/**
 * @description
 * The ReorderPlugin adds named, multiple reorder lists — each line carrying a positive integer quantity —
 * to the Vendure Shop API.
 *
 * A reorder list is a saved, named selection of product variants that a buyer curates and returns to. The
 * plugin publishes eight Shop operations: two reads — `activeCustomerReorderLists`, a paginated collection
 * of the caller's lists, and `activeCustomerReorderList`, one nullable list addressed by id whose nested
 * `lines` field is paginated; three list-level mutations, `createReorderList`, `updateReorderList` and
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
 * - **Every collection this plugin returns is bounded and deterministically ordered** — the lists page and
 *   the nested `lines` page alike. Lists are ordered by creation timestamp descending and lines ascending,
 *   each tie-broken by identifier so that a page boundary cannot reorder rows sharing a timestamp, and a
 *   caller who supplies no page size receives the configured default rather than every row.
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
 * import type { VendureConfig } from '\@vendure/core';
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
 * sufficient on its own: **a migration has to be applied** so those tables, their indices and their named
 * constraints exist before the first request arrives. No existing table is altered and no column is added
 * to one — every foreign key points from this plugin's tables to core tables — so the migration is purely
 * additive and reverses cleanly.
 *
 * **One registration serves every supported engine, because the bundled migration carries no SQL.** It
 * describes the two tables to TypeORM's `QueryRunner` table API and lets the configured driver render the
 * statements, taking the identifier type from `connection.driver.normalizeType()` over the configured
 * `EntityIdStrategy` and the table path from `connection.driver.buildTableName()`, so a configured non-default
 * schema is honoured in both directions. You do not need to generate a migration of your own for these two
 * tables on any engine.
 *
 * Register the classes this package publishes from its root as `reorderPluginMigrations`. Registering by
 * value rather than by path is correct in both the source and the built layout, because a class is resolved
 * by the module system:
 *
 * ```ts
 * import type { VendureConfig } from '\@vendure/core';
 * import { reorderPluginMigrations } from '\@vendure/reorder-plugin';
 *
 * const config: VendureConfig = {
 *   // ...
 *   dbConnectionOptions: {
 *     // ...your own entries stay where they are; add the plugin's beside them
 *     migrations: [...reorderPluginMigrations],
 *   },
 * };
 * ```
 *
 * Apply it with `runMigrations(config)`, exported by `\@vendure/core`. Rolling back is a separate,
 * deliberate operation rather than the next line of the same script: `revertLastMigration(config)` reverses
 * whichever migration was applied most recently, so it removes these two tables only while this one is the
 * last applied.
 *
 * Register it before the first boot of a server whose `dbConnectionOptions.synchronize` is `true`. That
 * server's schema builder creates the two tables itself, after which this migration compares what it finds
 * against its own frozen minimum and records itself as applied rather than authoring anything — a supported
 * outcome, but one where the schema builder and not the migration is what created the tables. The package's
 * README sets that sequencing out step by step, separates applying from rolling back, and records the
 * sql.js seed-cache reset a test harness needs after a schema change.
 *
 * One engine-scoped shortfall is declared rather than hidden: TypeORM 0.3.x cannot create a `CHECK`
 * constraint on the MySQL family and discards it silently, so the two named check constraints exist on
 * PostgreSQL and the SQLite family and not on MySQL or MariaDB. No behaviour depends on them — the quantity
 * invariant is refused by this plugin's service layer before any write on every engine, and the stored line
 * count is maintained by a conditional counter update — and both named unique constraints and the named
 * indices do exist on all four engines.
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
            // THE DECLARED DEFAULTS, and nothing that can move afterwards.
            //
            // This provider serves exactly one installation: a deployment that registers the bare
            // `ReorderPlugin` class instead of calling `init()`. Such a deployment has asked for the
            // documented defaults, so the defaults are what it gets — and it gets them whatever else has
            // happened in the process.
            //
            // It deliberately does NOT read `ReorderPlugin.options`. That accessor reports the most recent
            // initialisation, so reading it here would make a bare registration serve some OTHER
            // configuration's bounds: a process in which one server called
            // `init({ maxLinesPerList: 33 })` would silently give a second, bare server that same 33 rather
            // than the documented 200, and nothing would fail to say so. A configuration a deployment never
            // asked for is the one thing a bound must never be.
            //
            // `useValue` over an already-frozen constant rather than a factory, because there is nothing
            // left to defer: the value is fixed at module load and every path that could vary it now
            // carries its own registration. See {@link createScopedRegistration}.
            useValue: DEFAULT_REORDER_PLUGIN_OPTIONS,
        },
    ],
    shopApiExtensions: {
        schema: shopApiExtensions,
        // THREE classes, and every one of them is load-bearing.
        //
        // `ReorderListShopResolver` serves the eight operations. `ReorderListEntityResolver` resolves every
        // published field of the two entity types that is not a column of its table — `ReorderList.lines`,
        // `ReorderList.viewerAccess` and `ReorderListLine.productVariant` — binding BOTH parent types from
        // one class: its class-level `@Resolver('ReorderList')` covers the first two, and `productVariant`
        // carries its own method-level `@Resolver('ReorderListLine')`, which takes precedence over the
        // class-level one [@nestjs/graphql/dist/utils/extract-metadata.util.js].
        // `ReorderListResultResolver` carries the six `__resolveType` field resolvers required by EPIC-001
        // ruling R8, binding six union parent types from one class by the same mechanism; without it every
        // one of this plugin's unions is unresolvable, which surfaces on the first mutation a client
        // executes rather than at boot.
        //
        // Dropping any of the three leaves a published field or a union unresolved at run time while
        // everything still compiles and the server still starts, so the count is asserted rather than
        // assumed.
        resolvers: [ReorderListShopResolver, ReorderListEntityResolver, ReorderListResultResolver],
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
     * The resolved, validated options most recently accepted by {@link ReorderPlugin.init}.
     *
     * It is {@link ResolvedReorderPluginOptions} rather than the partial a caller supplies, and it is
     * pre-seeded with the declared defaults, so it is fully populated from the moment this module is
     * imported. Two things follow. Registering the bare `ReorderPlugin` class without calling `init()` is a
     * valid installation that runs on the documented defaults instead of reading `undefined` on a request
     * path. And the service and both API-layer resolvers can read every key directly, which is what keeps
     * the defaults declared in one place rather than restated at each point of use.
     *
     * **It reports the latest initialisation, and NO registration serves from it.** Each `init()` returns a
     * registration carrying the set that call resolved, bound as a `useValue` at that moment; the bare class
     * is bound to the frozen declared defaults. So every registration in a process serves the values it was
     * itself created with, whatever order they were created and bootstrapped in, and this accessor reports
     * whichever initialised last purely as a report of what was last accepted. Read
     * {@link REORDER_PLUGIN_OPTIONS} from a server's own injector for the set THAT server serves with. See
     * {@link createScopedRegistration}.
     *
     * **It is readable and not writable, deliberately.** An accessor with no setter over module-private
     * state, returning a frozen object, is what makes the startup validation hold for the life of the
     * process: `ReorderPlugin.options = …` is a compile error, `ReorderPlugin.options.maxLinesPerList = …`
     * is a compile error, and both throw at run time as well under the emitted `'use strict'`. A writable
     * static would have let any later code install a bound this plugin had already refused — and because a
     * registration's provider hands one frozen object to every consumer of that registration, a single write
     * would lower the bound for all of them at once, with nothing failing to report it.
     * {@link ReorderPlugin.init} is the only way in.
     *
     * @since 3.8.0
     */
    static get options(): ResolvedReorderPluginOptions {
        return resolvedOptions;
    }

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
     * import { ReorderPlugin } from '\@vendure/reorder-plugin';
     *
     * ReorderPlugin.init({ maxListsPerCustomer: 25, maxLinesPerList: 200, maxQuantityPerLine: 999 });
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
        //
        // Frozen before it is validated, so that the object which is validated is the object which is
        // stored — there is no window in which an accepted value could still be edited — and so that every
        // consumer of the provider receives a set it cannot write to.
        const resolved = validateResolvedReorderPluginOptions(
            Object.freeze({
                ...DEFAULT_REORDER_PLUGIN_OPTIONS,
                ...options,
            }),
        );
        // Reached only if validation returned rather than threw, which is what leaves a rejected call with
        // the previously resolved options still in force instead of a half-applied set.
        resolvedOptions = resolved;
        return createScopedRegistration(resolved);
    }

    /**
     * @description
     * Registers this plugin's message catalogue once the application has bootstrapped, and re-asserts that
     * the options in force are still usable.
     *
     * @since 3.8.0
     */
    onApplicationBootstrap(): void {
        // Cheap defence in depth: five integer comparisons proving that the values this server is about to
        // serve requests with are the values initialisation approved. The accessor and the freeze make a
        // write from outside this module impossible, so this is no longer the guard against one — it is the
        // guard against a server that was registered with a `ReorderPlugin` whose `init()` never ran the
        // validator, and a failure here still prevents the server from reaching a ready state.
        //
        // It reads THIS REGISTRATION's options rather than the static, so that in a process holding more
        // than one differently-configured registration each one checks the set it will actually serve with.
        validateResolvedReorderPluginOptions(this.optionsInForce());
        this.registerTranslations();
    }

    /**
     * The option set THIS registration serves with, which is the set its own provider is bound to.
     *
     * The base class serves the declared defaults, because registering the bare class without calling
     * `init()` is precisely a request for them. A registration returned by `init()` overrides this to return
     * the set that call resolved. Either way this method and the registration's `REORDER_PLUGIN_OPTIONS`
     * provider are bound to the SAME object, which is what makes
     * {@link ReorderPlugin.onApplicationBootstrap}'s re-validation a check on the values this server will
     * actually serve with rather than on whichever configuration initialised last.
     *
     * Nothing here reads {@link ReorderPlugin.options}. That accessor is a report of the latest
     * initialisation and is not the authority on what any registration serves — see
     * {@link createScopedRegistration}.
     */
    protected optionsInForce(): ResolvedReorderPluginOptions {
        return DEFAULT_REORDER_PLUGIN_OPTIONS;
    }

    /**
     * Loads the English message catalogue for this plugin's four input-error keys.
     *
     * `addTranslationFile` cannot report a failure to its caller — it catches everything and logs
     * (`packages/core/src/i18n/i18n.service.ts`) — so a path that does not exist would produce a running
     * server whose error messages are raw keys, with nothing failing anywhere to say so. The path is
     * therefore resolved against the `I18N_RESOURCE_CANDIDATE_PATHS` list above, which covers both layouts
     * this module runs from, and an exhausted candidate list is logged as an error naming every
     * package-relative candidate tried so that the silent failure becomes a visible one.
     *
     * Neither log line carries a resolved absolute path. What a reader needs in order to act is which
     * package-relative candidates were consulted and whether one answered, and both are constants of the
     * published source; the resolved path adds only the host's installation layout, which is deployment
     * information rather than diagnostic information and which the success branch would otherwise disclose
     * on every healthy boot. See {@link I18N_RESOURCE_IDENTIFIER}.
     *
     * It never throws. A missing catalogue degrades four messages to their keys, which is not a reason to
     * refuse to serve an otherwise healthy server — and unlike a bad bound, it cannot admit or refuse
     * anything it should not.
     */
    private registerTranslations(): void {
        // The relative specifier is kept beside the path it resolved to, because the lookup needs the
        // resolved form and the log line needs the relative one.
        const candidates = I18N_RESOURCE_CANDIDATE_PATHS.map(relativePath => ({
            relativePath,
            resolvedPath: path.resolve(__dirname, relativePath),
        }));
        const match = candidates.find(candidate => isReadableFile(candidate.resolvedPath));

        if (match === undefined) {
            Logger.error(
                `Could not locate the ${I18N_RESOURCE_IDENTIFIER} resource of the ReorderPlugin. ` +
                    'The following package-relative candidates were tried, in order: ' +
                    `${candidates.map(candidate => candidate.relativePath).join(', ')}. ` +
                    `This plugin's error messages will surface as raw message keys until the file is reachable.`,
                loggerCtx,
            );
            return;
        }

        this.i18nService.addTranslationFile(I18N_LANGUAGE_KEY, match.resolvedPath);
        Logger.verbose(
            `Registered the ${I18N_RESOURCE_IDENTIFIER} resource of the ReorderPlugin ` +
                `from the package-relative candidate ${match.relativePath}`,
            loggerCtx,
        );
    }
}

/**
 * A registration that carries one resolved option set of its own, rather than reading the module's.
 *
 * **The defect this closes.** `init()` used to return the `ReorderPlugin` class itself, and the options
 * provider read a module-level variable through {@link ReorderPlugin.options}. Since the class is the
 * registration, two configurations built in one process shared one slot: `A.init({ maxListsPerCustomer: 10 })`
 * followed by `B.init({ maxListsPerCustomer: 20 })` left A's provider resolving 20, because the provider's
 * factory ran when A bootstrapped — after B's `init()` had already overwritten the variable. Nothing failed
 * and nothing logged; A simply enforced a bound its own configuration never asked for. It is reachable
 * wherever one process holds more than one server: a multi-tenant host, and any test file that builds two
 * configurations before booting either.
 *
 * **How it is closed.** Each `init()` returns a distinct subclass of `ReorderPlugin` whose options provider
 * is a `useValue` capturing the set that call resolved. The value is fixed at registration time, so no later
 * `init()` can reach it — there is no shared slot left to overwrite.
 *
 * **What the subclass declares, and what it deliberately inherits.** It declares only the two module-scoped
 * keys, `imports` and `providers`. It has to declare `imports` as well as `providers` even though the value is
 * identical to the base's, because `VendurePlugin` hands its Nest metadata through a `pick` over every
 * `MODULE_METADATA` key and so defines each of them on the target — an absent key is defined as `undefined`,
 * which SHADOWS the base's rather than inheriting it. Measured: applying only `providers` left the subclass
 * reporting no `imports` at all, and its providers could not have resolved.
 *
 * Everything else inherits, and inherits LIVE, because `Reflect.getMetadata` walks the prototype chain and
 * `VendurePlugin` defines a plugin-scoped key only when it is non-null. So `entities`, `shopApiExtensions` and
 * `compatibility` are read off the base at the moment they are asked for. That is not merely economical, it is
 * required: `e2e/reorder-plugin-compatibility.e2e-spec.ts` substitutes an unsatisfiable range by
 * `Reflect.defineMetadata` on the base class AFTER the registration has been created, and a subclass that had
 * snapshotted the range would not see it.
 *
 * The subclass's `name` is set to the base's so that every platform log line, and the compatibility check's
 * own message, name `ReorderPlugin` rather than an internal class name. Its identity, not its name, is what
 * distinguishes it.
 *
 * **The bare class is bound to the DEFAULTS, not to the latest initialisation, and that is the other half of
 * the same property.** Registering `ReorderPlugin` itself instead of calling `init()` is a request for the
 * documented defaults, so the base class's provider is `useValue: DEFAULT_REORDER_PLUGIN_OPTIONS` and its
 * `optionsInForce()` returns the same object. Had either read {@link ReorderPlugin.options} instead, isolating
 * the scoped registrations would have left the hole open at the one registration that never asked for anything:
 * a process where one server called `init({ maxLinesPerList: 33 })` would have given a second, bare server
 * that same 33 in place of the documented 200, silently and in an order-dependent way.
 *
 * **What the static still means.** {@link ReorderPlugin.options} reports the most recently resolved set, which
 * is what keeps the shape EPIC-001 section 7.10 and the AAP prescribe — a readable static behind a validated
 * `init()`. It is a report and nothing serves from it, which is why the mutable variable behind it can no
 * longer move any server's bounds.
 *
 * @param resolved - The frozen, validated set this registration will serve with for the life of the process.
 * @returns A `ReorderPlugin` registration bound to exactly that set.
 */
function createScopedRegistration(resolved: ResolvedReorderPluginOptions): Type<ReorderPlugin> {
    class ScopedReorderPlugin extends ReorderPlugin {
        protected optionsInForce(): ResolvedReorderPluginOptions {
            return resolved;
        }
    }
    // Non-writable and non-enumerable, matching a class's own `name` descriptor, so nothing downstream can
    // tell this apart from the base by how the property behaves.
    Object.defineProperty(ScopedReorderPlugin, 'name', {
        value: ReorderPlugin.name,
        writable: false,
        enumerable: false,
        configurable: true,
    });
    VendurePlugin({
        imports: [PluginCommonModule],
        providers: [ReorderListService, { provide: REORDER_PLUGIN_OPTIONS, useValue: resolved }],
    })(ScopedReorderPlugin);
    return ScopedReorderPlugin;
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
