/*
 * -------------------------------------------------------------------------------------------------------
 * Unit specification for `ReorderPlugin` startup option validation — what it pins, and what it deliberately
 * leaves to another file.
 * -------------------------------------------------------------------------------------------------------
 * Attribution. No user-specified rules were provided for this project: the rules document was read and
 * returned exactly that, and EPIC-001 reaches the same finding independently in its own section 11.9.
 * Nothing asserted below is, or derives from, a user-specified rule, and no rule forces any case into this
 * file. Every clause pinned here traces to EPIC-001 section 7.10 (the plugin option ledger), to
 * STORY-001-01-01's option sub-task, or to a documented contract of `reorder.plugin.ts` itself, and is
 * attributed at the assertion that pins it. The absence of a rules document has not been treated as licence
 * to assert less.
 *
 * Where this file lives, and why. It sits beside the module it tests and carries the `.spec.ts` suffix,
 * which is this repository's stated convention for a unit test [CONTRIBUTING.md:L428], and which EPIC-001
 * section 11.6 restates. The package's Vitest configuration confines unit discovery to `src/**&#47;*.spec.ts`
 * and excludes `e2e/**` outright, so this file is found by that pattern and the package's `test` script is
 * what runs it. That configuration also registers the SWC transform with `useDefineForClassFields: false`,
 * which is what lets a decorated class be imported and initialised here at all: without it, ES2022
 * class-field semantics overwrite fields with `undefined` after the constructor has run. A field that is
 * unexpectedly `undefined` in this file is a symptom of that transform, not of the code under test.
 *
 * THE WHOLE SUBJECT OF THIS FILE IS ONE SENTENCE OF EPIC-001 SECTION 7.10, which the ledger states once as a
 * rule for every row rather than repeating per option: a value the plugin cannot use makes the plugin fail
 * to start, "with a named configuration error identifying the offending key", because "a bound that silently
 * degrades to 'admit everything' or 'admit nothing' is worse than no bound, because nothing fails while the
 * guarantee is gone". THAT SENTENCE HAS TWO HALVES AND BOTH ARE ASSERTED AT EVERY CELL BELOW. A cell that
 * asserted only that initialisation throws would leave a validator which refuses the WRONG key
 * indistinguishable from a correct one — the same reasoning EPIC-001 ruling R17 applies to a bare "the
 * request is refused". So each rejection cell pins the error class, the `optionKey` datum, the exact
 * requirement clause, the rendered description of the value, and that NO OTHER option key is named.
 *
 * STORY-001-01-01 supplies the value table. Its option sub-task requires each key to be "a required finite
 * integer of at least 1 … each failing plugin initialisation with the option named when absent, zero,
 * negative, fractional or non-finite, and the quantity bound additionally rejecting a value above a signed
 * 32-bit integer because the column it guards is a 32-bit `int`". Every one of those words is a row of
 * {@link REJECTED_VALUES}, and every row is driven against all five keys rather than against a
 * representative one. That is deliberate rather than thorough for its own sake: the validator is a loop over
 * a key list, so the matrix exists to prove the loop actually reaches every key, and that the one
 * key-specific clause it carries fires for that key alone.
 *
 * THE ONE PLACE THE TICKET SET AND THIS RUN GENUINELY DIFFER IS AN OMITTED KEY, AND BOTH HALVES ARE
 * ASSERTED RATHER THAN ONE BEING CHOSEN SILENTLY. EPIC-001 section 7.10 marks the three ledgered keys
 * "Required, no value in this set" and STORY-001-01-01 asks initialisation to fail when one is absent, while
 * this run's supplied decisions give 25, 200, 999, 25 and 50 as declared defaults to be used without
 * substitution — which makes an OMITTED key resolve to its default rather than fail. `reorder.plugin.ts`
 * records the same divergence in its own header as "A. REQUIRED BECAME DEFAULTED", and it is reported in the
 * pull request body alongside the two-key ledger divergence that `types.ts` records as conflict C-C. The
 * behaviour therefore has two halves and this file asserts both: an omitted key resolves to its declared
 * default and initialisation succeeds, whereas a key present with an explicit `undefined` or `null` is
 * refused by name. No value is invented and no supplied value is substituted.
 *
 * WHAT THIS FILE DOES NOT DO, stated so that a later reader does not add it.
 *
 * - It boots no server, opens no database connection, issues no GraphQL request and mocks nothing. An
 *   import of the testing harness, a client or a connection here would mean the specification had drifted
 *   from its subject.
 * - The two compatibility tests — that a server declaring this plugin's range starts, and that one
 *   declaring a deliberately unsatisfiable range fails with the platform's own message — need a booted
 *   server and belong to `e2e/reorder-plugin-compatibility.e2e-spec.ts` (EPIC-001 section 7.9.2).
 * - The proof that `ReorderPlugin` is reachable from the package root rather than only from a deep path is
 *   ruling R22's, and belongs to the same e2e suite. This file imports from `./reorder.plugin` precisely so
 *   that the root barrel is proved by the file whose job that is, and not incidentally here.
 * - `onApplicationBootstrap` is deliberately not exercised. Its second act reads the filesystem to locate
 *   the message catalogue, and whether `addTranslationFile` resolved a usable path is observable only
 *   through a booted server returning a translated sentence instead of a raw key — so that assertion
 *   belongs to the e2e suites, and asserting the re-validation half here would drag the filesystem in with
 *   it for nothing.
 * - Name canonicalisation and service behaviour belong to `src/service/reorder-list-name.spec.ts` and
 *   `src/service/reorder-list.service.spec.ts`. Duplicating their cases here would inflate a count without
 *   proving anything they do not already prove.
 * - It asserts no latency, throughput, service-level, conversion or revenue figure of any kind, and no
 *   timing at all. That is an epic-wide constraint (FEATURE-001-01 section 2.12) and compliance with it is
 *   stated explicitly in the pull request body.
 * -------------------------------------------------------------------------------------------------------
 */

