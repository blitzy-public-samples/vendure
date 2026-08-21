/*
 * Unit specification for `ReorderPlugin` startup option validation — what it pins, and what it deliberately
 * leaves to another file.
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
 */

import { MODULE_METADATA } from '@nestjs/common/constants';
import { ConfigService, I18nService, Logger, Type, VENDURE_VERSION } from '@vendure/core';
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { REORDER_PLUGIN_OPTIONS } from './constants';
import {
    assessPlatformSecurityPosture,
    ReorderPlugin,
    ReorderPluginConfigurationError,
} from './reorder.plugin';
import { ReorderPluginOptions, ResolvedReorderPluginOptions } from './types';

/**
 * The five option keys, **in the order the validator walks them**.
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
    readonly value: unknown;
    /** The verbatim requirement clause the message must contain. */
    readonly requirement: string;
    /** The verbatim rendering of the value the message must contain after "but received ". */
    readonly received: string;
}

/**
 * Every value that must be refused, for every one of the five keys.
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

function resetToDeclaredDefaults(): void {
    ReorderPlugin.init({});
}

/**
 * The option set a registration's own options provider is bound to, located the way the injector locates it.
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
 */
function expectNoOtherOptionKeyNamed(message: string, key: keyof ReorderPluginOptions): void {
    for (const other of OPTION_KEYS.filter(candidate => candidate !== key)) {
        expect(message).not.toContain(other);
    }
}

