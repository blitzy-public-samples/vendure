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
 * The declared default of every option — the five values this run supplies, restated here as the expected outcome
 * rather than imported from the module under test.
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
 * The requirement clause carried when `maxQuantityPerLine` exceeds the largest signed 32-bit integer. The
 * clause names the reason as well as the number, so the whole of it is pinned: that ceiling exists because
 * the column the bound guards is a 32-bit `int` and the published GraphQL `Int` is a signed 32-bit integer,
 * and a shortened expectation would not notice that reason going missing.
 */
const MUST_NOT_EXCEED_THE_32_BIT_CEILING =
    'must not exceed 2147483647, the largest signed 32-bit integer, because the quantity column it ' +
    'guards is a 32-bit int and the published GraphQL Int is a signed 32-bit integer';

/**
 * The requirement clause carried when a PAGE SIZE exceeds the same number. It is a separate expectation
 * rather than a reuse of the one above, and deliberately so: a page size is never stored in a column, so the
 * quantity key's reason would be false of it. The reason true of it is the request path — the value is
 * applied as the `take` of a Shop list query and is carried by the published GraphQL `Int` — and it is
 * pinned in full for the same purpose, so the reason cannot silently disappear from the refusal.
 */
const PAGE_SIZE_MUST_NOT_EXCEED_THE_32_BIT_CEILING =
    'must not exceed 2147483647, the largest signed 32-bit integer, because a page size is applied as ' +
    'the `take` of a Shop list query and is carried by the published GraphQL Int, which is a signed ' +
    '32-bit integer, so a larger page could never be served';

const MAX_SIGNED_32_BIT_INTEGER = 2147483647;

/**
 * The two keys that carry the 32-bit ceiling because their value is a page rather than a stored quantity.
 */
const PAGE_SIZE_KEYS: ReadonlyArray<keyof ReorderPluginOptions> = [
    'defaultReorderListsPageSize',
    'defaultReorderListLinesPageSize',
];

/**
 * The two keys that carry a LOWER bound only, listed explicitly rather than derived by filtering
 * {@link OPTION_KEYS}. A filter would silently absorb a sixth option into the no-ceiling set and assert that
 * an unbounded value is correct for it; naming these two means a new option has to be placed on one side of
 * the rule or the other by hand.
 */
const LOWER_BOUND_ONLY_KEYS: ReadonlyArray<keyof ReorderPluginOptions> = [
    'maxListsPerCustomer',
    'maxLinesPerList',
];

/**
 * The platform's own default Shop list-query limit, restated here because it is the value a server carries unless
 * its configuration lowers it, and both page-size defaults have to sit at or below it.
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
 * One row of the rejection matrix: a value the plugin must refuse, the requirement clause it must cite, and the
 * description it must render for the value.
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
 * The requirement clause carried when the ARGUMENT to `init()` is not an option object at all. Quoted
 * verbatim, because the clause is what tells an operator the argument — rather than one of the five keys —
 * is what has to change.
 */
const MUST_BE_AN_OBJECT_ARGUMENT =
    'must be an object carrying option keys — any subset of ReorderPluginOptions — or be omitted altogether';

/**
 * One row of the argument-shape matrix: a value that is not an option object, and the description the refusal
 * must render for it.
 */
interface RejectedArgumentCase {
    /** The `it()` title fragment, so a failure names the cell without the file having to be opened. */
    readonly label: string;
    readonly value: unknown;
    /** The verbatim rendering of the value the message must contain after "but received ". */
    readonly received: string;
}

/**
 * Every argument shape `init()` must refuse: `null`, an array, a function and each primitive.
 *
 * None of them can be reached from TypeScript, and all of them are reachable from JavaScript, from a JSON
 * configuration file and from any expression that returned the wrong thing. A string is the consequential
 * one: spread into the merge it contributes one enumerable index key per character, so accepting it would
 * resolve, freeze and serve `{ 0: 'n', 1: 'o', … }` beside the five declared defaults.
 */
