/*
 * The ReorderPlugin class — provenance, the two deliberate departures, and the one quiet failure mode.
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
 */

import { OnApplicationBootstrap } from '@nestjs/common';
import {
    ConfigService,
    I18nService,
    Logger,
    PluginCommonModule,
    Type,
    VENDURE_VERSION,
    VendurePlugin,
} from '@vendure/core';
import fs from 'fs';
import path from 'path';

import { shopApiExtensions } from './api/api-extensions';
import { ReorderListEntityResolver } from './api/reorder-list-entity.resolver';
import { ReorderListResultResolver } from './api/reorder-list-result.resolver';
import { ReorderListShopResolver } from './api/reorder-list-shop.resolver';
import { loggerCtx, REORDER_PLUGIN_OPTIONS } from './constants';
import { ReorderListLine } from './entities/reorder-list-line.entity';
import { ReorderList } from './entities/reorder-list.entity';
import { AddReorderLists1786838400000 } from './migrations/1786838400000-add-reorder-lists';
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
 * The engines on which TypeORM 0.3.x discards a named `CHECK` constraint instead of creating it.
 *
 * A fact about the object-relational mapper rather than about any deployment: `RdbmsSchemaBuilder.createNewChecks()`
 * returns early for this family (L694-L698), `dropOldChecks()` carries the identical guard (L333-L337), all four
 * check-constraint methods on `MysqlQueryRunner` throw (L1153-L1172), and `MysqlQueryRunner.createTableSql` never
 * reads `table.checks`. The engines themselves support `CHECK` — MySQL from 8.0.16 and MariaDB from 10.2.1 — so the
 * shortfall travels with the mapper version, not with the server. The same list is declared in the migration for
 * the same reason.
 */
const CHECK_LESS_ENGINES: readonly string[] = ['mysql', 'mariadb'];

/**
 * The two named check constraints both entities declare and this family does not receive.
 *
 * Named exactly, because the name is what an operator greps for in a catalogue and what a later migration would
 * have to create.
 */
const DECLARED_CHECK_CONSTRAINTS: readonly string[] = [
    'CHK_reorder_list_line_quantity_positive on reorder_list_line ("quantity" > 0)',
    'CHK_reorder_list_line_count_non_negative on reorder_list ("lineCount" >= 0)',
];

/**
 * The earliest platform release carrying the fixes for the advisories named in {@link PLATFORM_ADVISORIES}.
 *
 * Kept as the release triple rather than a range string so the comparison below needs no dependency, and
 * declared here rather than inside the check so that a later bump is one edit in one place.
 */
const PLATFORM_SECURITY_FLOOR: readonly [number, number, number] = [3, 7, 2];

/**
 * The published advisories against platform releases earlier than {@link PLATFORM_SECURITY_FLOOR}.
 *
 * Identifiers only, with each one's severity, because an identifier is what an operator can look up and a
 * paraphrase of the vulnerability would age badly and could mislead. All four were fixed in the same patch
 * release, which is why one floor covers them.
 */
const PLATFORM_ADVISORIES: readonly string[] = [
    'GHSA-v85r-wfgv-jcqc (critical)',
    'GHSA-hc75-2v4j-x372 (high)',
    'GHSA-fp4j-ff6j-9793 (moderate)',
    'GHSA-rgjm-ff27-p2hf (moderate)',
];