import { MODULE_METADATA } from '@nestjs/common/constants';
import { Type } from '@vendure/core';
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { REORDER_PLUGIN_OPTIONS } from './constants';
import { ReorderPlugin, ReorderPluginConfigurationError } from './reorder.plugin';
import { ReorderPluginOptions, ResolvedReorderPluginOptions } from './types';

/**
 * The five option keys, **in the order the validator walks them**.
 *
 * The order is not cosmetic and is not this file's invention: `reorder.plugin.ts` states that validation
 * reports the first offending key and stops, "because a message naming several keys at once makes a per-key
 * assertion ambiguous and leaves a reader guessing which value the server actually rejected". This array is
 * therefore both the checklist the matrix below is driven from and the expected outcome of the
 * first-offender cases, which is why it is declared once here rather than restated at each use.
 */
const OPTION_KEYS: ReadonlyArray<keyof ReorderPluginOptions> = [
    'maxListsPerCustomer',
    'maxLinesPerList',
    'maxQuantityPerLine',
    'defaultReorderListsPageSize',
    'defaultReorderListLinesPageSize',
];

/**
 * The declared default of every option — the five values this run supplies, restated here as the expected
 * outcome rather than imported from the module under test.
 *
 * Restating them is the point. Reading the defaults out of `reorder.plugin.ts` would make this assertion
 * tautological: a typo that changed a default would change the expectation with it and nothing would fail.
 * Typing the constant as {@link ResolvedReorderPluginOptions} keeps the restatement honest in the other
 * direction, since adding a sixth option to the interface without a value here is a compile error rather
 * than a silently unasserted key.
 */
const DECLARED_DEFAULTS: ResolvedReorderPluginOptions = {
    maxListsPerCustomer: 25,
    maxLinesPerList: 200,
    maxQuantityPerLine: 999,
    defaultReorderListsPageSize: 25,
    defaultReorderListLinesPageSize: 50,
};

/**
 * The requirement clause the error carries when a value is not a finite integer. Quoted verbatim from the
 * message the validator produces, because a paraphrase would pass against a message that had lost the
 * detail an operator needs in order to act.
 */
const MUST_BE_A_FINITE_INTEGER =
    'must be a finite integer (no fractional value, NaN, Infinity, null, undefined or non-numeric type)';

/** The requirement clause carried when a value is a finite integer but below the shared lower bound. */
const MUST_BE_AT_LEAST_ONE = 'must be at least 1';

/**
 * The requirement clause carried when `maxQuantityPerLine` — and only that key — exceeds the largest signed
 * 32-bit integer. The clause names the reason as well as the number, so the whole of it is pinned: the
 * ceiling exists because the column the bound guards is a 32-bit `int` and the published GraphQL `Int` is a
 * signed 32-bit integer, and a shortened expectation would not notice that reason going missing.
 */
const MUST_NOT_EXCEED_THE_32_BIT_CEILING =
    'must not exceed 2147483647, the largest signed 32-bit integer, because the quantity column it ' +
    'guards is a 32-bit int and the published GraphQL Int is a signed 32-bit integer';

/** The largest signed 32-bit integer: the inclusive ceiling on `maxQuantityPerLine`. */
const MAX_SIGNED_32_BIT_INTEGER = 2147483647;

/**
 * One row of the rejection matrix: a value the plugin must refuse, the requirement clause it must cite, and
 * the description it must render for the value.
 *
 * `value` is `unknown` rather than `number` on purpose. Roughly half the table is values TypeScript would
 * refuse at the call site, and they are exactly the values the run-time guard exists for — a JavaScript
 * caller, an environment variable or a JSON configuration file can produce any of them, and the guard is
 * what turns each into a startup failure instead of a bound that quietly means nothing.
 */
interface RejectedValueCase {
    /** The `it()` title fragment, so a failure names the cell without the file having to be opened. */
    readonly label: string;
    /** The value supplied for the key under test. */
    readonly value: unknown;
    /** The verbatim requirement clause the message must contain. */
    readonly requirement: string;
    /** The verbatim rendering of the value the message must contain after "but received ". */
    readonly received: string;
}

/**
 * Every value that must be refused, for every one of the five keys.
 *
 * The first four rows are the "zero" and "negative" cases STORY-001-01-01 names, the next three the
 * "fractional" case and the three non-finite ones, then the two forms of an explicitly absent value, and
 * finally the non-numeric types — worth driving individually because a deployment that reads an option from
 * an environment variable or a JSON file hands over whatever that source produced, and each of those
 * categories renders differently in the message.
 *
 * `0.5` earns its row rather than duplicating `2.5`: it is BOTH fractional and below the lower bound, so it
 * is the one value that proves which guard runs first. It must cite the integer clause and not the minimum
 * clause, and a validator that tested the bound before the type would fail on this row alone.
 */
