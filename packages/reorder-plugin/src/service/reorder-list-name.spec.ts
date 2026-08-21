/*
 * Unit specification for reorder list name canonicalisation — what it pins, and what it deliberately does not claim.
 */

import { UserInputError } from '@vendure/core';
import { describe, expect, it } from 'vitest';

import { MAX_LIST_NAME_LENGTH } from '../constants';

import {
    canonicaliseReorderListName,
    CanonicalReorderListName,
    toDisplayName,
    toNameKey,
} from './reorder-list-name';

/**
 * The stable code the platform's `UserInputError` carries, and the value a client branches on.
 */
const USER_INPUT_ERROR_CODE = 'USER_INPUT_ERROR';

/**
 * The one message key every name rejection carries.
 */
const LIST_NAME_REJECTED_MESSAGE_KEY = 'error.reorder-list-name-empty';

/**
 * The name of the interpolation variable the registered message expects. The bundle's placeholder is
 * `{ max }`, so a rejection carrying any other variable name would surface to a buyer as an unsubstituted
 * token rather than as a number, and nothing about that failure is a compile error.
 */
const MAX_LENGTH_VARIABLE_NAME = 'max';

/**
 * One row of a table-driven case: the value to drive and a description of what it demonstrates.
 *
 * The description exists so that a failing table reports which member failed. It is passed as the
 * assertion message rather than being turned into a test title, because a title should state the behaviour
 * under test and not the input that happens to exercise it.
 */
interface NameCase {
    readonly label: string;
    readonly input: string;
}

/**
 * Asserts that the entry point refuses the supplied value, and asserts everything observable about the refusal
 * rather than merely that something was thrown.
 */
function expectListNameRejection(input: string, because: string): void {
    expect(() => canonicaliseReorderListName(input), because).toThrowError(UserInputError);

    let returned: CanonicalReorderListName | undefined;
    let thrown: unknown;
    try {
        returned = canonicaliseReorderListName(input);
    } catch (caught) {
        thrown = caught;
    }

    expect(returned, `${because}: expected no value, but a value was returned`).toBeUndefined();
    expect(thrown, because).toBeInstanceOf(UserInputError);

    const error = thrown as UserInputError;
    expect(error.message, because).toBe(LIST_NAME_REJECTED_MESSAGE_KEY);
    expect(error.variables, because).toEqual({ [MAX_LENGTH_VARIABLE_NAME]: MAX_LIST_NAME_LENGTH });
    expect(error.code, because).toBe(USER_INPUT_ERROR_CODE);
    expect(error.extensions.code, because).toBe(USER_INPUT_ERROR_CODE);
}

/**
 * Asserts that the entry point accepts the supplied value and returns exactly the expected pair.
 *
 * Both halves are always asserted together, never one of them, because the display value and the canonical
 * key are produced together and written in the same transaction: a test that checked only the display value
 * would pass while the key — the value uniqueness is actually decided on — was wrong.
 */
function expectListNameAccepted(input: string, expected: CanonicalReorderListName, because: string): void {
    expect(canonicaliseReorderListName(input), because).toEqual(expected);
}

/** A display name at exactly the bound, built from the constant rather than from a written-out number. */
const nameAtBound = 'a'.repeat(MAX_LIST_NAME_LENGTH);

/** A display name one character below the bound. */
const nameBelowBound = 'a'.repeat(MAX_LIST_NAME_LENGTH - 1);

/** A display name one character above the bound — the length AC-2 drives, and the one that is refused. */
const nameAboveBound = 'a'.repeat(MAX_LIST_NAME_LENGTH + 1);

