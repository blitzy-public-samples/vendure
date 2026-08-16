/*
 * -------------------------------------------------------------------------------------------------------
 * Unit specification for reorder list name canonicalisation — what it pins, and what it deliberately does
 * not claim.
 * -------------------------------------------------------------------------------------------------------
 * Attribution. No user-specified rules were provided for this project: the rules document was read and
 * returned exactly that, and EPIC-001 reaches the same finding independently in its own section 11.9.
 * Nothing asserted below is, or derives from, a user-specified rule. Every clause pinned here traces to
 * FEATURE-001-01 section 2.10.1 or section 2.11, to STORY-001-01-01 acceptance criterion 1 or 2, or to
 * EPIC-001 ruling R13 or R17, and is attributed at the assertion that pins it. The absence of a rules
 * document has not been treated as licence to assert less.
 *
 * Where this file lives, and why. It sits beside the module it tests and carries the `.spec.ts` suffix,
 * which is this repository's stated convention for a unit test [CONTRIBUTING.md:L428]. The package's Vitest
 * configuration declares no `include`, so the runner's default `*.spec.ts` discovery is what finds it, and
 * the package's `test` script is what runs it.
 *
 * Why this specification carries more weight than its subject's size suggests. The whole of the list-name
 * contract is decided by string arithmetic, and it was extracted into pure functions precisely so that
 * every boundary of it could be asserted without a database, a request context or a running server. This
 * is therefore the file where the feature's line-coverage obligation is actually met, which is why the
 * tables below are exhaustive rather than representative: each refused character class is driven
 * individually, and the whitespace the pipeline legitimately consumes is driven as its own negative
 * control so that a refusal cannot be mistaken for correct behaviour.
 *
 * What this file does not do, stated so that a later reader does not add it. It touches no database, boots
 * no server, mocks nothing and loads no fixture — an import of an entity, a service or a connection here
 * would mean the specification had drifted from its subject. It asserts no latency, throughput,
 * service-level or other invented figure of any kind, and no timing at all.
 *
 * And it owns the transport half of the hostile-input contract only. That a name carrying markup survives
 * canonicalisation byte-for-byte is asserted here. That no element is created from such a value and no
 * handler executes when it is displayed is the rendering half, owned by STORY-001-08-03's dashboard
 * surface in a later batch, and it is explicitly not this feature's to discharge
 * [FEATURE-001-01:§2.10.1]. There is deliberately no DOM assertion below: this module renders nothing, so
 * an assertion here could only prove something about a surface this feature does not build, and the two
 * claims are different claims [FEATURE-001-01:§2.10.1 L534-L535].
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
 *
 * Naming it is a requirement rather than a nicety: a negative branch must name the exact error class, the
 * stable code it carries and the location the assertion reads, because "the request is refused" is
 * satisfied equally by a genuine refusal, an internal server error and a resolver crash (ruling R17). The
 * code is observable on the constructed instance because `UserInputError` extends `I18nError`, which
 * extends `GraphQLError` and places the code in `extensions.code`; an end-to-end suite reads the same value
 * from `errors[0].extensions.code`.
 */
const USER_INPUT_ERROR_CODE = 'USER_INPUT_ERROR';