/**
 * The complete Semantic Versioning 2.0.0 grammar, as one anchored expression.
 *
 * **Transcribed from the specification, not invented here.** This is the expression semver.org publishes in its
 * own FAQ as the official suggested regular expression for a valid version, with its two capture groups kept
 * (pre-release, then build metadata) and its named groups reduced to positional ones. It is quoted rather than
 * approximated because the grammar has three requirements a permissive `\d+\.\d+\.\d+` shape silently drops,
 * and each of them lets a *syntactically invalid* version be read as a later release than it is:
 *
 * - **A core identifier may not carry a leading zero** (clause 2: `0 | [1-9]\d*`). Without this, `03.8.0` reads
 *   as major 3 and is treated as carrying the fixes.
 * - **Every dot-separated identifier must be non-empty** (clauses 9 and 10). Without this, `3.8.0-..` and
 *   `3.8.0+.` both parse.
 * - **A NUMERIC pre-release identifier may not carry a leading zero either**, while a build identifier may —
 *   which is why the two halves of this expression are deliberately different: `(?:0|[1-9]\d*|\d*[a-zA-Z-]
 *   [0-9a-zA-Z-]*)` for pre-release against `[0-9a-zA-Z-]+` for build.
 *
 * A version this expression rejects is not "probably fine": it is a string whose ordering against any other
 * version is undefined, so {@link assessPlatformSecurityPosture} reports it as unassessable rather than
 * guessing. That is the whole reason the grammar is validated before any comparison happens.
 */
const SEMVER_2_0_0 = new RegExp(
    // <version core>: three numeric identifiers, none of which may carry a leading zero.
    '^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)' +
        // Optional <pre-release>: dot-separated identifiers, each either a leading-zero-free numeric
        // identifier or an alphanumeric one carrying at least one non-digit. None may be empty.
        '(?:-((?:0|[1-9]\\d*|\\d*[a-zA-Z-][0-9a-zA-Z-]*)' +
        '(?:\\.(?:0|[1-9]\\d*|\\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?' +
        // Optional <build>: dot-separated identifiers which MAY carry leading zeros, and none of which may
        // be empty. This is the one place the two halves of the grammar deliberately differ.
        '(?:\\+([0-9a-zA-Z-]+(?:\\.[0-9a-zA-Z-]+)*))?$',
);

/**
 * What can be said about a platform version's relation to {@link PLATFORM_SECURITY_FLOOR}.
 *
 * Three outcomes rather than a boolean, because a boolean cannot distinguish "this release precedes the fixes"
 * from "this build precedes the fixed release but may contain them" from "this string cannot be read at all",
 * and a security signal that collapses those into one claim is either wrong or silent about something it
 * should say.
 */
export type PlatformSecurityPosture = 'affected' | 'unproven-prerelease' | 'unassessable' | 'fixed';

/**
 * Decides what may honestly be said about a platform version's patch posture.
 *
 * **The version is validated against the full Semantic Versioning 2.0.0 grammar before anything is compared.**
 * Precedence is defined only between two *valid* versions, so a string the grammar rejects has no position
 * relative to the floor and gets `'unassessable'`. That ordering matters in one direction in particular: a
 * malformed string that merely looks later than the floor would otherwise suppress the warning outright. See
 * {@link SEMVER_2_0_0} for the three requirements a permissive shape drops and what each one lets through.
 *
 * Deliberately not delegated to `semver`. This package declares no runtime dependency of its own — the whole
 * of AAP section 0.3.1 rests on that — so the grammar is transcribed from the specification and the comparison
 * is a dozen lines, rather than the package's dependency posture changing to answer this one question.
 *
 * **Semantic-version precedence is honoured, including for pre-releases.** Semver clause 9 puts a pre-release
 * below its own release, so `3.7.2-rc.1` PRECEDES `3.7.2` and is not proven to carry the fixes; it is reported
 * `'unproven-prerelease'` rather than `'fixed'`. A pre-release of a LATER release is a different case:
 * `3.8.0-alpha.2` still orders above `3.7.2`, so it does carry them and is reported `'fixed'`. Build metadata
 * is ignored, which is also what clause 10 requires — `3.7.2+build.5` is `3.7.2`.
 *
 * **An unreadable version is reported as such rather than as either answer.** Calling it affected would assert
 * a vulnerability from ignorance; calling it fixed would assert the opposite from the same ignorance. Neither
 * belongs in a startup log, so the third outcome exists to say plainly that the posture could not be
 * determined and must be checked by hand.
 *
 * Exported for `src/reorder.plugin.spec.ts` and deliberately absent from the package's root barrel, so it is
 * package-internal rather than a published API. The decision it makes is a table, and a table is worth driving
 * directly instead of inferring from log output.
 *
 * @param version - The value of `VENDURE_VERSION`, or any string in its shape.
 * @returns Which of the four things can honestly be said about it.
 */