const REJECTED_ARGUMENTS: readonly RejectedArgumentCase[] = [
    { label: 'null', value: null, received: 'null' },
    { label: 'an empty array', value: [], received: 'an array' },
    { label: 'a populated array', value: [{ maxLinesPerList: 7 }], received: 'an array' },
    { label: 'a string', value: 'nonsense', received: 'a string of length 8' },
    { label: 'a number', value: 42, received: 'the number 42' },
    { label: 'a boolean', value: true, received: 'a boolean (true)' },
    { label: 'a function', value: () => ({ maxLinesPerList: 7 }), received: 'a function' },
    { label: 'a bigint', value: BigInt(42), received: 'a bigint' },
    {
        label: 'a symbol',
        value: Symbol('an options argument that arrived as a symbol'),
        received: 'a symbol',
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
 * Runs `init()` with an argument that is not an option object, and returns the refusal it raised.
 *
 * The cast is the cell rather than a convenience: `init()` is typed, so the caller this guards against is a
 * JavaScript one, a JSON configuration file or an expression that produced the wrong thing — and the `expect`
 * inside turns "the call did not throw at all" into a failure that names that fact.
 */
function captureArgumentFailure(value: unknown): ReorderPluginConfigurationError {
    let caught: unknown;
    try {
        ReorderPlugin.init(value as ReorderPluginOptions);
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

    expect(() => ReorderPlugin.init(optionsWith(key, value))).toThrowError(ReorderPluginConfigurationError);
    // Half two, in the form a developer reading a stack trace actually has: the offending key is legible in the
    // message text itself, not only as structured data beside it.
    expect(() => ReorderPlugin.init(optionsWith(key, value))).toThrowError(new RegExp(key));

    const error = captureInitFailure(optionsWith(key, value));

    // The class is named three ways, because each survives a different kind of change: `instanceof` proves the
    // prototype chain the plugin restores explicitly, `constructor.name` proves the class identity that
    // survives minification of the message, and `name` proves the value that appears in a serialised error and
    // in a stack trace's first line.
    expect(error.constructor.name).toBe('ReorderPluginConfigurationError');
    expect(error.name).toBe('ReorderPluginConfigurationError');
    expect(error.optionKey).toBe(key);
    expect(error.message).toContain(`the "${key}" option`);
    expect(error.message).toContain(requirement);
    expect(error.message).toContain(`but received ${received}.`);
    expect(error.message).toContain('Correct the value passed to ReorderPlugin.init()');
    expectNoOtherOptionKeyNamed(error.message, key);

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

    describe('a non-object argument fails initialisation and names the argument, not an option', () => {
        it.each(REJECTED_ARGUMENTS)('refuses $label', ({ value, received }) => {
            const optionsBeforeTheAttempt = ReorderPlugin.options;

            const error = captureArgumentFailure(value);

            expect(error.constructor.name).toBe('ReorderPluginConfigurationError');
            expect(error.name).toBe('ReorderPluginConfigurationError');
            // There is no key to name, because nothing was ever read out of the value.
            expect(error.optionKey).toBeNull();
            expect(error.message).toContain('the options argument');
            // The subject is rendered by branch rather than by interpolating the key, so `null` must never
            // reach the message as a sixth option that does not exist.
            expect(error.message).not.toContain('the "null" option');
            expect(error.message).toContain(MUST_BE_AN_OBJECT_ARGUMENT);
            expect(error.message).toContain(`but received ${received}.`);
            // The tail is the instruction a caller acts on, and it is the same instruction for both kinds of
            // rejection.
            expect(error.message).toContain('Correct the value passed to ReorderPlugin.init()');

            // A refused argument installs nothing, exactly as a refused value installs nothing: the set
            // already in force is the same object it was before the attempt.
            expect(ReorderPlugin.options).toBe(optionsBeforeTheAttempt);
            expect(ReorderPlugin.options).toEqual(DECLARED_DEFAULTS);
        });

        it('names none of the five option keys, the rejection being of the argument itself', () => {
            const error = captureArgumentFailure(42);

            for (const key of OPTION_KEYS) {
                expect(error.message).not.toContain(key);
            }
        });

        it('withholds the content of a string argument, rendering its kind and length only', () => {
            const withheldValue = 'AN_OPTIONS_ARGUMENT_WHOSE_CONTENT_MUST_NEVER_REACH_THE_LOG';

            const error = captureArgumentFailure(withheldValue);

            expect(error.message).toContain(`a string of length ${String(withheldValue.length)}`);
            expect(error.message).not.toContain(withheldValue);
        });

        it('resolves no index key from a string, so a refused argument cannot pollute the option set', () => {
            expect(() => ReorderPlugin.init('nonsense' as unknown as ReorderPluginOptions)).toThrowError(
                ReorderPluginConfigurationError,
            );

            expect(Object.keys(ReorderPlugin.options).sort()).toEqual([...OPTION_KEYS].sort());
            expect(ReorderPlugin.options).toEqual(DECLARED_DEFAULTS);
        });

        it('accepts an omitted argument, an explicit undefined and an empty object alike', () => {
            expect(optionsBoundTo(ReorderPlugin.init())).toEqual(DECLARED_DEFAULTS);
            expect(optionsBoundTo(ReorderPlugin.init(undefined))).toEqual(DECLARED_DEFAULTS);
            expect(optionsBoundTo(ReorderPlugin.init({}))).toEqual(DECLARED_DEFAULTS);
            expect(ReorderPlugin.options).toEqual(DECLARED_DEFAULTS);
        });

        it('accepts an object carrying an unknown key, which is neither validated nor honoured', () => {
            const registration = ReorderPlugin.init({
                anUnknownOptionKey: 'neither validated nor read',
            } as unknown as ReorderPluginOptions);

            for (const key of OPTION_KEYS) {
                expect(readOption(optionsBoundTo(registration), key)).toBe(
                    readOption(DECLARED_DEFAULTS, key),
                );
            }
        });
    });

    describe('the signed 32-bit ceiling, proved on both sides for every key that carries it', () => {
        // Three keys carry it and two do not, and both halves are asserted: an unusable value is refused at
        // `init()` — the earliest point it is knowable, before any server exists — while a row-count bound
        // above the range is accepted, because it refuses nothing rather than making a request unserviceable.
        it('accepts the largest signed 32-bit integer exactly for maxQuantityPerLine', () => {
            ReorderPlugin.init({ maxQuantityPerLine: MAX_SIGNED_32_BIT_INTEGER });

            expect(ReorderPlugin.options.maxQuantityPerLine).toBe(MAX_SIGNED_32_BIT_INTEGER);
        });

        it('refuses the first integer above it for maxQuantityPerLine, naming the key and the reason', () => {
            const error = expectInitToRefuse(
                'maxQuantityPerLine',
                MAX_SIGNED_32_BIT_INTEGER + 1,
                MUST_NOT_EXCEED_THE_32_BIT_CEILING,
                'the number 2147483648',
            );

            expect(error.optionKey).toBe('maxQuantityPerLine');
        });

        it('refuses a value far above it for maxQuantityPerLine', () => {
            expectInitToRefuse(
                'maxQuantityPerLine',
                Number.MAX_SAFE_INTEGER,
                MUST_NOT_EXCEED_THE_32_BIT_CEILING,
                'the number 9007199254740991',
            );
        });

        for (const key of PAGE_SIZE_KEYS) {
            it(`accepts the largest signed 32-bit integer exactly for ${key}`, () => {
                ReorderPlugin.init(optionsWith(key, MAX_SIGNED_32_BIT_INTEGER));

                expect(readOption(ReorderPlugin.options, key)).toBe(MAX_SIGNED_32_BIT_INTEGER);
            });

            it(`refuses the first integer above it for ${key}, naming the key and the page-size reason`, () => {
                const error = expectInitToRefuse(
                    key,
                    MAX_SIGNED_32_BIT_INTEGER + 1,
                    PAGE_SIZE_MUST_NOT_EXCEED_THE_32_BIT_CEILING,
                    'the number 2147483648',
                );

                expect(error.optionKey).toBe(key);
                // The refusal must not borrow the quantity key's justification, which is untrue of a page.
                expect(error.message).not.toContain('the quantity column it guards');
            });

            it(`refuses a value far above it for ${key}, at init() rather than at bootstrap`, () => {
                const error = expectInitToRefuse(
                    key,
                    Number.MAX_SAFE_INTEGER,
                    PAGE_SIZE_MUST_NOT_EXCEED_THE_32_BIT_CEILING,
                    'the number 9007199254740991',
                );

                expect(error.optionKey).toBe(key);
                // The other upper bound belongs to the server and is checked later; this refusal is the
                // 32-bit one, so it must not be reported as a Shop list-query limit failure.
                expect(error.message).not.toContain('apiOptions.shopListQueryLimit');
            });
        }

        for (const key of LOWER_BOUND_ONLY_KEYS) {
            it(`applies no such ceiling to ${key}, a row-count bound that refuses nothing`, () => {
                ReorderPlugin.init(optionsWith(key, MAX_SIGNED_32_BIT_INTEGER + 1));

                expect(readOption(ReorderPlugin.options, key)).toBe(MAX_SIGNED_32_BIT_INTEGER + 1);
            });
        }

        it('splits the five keys between the two rules with none left out and none in both', () => {
            // The rule is only as complete as the two lists are: this is what makes a sixth option — or a key
            // moved from one rule to the other — a failure here rather than an untested value.
            expect([...PAGE_SIZE_KEYS, 'maxQuantityPerLine', ...LOWER_BOUND_ONLY_KEYS].sort()).toEqual(
                [...OPTION_KEYS].sort(),
            );
        });
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
        // key, may carry newlines or terminal escapes that forge surrounding log lines, and may be arbitrarily
        // long. `reorder.plugin.ts` therefore renders the KIND of value, plus a string's length, and never the
        // content. These cells are what stops that guarantee being lost to a later change that interpolates the
        // value back in.
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
            expect(() => {
                (ReorderPlugin as unknown as { options: ResolvedReorderPluginOptions }).options = {
                    ...DECLARED_DEFAULTS,
                    maxLinesPerList: 1,
                };
            }).toThrow(TypeError);
            expect(ReorderPlugin.options.maxLinesPerList).toBe(200);
        });

        it('refuses a write to a member of the resolved set', () => {
            const target = ReorderPlugin.options as { maxLinesPerList: number };

            expect(() => {
                target.maxLinesPerList = 1;
            }).toThrow(TypeError);
            expect(ReorderPlugin.options.maxLinesPerList).toBe(200);
        });

        // These two cells assert what a registration is BOUND to, which is fixed when `init()` creates it and
        // is beyond the reach of every later `init()`. They deliberately assert nothing about which
        // registration a process's servers serve: `AppModule` is imported once per process
        // (`packages/core/src/bootstrap.ts` L202) and evaluates `PluginModule.forRoot()` in its decorator
        // argument (`packages/core/src/app.module.ts` L24), so a process that bootstraps two servers serves
        // the first configuration's registrations to both, and that is the platform's behaviour rather than
        // this plugin's to guarantee or to test here.
        it('binds each registration to the set its own init() resolved, beyond the reach of a later init()', () => {
            const first = ReorderPlugin.init({ maxListsPerCustomer: 10 });
            const second = ReorderPlugin.init({ maxListsPerCustomer: 20 });

            expect(first).not.toBe(second);
            expect(first).not.toBe(ReorderPlugin);
            expect(optionsBoundTo(first).maxListsPerCustomer).toBe(10);
            expect(optionsBoundTo(second).maxListsPerCustomer).toBe(20);

            ReorderPlugin.init({ maxListsPerCustomer: 30 });

            expect(optionsBoundTo(first).maxListsPerCustomer).toBe(10);
            expect(optionsBoundTo(second).maxListsPerCustomer).toBe(20);

            expect(optionsBoundTo(first).maxLinesPerList).toBe(DECLARED_DEFAULTS.maxLinesPerList);
            expect(optionsBoundTo(second).maxLinesPerList).toBe(DECLARED_DEFAULTS.maxLinesPerList);
        });

        it('re-validates the set its own registration carries, not whichever configuration initialised last', () => {
            const first = ReorderPlugin.init({ maxLinesPerList: 11 });
            ReorderPlugin.init({ maxLinesPerList: 22 });

            expect(optionsBoundTo(first).maxLinesPerList).toBe(11);
            expect(ReorderPlugin.options.maxLinesPerList).toBe(22);
            expect(optionsInForceFor(first).maxLinesPerList).toBe(11);
        });

        it('keeps the bare class on the declared defaults, whatever any earlier init() asked for', () => {
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
     * The unit inventory this package ships, which is the inventory AAP section 0.5.1.7 enumerates.
     */
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

    it('holds exactly the declared specifications, and no undeclared one', () => {
        // Vitest discovers specifications by PATTERN, so the inventory is only as stated as the filesystem is:
        // an undeclared specification joins the run merely by existing, and this assertion is what makes that
        // visible.
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

/**
 * `onApplicationBootstrap`, and the three acts it performs — no more than three.
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
                // The hook reads this to check both page sizes against the limit that will actually govern
                // them, so the double carries it.
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
        // The assertion that keeps the hook in scope. Every engine is driven, because a warning emitted here
        // would be decided by exactly this value, and `error`, `warn` and `info` are all watched so that a
        // line cannot appear at a different level and go unnoticed.
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
        const { plugin, addTranslationFile } = bootstrapSubject('mariadb');

        expect(() => plugin.onApplicationBootstrap()).not.toThrow();
        expect(
            addTranslationFile,
            'the catalogue registration must still have happened, so the hook was not short-circuited',
        ).toHaveBeenCalledTimes(1);
    });

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
            expect((caught as Error).message).toContain(String(declaredDefault));
            expect(addTranslationFile).not.toHaveBeenCalled();
        },
    );

    it('accepts a page size exactly equal to the server limit, because the platform test is strictly greater', () => {
        // The boundary matters in the accepting direction too: `parseTakeSkipParams` refuses `take > limit`, so
        // a page size OF the limit is served. Refusing it here would be stricter than the platform and would
        // reject a configuration that works.
        const { plugin, addTranslationFile } = bootstrapSubject('postgres', 50);

        expect(() => plugin.onApplicationBootstrap()).not.toThrow();
        expect(addTranslationFile).toHaveBeenCalledTimes(1);
    });

    it('leaves the three non-page-size options unbounded by the Shop limit', () => {
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
        const { plugin, addTranslationFile } = bootstrapSubject('postgres', limit);

        expect(() => plugin.onApplicationBootstrap()).not.toThrow();
        expect(addTranslationFile).toHaveBeenCalledTimes(1);
    });
});