/**
 * The one message key every name rejection carries.
 *
 * All three rejection classes share it, and that is a coordination constraint rather than a style choice:
 * the plugin's translation bundle registers exactly four keys, of which this is the only one about a name,
 * and an unregistered key would surface to the caller as the raw key text (ruling R13). It reads as a
 * combined statement — a name may be neither empty nor longer than the maximum — which is why it
 * interpolates a maximum even on the rejections that are not about length.
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
 * Asserts that the entry point refuses the supplied value, and asserts everything observable about the
 * refusal rather than merely that something was thrown.
 *
 * Five properties are asserted, each closing a hole a looser test would leave open:
 *
 * 1. The call throws, and it throws the named class. A bare "it throws" would also pass for a `TypeError`
 *    raised by a refactor that broke the module outright.
 * 2. Nothing is returned. This is the assertion that distinguishes refusal from repair: had the module
 *    stripped the offending characters or truncated the over-long value, it would have returned a cleaned
 *    pair, and the failing diagnostic would surface that value.
 * 3. The thrown value is an instance of the platform's `UserInputError` — so a malformed name reaches the
 *    caller as one top-level `errors` entry rather than as a member of any result union, which is what
 *    ruling R13 requires and why this feature declares four error results rather than five.
 * 4. It carries the exact message key, and the exact interpolation variable under the exact name the
 *    registered message expects.
 * 5. It carries the stable code, read both from the error's own `code` property and from `extensions.code`,
 *    which is the location a client and an end-to-end suite actually read (ruling R17).
 *
 * The entry point is called twice, which is safe precisely because it is pure: it performs no I/O, holds no
 * state and returns the same result for the same input, so the second call cannot observe the first.
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
            // The only place in this specification where the number is written out. Every string driven
            // below is built from the imported constant instead, so the assertions cannot drift from the
            // module, from the two `varchar` columns the migration creates, or from each other. The bound is
            // a constant and not a plugin option deliberately: it is the width the composite unique index
            // forces on two of the four engines under test, so an option would carry exactly one legal
            // value — the column's own width — and offer a deployment nothing but a way to break itself.
            // Asserting it here is what resolves the owning story's self-contradictory definition-of-done
            // item, whose second clause requires exactly this and whose first is residue.
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

        it('treats a tab, a line feed, a carriage return, a vertical tab and a form feed as whitespace', () => {
            // These five are C0 control characters as well as whitespace, and the pipeline consumes them
            // rather than refusing them. That ordering is what stops a name pasted with a tab between two
            // words from being reported as carrying a control character, and it is asserted from the other
            // direction further down, where a control character that is not whitespace is refused.
            expect(toDisplayName('Weekly\tOrder')).toBe('Weekly Order');
            expect(toDisplayName('Weekly\nOrder')).toBe('Weekly Order');
            expect(toDisplayName('Weekly\rOrder')).toBe('Weekly Order');
            expect(toDisplayName('Weekly\u000BOrder')).toBe('Weekly Order');
            expect(toDisplayName('Weekly\u000COrder')).toBe('Weekly Order');
        });

        it('collapses a mixed run of several whitespace kinds to one single space', () => {
            expect(toDisplayName('A\t\n\r B')).toBe('A B');
            expect(toDisplayName(' \t Weekly \r\n  Order \n ')).toBe('Weekly Order');
        });

        it('collapses the Unicode space separators, so a name spaced with a no-break space is not a second list', () => {
            // Two names a buyer cannot tell apart must not become two lists. That is the same reasoning that
            // puts NFC normalisation on the canonical key, applied to separators rather than to composition:
            // a name spaced with U+00A0 and the same name spaced with U+0020 are indistinguishable on screen.
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
            // This is the assertion that proves normalisation happens in `toNameKey` and not earlier. The
            // input is an `e` followed by the combining acute accent U+0301; the precomposed form U+00E9 is
            // a different code-point sequence that renders identically, so a normalising display transform
            // would pass a naive equality check against the rendered text while altering what was typed.
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
            // The transform validates nothing and throws nothing; deciding what is acceptable belongs to
            // the entry point, which is what the rejection table further down drives. Asserting the empty
            // return here is what makes that division of labour explicit rather than incidental.
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
            // Uniqueness is case-insensitive, and it is the canonical column rather than a collation that
            // makes it so — which is why the same two names collide identically on every engine instead of
            // colliding on one engine's default collation and not on another's.
            expect(toNameKey('WEEKLY')).toBe(toNameKey('weekly'));
            expect(toNameKey('Weekly')).toBe(toNameKey('weekly'));
            expect(toNameKey('WEEKLY')).toBe('weekly');
        });

        it('produces one key for a precomposed and a decomposed spelling of the same name', () => {
            // NFC is applied so that two names which are visually identical but composed differently in
            // Unicode collide, rather than producing two lists a buyer cannot tell apart. The inputs are
            // asserted to be genuinely different strings first, so the collision is demonstrably the
            // module's work rather than an artefact of the two literals being the same to begin with.
            const decomposed = 'Cafe\u0301';
            const precomposed = 'Caf\u00E9';

            expect(decomposed).not.toBe(precomposed);
            expect(toNameKey(decomposed)).toBe(toNameKey(precomposed));
            expect(toNameKey(decomposed)).toBe('caf\u00E9');
        });

        it('produces different keys for an accented and an unaccented name, because accents are never stripped', () => {
            // The single most likely defect in an implementation of this contract, and the reason this
            // assertion is stated on its own rather than folded into the case above. A pipeline that
            // decomposed and then stripped combining marks — or that applied a compatibility form — would
            // satisfy case-insensitivity, would satisfy the precomposed-versus-decomposed collision, and
            // would fail only here, by silently merging two names that are two different words.
            expect(toNameKey('Caf\u00E9')).not.toBe(toNameKey('Cafe'));
            expect(toNameKey('Cafe\u0301')).not.toBe(toNameKey('Cafe'));
            expect(toNameKey('Caf\u00E9')).toBe('caf\u00E9');
            expect(toNameKey('Cafe')).toBe('cafe');
        });

        it('preserves a compatibility character rather than expanding it, because the form applied is NFC and not NFKC', () => {
            // The same defect approached from its other side. NFKC would expand the ligature U+FB01 to the
            // two letters `fi` and fold the full-width forms to their ASCII equivalents, merging names a
            // buyer typed differently. NFC leaves both alone, so only the case mapping applies.
            expect(toNameKey('\uFB01le')).toBe('\uFB01le');
            expect(toNameKey('\uFB01le')).not.toBe('file');
            expect(toNameKey('\uFF21\uFF22')).toBe('\uFF41\uFF42');
            expect(toNameKey('\uFF21\uFF22')).not.toBe('ab');
        });

        it('neither trims nor collapses, because those two steps produced the value it is given', () => {
            // The other half of the pipeline-order assertion: steps three and four apply to the output of
            // steps one and two, so this transform must not repeat them. If it trimmed, the order of the
            // four steps would be unobservable and a later refactor could reorder them undetected.
            expect(toNameKey('  Weekly   Order  ')).toBe('  weekly   order  ');
        });

        it('is idempotent, so re-canonicalising a stored key cannot drift', () => {
            // A rename reads a stored value and canonicalises again. If the transform were not idempotent,
            // the key a row was inserted with and the key a later comparison computed could differ, and the
            // named unique constraint would stop matching the rows it exists to match.
            for (const input of ['Weekly Order', 'Caf\u00E9', 'Cafe\u0301', '\uFB01le', '\uFF21\uFF22']) {
                expect(toNameKey(toNameKey(input)), `${input} is stable under a second pass`).toBe(
                    toNameKey(input),
                );
            }
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
            // One input exercising all four steps, chosen so that each step's absence would be visible.
            // The padding and the run of three spaces exercise steps one and two; the upper-case letters
            // and the combining acute accent exercise steps four and three.
            const input = '  CAFE\u0301   Order  ';
            const result = canonicaliseReorderListName(input);

            // Steps one and two have run on the display value, and steps three and four have not: it is
            // still upper-case and the accent is still decomposed.
            expect(result.name).toBe('CAFE\u0301 Order');

            // Steps three and four have run on the key — and on the display value rather than on the raw
            // input, which is what fixes the order of the four steps rather than merely their membership.
            expect(result.nameKey).toBe('caf\u00E9 order');
            expect(result.nameKey).toBe(toNameKey(toDisplayName(input)));
        });

        it('returns a name carrying markup-significant characters byte-identical to the value submitted', () => {
            // The transport half of the hostile-input contract, and the case the owning story's first
            // acceptance criterion names. The stored name is data and every consumer renders it as text, so
            // it is neither escaped, nor stripped, nor entity-encoded at rest: encoding here would
            // double-encode for a consumer that correctly escapes on output, and would silently alter what
            // the buyer typed. The length is asserted as well as the value so that a transformation which
            // happened to produce an equal-looking string cannot pass unnoticed.
            const submitted = '<b>Tools</b> &amp; spares';
            const result = canonicaliseReorderListName(submitted);

            expect(result.name).toBe(submitted);
            expect(result.name).toHaveLength(submitted.length);
            expect(result.nameKey).toBe('<b>tools</b> &amp; spares');
        });

        it('returns a name carrying an event-handler attribute, a quote, an ampersand and a backslash byte-identical to the value submitted', () => {
            // The four characters the contract names, driven together in one angle-bracketed element with an
            // `on`-prefixed attribute. Whether such a value is safe to display is a different claim and is
            // not made here: this asserts only that it is stored and transported unaltered.
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
            // The two halves are asserted together deliberately. A refusal on its own does not distinguish
            // refusal from truncation, because an implementation that quietly stored only as many characters
            // as the column holds could also have raised an error; and an acceptance on its own does not
            // either. The pair does: the over-long value yields no result at all, and the value obtained by
            // dropping its final character is returned at its full length rather than one character shorter.
            expectListNameRejection(nameAboveBound, 'the over-long name is refused outright');

            const shortenedByOne = nameAboveBound.slice(0, -1);
            const result = canonicaliseReorderListName(shortenedByOne);

            expect(result.name).toBe(shortenedByOne);
            expect(Array.from(result.name)).toHaveLength(MAX_LIST_NAME_LENGTH);
            expect(result.name).not.toBe(nameAboveBound);
        });

        it('measures the bound on the canonical form, accepting a padded name whose trimmed length is at the bound', () => {
            // Leading and trailing padding taking the raw value to 200 characters for the shipped constant,
            // whose canonical form is exactly at the bound. This is what proves the measurement happens
            // after trim and collapse rather than against the raw input.
            const padded = `${' '.repeat(4)}${nameAtBound}${' '.repeat(5)}`;

            expect(padded).toHaveLength(MAX_LIST_NAME_LENGTH + 9);
            expectListNameAccepted(
                padded,
                { name: nameAtBound, nameKey: nameAtBound },
                'padding is not counted against the bound',
            );
        });

        it('measures the bound in Unicode code points, as the varchar column counts them', () => {
            // A supplementary character occupies two UTF-16 code units and one code point, and both
            // PostgreSQL and the MySQL family count a `varchar` length in characters. Measuring code units
            // would refuse a name the database would have accepted, which is a validation defect rather
            // than a conservative choice, so the count is asserted against a value whose two measurements
            // differ by a factor of two.
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
            // U+0958 is a composition exclusion: NFC turns one code point into two, so the key can be
            // longer than the display value it was derived from. Both are stored in columns of the same
            // declared width, so an unbounded key would fail in the driver rather than as a validation
            // rejection a buyer can act on.
            const excluded = '\u0958';
            expect(Array.from(excluded.normalize('NFC'))).toHaveLength(2);

            const displayAtBound = excluded.repeat(MAX_LIST_NAME_LENGTH);
            expect(Array.from(toDisplayName(displayAtBound))).toHaveLength(MAX_LIST_NAME_LENGTH);
            expectListNameRejection(displayAtBound, 'a key twice an at-bound display value is refused');

            // The same character within both bounds is accepted, so the guard refuses only what overflows.
            // The key's expected length is stated as twice the display value's rather than as a number
            // derived from the bound, because the doubling is the property under test and the arithmetic
            // relation between the two would otherwise hold only for an odd bound.
            const halfBound = Math.floor(MAX_LIST_NAME_LENGTH / 2);
            const withinBothBounds = excluded.repeat(halfBound);
            const accepted = canonicaliseReorderListName(withinBothBounds);

            expect(Array.from(accepted.name)).toHaveLength(halfBound);
            expect(Array.from(accepted.nameKey)).toHaveLength(halfBound * 2);
            expect(halfBound * 2).toBeLessThanOrEqual(MAX_LIST_NAME_LENGTH);
        });

        it('accepts ordinary whitespace, which the collapse step handles rather than the character test refusing', () => {
            // The negative control for the refused-character tables below, and the assertion that pins the
            // one ordering subtlety in the module: five of the characters refused as C0 controls are also
            // whitespace, so the character test must run on the canonical form rather than on the raw input.
            // Without this control, an implementation that refused every control character before collapsing
            // would pass every rejection test in this file while refusing a perfectly reasonable name.
            const whitespaceCases: NameCase[] = [
                { label: 'a tab between two words', input: 'Weekly\tOrder' },
                { label: 'a line feed between two words', input: 'Weekly\nOrder' },
                { label: 'a carriage return between two words', input: 'Weekly\rOrder' },
                { label: 'a vertical tab between two words', input: 'Weekly\u000BOrder' },
                { label: 'a form feed between two words', input: 'Weekly\u000COrder' },
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
            // Uniqueness is the named database constraint over customer, channel and canonical key, and it
            // is deliberately not a service pre-check: a read followed by an insert loses a race that a
            // constraint wins. This module's whole contribution is producing the key the constraint
            // compares, so a repeated name is not its business and it neither refuses one nor varies.
            const submitted = 'Weekly grocery restock';
            const expected = { name: submitted, nameKey: 'weekly grocery restock' };

            expectListNameAccepted(submitted, expected, 'the first submission is canonicalised');
            expectListNameAccepted(submitted, expected, 'a repeated submission is canonicalised identically');
        });
    });

    describe('the name rejections', () => {
        it('refuses each of the four names the input contract names, with one code and one message key', () => {
            // The four names the owning story's second acceptance criterion drives, as one table because
            // they share one operation and one outcome. Through the published mutation each writes no row
            // and returns exactly one entry in the response's top-level `errors` array whose
            // `extensions.code` is exactly `USER_INPUT_ERROR`; the half of that observable here is the
            // thrown class, its code and its message key, and the end-to-end suites read the response.
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
            // What makes a blank name a rejection rather than a stored empty string. Every kind of
            // whitespace the pipeline collapses is driven, including the Unicode separators, because a name
            // built only from those collapses to nothing just as a run of spaces does.
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
            // The block U+0000 to U+001F, less the five members that are whitespace and are consumed by the
            // collapse step instead — those five are the negative control asserted above. Each character is
            // driven in an interior, a leading and a trailing position, because a trim step that reached
            // beyond whitespace would remove it at the edges and leave the rejection unreachable there.
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

        it('refuses a name carrying DELETE or a C1 control character', () => {
            // U+007F and the block U+0080 to U+009F, which are control characters that no whitespace class
            // covers. U+0085 NEL is included deliberately: it is a line break in some encodings and would
            // be collapsed by an implementation that treated it as whitespace, so its refusal is asserted
            // rather than assumed.
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

        it('refuses a name carrying a zero-width formatting character', () => {
            // U+200B, U+200C and U+200D. A zero-width character is invisible, so two names differing only by
            // one are indistinguishable to a buyer while colliding with nothing; refusing them is what keeps
            // an invisible difference from becoming two lists nobody can tell apart. Note that the
            // neighbouring block U+2000 to U+200A is whitespace and is collapsed instead, which is why these
            // three are asserted individually rather than as a range.
            const zeroWidthCases: NameCase[] = [
                { label: 'U+200B ZERO WIDTH SPACE between two words', input: 'Weekly\u200BOrder' },
                { label: 'U+200B ZERO WIDTH SPACE leading', input: '\u200BWeekly Order' },
                { label: 'U+200B ZERO WIDTH SPACE trailing', input: 'Weekly Order\u200B' },
                { label: 'U+200B ZERO WIDTH SPACE alone', input: '\u200B' },
                { label: 'U+200C ZERO WIDTH NON-JOINER between two words', input: 'Weekly\u200COrder' },
                { label: 'U+200D ZERO WIDTH JOINER between two words', input: 'Weekly\u200DOrder' },
            ];

            for (const zeroWidthCase of zeroWidthCases) {
                expectListNameRejection(zeroWidthCase.input, zeroWidthCase.label);
            }
        });

        it('refuses a name carrying a byte order mark', () => {
            // U+FEFF is the one character whose refusal depends on the module not using the language's own
            // whitespace definition: `\s` — and therefore `String.prototype.trim()`, which is defined in
            // terms of it — classifies U+FEFF as whitespace, so an implementation built on either would
            // silently remove it at the edges and collapse it in the middle, and this rejection would be
            // unreachable code. The leading and trailing cases are what actually assert that, since they
            // are the positions a trim step would have consumed.
            const byteOrderMarkCases: NameCase[] = [
                { label: 'U+FEFF between two words', input: 'Weekly\uFEFFOrder' },
                { label: 'U+FEFF leading', input: '\uFEFFWeekly Order' },
                { label: 'U+FEFF trailing', input: 'Weekly Order\uFEFF' },
                { label: 'U+FEFF alone', input: '\uFEFF' },
            ];

            for (const byteOrderMarkCase of byteOrderMarkCases) {
                expectListNameRejection(byteOrderMarkCase.input, byteOrderMarkCase.label);
            }

            // And the mechanism itself, asserted rather than inferred: the display transform leaves the
            // character in place, which is what allows the character test to find it.
            expect(Array.from(toDisplayName('\uFEFFWeekly Order'))).toContain('\uFEFF');
        });

        it('refuses rather than repairs, so no call returns the value a stripping implementation would have stored', () => {
            // The contract settles reject-or-strip as rejection, and this is the assertion that tells the
            // two apart. A stripping implementation would have returned `WeeklyOrder` for the first input
            // and a truncating one the at-bound value for the second; both would have satisfied a test that
            // only checked the stored row for the offending character. Nothing is returned at all, and the
            // display transform is asserted to have left the character in place, so no layer strips it.
            const strippable = 'Weekly\u0007Order';

            expectListNameRejection(strippable, 'a control character is refused, not removed');
            expect(toDisplayName(strippable)).toBe(strippable);
            expect(Array.from(toDisplayName(strippable))).toContain('\u0007');
            expect(toDisplayName(strippable)).not.toBe('WeeklyOrder');

            expectListNameRejection(nameAboveBound, 'an over-long name is refused, not truncated');
            expect(nameAboveBound.startsWith(nameAtBound)).toBe(true);
        });

        it('refuses a value that is not a string at all', () => {
            // The published mutation's argument is a non-nullable GraphQL `String`, checked before any
            // resolver runs, so this branch cannot be reached through the operation. It exists because the
            // entry point is exported and its caller may not be that operation: refusing a missing value as
            // malformed input reports the problem, whereas letting the string transforms fail on it would
            // put an internal error and a stack trace where a validation message belongs.
            expectListNameRejection(undefined as unknown as string, 'an undefined value is refused');
            expectListNameRejection(null as unknown as string, 'a null value is refused');
            expectListNameRejection(42 as unknown as string, 'a number is refused');
        });

        it('carries the same class, code and message key across all three rejection classes', () => {
            // Stated as its own assertion because it is a coordination constraint rather than an
            // implementation detail: the translation bundle registers exactly four keys, only one of which
            // is about a name, so an emptiness rejection, a length rejection and a disallowed-character
            // rejection have to share it. That is also why the key interpolates a maximum on all three.
            const oneOfEachClass: NameCase[] = [
                { label: 'the emptiness rejection', input: '   ' },
                { label: 'the length rejection', input: nameAboveBound },
                { label: 'the disallowed-character rejection', input: 'Weekly\u200BOrder' },
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
