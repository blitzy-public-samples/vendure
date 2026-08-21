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
import { ConfigService, I18nService, Logger, Type } from '@vendure/core';
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { REORDER_PLUGIN_OPTIONS } from './constants';
import { ReorderPlugin, ReorderPluginConfigurationError } from './reorder.plugin';
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
 * The platform's own default Shop list-query limit, restated here because it is the value a server carries
 * unless its configuration lowers it, and both page-size defaults have to sit at or below it.
 *
 * Not imported: it is a property of a resolved `VendureConfig` rather than an exported constant, and reading
 * it out of one would need a bootstrapped server — which is precisely what these cases avoid. The number is
 * pinned by the end-to-end suite instead, which reads it off a real server's own configuration.
 * (`packages/core/src/config/default-config.ts` L89.)
 */
const DEFAULT_SHOP_LIST_QUERY_LIMIT = 100;

/**
 * The requirement clause carried when a page-size option exceeds the running server's Shop list-query limit.
 * The clause names the limit AND the reason, because the reason is what makes the refusal correct rather than
 * merely strict: the platform refuses a larger `take` outright instead of clamping it, so an unrefused value
 * would leave every read that omits `take` failing at request time on a server that started cleanly.
 */
function mustNotExceedShopLimit(limit: number): string {
    return (
        `must not exceed apiOptions.shopListQueryLimit, which this server sets to ${String(limit)}, ` +
        'because it is applied as the `take` of a Shop list query when a caller supplies none and the ' +
        'platform refuses a larger page outright rather than clamping it'
    );
}

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

    /**
     * The unit inventory this package actually ships, and the one entry that is wider than the plan's.
     *
     * AAP section 0.5.1.7 enumerates THREE co-located specifications — this file and the two under
     * `src/service`. `src/api/reorder-list-counter-repair.spec.ts` is a fourth, and it is listed here rather
     * than allowed to fail this assertion because it is a declared addition and not a drift: section 0.6.1.2
     * puts every co-located `.spec.ts` beneath `packages/reorder-plugin/src` in scope, and the file's own
     * header states the deviation under section 0.8.2's no-silent-deviation obligation. What it guards is a
     * class of defect no other specification can reach — WHEN the single-list read reconciles `lineCount`
     * relative to GraphQL's own field execution, and WHICH parent object is eligible — both of which are
     * invisible in the payload of every request that has nothing to repair, and both of which have been got
     * wrong before.
     *
     * The assertion below remains an EXACT SET, so a fifth specification still has to be declared here before
     * it can join the run.
     */
    const UNIT_SPEC_FILES = [
        'src/api/reorder-list-counter-repair.spec.ts',
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

    it('holds exactly the declared specifications, and no undeclared one', () => {
        // Vitest discovers specifications by PATTERN, so the inventory is only as stated as the filesystem
        // is: an undeclared specification joins the run merely by existing, and this assertion is what makes
        // that visible. Both directories are walked, because a `*.spec.ts` under `e2e/` would be collected by
        // the unit run rather than by the e2e one, which supplies the server harness it would need.
        // {@link UNIT_SPEC_FILES} records which entry is wider than AAP section 0.5.1.7 and why.
        const onDisk = [...specsUnder('src'), ...specsUnder('e2e')].sort();
        expect(onDisk, 'the discovered unit inventory has changed').toEqual([...UNIT_SPEC_FILES].sort());
        for (const relative of UNIT_SPEC_FILES) {
            expect(
                fs.existsSync(path.join(PACKAGE_DIR, relative)),
                `${relative} is declared but is not on disk`,
            ).toBe(true);
        }
    });
});
// ═════════════════════════════════════════════════════════════════════════════════════════════════════
// The bootstrap hook
// ═════════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * `onApplicationBootstrap`, and the two acts it performs — no more than two.
 *
 * WHY THE ABSENCE IS ASSERTED RATHER THAN LEFT IMPLICIT. An earlier revision emitted two advisory lines from
 * this hook: one naming the platform's published security advisories against releases below 3.7.2, and one
 * naming the two check constraints TypeORM does not create on the MySQL family. Both were truthful, and
 * neither belonged here. AAP section 0.2.4.1 scopes this file to entity, provider and resolver registration,
 * the declared compatibility range, `init()`, startup option validation and the i18n catalogue; a hardcoded
 * advisory list and version floor inside a feature plugin additionally goes stale with no mechanism to
 * refresh it, so it would eventually mislead the operator it was written to inform. The engine limitation
 * conflict C-E records is stated where a reader actually meets it instead: the migration's own header, the
 * README, and a positive assertion in the migration end-to-end suite.
 *
 * So the cases below hold the hook to exactly what it is for, and the last one is the guard against the
 * removal being undone by accident.
 */
