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
 * configuration confines unit discovery to `src/**&#47;*.spec.ts` and excludes `e2e/**` outright, so this
 * file is found by that pattern and the package's `test` script is what runs it. The e2e suites are
 * collected separately, by the shared `*.e2e-spec.ts` configuration under `e2e-common/`, which is what
 * supplies their database initializers and their far longer timeouts — none of which this file needs.
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

        it('treats exactly three C0 characters as whitespace — tab, line feed and carriage return', () => {
            // These three are C0 control characters as well as whitespace, and they are the only members of
            // that block the pipeline consumes rather than refusing. That ordering is what stops a name
            // pasted with a tab between two words from being reported as carrying a control character, and
            // it is asserted from the other direction further down, where every other C0 character —
            // U+000B vertical tab and U+000C form feed included — is refused.
            expect(toDisplayName('Weekly\tOrder')).toBe('Weekly Order');
            expect(toDisplayName('Weekly\nOrder')).toBe('Weekly Order');
            expect(toDisplayName('Weekly\rOrder')).toBe('Weekly Order');
        });

        it('leaves a vertical tab and a form feed in place, because they are controls rather than whitespace', () => {
            // The negative half of the assertion above, and the mechanism behind the U+000B/U+000C
            // rejections further down. JavaScript's `\s` — and therefore `String.prototype.trim()` —
            // classifies both as whitespace; this module's own whitespace class deliberately excludes them,
            // so they survive trim-and-collapse and reach the disallowed-character test. Were they
            // collapsed here, that rejection would be unreachable code and two invisible control characters
            // would reach storage inside a name the caller was told had been accepted.
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

        it('normalises to NFC before lower-casing, proved on an input whose result differs between the two orders', () => {
            // ★ The assertion that makes the pipeline's step order falsifiable rather than merely stated.
            //
            // Every other case/normalisation assertion in this file is order-blind: for `CAFE\u0301`,
            // normalising and then lower-casing and lower-casing and then normalising both yield
            // `caf\u00E9`, so a module that inverted steps three and four would pass all of them. Two
            // characters do distinguish the orders, and both are driven here.
            //
            // `J` followed by U+030C COMBINING CARON is the first. Unicode has no precomposed capital J with
            // caron, so NFC leaves the pair alone; the case mapping then yields `j` followed by the same
            // combining caron — two code points. Invert the two steps and the case mapping runs first,
            // producing `j` + caron, which NFC *can* compose, collapsing it into the single code point
            // U+01F0. So the two orders disagree in code-point count as well as in content.
            //
            // What this pins is the contract's order — trim, collapse, NFC, lower-case — and nothing more.
            // It deliberately makes no claim that either result is the better key: the order is fixed by
            // the feature contract, so the module's job is to implement that order observably, and this
            // test's job is to fail if it ever stops doing so.
            const capitalJWithCaron = 'J\u030C';
            const invertedOrderKey = capitalJWithCaron.toLowerCase().normalize('NFC');

            // First, that the two orders genuinely differ for this input — without this, the assertion
            // below would prove nothing, which is exactly the hole a same-result fixture leaves.
            expect(invertedOrderKey).toBe('\u01F0');
            expect(Array.from(invertedOrderKey)).toHaveLength(1);

            // Then, that the module took the contract's order.
            expect(toNameKey(capitalJWithCaron)).toBe('j\u030C');
            expect(Array.from(toNameKey(capitalJWithCaron))).toHaveLength(2);
            expect(toNameKey(capitalJWithCaron)).not.toBe(invertedOrderKey);

            // A second character with the same property, so the evidence does not rest on one code point:
            // `T` followed by U+0308 COMBINING DIAERESIS. NFC first leaves `t` + diaeresis; lower-casing
            // first composes to U+1E97, LATIN SMALL LETTER T WITH DIAERESIS.
            const capitalTWithDiaeresis = 'T\u0308';
            expect(capitalTWithDiaeresis.toLowerCase().normalize('NFC')).toBe('\u1E97');
            expect(toNameKey(capitalTWithDiaeresis)).toBe('t\u0308');
            expect(toNameKey(capitalTWithDiaeresis)).not.toBe('\u1E97');
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

        it('is stable under a second pass for these inputs, which is not a general property', () => {
            // Narrowly scoped on purpose. Each input below is already in its own image, so a second pass
            // changes nothing — useful to pin, because these are the shapes a stored key actually takes.
            for (const input of ['Weekly Order', 'Caf\u00E9', 'Cafe\u0301', '\uFB01le', '\uFF21\uFF22']) {
                expect(toNameKey(toNameKey(input)), `${input} is stable under a second pass`).toBe(
                    toNameKey(input),
                );
            }
        });

        it('is NOT idempotent in general, which the mandated step order makes unavoidable', () => {
            // ★ Stated as a fact about the contract rather than hidden behind a selective input list.
            // The order is fixed at trim, collapse, normalise (NFC), lower-case
            // [FEATURE-001-01:section 2.11], so NFC runs on the *cased* text and the lower-casing that
            // follows can expose a new composition. `J` + U+030C lower-cases to `j` + U+030C, which NFC
            // would have composed to U+01F0 had it run afterwards — so a second pass composes it.
            const once = toNameKey('J\u030C');
            expect(once).toBe('j\u030C');
            expect(toNameKey(once)).toBe('\u01F0');
            expect(toNameKey(once)).not.toBe(once);

            // Why this is a correctness statement and not a defect to fix here. The pipeline order is
            // frozen and is asserted three ways above; changing it to gain idempotence would break the
            // accent-preserving, case-insensitive comparison the feature specifies. What follows from it
            // is a constraint on *callers*: a stored `nameKey` is a canonical form already and must be
            // compared as it stands, never re-canonicalised. The service satisfies this — it derives the
            // key from the submitted display name on every write and never feeds a stored key back
            // through — and the named unique constraint therefore keeps matching the rows it exists to
            // match. Re-canonicalising a stored key would be the bug.
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

            // ★ The input above fixes the *membership* of the four steps and the position of trim and
            // collapse, but it cannot distinguish step three from step four: `CAFE\u0301` yields
            // `caf\u00E9` whichever of normalise and lower-case runs first. This second input can. `J`
            // followed by U+030C COMBINING CARON has no precomposed capital form, so normalising first
            // leaves the pair and the case mapping then gives `j` + caron; lower-casing first gives `j` +
            // caron, which NFC composes into the single code point U+01F0. The two orders therefore produce
            // different keys, and the module is asserted to have produced the contract's one.
            const orderSensitiveInput = '  J\u030C   Order  ';
            const orderSensitiveResult = canonicaliseReorderListName(orderSensitiveInput);
            const invertedOrderKey = toDisplayName(orderSensitiveInput).toLowerCase().normalize('NFC');

            expect(orderSensitiveResult.name).toBe('J\u030C Order');
            expect(orderSensitiveResult.nameKey).toBe('j\u030C order');
            expect(invertedOrderKey).toBe('\u01F0 order');
            expect(orderSensitiveResult.nameKey).not.toBe(invertedOrderKey);
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
            // one ordering subtlety in the module: three of the characters that would otherwise be refused
            // as C0 controls are also whitespace, so the character test must run on the canonical form
            // rather than on the raw input. Without this control, an implementation that refused every
            // control character before collapsing would pass every rejection test in this file while
            // refusing a perfectly reasonable name. The three are tab, line feed and carriage return and
            // nothing else — U+000B and U+000C are driven in the rejection table instead.
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
            // The block U+0000 to U+001F, less the three members that are whitespace and are consumed by the
            // collapse step instead — those three are the negative control asserted above. Each character is
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

        it('refuses a name carrying a vertical tab or a form feed, which the C0 block does not carve out', () => {
            // The two C0 characters JavaScript's `\s` calls whitespace and the input contract does not. The
            // contract carves exactly three members out of U+0000 to U+001F as whitespace the pipeline
            // handles — tab U+0009, line feed U+000A and carriage return U+000D — and refuses the rest, so
            // U+000B VERTICAL TAB and U+000C FORM FEED are invisible control characters rather than spacing.
            // They are asserted separately from the table above because their refusal depends on a decision
            // that is easy to lose: this module defines its own whitespace class instead of using `\s`, and
            // an implementation built on `\s` or on `String.prototype.trim()` would collapse both of these
            // into an ordinary space and store them, passing every other test in this file.
            //
            // The leading and trailing positions carry most of the weight, because those are exactly the
            // positions a `trim()`-based implementation would silently clear. The alone case is driven too:
            // under such an implementation the name would collapse to the empty string and be refused for
            // emptiness instead, which would look like the right answer for the wrong reason — so the
            // display transform is asserted above to leave both characters in place.
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

            // And the mechanism, asserted rather than inferred: `\s` and `trim()` disagree with this module
            // about both characters, which is precisely why neither is used to build the whitespace class.
            expect(/\s/.test('\u000B'), 'the language calls U+000B whitespace').toBe(true);
            expect(/\s/.test('\u000C'), 'the language calls U+000C whitespace').toBe(true);
            expect('Weekly Order\u000B'.trim(), 'trim() would have removed it').toBe('Weekly Order');
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