const REJECTED_VALUES: readonly RejectedValueCase[] = [
    {
        label: 'zero',
        value: 0,
        requirement: MUST_BE_AT_LEAST_ONE,
        received: 'the number 0',
    },
    {
        label: 'negative zero',
        value: -0,
        requirement: MUST_BE_AT_LEAST_ONE,
        received: 'the number 0',
    },
    {
        label: 'a negative integer',
        value: -1,
        requirement: MUST_BE_AT_LEAST_ONE,
        received: 'the number -1',
    },
    {
        label: 'the most negative signed 32-bit integer',
        value: -2147483648,
        requirement: MUST_BE_AT_LEAST_ONE,
        received: 'the number -2147483648',
    },
    {
        label: 'a fractional value above the lower bound',
        value: 2.5,
        requirement: MUST_BE_A_FINITE_INTEGER,
        received: 'the number 2.5',
    },
    {
        label: 'a fractional value below the lower bound, citing the integer clause and not the bound',
        value: 0.5,
        requirement: MUST_BE_A_FINITE_INTEGER,
        received: 'the number 0.5',
    },
    {
        label: 'NaN',
        value: Number.NaN,
        requirement: MUST_BE_A_FINITE_INTEGER,
        received: 'the number NaN',
    },
    {
        label: 'positive Infinity',
        value: Number.POSITIVE_INFINITY,
        requirement: MUST_BE_A_FINITE_INTEGER,
        received: 'the number Infinity',
    },
    {
        label: 'negative Infinity',
        value: Number.NEGATIVE_INFINITY,
        requirement: MUST_BE_A_FINITE_INTEGER,
        received: 'the number -Infinity',
    },
    {
        label: 'an explicitly supplied undefined',
        value: undefined,
        requirement: MUST_BE_A_FINITE_INTEGER,
        received: 'undefined',
    },
    {
        label: 'an explicitly supplied null',
        value: null,
        requirement: MUST_BE_A_FINITE_INTEGER,
        received: 'null',
    },
    {
        label: 'a numeric string, as an environment variable would supply',
        value: '25',
        requirement: MUST_BE_A_FINITE_INTEGER,
        received: 'a string of length 2',
    },
    {
        label: 'an empty string, as an unset environment variable would supply',
        value: '',
        requirement: MUST_BE_A_FINITE_INTEGER,
        received: 'a string of length 0',
    },
    {
        label: 'a true boolean',
        value: true,
        requirement: MUST_BE_A_FINITE_INTEGER,
        received: 'a boolean (true)',
    },
    {
        label: 'a false boolean',
        value: false,
        requirement: MUST_BE_A_FINITE_INTEGER,
        received: 'a boolean (false)',
    },
    {
        label: 'a plain object',
        value: {},
        requirement: MUST_BE_A_FINITE_INTEGER,
        received: 'a value of type object',
    },
    {
        label: 'an array',
        value: [],
        requirement: MUST_BE_A_FINITE_INTEGER,
        received: 'an array',
    },
    {
        label: 'a bigint',
        value: BigInt(25),
        requirement: MUST_BE_A_FINITE_INTEGER,
        received: 'a bigint',
    },
    {
        label: 'a symbol',
        value: Symbol('an option value that arrived as a symbol'),
        requirement: MUST_BE_A_FINITE_INTEGER,
        received: 'a symbol',
    },
    {
        label: 'a function',
        value: () => 25,
        requirement: MUST_BE_A_FINITE_INTEGER,
        received: 'a function',
    },
];

/**
 * Builds an option set carrying exactly one key, so that a cell can name one offender and the remaining four
 * keys take their declared defaults through the merge.
 *
 * The single `as number` is the one place a deliberately malformed value crosses the typed boundary, and it
 * is written narrowly rather than as a wholesale assertion on the object. That is what lets this file reach
 * the run-time guard without a `@ts-expect-error`, without a `@ts-ignore` and without loosening the
 * package's `strict` setting — none of which would be a local convenience, since each would also stop the
 * compiler checking the assertions in the same file.
 */
function optionsWith(key: keyof ReorderPluginOptions, value: unknown): ReorderPluginOptions {
    return { [key]: value as number };
}

/**
 * Reads one option off a resolved set by key.
 *
 * Every member of {@link ResolvedReorderPluginOptions} is a `number`, so this is a total function over the
 * five keys and needs no assertion — which is precisely why the matrix can be driven from
 * {@link OPTION_KEYS} instead of restating five nearly identical blocks.
 */
function readOption(options: ResolvedReorderPluginOptions, key: keyof ReorderPluginOptions): number {
    return options[key];
}

/**
 * Returns the resolved options to the declared defaults.
 *
 * `ReorderPlugin.options` is deliberately a getter with no setter over module-private state, so there is no
 * assignment that could reset it: calling `init({})` is the only way in, and it is enough, because an
 * omitted key takes its declared default. This runs both before and after every test so that a cell can
 * neither observe nor bequeath a set a sibling installed — which is what makes the file's result independent
 * of the order the cases run in, whether that is declaration order, reverse order, a shuffled sequence or a
 * single case alone.
 */
function resetToDeclaredDefaults(): void {
    ReorderPlugin.init({});
}

/**
 * The option set a registration's own options provider is bound to, located the way the injector locates it.
 *
 * A registration returned by `init()` carries a `useValue` provider for {@link REORDER_PLUGIN_OPTIONS} in its
 * Nest module metadata; the bare `ReorderPlugin` class carries a `useFactory` over the static instead, which
 * is what makes registering it without calling `init()` a valid installation on the declared defaults. Both
 * are read here through the same metadata key Nest reads, rather than by reaching into module state, so what
 * these cases assert is the binding a running server would resolve.
 *
 * @param registration - The plugin class or an `init()` registration.
 * @returns The resolved option set that registration's provider yields.
 */
function optionsBoundTo(registration: Type<ReorderPlugin>): ResolvedReorderPluginOptions {
    const providers: unknown[] = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, registration) ?? [];
    const bound = providers.find(
        (provider): provider is { provide: symbol; useValue?: unknown; useFactory?: () => unknown } =>
            typeof provider === 'object' &&
            provider !== null &&
            (provider as { provide?: unknown }).provide === REORDER_PLUGIN_OPTIONS,
    );

    expect(
        bound,
        'every registration must bind the options token, or nothing can read the bounds',
    ).toBeDefined();
    const value = bound?.useFactory ? bound.useFactory() : bound?.useValue;

    return value as ResolvedReorderPluginOptions;
}

/**
 * The option set a registration's bootstrap hook re-validates.
 *
 * The hook reads a protected accessor rather than the static, so that in a process holding more than one
 * registration each checks the values it will itself serve with. Read here by instantiating the registration
 * with a stub for its one dependency, because the accessor is protected and the behaviour — not the property —
 * is the guarantee.
 *
 * @param registration - The plugin class or an `init()` registration.
 * @returns The set that registration's `onApplicationBootstrap` would validate.
 */