describe('the bootstrap hook', () => {
    /**
     * Builds a plugin instance over doubles, so the hook can be driven without a server.
     *
     * The engine is a parameter because it is the input the removed check-constraint warning branched on, so
     * a subject fixed to one engine could not show that no engine now produces a line.
     */
    function bootstrapSubject(
        engine = 'postgres',
        shopListQueryLimit: unknown = DEFAULT_SHOP_LIST_QUERY_LIMIT,
    ): {
        plugin: ReorderPlugin;
        addTranslationFile: ReturnType<typeof vi.fn>;
    } {
        const addTranslationFile = vi.fn();
        const plugin = new ReorderPlugin(
            { addTranslationFile } as unknown as I18nService,
            {
                dbConnectionOptions: { type: engine },
                // The hook reads this to check both page sizes against the limit that will actually clamp
                // them, so the double carries it. `100` is the platform's own default
                // (`packages/core/src/config/default-config.ts` L89), which is what a server carries unless
                // its configuration lowers it.
                apiOptions: { shopListQueryLimit },
            } as unknown as ConfigService,
        );
        return { plugin, addTranslationFile };
    }

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('registers the message catalogue exactly once, for the one language this package ships', () => {
        const { plugin, addTranslationFile } = bootstrapSubject();

        plugin.onApplicationBootstrap();

        expect(addTranslationFile).toHaveBeenCalledTimes(1);
        expect(addTranslationFile.mock.calls[0][0]).toBe('en');
        expect(String(addTranslationFile.mock.calls[0][1])).toContain('en.json');
    });

    it('writes nothing to the startup log, on any engine', () => {
        // ★ THE ASSERTION THAT KEEPS THE HOOK IN SCOPE. Every engine is driven, because the warning that
        // used to be emitted here was decided by exactly this value, and `error`, `warn` and `info` are all
        // watched so that a line cannot reappear at a different level and go unnoticed.
        const error = vi.spyOn(Logger, 'error').mockImplementation(() => undefined);
        const warn = vi.spyOn(Logger, 'warn').mockImplementation(() => undefined);
        const info = vi.spyOn(Logger, 'info').mockImplementation(() => undefined);

        for (const engine of ['postgres', 'mysql', 'mariadb', 'sqljs', 'better-sqlite3']) {
            const { plugin } = bootstrapSubject(engine);

            plugin.onApplicationBootstrap();
        }

        expect(error, 'the bootstrap hook must log nothing').not.toHaveBeenCalled();
        expect(
            warn,
            'the bootstrap hook must not warn about the platform or the schema it is given',
        ).not.toHaveBeenCalled();
        expect(info).not.toHaveBeenCalled();
    });

    it('declares no platform advisory list, version floor or engine posture of its own', () => {
        // Read out of the shipped source rather than inferred from behaviour, because what is being asserted
        // is that the DECLARATIONS are gone — a table of advisory identifiers and a hardcoded release floor
        // are stale the moment they are written, and a behavioural assertion would pass on a version of this
        // file that still carried them behind an unreached branch.
        const source = fs.readFileSync(path.join(__dirname, 'reorder.plugin.ts'), 'utf-8');

        for (const absent of [
            'GHSA-',
            'PLATFORM_ADVISORIES',
            'PLATFORM_SECURITY_FLOOR',
            'assessPlatformSecurityPosture',
            'VENDURE_VERSION',
            'warnIfCheckConstraintsAreUnavailable',
            'CHECK_LESS_ENGINES',
        ]) {
            expect(source, `${absent} must not appear in the plugin class`).not.toContain(absent);
        }
        expect(source, 'the plugin must issue no log line of its own at bootstrap').not.toContain(
            'Logger.warn',
        );
    });

    it('does not refuse to start, and still re-validates the options it will serve with', () => {
        // The hook's fail-closed acts are the two validations, and they must remain the ONLY things that can
        // stop a boot here. Asserted alongside the catalogue registration so that "it does not throw" is
        // not bought by the hook doing nothing.
        const { plugin, addTranslationFile } = bootstrapSubject('mariadb');

        expect(() => plugin.onApplicationBootstrap()).not.toThrow();
        expect(
            addTranslationFile,
            'the catalogue registration must still have happened, so the hook was not short-circuited',
        ).toHaveBeenCalledTimes(1);
    });

    // ────────────────────────────────────────────────────────────────────────────────────────────────────
    // The one bound `init()` cannot check: a page size against the server's own Shop list-query limit.
    //
    // WHY THIS IS A BOOT FAILURE AND NOT A CAVEAT. Both page-size options are applied as the `take` of a
    // `ListQueryBuilder` query when a caller supplies none, and `parseTakeSkipParams` throws
    // `UserInputError('error.list-query-limit-exceeded')` when `take` exceeds `apiOptions.shopListQueryLimit`
    // for a Shop request — this plugin leaves `ignoreQueryLimits` false deliberately. So a page size above
    // the limit does not degrade to the limit: it makes EVERY read that omits `take` fail, on a server that
    // started healthily. The refusal therefore has to happen at bootstrap, where the configured limit is
    // finally readable, and it has to name which key is at fault.
    // ────────────────────────────────────────────────────────────────────────────────────────────────────

    it.each([
        ['defaultReorderListsPageSize' as const, 24, 25],
        ['defaultReorderListLinesPageSize' as const, 49, 50],
    ])(
        'refuses to start when the server limit is below %s, naming that key',
        (key, limit, declaredDefault) => {
            const { plugin, addTranslationFile } = bootstrapSubject('postgres', limit);

            let caught: unknown;
            try {
                plugin.onApplicationBootstrap();
            } catch (e) {
                caught = e;
            }

            expect(caught, 'a page size above the server limit must stop the boot').toBeInstanceOf(
                ReorderPluginConfigurationError,
            );
            expect((caught as ReorderPluginConfigurationError).optionKey).toBe(key);
            expect((caught as Error).message).toContain(key);
            expect((caught as Error).message).toContain(mustNotExceedShopLimit(limit));
            // The declared default is what was refused, so the message names a value the operator can find
            // in their own configuration rather than an abstraction.
            expect((caught as Error).message).toContain(String(declaredDefault));
            // And the hook failed CLOSED: the catalogue registration is behind the validations, so it did
            // not run. A boot that got as far as registering translations would be a boot that continued.
            expect(addTranslationFile).not.toHaveBeenCalled();
        },
    );

    it('accepts a page size exactly equal to the server limit, because the platform test is strictly greater', () => {
        // The boundary matters in the accepting direction too: `parseTakeSkipParams` refuses `take > limit`,
        // so a page size OF the limit is served. Refusing it here would be stricter than the platform and
        // would reject a configuration that works.
        const { plugin, addTranslationFile } = bootstrapSubject('postgres', 50);

        expect(() => plugin.onApplicationBootstrap()).not.toThrow();
        expect(addTranslationFile).toHaveBeenCalledTimes(1);
    });

    it('leaves the three non-page-size options unbounded by the Shop limit', () => {
        // `maxListsPerCustomer` (25), `maxLinesPerList` (200) and `maxQuantityPerLine` (999) are all above a
        // limit of 10, and none of them is ever applied as a `take` — so a low limit must not refuse them.
        // Without this case the check could be widened to every key and nothing would notice.
        const { plugin } = bootstrapSubject('postgres', 50);

        expect(() => plugin.onApplicationBootstrap()).not.toThrow();
    });

    it.each([
        ['undefined', undefined],
        ['a fractional value', 12.5],
        ['zero', 0],
        ['a negative number', -1],
        ['a string', '100'],
    ])('draws no conclusion from a Shop limit that is %s', (_label, limit) => {
        // A limit this plugin cannot read is the platform's own configuration to answer for. Comparing
        // against it would produce a refusal naming a plugin key for somebody else's value — and worse,
        // `25 > undefined` is false while `25 > '10'` is true, so an unguarded comparison would be
        // arbitrary rather than merely wrong. The platform clamps with whatever it holds; this hook
        // declines to conclude anything.
        const { plugin, addTranslationFile } = bootstrapSubject('postgres', limit);

        expect(() => plugin.onApplicationBootstrap()).not.toThrow();
        expect(addTranslationFile).toHaveBeenCalledTimes(1);
    });
});