/**
 * The complete assertion for one rejection cell: both halves of the section 7.10 rule, the exact clause
 * cited, the exact description rendered, and the fact that a refused value is never installed.
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
            expect(ReorderPlugin.options.maxListsPerCustomer).toBe(25);
            expect(ReorderPlugin.options.maxLinesPerList).toBe(200);
            expect(ReorderPlugin.options.maxQuantityPerLine).toBe(999);
            expect(ReorderPlugin.options.defaultReorderListsPageSize).toBe(25);
            expect(ReorderPlugin.options.defaultReorderListLinesPageSize).toBe(50);
        });

        it('resolves exactly the five documented keys and no sixth', () => {
            // The negative half of the option surface. There is deliberately no name-length option: that
            // bound is the fixed constant equal to the `name` column's width, so an option would carry
            // exactly one legal value.
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
        // An omitted key and a key present with an explicit `undefined` or `null` are different inputs and
        // resolve differently: the first takes the declared default, the second is refused by name. Both
        // halves are asserted — the successes below, and the refusals in the matrix above — because a
        // validator that conflated them would either reject a valid `init({})` or admit a malformed value.
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
            // A write that lowered a bound after startup validation had accepted it would leave nothing to
            // report while the guarantee the bound exists to make was gone — worse than a wrong bound. The
            // provider hands one object to every consumer of a registration, so a single write would lower
            // the bound for all of them at once.
            const target = ReorderPlugin.options as { maxLinesPerList: number };

            expect(() => {
                target.maxLinesPerList = 1;
            }).toThrow(TypeError);
            expect(ReorderPlugin.options.maxLinesPerList).toBe(200);
        });

        it('gives two differently configured registrations their own options, whenever they bootstrap', () => {
            /*
             * THE ISOLATION PROPERTY, exercised in the order that can break it: BOTH registrations are created
             * BEFORE either is bootstrapped. A provider that resolved its options lazily from module state
             * would, in that order, hand each registration whatever the LAST `init()` had stored, so the
             * earlier registration would silently enforce the later one's bounds. The order matters because it
             * is reachable wherever one process holds two servers: a multi-tenant host, or a test file that
             * builds two configurations before booting either.
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

            expect(optionsBoundTo(first).maxLinesPerList).toBe(DECLARED_DEFAULTS.maxLinesPerList);
            expect(optionsBoundTo(second).maxLinesPerList).toBe(DECLARED_DEFAULTS.maxLinesPerList);
        });

        it('re-asserts its OWN options at bootstrap, not whichever configuration initialised last', () => {
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
             */
            ReorderPlugin.init({ maxLinesPerList: 33 });
            ReorderPlugin.init({ maxListsPerCustomer: 3, maxQuantityPerLine: 7 });
            ReorderPlugin.init({ defaultReorderListsPageSize: 5, defaultReorderListLinesPageSize: 6 });

            expect(ReorderPlugin.options.defaultReorderListsPageSize).toBe(5);

            expect(optionsBoundTo(ReorderPlugin)).toEqual(DECLARED_DEFAULTS);
            expect(optionsInForceFor(ReorderPlugin)).toEqual(DECLARED_DEFAULTS);
        });

        it('binds the bare class and its bootstrap hook to the very same frozen object', () => {
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

describe('the specifications this package discovers', () => {
    const PACKAGE_DIR = path.join(__dirname, '..');

    const UNIT_SPEC_FILES = [
        'src/reorder.plugin.spec.ts',
        'src/service/reorder-list-name.spec.ts',
        'src/service/reorder-list.service.spec.ts',
    ];

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

    it('holds exactly the three specifications the plan names, and no fourth', () => {
        // Section 0.5.1.7 fixes this feature's unit inventory at three co-located specifications. Vitest
        // discovers them by pattern, so the inventory is only as stated as the filesystem is: a fourth
        // specification would join the run by existing, and this assertion is what makes that visible.
        // Both directories are walked, because a `*.spec.ts` under `e2e/` would be collected by the unit
        // run rather than by the e2e one, which supplies the server harness it would need.
        const onDisk = [...specsUnder('src'), ...specsUnder('e2e')].sort();
        expect(onDisk, 'the discovered unit inventory has changed').toEqual([...UNIT_SPEC_FILES].sort());
        for (const relative of UNIT_SPEC_FILES) {
            expect(
                fs.existsSync(path.join(PACKAGE_DIR, relative)),
                `${relative} is named by the plan but is not on disk`,
            ).toBe(true);
        }
    });
});
// ═════════════════════════════════════════════════════════════════════════════════════════════════════
// The two bootstrap warnings
// ═════════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * The third and fourth acts of `onApplicationBootstrap`, and the only ones of the four this file can decide.
 *
 * WHAT IS BEING ASSERTED, AND WHY IT IS WORTH ASSERTING. The vulnerabilities this warning names are the
 * platform's, and no change inside this package can fix them: AAP sections 0.1.2.1, 0.3.1 and 0.6.2.3 hold
 * `packages/core` byte-identical and forbid any dependency or lock change, so upgrading the host is outside
 * this package's boundary by construction. What IS inside it is making the fact reach somebody. The README
 * and the `compatibility` comment state it, but a document is read at most once and by whoever installs the
 * package — a deployment that inherits an old platform later has nothing telling it so, and the declared
 * range cannot tell it either, because that mechanism only refuses versions BELOW its floor.
 *
 * So the assertions below are of a signal, not of a fix, and they are written to hold the signal to two
 * properties that decide whether it is worth having at all. It must not cry wolf, because an operator who
 * learns that it does will stop reading it — hence the pre-release and unparseable cases. And it must not
 * refuse to boot, because a plugin declining to start over its host's patch level converts a documented risk
 * into a certain outage, and takes an availability decision belonging to the deployment.
 */
describe('the two bootstrap warnings', () => {
    /** The release the advisories were fixed in, as the implementation's own floor. */
    const FLOOR = '3.7.2';

    describe('assessPlatformSecurityPosture', () => {
        it('reports every release below the floor as affected', () => {
            // Across all three positions of the triple, so a comparison that only ever looked at one of
            // them would fail here rather than pass by coincidence on this workspace's version.
            for (const version of ['3.7.1', '3.7.0', '3.6.9', '3.3.0', '2.0.0', '0.0.1', '3.0.0']) {
                expect(
                    assessPlatformSecurityPosture(version),
                    `${version} orders below ${FLOOR} and must be reported as affected`,
                ).toBe('affected');
            }
        });

        it('reports the floor itself, and every later release, as fixed', () => {
            // Boundary inclusive: the floor is the FIRST fixed release, so it must not warn. The two-digit
            // minor and patch cases are here because a string comparison would order '3.10.0' below '3.7.2'
            // and '3.7.10' below '3.7.2', which is exactly the defect a numeric comparison exists to avoid.
            for (const version of ['3.7.2', '3.7.3', '3.7.10', '3.8.0', '3.10.0', '4.0.0', '10.0.0']) {
                expect(
                    assessPlatformSecurityPosture(version),
                    `${version} is at or above ${FLOOR} and must be reported as fixed`,
                ).toBe('fixed');
            }
        });

        it('honours semantic-version precedence for a pre-release of the fixed release itself', () => {
            // SEMVER CLAUSE 9: A PRE-RELEASE ORDERS BELOW ITS OWN RELEASE. `3.7.2-rc.1` therefore PRECEDES
            // 3.7.2, and nothing establishes that such a build already carried all four fixes — so it is
            // neither 'affected' (which would assert a vulnerability it may not have) nor 'fixed' (which
            // would assert safety nothing has shown). The third outcome exists for exactly this case.
            for (const version of ['3.7.2-next.0', '3.7.2-rc.1', '3.7.2-0', '3.7.2-alpha.1.2']) {
                expect(
                    assessPlatformSecurityPosture(version),
                    `${version} precedes ${FLOOR} in semver order, so its posture is not proven`,
                ).toBe('unproven-prerelease');
            }
        });

        it('treats a pre-release of a LATER release as fixed, because it still orders above the floor', () => {
            // The distinction that keeps the previous case from crying wolf: `3.8.0-alpha.2` is below 3.8.0
            // but comfortably above 3.7.2, so it does carry the fixes and must produce no line at all.
            for (const version of ['3.8.0-alpha.2', '3.7.3-rc.1', '4.0.0-beta.7', '3.10.0-next.5']) {
                expect(
                    assessPlatformSecurityPosture(version),
                    `${version} orders above ${FLOOR}, so it carries the fixes`,
                ).toBe('fixed');
            }
        });

        it('ignores build metadata, which semver excludes from precedence', () => {
            // Clause 10: build metadata does not participate in ordering, so `3.7.2+build.5` IS 3.7.2 and
            // `3.7.1+build.5` is still affected.
            expect(assessPlatformSecurityPosture('3.7.2+build.5')).toBe('fixed');
            expect(assessPlatformSecurityPosture('3.7.1+build.5')).toBe('affected');
            // Both parts together, in the order semver specifies them.
            expect(assessPlatformSecurityPosture('3.7.2-rc.1+build.5')).toBe('unproven-prerelease');
        });

        it('reports a version it cannot read as unassessable, claiming nothing either way', () => {
            // CALLING IT AFFECTED WOULD ASSERT A VULNERABILITY FROM IGNORANCE; CALLING IT FIXED WOULD ASSERT
            // SAFETY FROM THE SAME IGNORANCE. Neither belongs in a startup log. Saying the posture could not
            // be determined is the only honest answer, and unlike silence it still prompts a check.
            for (const version of [
                '',
                '   ',
                'next',
                '3',
                '3.7',
                '3.7.x',
                'v3.7.0',
                'not-a-version',
                '3.7.2-',
            ]) {
                expect(
                    assessPlatformSecurityPosture(version),
                    `"${version}" is unreadable, so neither answer may be asserted about it`,
                ).toBe('unassessable');
            }
        });

        it('rejects a core identifier carrying a leading zero, which semver forbids', () => {
            // THE SHAPE THAT MADE THIS WORTH VALIDATING AT ALL. `03.8.0` is not a valid version, but a
            // permissive `\d+\.\d+\.\d+` reads it as major 3 — LATER than the floor — and so suppresses the
            // warning entirely. Every position of the triple is exercised, because a check applied to only
            // one of them would pass here by coincidence.
            for (const version of ['03.8.0', '3.08.0', '3.8.00', '00.0.0', '3.7.02', '0003.7.2']) {
                expect(
                    assessPlatformSecurityPosture(version),
                    `"${version}" carries a leading zero in its version core, so it is not a version`,
                ).toBe('unassessable');
            }
        });

        it('rejects an empty dot-separated identifier in a pre-release or in build metadata', () => {
            // Semver clauses 9 and 10 both require every identifier to be non-empty. A character class that
            // simply admits dots — `[0-9A-Za-z.-]+` — admits all of these, and each then parses as a
            // pre-release or build suffix on a release ABOVE the floor, which again means silence.
            for (const version of [
                '3.8.0-..',
                '3.8.0-.',
                '3.8.0-a..b',
                '3.8.0-.a',
                '3.8.0-a.',
                '3.8.0+.',
                '3.8.0+a..b',
                '3.8.0+.a',
                '3.8.0+a.',
            ]) {
                expect(
                    assessPlatformSecurityPosture(version),
                    `"${version}" carries an empty identifier, so it is not a version`,
                ).toBe('unassessable');
            }
        });

        it('rejects a NUMERIC pre-release identifier carrying a leading zero, while allowing one in build', () => {
            // The one place the two halves of the grammar deliberately differ, and therefore the one most
            // likely to be got wrong by approximating either half from the other. A numeric pre-release
            // identifier may not carry a leading zero; a build identifier may.
            expect(assessPlatformSecurityPosture('3.7.2-01')).toBe('unassessable');
            expect(assessPlatformSecurityPosture('3.8.0-1.02')).toBe('unassessable');
            // `0` alone is a legal numeric identifier, and an alphanumeric one may begin with a zero.
            expect(assessPlatformSecurityPosture('3.7.2-0')).toBe('unproven-prerelease');
            expect(assessPlatformSecurityPosture('1.0.0-0A.is.legal')).toBe('affected');
            // Build metadata: leading zeros are explicitly permitted, and it never affects precedence.
            expect(assessPlatformSecurityPosture('3.7.2+0.build.01')).toBe('fixed');
            expect(assessPlatformSecurityPosture('3.7.2+21AF26D3----117B344092BD')).toBe('fixed');
        });

        it('rejects a trailing separator and a character the grammar does not permit', () => {
            // `-`, `+` and `.` may not end a version, and an identifier is limited to alphanumerics and the
            // hyphen — an underscore is not in it, however version-like the rest of the string looks.
            for (const version of ['3.7.2-', '3.7.2+', '3.7.2.', '3.8.0-a_b', '3.8.0+a_b', '3.8.0-α']) {
                expect(assessPlatformSecurityPosture(version), `"${version}" is not a valid version`).toBe(
                    'unassessable',
                );
            }
        });

        it('lets no malformed version reach the silent outcome, whatever it looks like', () => {
            // THE PROPERTY THE FOUR CASES ABOVE EXIST TO ESTABLISH, ASSERTED DIRECTLY. Silence is the only
            // outcome that loses information, and it is the outcome every one of these defects produced. So
            // this states the invariant over the whole malformed corpus at once, rather than leaving it as
            // something a reader has to infer from four separate lists — and it deliberately includes shapes
            // that look LATER than the floor, since those are the ones a permissive parser waves through.
            const malformed = [
                '03.8.0',
                '3.08.0',
                '3.8.00',
                '0003.7.2',
                '3.8.0-..',
                '3.8.0-.',
                '3.8.0-a..b',
                '3.8.0+.',
                '3.8.0+a..b',
                '3.7.2-01',
                '3.8.0-1.02',
                '3.7.2-',
                '3.7.2+',
                '3.7.2.',
                '3.8.0-a_b',
                '3.8.0+a_b',
                '3.8.0-α',
                'v3.8.0',
                '3.8',
                '3.8.0.1',
                '',
                'latest',
            ];
            for (const version of malformed) {
                expect(
                    assessPlatformSecurityPosture(version),
                    `"${version}" must never be treated as carrying the fixes`,
                ).not.toBe('fixed');
                // And the specific outcome, so the invariant cannot be satisfied by mislabelling one of
                // these as 'affected' or 'unproven-prerelease' — either would be a claim about a version
                // that has no defined position at all.
                expect(assessPlatformSecurityPosture(version)).toBe('unassessable');
            }
        });

        it('reads a version carrying surrounding whitespace', () => {
            // The constant it is handed comes from a published `package.json`, so it is trimmed rather than
            // rejected: a stray space must not turn a readable version into an unassessable one.
            expect(assessPlatformSecurityPosture(' 3.7.0 ')).toBe('affected');
            expect(assessPlatformSecurityPosture('\t3.7.2\n')).toBe('fixed');
        });
    });

    describe('the bootstrap hook that emits it', () => {
        /**
         * Builds a plugin instance over doubles, so the hook can be driven without a server.
         *
         * The engine is a parameter because the hook's other warning is decided by it, and a subject fixed to
         * one engine would silently exercise only half of the pair.
         */
        function bootstrapSubject(engine = 'postgres'): {
            plugin: ReorderPlugin;
            addTranslationFile: ReturnType<typeof vi.fn>;
        } {
            const addTranslationFile = vi.fn();
            const plugin = new ReorderPlugin(
                { addTranslationFile } as unknown as I18nService,
                {
                    dbConnectionOptions: { type: engine },
                } as unknown as ConfigService,
            );
            return { plugin, addTranslationFile };
        }

        afterEach(() => {
            vi.restoreAllMocks();
        });

        it('warns exactly once on a platform below the floor, naming the version and all four advisories', () => {
            // Guarded rather than assumed: this workspace runs 3.7.0, but the assertion states which branch
            // it is exercising, so the same file remains honest on a workspace that has been upgraded.
            if (assessPlatformSecurityPosture(VENDURE_VERSION) !== 'affected') {
                expect(
                    assessPlatformSecurityPosture(VENDURE_VERSION),
                    `this workspace runs Vendure ${VENDURE_VERSION}, which is not below ${FLOOR}, so the ` +
                        'affected branch is not reachable here and the case below is the live one',
                ).not.toBe('affected');
                return;
            }
            const warn = vi.spyOn(Logger, 'warn').mockImplementation(() => undefined);
            // Pinned to an engine that receives the check constraints, so the only line this can produce is
            // the advisory one and "exactly once" means what it says.
            const { plugin } = bootstrapSubject('postgres');

            plugin.onApplicationBootstrap();

            expect(warn, 'one line, not one per advisory').toHaveBeenCalledTimes(1);
            const [message, context] = warn.mock.calls[0];
            expect(context, 'the line must be attributable to this plugin').toBe('ReorderPlugin');
            // The version actually running, so an operator does not have to work out which release the
            // warning is about.
            expect(message).toContain(VENDURE_VERSION);
            expect(message).toContain(FLOOR);
            for (const advisory of [
                'GHSA-v85r-wfgv-jcqc',
                'GHSA-hc75-2v4j-x372',
                'GHSA-fp4j-ff6j-9793',
                'GHSA-rgjm-ff27-p2hf',
            ]) {
                expect(message, `${advisory} is what an operator can look up`).toContain(advisory);
            }
            // AND IT MUST NOT MISATTRIBUTE. The vulnerabilities are the platform's; a line that let a reader
            // conclude this plugin introduced them would send the investigation to the wrong place.
            expect(message).toContain('not introduced or fixable by the ReorderPlugin');
        });

        it('says nothing on a platform at or above the floor', () => {
            // The complement of the case above, exercised through the predicate the hook consults rather
            // than by rewriting a platform constant, so exactly one of the two is live on any workspace.
            if (assessPlatformSecurityPosture(VENDURE_VERSION) !== 'fixed') {
                expect(
                    assessPlatformSecurityPosture('3.7.2'),
                    'the floor release must be treated as fixed, which is what makes this hook silent once ' +
                        'the platform is upgraded',
                ).toBe('fixed');
                return;
            }
            const warn = vi.spyOn(Logger, 'warn').mockImplementation(() => undefined);
            const { plugin } = bootstrapSubject('postgres');

            plugin.onApplicationBootstrap();

            expect(warn, 'an upgraded platform must produce no advisory line at all').not.toHaveBeenCalled();
        });

        it('reports an engine that does not receive the two named check constraints', () => {
            // THE OTHER THING THE DEPLOYMENT CANNOT SEE FOR ITSELF. Both entities declare both checks on every
            // engine and TypeORM discards them on the MySQL family, so on those two engines the invariants have
            // no database-side backstop. Nothing this plugin serves is affected — every write path refuses a
            // non-positive quantity in process and the counter floor is in the decrement's own predicate — but a
            // writer that does not come through the plugin can persist invalid state, and the operator who
            // later points a repair script at these tables is not the person who read the README.
            //
            // Asserted as a WARNING, and asserted to be about the engine rather than about this deployment's
            // catalogue: the shortfall travels with the mapper version, which is why the check needs no query.
            for (const engine of ['mysql', 'mariadb']) {
                const warn = vi.spyOn(Logger, 'warn').mockImplementation(() => undefined);
                const { plugin } = bootstrapSubject(engine);

                plugin.onApplicationBootstrap();

                const lines = warn.mock.calls.map(call => String(call[0]));
                const constraintLine = lines.find(line => line.includes('check constraints'));
                expect(constraintLine, `${engine} must be told the constraints are absent`).toBeDefined();
                // Both objects named exactly, because the name is what an operator greps a catalogue for.
                expect(constraintLine).toContain('CHK_reorder_list_line_quantity_positive');
                expect(constraintLine).toContain('CHK_reorder_list_line_count_non_negative');
                expect(constraintLine).toContain(engine);
                // Attribution: the engine supports them, the mapper drops them. Blaming the engine would send
                // an operator to upgrade a server that is already capable.
                expect(constraintLine).toContain('mapper discards them');
                // And the consequence stated in terms an operator can act on, rather than as a schema fact.
                expect(constraintLine).toContain('does not come through this plugin');
                for (const call of warn.mock.calls) {
                    expect(call[1], 'every line must be attributable to this plugin').toBe('ReorderPlugin');
                }
                vi.restoreAllMocks();
            }
        });

        it('says nothing about check constraints on an engine that receives them', () => {
            // The complement, so the warning cannot be a constant that fires everywhere. PostgreSQL and the
            // SQLite family both create the objects, and a line claiming otherwise there would be false.
            for (const engine of ['postgres', 'sqljs', 'sqlite', 'better-sqlite3', 'cockroachdb']) {
                const warn = vi.spyOn(Logger, 'warn').mockImplementation(() => undefined);
                const { plugin } = bootstrapSubject(engine);

                plugin.onApplicationBootstrap();

                const lines = warn.mock.calls.map(call => String(call[0]));
                expect(
                    lines.some(line => line.includes('check constraints')),
                    `${engine} creates both objects, so claiming they are absent would be false`,
                ).toBe(false);
                vi.restoreAllMocks();
            }
        });

        it('issues no DDL of its own to close the gap it reports', () => {
            // THE LINE THIS METHOD MUST NOT CROSS. Closing the shortfall rather than reporting it needs
            // engine-specific ALTER TABLE, which is conflict C-E option two and requires a maintainer ruling
            // that has not been recorded. The subject is handed no connection, query runner or entity manager
            // at all, so the hook cannot have issued a statement: a construction that needed one would fail
            // here rather than pass quietly.
            vi.spyOn(Logger, 'warn').mockImplementation(() => undefined);
            const { plugin } = bootstrapSubject('mariadb');

            expect(() => plugin.onApplicationBootstrap()).not.toThrow();
        });

        it('does not claim to have looked in the catalogue when it has not', () => {
            // A CORRECTLY HARDENED DEPLOYMENT MUST NOT BE SENT CHASING A NON-PROBLEM. Engine type establishes
            // what the mapper does, not what is in this database: an operator may have provisioned both
            // constraints by hand, and the migration's existing-table check deliberately tolerates surplus
            // objects. So the line is required to qualify the claim and to say outright that it did not look —
            // a categorical "they are absent from this database" would sometimes be false, and one false
            // alarm is enough for an operator to stop reading the genuine warning beside it.
            const warn = vi.spyOn(Logger, 'warn').mockImplementation(() => undefined);
            const { plugin } = bootstrapSubject('mysql');

            plugin.onApplicationBootstrap();

            const line = warn.mock.calls
                .map(call => String(call[0]))
                .find(l => l.includes('check constraints'));
            expect(line).toBeDefined();
            expect(line, 'the claim must be conditional on nothing else having provisioned them').toContain(
                'unless something outside this plugin has provisioned them',
            );
            expect(line, 'and it must admit that it did not check').toContain(
                'does not read the catalogue to check',
            );
            expect(line, 'an operator who did provision them must be told the line does not apply').toContain(
                'does not apply to you',
            );
            // The categorical form must be gone, not merely softened somewhere else in the sentence.
            expect(line).not.toContain('so they are absent from this database');
        });

        it('says the posture is unproven, not that it is vulnerable, on a pre-release of the fixed release', () => {
            // The wording matters as much as the branch: this build MIGHT carry every fix, so asserting it is
            // affected would be a claim the version does not support. Driven through the assessment directly,
            // because a workspace cannot be on two versions at once.
            expect(assessPlatformSecurityPosture('3.7.2-rc.1')).toBe('unproven-prerelease');
        });

        it('says the posture is undetermined, not safe, when the version cannot be read', () => {
            // Silence here would be the one outcome that loses information: an operator whose platform
            // reports an unreadable version learns nothing, and the absence of a line reads as reassurance.
            expect(assessPlatformSecurityPosture('not-a-version')).toBe('unassessable');
        });

        it('does not refuse to start, whatever the platform version is', () => {
            // THE PROPERTY THAT KEEPS THIS A WARNING. A plugin that threw here would turn a known,
            // documented and unfixable-from-inside risk into a certain outage, and would take an
            // availability decision that belongs to the deployment. Asserted alongside the fact that the
            // hook's own first act — option re-validation — still ran, so "it does not throw" is not being
            // bought by the hook doing nothing.
            vi.spyOn(Logger, 'warn').mockImplementation(() => undefined);
            const { plugin, addTranslationFile } = bootstrapSubject('mariadb');

            expect(() => plugin.onApplicationBootstrap()).not.toThrow();
            expect(
                addTranslationFile,
                'the catalogue registration must still have happened, so the hook was not short-circuited',
            ).toHaveBeenCalledTimes(1);
        });
    });
});