function optionsInForceFor(registration: Type<ReorderPlugin>): ResolvedReorderPluginOptions {
    const instance = new (registration as unknown as new (i18nService: unknown) => {
        optionsInForce(): ResolvedReorderPluginOptions;
    })({ addTranslationFile: () => undefined });

    return instance.optionsInForce();
}

/**
 * Runs `init()` with the given options and returns the refusal it raised.
 *
 * The `expect` inside is not redundant with the caller's assertions: it is what turns "the call did not
 * throw at all" — the single most consequential way this specification could be wrong — into a failure that
 * names that fact, rather than into a confusing `undefined` dereference several assertions later.
 */
function captureInitFailure(options: ReorderPluginOptions): ReorderPluginConfigurationError {
    let caught: unknown;
    try {
        ReorderPlugin.init(options);
    } catch (thrown) {
        caught = thrown;
    }
    expect(caught).toBeInstanceOf(ReorderPluginConfigurationError);
    expect(caught).toBeInstanceOf(Error);
    return caught as ReorderPluginConfigurationError;
}

/**
 * Asserts that a message names the given key and **no other option key**.
 *
 * This is the half of EPIC-001 section 7.10 that a bare "it throws" would miss. A validator that refused the
 * wrong key, or that reported every key it had walked, would satisfy "initialisation fails" and still leave
 * an operator unable to tell which value to correct. The assertion is sound as a plain substring test
 * because none of the five key names is a substring of another, and because no requirement clause the
 * validator can cite mentions a key name at all.
 */
function expectNoOtherOptionKeyNamed(message: string, key: keyof ReorderPluginOptions): void {
    for (const other of OPTION_KEYS.filter(candidate => candidate !== key)) {
        expect(message).not.toContain(other);
    }
}

/**
 * The complete assertion for one rejection cell: both halves of the section 7.10 rule, the exact clause
 * cited, the exact description rendered, and the fact that a refused value is never installed.
 *
 * It is a helper rather than the same set of assertions written out at each of the hundred-odd cells,
 * because every cell must assert all of them — a cell that quietly asserted fewer would be the one that let
 * a regression through — and the returned error lets a caller add a cell-specific assertion on top of the
 * set without being able to loosen any member of it.
 */
function expectInitToRefuse(
    key: keyof ReorderPluginOptions,
    value: unknown,
    requirement: string,
    received: string,
): ReorderPluginConfigurationError {
    const optionsBeforeTheAttempt = ReorderPlugin.options;

    // Half one of the rule: initialisation FAILS, rather than the bound degrading to admit everything or
    // nothing. Asserted in the callback form because that is the form which proves the call itself throws.
    expect(() => ReorderPlugin.init(optionsWith(key, value))).toThrowError(ReorderPluginConfigurationError);
    // Half two, in the form a developer reading a stack trace actually has: the offending key is legible in
    // the message text itself, not only as structured data beside it. The two are asserted separately and
    // not folded into one loose regexp, because a regexp that matched the class and the key together would
    // pass on a message that named the right key for the wrong reason.
    expect(() => ReorderPlugin.init(optionsWith(key, value))).toThrowError(new RegExp(key));

    const error = captureInitFailure(optionsWith(key, value));

    // The class is named three ways, because each survives a different kind of change: `instanceof` proves
    // the prototype chain the plugin restores explicitly, `constructor.name` proves the class identity that
    // survives minification of the message, and `name` proves the value that appears in a serialised error
    // and in a stack trace's first line.
    expect(error.constructor.name).toBe('ReorderPluginConfigurationError');
    expect(error.name).toBe('ReorderPluginConfigurationError');
    // The offending key as data rather than as prose, so a caller can branch on it without parsing English.
    expect(error.optionKey).toBe(key);
    // …and as prose as well, quoted exactly as the message quotes it.
    expect(error.message).toContain(`the "${key}" option`);
    expect(error.message).toContain(requirement);
    expect(error.message).toContain(`but received ${received}.`);
    // The remedy is stated, since a startup failure that does not say what to do next is a worse failure.
    expect(error.message).toContain('Correct the value passed to ReorderPlugin.init()');
    expectNoOtherOptionKeyNamed(error.message, key);

    // A refused value is never installed. `init()` validates the merged set BEFORE it stores it, so a
    // rejected call leaves the previously resolved options exactly as they were — which is what stops a
    // failed initialisation from leaving the plugin holding a value it has already refused.
    expect(ReorderPlugin.options).toEqual(optionsBeforeTheAttempt);

    return error;
}