export function assessPlatformSecurityPosture(version: string): PlatformSecurityPosture {
    // GRAMMAR FIRST, PRECEDENCE SECOND, AND IN THAT ORDER FOR A REASON. Precedence is only defined between two
    // VALID versions, so comparing a malformed string is comparing something whose position is undefined — and
    // every way of getting that wrong errs towards silence, because a malformed string that merely looks later
    // than the floor would suppress the warning entirely. Surrounding whitespace is removed before validating,
    // since the value arrives from a published manifest and a stray space is not a grammar violation.
    const parts = SEMVER_2_0_0.exec(version.trim());
    if (parts === null) {
        return 'unassessable';
    }
    const release = [Number(parts[1]), Number(parts[2]), Number(parts[3])] as const;
    const isPrerelease = parts[4] !== undefined;
    for (let position = 0; position < PLATFORM_SECURITY_FLOOR.length; position++) {
        if (release[position] !== PLATFORM_SECURITY_FLOOR[position]) {
            // A pre-release of a release BELOW the floor is affected twice over, so the release comparison
            // alone settles it in both directions here.
            return release[position] < PLATFORM_SECURITY_FLOOR[position] ? 'affected' : 'fixed';
        }
    }
    // Exactly the floor's release triple. Without a pre-release suffix this IS the first fixed release; with
    // one it precedes it, and nothing establishes that the build already carried every fix.
    return isPrerelease ? 'unproven-prerelease' : 'fixed';
}

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
 * that happened to be assigned to the wrong key. Interpolating it verbatim would write it into the startup
 * log and into the error's message, where it outlives the request and is read by
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
 * Register the classes this package publishes from its root as {@link reorderPluginMigrations}. Registering
 * by value rather than by path is correct in both the source and the built layout, because a class is
 * resolved by the module system:
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
 * Register it before the first boot of a server whose `dbConnectionOptions.synchronize` is `true`. Boot such
 * a server first and its schema builder creates the two tables from the entity metadata, after which the
 * migration has nothing left to create and applying it fails on the tables already existing. The package's
 * README sets that sequencing out step by step, separates applying from rolling back, and records the sql.js
 * seed-cache reset a test harness needs after a schema change.
 *
 * **The shipped migration is PostgreSQL DDL, and that is a property of how it is produced rather than a
 * choice.** It is the output of Vendure's own migration generator, which serialises the statements one
 * configured engine emits, so the artefact is bound to that engine. Deploying on PostgreSQL applies the
 * shipped file as it stands. Deploying on MySQL, MariaDB or SQLite means generating the equivalent file for
 * that engine from these same two entity classes, by the invocation the migration's own header records; the
 * entities, the tables and the column names are the same either way. A server with `synchronize` enabled
 * needs no migration at all, which is the path the test harnesses take.
 *
 * **What a generated file actually creates differs by engine, and the difference is declared rather than
 * hidden.** The two entity classes declare five named database objects. A file generated for PostgreSQL or
 * the SQLite family creates all five. A file generated for MySQL or MariaDB creates **three** — the two
 * named unique constraints, as named unique indices, and the named index — and neither named check
 * constraint, because TypeORM 0.3.x cannot create a `CHECK` on that family and discards the declaration
 * silently.
 *
 * No behaviour of this plugin depends on the two missing constraints, and the reason differs by write path
 * rather than being uniform, so it is stated per path:
 *
 * - **Every** path that can set `quantity` or `lineCount` validates the RESULTING value in process before it
 *   writes, refusing a non-integer, a non-positive quantity or one above `maxQuantityPerLine` with a top-level
 *   `USER_INPUT_ERROR`, and refusing a counter total that is not a non-negative integer outright.
 * - **Three** of them additionally carry the bound as a value predicate in their OWN statement, so the
 *   database evaluates it on all four engines: `quantity <= maxQuantityPerLine - increment` on the
 *   accumulating add, `lineCount < maxLinesPerList` on the capacity claim, `lineCount > 0` on the release.
 * - **Three do not**, and their statements carry ownership and identity conjuncts only: the line insert, the
 *   absolute quantity set of `adjustReorderListLine`, and the counter compare-and-set repair. On PostgreSQL
 *   and the SQLite family the check constraint is what would have refused a bad value from those; on MySQL and
 *   MariaDB the in-process guard is the only thing that does.
 *
 * What is therefore genuinely lost on MySQL and MariaDB is the last line of defence against a write that does
 * not go through this service at all — direct SQL, another application sharing the schema, or a future code
 * path that bypasses the guards — and, for those three paths, the database-side backstop behind the in-process
 * guard. The package README states the consequence in full, and the gap is the unresolved conflict C-E.
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
    //
    // ‼ IT IS A COMPATIBILITY STATEMENT AND NOT A SECURITY ENDORSEMENT, and the difference is worth stating
    // here because the two are easy to read as one. What this range asserts is which platform versions this
    // plugin's own code is built against and will boot on. It asserts nothing about whether a given version
    // in that range carries current security fixes, and it cannot: the mechanism only refuses versions BELOW
    // the floor, so no value here protects a deployment from running an outdated platform. Vendure's own
    // 3.7.2 patch release fixes four reported vulnerabilities (one critical, one high, two medium) affecting
    // 3.7.0, which is the version of this workspace — so a deployment should be on a release carrying those
    // fixes regardless of what this string says, and the package README says so in terms.
    //
    // Raising the floor to exclude the affected line would be a SUPPORT-POLICY change rather than a fix: it
    // would refuse to boot on every 3.3 to 3.7.1 release, and the floor is fixed at the 3.3 line by
    // EPIC-001 section 7.9.2 (AAP section 0.8.4). Narrowing it therefore needs a maintainer decision, and
    // upgrading the workspace itself is outside this package's change boundary (AAP sections 0.1.2.1, 0.3.1
    // and 0.6.2.3 hold `packages/core` byte-identical and forbid any dependency or lock change). Both are
    // recorded rather than acted on unilaterally, which is what keeps the posture disclosed instead of quiet.
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
    constructor(
        private i18nService: I18nService,
        private configService: ConfigService,
    ) {}

    /**
     * @description
     * Initialises the plugin with the given options and returns a `ReorderPlugin` registration class bound
     * to this resolved option set, for the `plugins` array.
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
     * @returns A `ReorderPlugin` registration class bound to exactly this resolved option set, for
     * inclusion in the `plugins` array of your `VendureConfig`. Each call returns a distinct class, so two
     * differently configured servers in one process keep their own bounds.
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
     * Registers this plugin's message catalogue once the application has bootstrapped, re-asserts that the
     * options in force are still usable, and reports two things the deployment cannot see for itself: whether
     * this engine received the plugin's named check constraints, and the host platform's patch posture.
     *
     * The three acts are ordered by what a failure in each means. The re-validation runs first and **fails
     * closed**, because a bound this plugin cannot serve correctly must stop the server reaching a ready
     * state. The catalogue registration cannot fail the boot — a missing catalogue degrades four messages to
     * their keys. Neither warning can either, by deliberate choice: see
     * {@link ReorderPlugin.warnIfCheckConstraintsAreUnavailable} and
     * {@link ReorderPlugin.warnIfPlatformSecurityPostureIsNotEstablished} for why a plugin must not refuse to start over
     * a shortfall in the schema it is given or in its host's patch level.
     *
     * @since 3.8.0
     */
    onApplicationBootstrap(): void {
        // Cheap defence in depth: five integer comparisons proving that the values this server is about to
        // serve requests with are the values initialisation approved. The accessor and the freeze already
        // make a write from outside this module impossible, so what this guards is a server registered with
        // a `ReorderPlugin` whose `init()` never ran the validator; a failure here prevents that server from
        // reaching a ready state.
        //
        // It reads THIS REGISTRATION's options rather than the static, so that in a process holding more
        // than one differently-configured registration each one checks the set it will actually serve with.
        validateResolvedReorderPluginOptions(this.optionsInForce());
        this.registerTranslations();
        this.warnIfCheckConstraintsAreUnavailable();
        this.warnIfPlatformSecurityPostureIsNotEstablished();
    }

    /**
     * Writes one warning to the startup log when the configured engine is one TypeORM cannot create this
     * plugin's two named check constraints on.
     *
     * **What it is telling the operator, and why a document could not.** Both entities declare both checks on
     * every engine, and on PostgreSQL and the SQLite family both exist and refuse a violating write. On MySQL
     * and MariaDB TypeORM discards them silently — see {@link CHECK_LESS_ENGINES} for the exact source
     * locations — so the two invariants have no database-side backstop there. Nothing this plugin serves is
     * affected: every write path validates the resulting quantity in process before writing, the accumulating
     * add additionally carries the bound in its own statement's `WHERE`, and the counter floor lives in the
     * decrement's own predicate on all four engines. What is genuinely absent is the last line of defence
     * against a write that does not come through this plugin at all — direct SQL, another application sharing
     * the schema, a data-repair script, or a future code path below the service. Such a write can persist a
     * non-positive `quantity` or a negative `lineCount` on these two engines, and everything that reads
     * afterwards consumes it.
     *
     * That is exactly the audience a README cannot reach. A document is read once, by whoever installs the
     * package; the operator who later points a reporting job or a migration script at these tables is a
     * different person, often at a different time, and the schema they are writing to does not tell them. A
     * boot-time line in the deployment's own log does.
     *
     * **It reads configuration and issues no statement of any kind**, and its wording is bounded accordingly.
     * What `dbConnectionOptions.type` establishes is what the MAPPER does on this engine family, which is
     * decided by the mapper's version; it does not establish what is in the deployment's catalogue. An operator
     * may have provisioned both constraints by hand, and the migration's existing-table check deliberately
     * tolerates surplus objects, so a categorical "they are absent" would sometimes be false and would send a
     * correctly hardened deployment chasing a non-problem. The line therefore says they are absent *unless
     * something outside this plugin provisioned them*, and says outright that this plugin does not look.
     *
     * Reading the catalogue instead would be more precise and is deliberately not done here: it needs
     * engine-specific `information_schema` SQL on a boot path, and the wording above conveys the actionable
     * part without it. In particular this method issues **no DDL**: closing the gap rather than reporting it
     * would need engine-specific `ALTER TABLE`, which is conflict C-E option two and requires an explicit
     * maintainer ruling that has not been recorded. It reports the gap and does not attempt to close it.
     *
     * Like {@link ReorderPlugin.warnIfPlatformSecurityPostureIsNotEstablished} it warns and never refuses, for the same
     * reason: the plugin serves correctly on these engines, and declining to start would take an availability
     * decision belonging to the deployment over a shortfall the deployment may well have accepted.
     */
    private warnIfCheckConstraintsAreUnavailable(): void {
        if (!CHECK_LESS_ENGINES.includes(this.configService.dbConnectionOptions.type)) {
            return;
        }
        Logger.warn(
            `The ReorderPlugin declares two named check constraints that TypeORM does not create on ` +
                `${this.configService.dbConnectionOptions.type}, so unless something outside this plugin has ` +
                `provisioned them, this database does not have them: ` +
                `${DECLARED_CHECK_CONSTRAINTS.join('; ')}. The engine supports them; the object-relational ` +
                'mapper discards them for this family. This plugin does not read the catalogue to check, and ' +
                'issues no DDL either way — if you provisioned them yourself, they are in force and this ' +
                'line does not apply to you. Every operation this plugin serves still refuses a non-positive ' +
                'quantity and cannot drive the line counter below zero, so nothing it does is affected. What ' +
                'these constraints would add is the database-side backstop against a write that does not ' +
                'come through this plugin — direct SQL, another application sharing this schema, or a ' +
                'data-repair script — which without them can persist a non-positive quantity or a negative ' +
                'line count. If anything other than this plugin writes to reorder_list or reorder_list_line, ' +
                "either provision both constraints or treat those two invariants as that writer's " +
                'responsibility. Tracked as conflict C-E; closing it inside this package needs a maintainer ' +
                'ruling, because the only mechanism available here is engine-specific DDL that the ' +
                "project's migration policy forbids.",
            loggerCtx,
        );
    }

    /**
     * Writes one warning to the startup log unless the platform hosting this plugin is a release known to
     * carry the fixes named in {@link PLATFORM_ADVISORIES}.
     *
     * **What this is for, and what it is not.** It does not fix anything and cannot: the vulnerabilities are
     * in the platform, and this package holds no part of it — AAP sections 0.1.2.1, 0.3.1 and 0.6.2.3 hold
     * `packages/core` byte-identical and forbid any dependency or lock change, so upgrading the host is
     * outside this package's change boundary by construction. What it does is convert a passive disclosure
     * into an active one. The README and the `compatibility` comment already state the posture, but a
     * document is read once, by whoever installs the package, and possibly by nobody; a deployment that
     * inherits an old platform months later has nothing telling it so. The declared `compatibility` range
     * cannot serve either — it only refuses versions BELOW its floor, so no value in it warns about running
     * an outdated one, and raising it to exclude the affected line would be a support-policy change fixed at
     * the 3.3 line by EPIC-001 section 7.9.2 (AAP section 0.8.4) rather than a fix. A boot-time line is the
     * one place left where the fact reaches the person who can act on it.
     *
     * **It warns and never refuses.** A plugin declining to start because its host is behind on patches would
     * take an availability decision belonging to the deployment, and would do it from inside an unrelated
     * feature — turning a known, documented risk into a certain outage. So this sits after
     * {@link ReorderPlugin.registerTranslations} rather than beside the option validation that deliberately
     * does fail closed: a bad option means this plugin cannot serve correctly, whereas an old host means the
     * platform around it needs attention.
     *
     * **It says only what the version establishes.** {@link assessPlatformSecurityPosture} distinguishes three
     * reasons to speak from the one reason to stay quiet, and each gets its own sentence, because a signal that
     * asserts more than it knows is one an operator is right to stop believing:
     *
     * - `'affected'` — the release orders below the floor, so the advisories apply to it. Stated as fact.
     * - `'unproven-prerelease'` — a pre-release of the floor itself, which semver orders BELOW the floor. It may
     *   already carry every fix; nothing here establishes that it does, so it is reported as unproven rather
     *   than as either affected or fixed.
     * - `'unassessable'` — the version string could not be read. Reported as exactly that. Calling it affected
     *   would assert a vulnerability from ignorance and calling it fixed would assert safety from the same
     *   ignorance; saying the posture is undetermined is the only honest option, and it still prompts a check.
     * - `'fixed'` — nothing is written.
     *
     * It reads `VENDURE_VERSION`, the platform's own published constant, so it reports the version actually
     * running rather than a version this package's manifest happens to name.
     */
    private warnIfPlatformSecurityPostureIsNotEstablished(): void {
        const posture = assessPlatformSecurityPosture(VENDURE_VERSION);
        if (posture === 'fixed') {
            return;
        }
        const floor = PLATFORM_SECURITY_FLOOR.join('.');
        const advisories = `${PLATFORM_ADVISORIES.join(', ')}`;
        const finding =
            posture === 'affected'
                ? `This server is running Vendure ${VENDURE_VERSION}. Releases earlier than ${floor} are ` +
                  `affected by published advisories fixed in ${floor}: ${advisories}.`
                : posture === 'unproven-prerelease'
                  ? `This server is running Vendure ${VENDURE_VERSION}, which semantic-version ordering places ` +
                    `BEFORE the ${floor} release that fixes ${advisories}. It is not established that this ` +
                    'pre-release carries all of those fixes.'
                  : `This server reports its Vendure version as "${VENDURE_VERSION}", which this plugin could ` +
                    `not read as a version number, so it could not determine whether the platform carries the ` +
                    `fixes released in ${floor}: ${advisories}. Treat the posture as unverified and check by hand.`;
        Logger.warn(
            `${finding} They are platform vulnerabilities and are not introduced or fixable by the ` +
                `ReorderPlugin, which continues to serve normally; run a platform release of ${floor} or ` +
                "later. The plugin's own operations remain scoped to the authenticated customer and active " +
                'channel on every read and write.',
            loggerCtx,
        );
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
 * **Why a distinct class per call.** The class a deployment registers *is* the registration, so returning
 * `ReorderPlugin` itself from every `init()` would give every configuration in a process one shared slot to
 * resolve its options from: `A.init({ maxListsPerCustomer: 10 })` followed by
 * `B.init({ maxListsPerCustomer: 20 })` would leave A's provider resolving 20, because a provider factory
 * reading module state runs when A bootstraps — after B's `init()` has already written the variable. Nothing
 * would fail and nothing would log; A would simply enforce a bound its own configuration never asked for.
 * That is reachable wherever one process holds more than one server: a multi-tenant host, and any test file
 * that builds two configurations before booting either.
 *
 * So each `init()` returns a distinct subclass of `ReorderPlugin` whose options provider is a `useValue`
 * capturing the set that call resolved. The value is fixed at registration time and no later `init()` can
 * reach it — there is no shared slot to overwrite.
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
 * `optionsInForce()` returns the same object. Were either to read {@link ReorderPlugin.options} instead,
 * isolating the scoped registrations would leave the hole open at the one registration that never asked for
 * anything: a process where one server called `init({ maxLinesPerList: 33 })` would give a second, bare
 * server that same 33 in place of the documented 200, silently and in an order-dependent way.
 *
 * **What the static means.** {@link ReorderPlugin.options} reports the most recently resolved set, which is
 * the shape EPIC-001 section 7.10 and the AAP prescribe — a readable static behind a validated `init()`. It
 * is a report and nothing serves from it, so the mutable variable behind it cannot move any server's bounds.
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

/**
 * @description
 * The migration classes that create this plugin's two tables, for `dbConnectionOptions.migrations`.
 *
 * Registering the classes rather than a path is what makes one registration correct in both layouts this
 * package runs in: TypeORM accepts a migration class wherever it accepts a glob, and a class is resolved by
 * the module system rather than by the filesystem, so a deployment needs no path arithmetic over `src/`
 * versus `lib/src/`. The compiled files remain available at `lib/src/migrations/` for a deployment that
 * prefers globs. The array is ordered, and TypeORM additionally orders migrations by the timestamp in each
 * class name, so spreading it beside another project's migrations cannot reorder either set.
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
 * Register it before the first boot of a server that has `synchronize` enabled. `runMigrations` applies every
 * pending entry in `dbConnectionOptions.migrations`, and a schema builder that has already created the two
 * tables leaves this class with nothing to create, so applying it then fails on the existing tables rather
 * than adopting them. The class is the migration generator's PostgreSQL output and applies to a PostgreSQL
 * deployment; the migration's own header records the invocation that produces the equivalent file for another
 * engine. The package README sets that sequencing out step by step, and separates applying from rolling back.
 *
 * @docsCategory core plugins/ReorderPlugin
 * @docsPage ReorderPlugin
 * @since 3.8.0
 */
export const reorderPluginMigrations = [AddReorderLists1786838400000];