describe('reorder list name canonicalisation', () => {
    describe('the name length bound', () => {
        it('is a fixed constant, which is also the declared width of both stored columns', () => {
            // forces on two of the four engines under test, so an option would carry exactly one legal
            expect(MAX_LIST_NAME_LENGTH).toBe(191);
        });
    });

    describe('toDisplayName()', () => {
        it('removes leading and trailing whitespace', () => {
            expect(toDisplayName('  Weekly Order  ')).toBe('Weekly Order');
            expect(toDisplayName('Weekly Order  ')).toBe('Weekly Order');
            expect(toDisplayName('  Weekly Order')).toBe('Weekly Order');
        });

        it('collapses every internal run of whitespace to a single space', () => {
            expect(toDisplayName('Weekly   Order')).toBe('Weekly Order');
            expect(toDisplayName('  Weekly   Order  ')).toBe('Weekly Order');
            expect(toDisplayName('Weekly   grocery     restock')).toBe('Weekly grocery restock');
        });

        it('treats exactly three C0 characters as whitespace — tab, line feed and carriage return', () => {
            // that block the pipeline consumes rather than refusing. That ordering is what stops a name
            expect(toDisplayName('Weekly\tOrder')).toBe('Weekly Order');
            expect(toDisplayName('Weekly\nOrder')).toBe('Weekly Order');
            expect(toDisplayName('Weekly\rOrder')).toBe('Weekly Order');
        });

        it('leaves a vertical tab and a form feed in place, because they are controls rather than whitespace', () => {
            expect(toDisplayName('Weekly\u000BOrder')).toBe('Weekly\u000BOrder');
            expect(toDisplayName('Weekly\u000COrder')).toBe('Weekly\u000COrder');
            expect(toDisplayName('\u000BWeekly Order')).toBe('\u000BWeekly Order');
            expect(toDisplayName('Weekly Order\u000C')).toBe('Weekly Order\u000C');
            expect(Array.from(toDisplayName('Weekly\u000BOrder'))).toContain('\u000B');
            expect(Array.from(toDisplayName('Weekly\u000COrder'))).toContain('\u000C');
        });

        it('collapses a mixed run of several whitespace kinds to one single space', () => {
            expect(toDisplayName('A\t\n\r B')).toBe('A B');
            expect(toDisplayName(' \t Weekly \r\n  Order \n ')).toBe('Weekly Order');
        });

        it('collapses the Unicode space separators, so a name spaced with a no-break space is not a second list', () => {
            const separators = [
                '\u00A0',
                '\u1680',
                '\u2000',
                '\u200A',
                '\u2028',
                '\u2029',
                '\u202F',
                '\u205F',
                '\u3000',
            ];
            for (const separator of separators) {
                const codePoint = (separator.codePointAt(0) as number).toString(16).toUpperCase();
                expect(toDisplayName(`Weekly${separator}Order`), `U+${codePoint} collapses`).toBe(
                    'Weekly Order',
                );
            }
        });

        it('does not fold case, because the display value is what the buyer typed', () => {
            expect(toDisplayName('Weekly Order')).toBe('Weekly Order');
            expect(toDisplayName('WEEKLY')).toBe('WEEKLY');
            expect(toDisplayName('wEeKlY oRdEr')).toBe('wEeKlY oRdEr');
        });

        it('does not normalise Unicode, leaving a decomposed accent decomposed', () => {
            const decomposed = 'Cafe\u0301';
            const precomposed = 'Caf\u00E9';

            expect(decomposed).not.toBe(precomposed);
            expect(toDisplayName(decomposed)).toBe(decomposed);
            expect(toDisplayName(decomposed)).not.toBe(precomposed);
            expect(Array.from(toDisplayName(decomposed))).toHaveLength(5);
            expect(toDisplayName(precomposed)).toBe(precomposed);
            expect(Array.from(toDisplayName(precomposed))).toHaveLength(4);
        });

        it('returns the empty string for a whitespace-only name rather than refusing it', () => {
            expect(toDisplayName('')).toBe('');
            expect(toDisplayName('   ')).toBe('');
            expect(toDisplayName('\t\n\r')).toBe('');
            expect(toDisplayName('\u00A0\u3000')).toBe('');
        });
    });

    describe('toNameKey()', () => {
        it('lower-cases the display value', () => {
            expect(toNameKey('Weekly Order')).toBe('weekly order');
            expect(toNameKey('WEEKLY GROCERY RESTOCK')).toBe('weekly grocery restock');
        });

        it('produces one key for two names differing only in case', () => {
            // makes it so — which is why the same two names collide identically on every engine instead of
            // colliding on one engine's default collation and not on another's.
            expect(toNameKey('WEEKLY')).toBe(toNameKey('weekly'));
            expect(toNameKey('Weekly')).toBe(toNameKey('weekly'));
            expect(toNameKey('WEEKLY')).toBe('weekly');
        });

        it('produces one key for a precomposed and a decomposed spelling of the same name', () => {
            const decomposed = 'Cafe\u0301';
            const precomposed = 'Caf\u00E9';

            expect(decomposed).not.toBe(precomposed);
            expect(toNameKey(decomposed)).toBe(toNameKey(precomposed));
            expect(toNameKey(decomposed)).toBe('caf\u00E9');
        });

        it('normalises to NFC before lower-casing, proved on an input whose result differs between the two orders', () => {
            const capitalJWithCaron = 'J\u030C';
            const invertedOrderKey = capitalJWithCaron.toLowerCase().normalize('NFC');

            expect(invertedOrderKey).toBe('\u01F0');
            expect(Array.from(invertedOrderKey)).toHaveLength(1);

            expect(toNameKey(capitalJWithCaron)).toBe('j\u030C');
            expect(Array.from(toNameKey(capitalJWithCaron))).toHaveLength(2);
            expect(toNameKey(capitalJWithCaron)).not.toBe(invertedOrderKey);

            const capitalTWithDiaeresis = 'T\u0308';
            expect(capitalTWithDiaeresis.toLowerCase().normalize('NFC')).toBe('\u1E97');
            expect(toNameKey(capitalTWithDiaeresis)).toBe('t\u0308');
            expect(toNameKey(capitalTWithDiaeresis)).not.toBe('\u1E97');
        });

        it('produces different keys for an accented and an unaccented name, because accents are never stripped', () => {
            expect(toNameKey('Caf\u00E9')).not.toBe(toNameKey('Cafe'));
            expect(toNameKey('Cafe\u0301')).not.toBe(toNameKey('Cafe'));
            expect(toNameKey('Caf\u00E9')).toBe('caf\u00E9');
            expect(toNameKey('Cafe')).toBe('cafe');
        });

        it('preserves a compatibility character rather than expanding it, because the form applied is NFC and not NFKC', () => {
            expect(toNameKey('\uFB01le')).toBe('\uFB01le');
            expect(toNameKey('\uFB01le')).not.toBe('file');
            expect(toNameKey('\uFF21\uFF22')).toBe('\uFF41\uFF42');
            expect(toNameKey('\uFF21\uFF22')).not.toBe('ab');
        });

        it('neither trims nor collapses, because those two steps produced the value it is given', () => {
            expect(toNameKey('  Weekly   Order  ')).toBe('  weekly   order  ');
        });

        it('is stable under a second pass for these inputs, which is not a general property', () => {
            for (const input of ['Weekly Order', 'Caf\u00E9', 'Cafe\u0301', '\uFB01le', '\uFF21\uFF22']) {
                expect(toNameKey(toNameKey(input)), `${input} is stable under a second pass`).toBe(
                    toNameKey(input),
                );
            }
        });

        it('is NOT idempotent in general, which the mandated step order makes unavoidable', () => {
            // [FEATURE-001-01:section 2.11], so NFC runs on the *cased* text and the lower-casing that
            const once = toNameKey('J\u030C');
            expect(once).toBe('j\u030C');
            expect(toNameKey(once)).toBe('\u01F0');
            expect(toNameKey(once)).not.toBe(once);

            // Why this is a correctness statement and not a defect to fix here. The pipeline order is
            expect(canonicaliseReorderListName('J\u030C').nameKey).toBe('j\u030C');
        });
    });

    describe('canonicaliseReorderListName()', () => {
        it('returns the display name and the canonical key together', () => {
            expectListNameAccepted(
                '  Weekly   Order  ',
                { name: 'Weekly Order', nameKey: 'weekly order' },
                'both stored values are produced by one call',
            );
        });

        it('applies the pipeline in the order trim, collapse, normalise, lower-case', () => {
            const input = '  CAFE\u0301   Order  ';
            const result = canonicaliseReorderListName(input);

            expect(result.name).toBe('CAFE\u0301 Order');

            expect(result.nameKey).toBe('caf\u00E9 order');
            expect(result.nameKey).toBe(toNameKey(toDisplayName(input)));

            const orderSensitiveInput = '  J\u030C   Order  ';
            const orderSensitiveResult = canonicaliseReorderListName(orderSensitiveInput);
            const invertedOrderKey = toDisplayName(orderSensitiveInput).toLowerCase().normalize('NFC');

            expect(orderSensitiveResult.name).toBe('J\u030C Order');
            expect(orderSensitiveResult.nameKey).toBe('j\u030C order');
            expect(invertedOrderKey).toBe('\u01F0 order');
            expect(orderSensitiveResult.nameKey).not.toBe(invertedOrderKey);
        });

        it('returns a name carrying markup-significant characters byte-identical to the value submitted', () => {
            const submitted = '<b>Tools</b> &amp; spares';
            const result = canonicaliseReorderListName(submitted);

            expect(result.name).toBe(submitted);
            expect(result.name).toHaveLength(submitted.length);
            expect(result.nameKey).toBe('<b>tools</b> &amp; spares');
        });

        it('returns a name carrying an event-handler attribute, a quote, an ampersand and a backslash byte-identical to the value submitted', () => {
            const submitted = '<img src="x" onerror="alert(1)" & \\ >';
            const result = canonicaliseReorderListName(submitted);

            expect(result.name).toBe(submitted);
            expect(result.name).toHaveLength(submitted.length);
            expect(result.nameKey).toBe(submitted);
        });

        it('accepts a canonical name one character below the bound', () => {
            expectListNameAccepted(
                nameBelowBound,
                { name: nameBelowBound, nameKey: nameBelowBound },
                'one below the bound is accepted',
            );
            expect(Array.from(nameBelowBound)).toHaveLength(MAX_LIST_NAME_LENGTH - 1);
        });

        it('accepts a canonical name at exactly the bound', () => {
            expectListNameAccepted(
                nameAtBound,
                { name: nameAtBound, nameKey: nameAtBound },
                'exactly at the bound is accepted',
            );
            expect(Array.from(nameAtBound)).toHaveLength(MAX_LIST_NAME_LENGTH);
        });

        it('refuses a canonical name one character above the bound', () => {
            expect(Array.from(nameAboveBound)).toHaveLength(MAX_LIST_NAME_LENGTH + 1);
            expectListNameRejection(nameAboveBound, 'one above the bound is refused');
        });

        it('refuses the over-long name and accepts that same name minus its final character, so nothing is truncated', () => {
            expectListNameRejection(nameAboveBound, 'the over-long name is refused outright');

            const shortenedByOne = nameAboveBound.slice(0, -1);
            const result = canonicaliseReorderListName(shortenedByOne);

            expect(result.name).toBe(shortenedByOne);
            expect(Array.from(result.name)).toHaveLength(MAX_LIST_NAME_LENGTH);
            expect(result.name).not.toBe(nameAboveBound);
        });

        it('measures the bound on the canonical form, accepting a padded name whose trimmed length is at the bound', () => {
            const padded = `${' '.repeat(4)}${nameAtBound}${' '.repeat(5)}`;

            expect(padded).toHaveLength(MAX_LIST_NAME_LENGTH + 9);
            expectListNameAccepted(
                padded,
                { name: nameAtBound, nameKey: nameAtBound },
                'padding is not counted against the bound',
            );
        });

        it('measures the bound in Unicode code points, as the varchar column counts them', () => {
            // PostgreSQL and the MySQL family count a `varchar` length in characters. Measuring code units
            const supplementary = '\u{1F600}';
            const supplementaryAtBound = supplementary.repeat(MAX_LIST_NAME_LENGTH);
            const supplementaryAboveBound = supplementary.repeat(MAX_LIST_NAME_LENGTH + 1);

            expect(supplementaryAtBound).toHaveLength(MAX_LIST_NAME_LENGTH * 2);
            expect(Array.from(supplementaryAtBound)).toHaveLength(MAX_LIST_NAME_LENGTH);
            expectListNameAccepted(
                supplementaryAtBound,
                { name: supplementaryAtBound, nameKey: supplementaryAtBound },
                'code points rather than code units are counted',
            );
            expectListNameRejection(supplementaryAboveBound, 'one code point above the bound is refused');
        });

        it('refuses a name whose canonical key would exceed the bound although its display value does not', () => {
            const excluded = '\u0958';
            expect(Array.from(excluded.normalize('NFC'))).toHaveLength(2);

            const displayAtBound = excluded.repeat(MAX_LIST_NAME_LENGTH);
            expect(Array.from(toDisplayName(displayAtBound))).toHaveLength(MAX_LIST_NAME_LENGTH);
            expectListNameRejection(displayAtBound, 'a key twice an at-bound display value is refused');

            const halfBound = Math.floor(MAX_LIST_NAME_LENGTH / 2);
            const withinBothBounds = excluded.repeat(halfBound);
            const accepted = canonicaliseReorderListName(withinBothBounds);

            expect(Array.from(accepted.name)).toHaveLength(halfBound);
            expect(Array.from(accepted.nameKey)).toHaveLength(halfBound * 2);
            expect(halfBound * 2).toBeLessThanOrEqual(MAX_LIST_NAME_LENGTH);
        });

        it('accepts ordinary whitespace, which the collapse step handles rather than the character test refusing', () => {
            const whitespaceCases: NameCase[] = [
                { label: 'a tab between two words', input: 'Weekly\tOrder' },
                { label: 'a line feed between two words', input: 'Weekly\nOrder' },
                { label: 'a carriage return between two words', input: 'Weekly\rOrder' },
                { label: 'a no-break space between two words', input: 'Weekly\u00A0Order' },
                { label: 'a mixed whitespace run between two words', input: 'Weekly \t\n Order' },
            ];

            for (const whitespaceCase of whitespaceCases) {
                expectListNameAccepted(
                    whitespaceCase.input,
                    { name: 'Weekly Order', nameKey: 'weekly order' },
                    whitespaceCase.label,
                );
            }
        });

        it('returns the same pair each time a name is submitted, because it decides nothing about uniqueness', () => {
            // is deliberately not a service pre-check: a read followed by an insert loses a race that a
            const submitted = 'Weekly grocery restock';
            const expected = { name: submitted, nameKey: 'weekly grocery restock' };

            expectListNameAccepted(submitted, expected, 'the first submission is canonicalised');
            expectListNameAccepted(submitted, expected, 'a repeated submission is canonicalised identically');
        });
    });

    describe('the name rejections', () => {
        it('refuses each of the four names the input contract names, with one code and one message key', () => {
            const inputContractCases: NameCase[] = [
                { label: 'a name consisting only of space characters', input: '   ' },
                { label: 'a name one character longer than the fixed bound', input: nameAboveBound },
                { label: 'a name containing the C0 control character U+0007', input: 'Weekly\u0007Order' },
                { label: 'a name containing the zero-width character U+200B', input: 'Weekly\u200BOrder' },
            ];

            for (const contractCase of inputContractCases) {
                expectListNameRejection(contractCase.input, contractCase.label);
            }
        });

        it('refuses an empty name and a name that is only whitespace', () => {
            const blankCases: NameCase[] = [
                { label: 'the empty string', input: '' },
                { label: 'a single space', input: ' ' },
                { label: 'several spaces', input: '   ' },
                { label: 'a single tab', input: '\t' },
                { label: 'a mixture of space, tab, line feed and carriage return', input: ' \t\n\r ' },
                { label: 'a single no-break space', input: '\u00A0' },
                { label: 'a run of Unicode space separators', input: '\u3000\u2000\u205F' },
                { label: 'a line separator and a paragraph separator', input: '\u2028\u2029' },
            ];

            for (const blankCase of blankCases) {
                expectListNameRejection(blankCase.input, blankCase.label);
            }
        });

        it('refuses a name carrying a C0 control character', () => {
            // The block U+0000 to U+001F, less the three members that are whitespace and are consumed by the
            const controlCases: NameCase[] = [
                { label: 'U+0000 NULL between two words', input: 'Weekly\u0000Order' },
                { label: 'U+0001 START OF HEADING between two words', input: 'Weekly\u0001Order' },
                { label: 'U+0007 BELL between two words', input: 'Weekly\u0007Order' },
                { label: 'U+0007 BELL leading', input: '\u0007Weekly Order' },
                { label: 'U+0007 BELL trailing', input: 'Weekly Order\u0007' },
                { label: 'U+0007 BELL alone', input: '\u0007' },
                { label: 'U+001B ESCAPE between two words', input: 'Weekly\u001BOrder' },
                { label: 'U+001F UNIT SEPARATOR between two words', input: 'Weekly\u001FOrder' },
            ];

            for (const controlCase of controlCases) {
                expectListNameRejection(controlCase.input, controlCase.label);
            }
        });

        it('refuses a name carrying a vertical tab or a form feed, which the C0 block does not carve out', () => {
            const verticalAndFormFeedCases: NameCase[] = [
                { label: 'U+000B VERTICAL TAB between two words', input: 'Weekly\u000BOrder' },
                { label: 'U+000B VERTICAL TAB leading', input: '\u000BWeekly Order' },
                { label: 'U+000B VERTICAL TAB trailing', input: 'Weekly Order\u000B' },
                { label: 'U+000B VERTICAL TAB alone', input: '\u000B' },
                { label: 'U+000C FORM FEED between two words', input: 'Weekly\u000COrder' },
                { label: 'U+000C FORM FEED leading', input: '\u000CWeekly Order' },
                { label: 'U+000C FORM FEED trailing', input: 'Weekly Order\u000C' },
                { label: 'U+000C FORM FEED alone', input: '\u000C' },
                {
                    label: 'both, inside an otherwise ordinary whitespace run',
                    input: 'Weekly \u000B\u000C Order',
                },
            ];

            for (const verticalOrFormFeedCase of verticalAndFormFeedCases) {
                expectListNameRejection(verticalOrFormFeedCase.input, verticalOrFormFeedCase.label);
            }

            expect(/\s/.test('\u000B'), 'the language calls U+000B whitespace').toBe(true);
            expect(/\s/.test('\u000C'), 'the language calls U+000C whitespace').toBe(true);
            expect('Weekly Order\u000B'.trim(), 'trim() would have removed it').toBe('Weekly Order');
        });

        it('refuses a name carrying DELETE or a C1 control character', () => {
            // U+007F and the block U+0080 to U+009F, which are control characters that no whitespace class
            const highControlCases: NameCase[] = [
                { label: 'U+007F DELETE between two words', input: 'Weekly\u007FOrder' },
                { label: 'U+0080 PADDING CHARACTER between two words', input: 'Weekly\u0080Order' },
                { label: 'U+0085 NEXT LINE between two words', input: 'Weekly\u0085Order' },
                { label: 'U+0085 NEXT LINE leading', input: '\u0085Weekly Order' },
                { label: 'U+009F APPLICATION PROGRAM COMMAND between two words', input: 'Weekly\u009FOrder' },
            ];

            for (const highControlCase of highControlCases) {
                expectListNameRejection(highControlCase.input, highControlCase.label);
            }
        });

        it('refuses a name carrying U+200B, the one zero-width character the contract names', () => {
            // becoming two lists nobody can tell apart. Note that the neighbouring block U+2000 to U+200A is
            // no such role, which is why it is the one the requirements name [F-101-RQ-002].
            const zeroWidthCases: NameCase[] = [
                { label: 'U+200B ZERO WIDTH SPACE between two words', input: 'Weekly\u200BOrder' },
                { label: 'U+200B ZERO WIDTH SPACE leading', input: '\u200BWeekly Order' },
                { label: 'U+200B ZERO WIDTH SPACE trailing', input: 'Weekly Order\u200B' },
                { label: 'U+200B ZERO WIDTH SPACE alone', input: '\u200B' },
            ];

            for (const zeroWidthCase of zeroWidthCases) {
                expectListNameRejection(zeroWidthCase.input, zeroWidthCase.label);
            }
        });

        it('refuses a name carrying a byte order mark', () => {
            const byteOrderMarkCases: NameCase[] = [
                { label: 'U+FEFF between two words', input: 'Weekly\uFEFFOrder' },
                { label: 'U+FEFF leading', input: '\uFEFFWeekly Order' },
                { label: 'U+FEFF trailing', input: 'Weekly Order\uFEFF' },
                { label: 'U+FEFF alone', input: '\uFEFF' },
            ];

            for (const byteOrderMarkCase of byteOrderMarkCases) {
                expectListNameRejection(byteOrderMarkCase.input, byteOrderMarkCase.label);
            }

            expect(Array.from(toDisplayName('\uFEFFWeekly Order'))).toContain('\uFEFF');
        });

        it('accepts every other invisible or formatting character, storing it byte for byte', () => {
            // THE BOUNDARY OF THE REFUSAL, AND IT IS DELIBERATELY NARROW. An earlier revision refused
            // collapsed and NOTHING ELSE [AAP §0.1.2.5], that the characters it names are U+0007 and U+200B
            // [F-101-RQ-002], and that a name is stored verbatim while the safety of its PRESENTATION is the
            // storefront's [FEATURE-001-01:§2.10]. So each case below is accepted and stored byte for byte,
            const acceptedFormattingCases: Array<NameCase & { expected: CanonicalReorderListName }> = [
                {
                    label: 'U+061C ARABIC LETTER MARK between two words',
                    input: 'Weekly\u061COrder',
                    expected: { name: 'Weekly\u061COrder', nameKey: 'weekly\u061corder' },
                },
                {
                    label: 'U+200E LEFT-TO-RIGHT MARK between two words',
                    input: 'Weekly\u200EOrder',
                    expected: { name: 'Weekly\u200EOrder', nameKey: 'weekly\u200eorder' },
                },
                {
                    label: 'U+200F RIGHT-TO-LEFT MARK leading',
                    input: '\u200FWeekly Order',
                    expected: { name: '\u200FWeekly Order', nameKey: '\u200fweekly order' },
                },
                {
                    label: 'U+202A LEFT-TO-RIGHT EMBEDDING between two words',
                    input: 'Weekly\u202AOrder',
                    expected: { name: 'Weekly\u202AOrder', nameKey: 'weekly\u202aorder' },
                },
                {
                    label: 'U+202E RIGHT-TO-LEFT OVERRIDE trailing',
                    input: 'Weekly Order\u202E',
                    expected: { name: 'Weekly Order\u202E', nameKey: 'weekly order\u202e' },
                },
                {
                    label: 'an isolate opened and popped around one word',
                    input: 'Weekly \u2066Order\u2069',
                    expected: { name: 'Weekly \u2066Order\u2069', nameKey: 'weekly \u2066order\u2069' },
                },
                {
                    label: 'U+2060 WORD JOINER between two words',
                    input: 'Weekly\u2060Order',
                    expected: { name: 'Weekly\u2060Order', nameKey: 'weekly\u2060order' },
                },
                {
                    label: 'U+2062 INVISIBLE TIMES between two words',
                    input: 'Weekly\u2062Order',
                    expected: { name: 'Weekly\u2062Order', nameKey: 'weekly\u2062order' },
                },
                {
                    label: 'U+00AD SOFT HYPHEN between two words',
                    input: 'Co\u00ADop pantry',
                    expected: { name: 'Co\u00ADop pantry', nameKey: 'co\u00adop pantry' },
                },
                {
                    label: 'U+034F COMBINING GRAPHEME JOINER between two words',
                    input: 'Weekly\u034FOrder',
                    expected: { name: 'Weekly\u034FOrder', nameKey: 'weekly\u034forder' },
                },
                // collapsed either: the whitespace class this module uses is enumerated, so a character
                {
                    label: 'U+180E MONGOLIAN VOWEL SEPARATOR between two words',
                    input: 'Weekly\u180EOrder',
                    expected: { name: 'Weekly\u180EOrder', nameKey: 'weekly\u180eorder' },
                },
                {
                    label: 'U+3164 HANGUL FILLER between two words',
                    input: 'Weekly\u3164Order',
                    expected: { name: 'Weekly\u3164Order', nameKey: 'weekly\u3164order' },
                },
                {
                    label: 'a heart emoji with its U+FE0F presentation selector',
                    input: 'Favourites \u2764\uFE0F',
                    expected: { name: 'Favourites \u2764\uFE0F', nameKey: 'favourites \u2764\ufe0f' },
                },
                {
                    label: 'a pencil emoji with its U+FE0F presentation selector',
                    input: 'Notes \u270F\uFE0F',
                    expected: { name: 'Notes \u270F\uFE0F', nameKey: 'notes \u270f\ufe0f' },
                },
                {
                    label: 'U+200C ZERO WIDTH NON-JOINER, required orthography in Persian',
                    input: '\u0645\u06CC\u200C\u062E\u0648\u0631\u0645',
                    expected: {
                        name: '\u0645\u06CC\u200C\u062E\u0648\u0631\u0645',
                        nameKey: '\u0645\u06CC\u200C\u062E\u0648\u0631\u0645',
                    },
                },
                {
                    label: 'a zero-width-joiner family sequence',
                    input: 'Family \u{1F468}\u200D\u{1F469}\u200D\u{1F467}',
                    expected: {
                        name: 'Family \u{1F468}\u200D\u{1F469}\u200D\u{1F467}',
                        nameKey: 'family \u{1F468}\u200D\u{1F469}\u200D\u{1F467}',
                    },
                },
                {
                    label: 'a tag sequence',
                    input: 'Weekly\u{E0020}Order',
                    expected: { name: 'Weekly\u{E0020}Order', nameKey: 'weekly\u{E0020}order' },
                },
            ];

            for (const acceptedCase of acceptedFormattingCases) {
                expectListNameAccepted(acceptedCase.input, acceptedCase.expected, acceptedCase.label);
            }
        });

        it('still refuses a zero-width space inside an otherwise accepted emoji name', () => {
            expectListNameAccepted(
                'Family \u{1F468}\u200D\u{1F469}',
                {
                    name: 'Family \u{1F468}\u200D\u{1F469}',
                    nameKey: 'family \u{1F468}\u200D\u{1F469}',
                },
                'a joiner between two emoji is what builds the sequence',
            );
            expectListNameRejection(
                'Family \u200B\u{1F468}',
                'a zero-width SPACE in the same position is still refused',
            );
        });

        it('refuses only the four enumerated ranges, so ordinary text in any script is accepted', () => {
            const acceptedCases: Array<NameCase & { expected: CanonicalReorderListName }> = [
                {
                    label: 'a Han name',
                    input: '漢字の注文',
                    expected: { name: '漢字の注文', nameKey: '漢字の注文' },
                },
                {
                    label: 'an Arabic name, whose script is right-to-left without any bidi control',
                    input: 'مرحبا بالعالم',
                    expected: { name: 'مرحبا بالعالم', nameKey: 'مرحبا بالعالم' },
                },
                {
                    label: 'a Hebrew name',
                    input: 'שלום',
                    expected: { name: 'שלום', nameKey: 'שלום' },
                },
                {
                    label: 'a bare emoji, carrying no variation selector',
                    input: '\u{1F600} Weekly Order',
                    expected: { name: '\u{1F600} Weekly Order', nameKey: '\u{1F600} weekly order' },
                },
                {
                    label: 'a bare symbol in its text presentation',
                    input: 'Weekly \u2764 Order',
                    expected: { name: 'Weekly \u2764 Order', nameKey: 'weekly \u2764 order' },
                },
                {
                    label: 'letters outside ASCII, which lower-case rather than being refused',
                    input: 'Ωmega ß Order',
                    expected: { name: 'Ωmega ß Order', nameKey: 'ωmega ß order' },
                },
            ];

            for (const acceptedCase of acceptedCases) {
                expectListNameAccepted(acceptedCase.input, acceptedCase.expected, acceptedCase.label);
            }
        });

        it('refuses rather than repairs, so no call returns the value a stripping implementation would have stored', () => {
            const strippable = 'Weekly\u0007Order';

            expectListNameRejection(strippable, 'a control character is refused, not removed');
            expect(toDisplayName(strippable)).toBe(strippable);
            expect(Array.from(toDisplayName(strippable))).toContain('\u0007');
            expect(toDisplayName(strippable)).not.toBe('WeeklyOrder');

            expectListNameRejection(nameAboveBound, 'an over-long name is refused, not truncated');
            expect(nameAboveBound.startsWith(nameAtBound)).toBe(true);
        });

        it('refuses a value that is not a string at all', () => {
            // put an internal error and a stack trace where a validation message belongs.
            expectListNameRejection(undefined as unknown as string, 'an undefined value is refused');
            expectListNameRejection(null as unknown as string, 'a null value is refused');
            expectListNameRejection(42 as unknown as string, 'a number is refused');
        });

        it('carries the same class, code and message key across all four rejection classes', () => {
            const oneOfEachClass: NameCase[] = [
                { label: 'the emptiness rejection', input: '   ' },
                { label: 'the length rejection', input: nameAboveBound },
                { label: 'the disallowed-character rejection', input: 'Weekly\u200BOrder' },
                {
                    label: 'the derived-key-length rejection',
                    input: '\u0958'.repeat(MAX_LIST_NAME_LENGTH),
                },
            ];

            for (const rejectionClass of oneOfEachClass) {
                let thrown: unknown;
                try {
                    canonicaliseReorderListName(rejectionClass.input);
                } catch (caught) {
                    thrown = caught;
                }

                expect(thrown, rejectionClass.label).toBeInstanceOf(UserInputError);

                const error = thrown as UserInputError;
                expect(error.message, rejectionClass.label).toBe(LIST_NAME_REJECTED_MESSAGE_KEY);
                expect(error.variables, rejectionClass.label).toEqual({
                    [MAX_LENGTH_VARIABLE_NAME]: MAX_LIST_NAME_LENGTH,
                });
                expect(error.code, rejectionClass.label).toBe(USER_INPUT_ERROR_CODE);
                expect(error.extensions.code, rejectionClass.label).toBe(USER_INPUT_ERROR_CODE);
            }
        });
    });
});