describe('ReorderPlugin startup option validation', () => {
    beforeEach(() => {
        resetToDeclaredDefaults();
    });

    afterEach(() => {
        resetToDeclaredDefaults();
    });

    it('starts every case from the declared defaults, whatever order the cases run in', () => {
        // Asserted rather than assumed, because `ReorderPlugin.options` is process-wide state reached through
        // a getter with no setter: a cell that installed `maxLinesPerList: 7` and a sibling that expected the
        // default would otherwise pass or fail according to the order the runner happened to choose. This is
        // what makes the file's result identical in declaration order, in reverse, shuffled, and for any
        // single case run alone.
        expect(ReorderPlugin.options).toEqual(DECLARED_DEFAULTS);
    });

    describe('the accepted option set', () => {
        it('resolves every declared default when init() is called with no argument at all', () => {
            expect(ReorderPlugin.init().prototype instanceof ReorderPlugin).toBe(true);
            expect(ReorderPlugin.options).toEqual(DECLARED_DEFAULTS);
        });

        it('resolves every declared default when init() is called with an empty object', () => {
            expect(ReorderPlugin.init({}).prototype instanceof ReorderPlugin).toBe(true);
            expect(ReorderPlugin.options).toEqual(DECLARED_DEFAULTS);
        });

        it('accepts all five declared defaults supplied explicitly, resolving the same set', () => {
            ReorderPlugin.init({ ...DECLARED_DEFAULTS });

            expect(ReorderPlugin.options).toEqual(DECLARED_DEFAULTS);
        });

        it('resolves each declared default to its own documented number', () => {
            // Stated one key at a time as well as as a whole, so that a failure names the option whose
            // default moved rather than printing a five-key diff for a one-key change.
            expect(ReorderPlugin.options.maxListsPerCustomer).toBe(25);
            expect(ReorderPlugin.options.maxLinesPerList).toBe(200);
            expect(ReorderPlugin.options.maxQuantityPerLine).toBe(999);
            expect(ReorderPlugin.options.defaultReorderListsPageSize).toBe(25);
            expect(ReorderPlugin.options.defaultReorderListLinesPageSize).toBe(50);
        });

        it('resolves exactly the five documented keys and no sixth', () => {
            // The negative half of the option surface. STORY-001-01-01 is "the declaring owner of all three
            // of this feature's option keys, and of no others", and adds "no fourth key … in particular
            // there is no name-length option" — the list-name bound being the fixed constant that equals the
            // column width. The two page-size keys beyond the ledgered three are conflict C-C, reported in
            // the pull request body. A sixth key appearing here would be an unreported option surface.
            expect(Object.keys(ReorderPlugin.options).sort()).toEqual([...OPTION_KEYS].sort());
        });

        for (const key of OPTION_KEYS) {
            it(`accepts 1 for ${key}, the bound being "at least 1" rather than "greater than 1"`, () => {
                ReorderPlugin.init(optionsWith(key, 1));

                expect(readOption(ReorderPlugin.options, key)).toBe(1);
            });
        }

        it('accepts every key at 1 at once', () => {
            ReorderPlugin.init({
                maxListsPerCustomer: 1,
                maxLinesPerList: 1,
                maxQuantityPerLine: 1,
                defaultReorderListsPageSize: 1,
                defaultReorderListLinesPageSize: 1,
            });

            for (const key of OPTION_KEYS) {
                expect(readOption(ReorderPlugin.options, key)).toBe(1);
            }
        });
    });

    describe('an omitted key resolves to its declared default', () => {
        // The Required-to-Defaulted divergence, recorded here rather than resolved silently. EPIC-001
        // section 7.10 marks the three ledgered keys "Required, no value in this set" and STORY-001-01-01
        // asks initialisation to fail when one is absent, whereas this run's supplied decisions give 25, 200,
        // 999, 25 and 50 as declared defaults to be used without substitution — which makes an OMITTED key
        // resolve to its default rather than fail. `reorder.plugin.ts` carries the same note in its header as
        // "A. REQUIRED BECAME DEFAULTED", and the divergence is reported in the pull request body alongside
        // conflict C-C. Both halves of the resulting behaviour are asserted: the successes below for an
        // omitted key, and the refusals in the matrix for a key present with an explicit `undefined` or
        // `null`. No value is invented here and no supplied value is substituted.
        for (const key of OPTION_KEYS) {
            it(`takes the declared default for the four keys omitted alongside ${key}`, () => {
                const supplied = readOption(DECLARED_DEFAULTS, key) + 1;

                ReorderPlugin.init(optionsWith(key, supplied));

                expect(readOption(ReorderPlugin.options, key)).toBe(supplied);
                for (const omitted of OPTION_KEYS.filter(candidate => candidate !== key)) {
                    expect(readOption(ReorderPlugin.options, omitted)).toBe(
                        readOption(DECLARED_DEFAULTS, omitted),
                    );
                }
            });
        }

        it('distinguishes an omitted key from one explicitly supplied as undefined', () => {
            // The two are different outcomes rather than one outcome spelled twice, which is the whole reason
            // the merge keeps an explicit `undefined` instead of discarding it: an omitted key is a
            // deployment accepting the default, whereas a key present with nothing usable in it is a mistake
            // at the call site — typically an expression that evaluated to nothing — and substituting a bound
            // for it would hide that mistake behind a healthy-looking server.
            expect(() => ReorderPlugin.init({})).not.toThrow();
            expect(ReorderPlugin.options.maxLinesPerList).toBe(200);

            const error = captureInitFailure({ maxLinesPerList: undefined });

            expect(error.optionKey).toBe('maxLinesPerList');
            expect(error.message).toContain('but received undefined.');
            expect(ReorderPlugin.options.maxLinesPerList).toBe(200);
        });
    });

    describe('a malformed value fails initialisation and names the offending key', () => {
        for (const key of OPTION_KEYS) {
            describe(key, () => {
                it.each(REJECTED_VALUES)('refuses $label', ({ value, requirement, received }) => {
                    expectInitToRefuse(key, value, requirement, received);
                });
            });
        }
    });

    describe('the maxQuantityPerLine ceiling, proved on both sides', () => {
        it('accepts the largest signed 32-bit integer exactly', () => {
            ReorderPlugin.init({ maxQuantityPerLine: MAX_SIGNED_32_BIT_INTEGER });

            expect(ReorderPlugin.options.maxQuantityPerLine).toBe(MAX_SIGNED_32_BIT_INTEGER);
        });

        it('refuses the first integer above it, naming the key and the reason', () => {
            const error = expectInitToRefuse(
                'maxQuantityPerLine',
                MAX_SIGNED_32_BIT_INTEGER + 1,
                MUST_NOT_EXCEED_THE_32_BIT_CEILING,
                'the number 2147483648',
            );

            expect(error.optionKey).toBe('maxQuantityPerLine');
        });

        it('refuses a value far above it', () => {
            expectInitToRefuse(
                'maxQuantityPerLine',
                Number.MAX_SAFE_INTEGER,
                MUST_NOT_EXCEED_THE_32_BIT_CEILING,
                'the number 9007199254740991',
            );
        });

        for (const key of OPTION_KEYS.filter(candidate => candidate !== 'maxQuantityPerLine')) {
            it(`applies no such ceiling to ${key}, which carries a lower bound only`, () => {
                // The ceiling is key-specific because its reason is: only `maxQuantityPerLine` guards a
                // 32-bit `int` column that `addItemToReorderList` accumulates into. Proving the other four
                // accept the same value is what pins "the one key … carrying an upper bound as well as a
                // lower one", and what would catch a ceiling accidentally hoisted out of its key test.
                ReorderPlugin.init(optionsWith(key, MAX_SIGNED_32_BIT_INTEGER + 1));

                expect(readOption(ReorderPlugin.options, key)).toBe(MAX_SIGNED_32_BIT_INTEGER + 1);
            });
        }
    });

    describe('one offender at a time: the first key in validation order is the one named', () => {
        const malformedPairs: ReadonlyArray<{
            readonly first: keyof ReorderPluginOptions;
            readonly second: keyof ReorderPluginOptions;
        }> = [
            { first: 'maxListsPerCustomer', second: 'maxLinesPerList' },
            { first: 'maxListsPerCustomer', second: 'defaultReorderListLinesPageSize' },
            { first: 'maxLinesPerList', second: 'maxQuantityPerLine' },
            { first: 'maxLinesPerList', second: 'defaultReorderListLinesPageSize' },
            { first: 'maxQuantityPerLine', second: 'defaultReorderListsPageSize' },
            { first: 'defaultReorderListsPageSize', second: 'defaultReorderListLinesPageSize' },
        ];

        for (const { first, second } of malformedPairs) {
            it(`names ${first} and not ${second} when both are malformed`, () => {
                const error = captureInitFailure({
                    ...optionsWith(first, 0),
                    ...optionsWith(second, 0),
                });

                expect(error.optionKey).toBe(first);
                expect(error.message).toContain(`the "${first}" option`);
                expect(error.message).not.toContain(second);
            });
        }

        it('names the first key in validation order when all five are malformed', () => {
            const error = captureInitFailure({
                maxListsPerCustomer: 0,
                maxLinesPerList: 0,
                maxQuantityPerLine: 0,
                defaultReorderListsPageSize: 0,
                defaultReorderListLinesPageSize: 0,
            });

            expect(error.optionKey).toBe(OPTION_KEYS[0]);
            expectNoOtherOptionKeyNamed(error.message, OPTION_KEYS[0]);
        });

        it('names only the malformed key when the other four are supplied and valid', () => {
            const error = captureInitFailure({ ...DECLARED_DEFAULTS, maxLinesPerList: 0 });

            expect(error.optionKey).toBe('maxLinesPerList');
            expect(error.message).toContain(`the "maxLinesPerList" option`);
            expectNoOtherOptionKeyNamed(error.message, 'maxLinesPerList');
        });
    });

    describe('the refused value is described by kind and never by its content', () => {
        // The message reaches the startup log, and a rejected value arrives from whatever the deployment's
        // configuration produced — so a string may be a credential or a connection URL assigned to the wrong
        // key, may carry newlines or terminal escapes that forge surrounding log lines, and may be
        // arbitrarily long. `reorder.plugin.ts` therefore renders the KIND of value, plus a string's length,
        // and never the content. These cells are what stops that guarantee being lost to a later "helpful"
        // change that interpolates the value back in.
        it('reports a string by its length and withholds its content', () => {
            const withheldValue = 'AN_OPTION_VALUE_WHOSE_CONTENT_MUST_NEVER_REACH_THE_LOG';

            const error = captureInitFailure(optionsWith('maxLinesPerList', withheldValue));

            expect(error.message).toContain(`a string of length ${String(withheldValue.length)}`);
            expect(error.message).not.toContain(withheldValue);
        });

        it('counts a string length in code points rather than in UTF-16 units', () => {
            const threeAstralCharacters = '\u{1F642}\u{1F642}\u{1F642}';

            expect(threeAstralCharacters.length).toBe(6);

            const error = captureInitFailure(optionsWith('maxLinesPerList', threeAstralCharacters));

            expect(error.message).toContain('a string of length 3');
        });

        it("withholds a symbol's description", () => {
            const withheldDescription = 'A_SYMBOL_DESCRIPTION_THAT_MUST_NEVER_REACH_THE_LOG';

            const error = captureInitFailure(optionsWith('maxLinesPerList', Symbol(withheldDescription)));

            expect(error.message).toContain('but received a symbol.');
            expect(error.message).not.toContain(withheldDescription);
        });

        it("withholds a function's name and source text", () => {
            const error = captureInitFailure(
                optionsWith('maxLinesPerList', function aFunctionWhoseSourceMustNeverReachTheLog() {
                    return 25;
                }),
            );

            expect(error.message).toContain('but received a function.');
            expect(error.message).not.toContain('aFunctionWhoseSourceMustNeverReachTheLog');
        });

        it('renders no newline into the message, so a value cannot forge a log line', () => {
            const error = captureInitFailure(
                optionsWith('maxLinesPerList', 'first line\nforged second line'),
            );

            expect(error.message).not.toContain('\n');
            expect(error.message).not.toContain('forged second line');
        });
    });

    describe('the accepted set is durable, so validation holds for the life of the process', () => {
        it('resolves a frozen object', () => {
            expect(Object.isFrozen(ReorderPlugin.options)).toBe(true);
        });

        it('resolves a frozen object after an explicit init as well', () => {
            ReorderPlugin.init({ maxLinesPerList: 7 });

            expect(Object.isFrozen(ReorderPlugin.options)).toBe(true);
        });

        it('exposes the options through an accessor that has no setter', () => {
            const descriptor = Object.getOwnPropertyDescriptor(ReorderPlugin, 'options');

            // An accessor rather than a data property: `writable` is absent from an accessor descriptor
            // altogether, whereas a writable static would report it as `true`.
            expect(descriptor).toBeDefined();
            expect(descriptor?.writable).toBeUndefined();
            // And no setter — asserted behaviourally rather than by reading the descriptor's function slots,
            // because the behaviour is the guarantee: assigning to an accessor that has no setter throws
            // under the strict mode an ES module always carries. `ReorderPlugin.options = …` is therefore
            // impossible at run time as well as being a compile error, which is what stops any later code
            // installing a set the validator has never seen.
            expect(() => {
                (ReorderPlugin as unknown as { options: ResolvedReorderPluginOptions }).options = {
                    ...DECLARED_DEFAULTS,
                    maxLinesPerList: 1,
                };
            }).toThrow(TypeError);
            expect(ReorderPlugin.options.maxLinesPerList).toBe(200);
        });

        it('refuses a write to a member of the resolved set', () => {
            // The failure mode this closes is worse than a wrong bound: code that lowered a bound after
            // startup validation had accepted it would leave nothing to report, while the guarantee the bound
            // existed to make was gone. The provider hands the same object to every consumer, so one write
            // would lower the bound for all of them at once.
            const target = ReorderPlugin.options as { maxLinesPerList: number };

            expect(() => {
                target.maxLinesPerList = 1;
            }).toThrow(TypeError);
            expect(ReorderPlugin.options.maxLinesPerList).toBe(200);
        });

        it('gives two differently configured registrations their own options, whenever they bootstrap', () => {
            /*
             * THE ISOLATION PROPERTY, exercised in the order that used to break it: BOTH registrations are
             * created BEFORE either is bootstrapped. That order is what made the old shape wrong — the options
             * provider was a factory reading a module-level variable, so it resolved whatever the LAST `init()`
             * had stored, and the earlier registration silently enforced the later one's bounds. It is reachable
             * wherever one process holds two servers: a multi-tenant host, or a test file that builds two
             * configurations before booting either.
             *
             * Each registration's own provider is read rather than the static, because the provider is what the
             * service and both resolvers are given. It is located by name in the registration's Nest metadata,
             * exactly as the injector locates it, so this reads the binding the injector would use rather than a
             * value this file arranged.
             */
            const first = ReorderPlugin.init({ maxListsPerCustomer: 10 });
            const second = ReorderPlugin.init({ maxListsPerCustomer: 20 });

            expect(first).not.toBe(second);
            expect(first).not.toBe(ReorderPlugin);
            expect(optionsBoundTo(first).maxListsPerCustomer).toBe(10);
            expect(optionsBoundTo(second).maxListsPerCustomer).toBe(20);

            // A third initialisation, standing in for a third server configured after the other two have been
            // built: it must move neither of them.
            ReorderPlugin.init({ maxListsPerCustomer: 30 });

            expect(optionsBoundTo(first).maxListsPerCustomer).toBe(10);
            expect(optionsBoundTo(second).maxListsPerCustomer).toBe(20);

            // Every other key still takes its declared default in each, so isolation carries the whole set
            // rather than only the key that differed.
            expect(optionsBoundTo(first).maxLinesPerList).toBe(DECLARED_DEFAULTS.maxLinesPerList);
            expect(optionsBoundTo(second).maxLinesPerList).toBe(DECLARED_DEFAULTS.maxLinesPerList);
        });

        it('re-asserts its OWN options at bootstrap, not whichever configuration initialised last', () => {
            // The bootstrap hook's re-validation has to read the registration's own set for the same reason
            // the provider does. Asserted by making a later initialisation carry a value the earlier
            // registration must not adopt, and reading what that registration's hook validates.
            const first = ReorderPlugin.init({ maxLinesPerList: 11 });
            ReorderPlugin.init({ maxLinesPerList: 22 });

            expect(optionsBoundTo(first).maxLinesPerList).toBe(11);
            expect(ReorderPlugin.options.maxLinesPerList).toBe(22);
            expect(optionsInForceFor(first).maxLinesPerList).toBe(11);
        });

        it('keeps the bare class on the declared defaults, whatever any earlier init() asked for', () => {
            /*
             * THE OTHER HALF OF THE ISOLATION PROPERTY, and the one that survives longest if it is not asserted.
             * A deployment may register `ReorderPlugin` itself instead of calling `init()`, and doing so is a
             * request for the DOCUMENTED DEFAULTS. If the bare class's provider read the latest initialisation,
             * a process in which some other server had called `init({ maxLinesPerList: 33 })` would hand that
             * 33 to this one in place of the documented 200 — silently, and depending on the order the two were
             * created in. A bound a deployment never asked for is the one thing a bound must never be.
             *
             * Several prior initialisations are made, with different values and in a deliberate order, so the
             * assertion cannot be satisfied by the bare class merely happening to agree with the last one.
             */
            ReorderPlugin.init({ maxLinesPerList: 33 });
            ReorderPlugin.init({ maxListsPerCustomer: 3, maxQuantityPerLine: 7 });
            ReorderPlugin.init({ defaultReorderListsPageSize: 5, defaultReorderListLinesPageSize: 6 });

            // The latest initialisation is reported by the static, which is all the static claims to do.
            expect(ReorderPlugin.options.defaultReorderListsPageSize).toBe(5);

            // And it has moved neither what the bare registration's provider yields nor what its bootstrap
            // hook re-validates. All five keys, so a leak in any one of them is named rather than a single
            // key standing in for the set.
            expect(optionsBoundTo(ReorderPlugin)).toEqual(DECLARED_DEFAULTS);
            expect(optionsInForceFor(ReorderPlugin)).toEqual(DECLARED_DEFAULTS);
        });

        it('binds the bare class and its bootstrap hook to the very same frozen object', () => {
            // Not two equal snapshots but one object: the hook's re-validation is only a check on what this
            // registration will serve with if it reads exactly what the injector hands out.
            expect(optionsInForceFor(ReorderPlugin)).toBe(optionsBoundTo(ReorderPlugin));
            expect(Object.isFrozen(optionsBoundTo(ReorderPlugin))).toBe(true);
        });

        it('binds each scoped registration and its bootstrap hook to the very same frozen object', () => {
            const scoped = ReorderPlugin.init({ maxLinesPerList: 44 });

            expect(optionsInForceFor(scoped)).toBe(optionsBoundTo(scoped));
            expect(optionsBoundTo(scoped).maxLinesPerList).toBe(44);
            expect(Object.isFrozen(optionsBoundTo(scoped))).toBe(true);
        });

        it('leaves a previously accepted set in force when a later init is refused', () => {
            ReorderPlugin.init({ maxLinesPerList: 7, maxQuantityPerLine: 11 });

            expect(ReorderPlugin.options.maxLinesPerList).toBe(7);

            const error = captureInitFailure({ maxLinesPerList: 0 });

            expect(error.optionKey).toBe('maxLinesPerList');
            expect(ReorderPlugin.options.maxLinesPerList).toBe(7);
            expect(ReorderPlugin.options.maxQuantityPerLine).toBe(11);
            expect(ReorderPlugin.options.maxListsPerCustomer).toBe(25);
        });
    });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
// THE INVENTORY THIS PACKAGE DISCOVERS, AND WHY IT IS ENUMERATED RATHER THAN MATCHED.
//
// Section 0.5.1.7 fixes this feature's unit inventory at exactly three co-located specifications, and
// `vitest.config.mts` states that inventory directly: its `unit` project ENUMERATES those three rather than
// matching a glob, so the run cannot quietly grow a fourth.
//
// Two specifications once sat beside them — an api-layer counter-repair spec under `src/api/` and a fixture
// spec under `e2e/fixtures/` — and between them widened the discovered inventory to four unit specs and
// seven e2e suites. Neither was dropped: the counter-repair cases are a section of
// `src/service/reorder-list.service.spec.ts` and the statement-parser cases a section of
// `e2e/reorder-list-mutate.e2e-spec.ts`, so every claim they made is still made from a file the manifest
// names. What the assertions below pin is that the inventory is exactly those three, and that no
// specification anywhere in the package is orphaned — a file collected by no project would be silently
// unrun, which is a worse failure than a miscount because it is invisible.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════

describe('the specifications this package discovers, and the project each belongs to', () => {
    const PACKAGE_DIR = path.join(__dirname, '..');

    /** This feature's own inventory: the three specifications section 0.5.1.7 names, and no others. */
    const UNIT_PROJECT_FILES = [
        'src/reorder.plugin.spec.ts',
        'src/service/reorder-list-name.spec.ts',
        'src/service/reorder-list.service.spec.ts',
    ];

    /** The `include` list a named project declares, in declaration order, read from the configuration. */
    function declaredInclude(projectName: string): string[] {
        const source = fs.readFileSync(path.join(PACKAGE_DIR, 'vitest.config.mts'), 'utf-8');
        const at = source.indexOf(`name: '${projectName}'`);
        expect(at, `vitest.config.mts declares no project named "${projectName}"`).toBeGreaterThan(-1);
        const list = /include:\s*\[([^\]]*)\]/.exec(source.slice(at));
        expect(list, `the "${projectName}" project declares no include list`).not.toBeNull();
        return (list as RegExpExecArray)[1]
            .split(',')
            .map(token => token.trim().replace(/^'|'$/g, ''))
            .filter(token => token.length > 0);
    }

    /** Every `*.spec.ts` beneath one directory, as package-relative POSIX paths. */
    function specsUnder(relativeDirectory: string): string[] {
        const root = path.join(PACKAGE_DIR, relativeDirectory);
        if (!fs.existsSync(root)) {
            return [];
        }
        const found: string[] = [];
        const walk = (directory: string): void => {
            for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
                const absolute = path.join(directory, entry.name);
                if (entry.isDirectory()) {
                    if (entry.name !== 'node_modules' && entry.name !== '__data__') {
                        walk(absolute);
                    }
                } else if (entry.name.endsWith('.spec.ts') && !entry.name.endsWith('.e2e-spec.ts')) {
                    found.push(path.relative(PACKAGE_DIR, absolute).split(path.sep).join('/'));
                }
            }
        };
        walk(root);
        return found;
    }

    it('declares this feature inventory as exactly the three specifications the plan names', () => {
        // THE REQUIREMENT THIS WORK OWNS. Enumerated in the configuration rather than matched by a pattern,
        // so a fourth specification added to this feature does not join the run by existing — it has to be
        // declared, and declaring it fails this assertion, which is the point.
        expect(declaredInclude('unit')).toEqual(UNIT_PROJECT_FILES);
        for (const relative of UNIT_PROJECT_FILES) {
            expect(
                fs.existsSync(path.join(PACKAGE_DIR, relative)),
                `${relative} is declared in the unit project but is not on disk`,
            ).toBe(true);
        }
    });

    it('leaves no specification orphaned, so every one on disk belongs to the project', () => {
        // THE GAP AN ENUMERATED LIST COULD OTHERWISE OPEN, CLOSED. A specification the list does not name
        // runs nowhere, which is invisible rather than merely wrong, so the filesystem is required to hold
        // exactly the enumerated set — under `src/` and under `e2e/` alike.
        const onDisk = [...specsUnder('src'), ...specsUnder('e2e')].sort();
        expect(
            onDisk,
            'a specification exists that no project collects, or a declared one has moved',
        ).toEqual([...UNIT_PROJECT_FILES].sort());
    });
});
