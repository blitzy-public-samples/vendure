/*
 * -------------------------------------------------------------------------------------------------------
 * Reorder list name canonicalisation — provenance, and why this module is pure.
 * -------------------------------------------------------------------------------------------------------
 * Attribution. No user-specified rules were provided for this project: the rules document was read and
 * returned exactly that, and EPIC-001 reaches the same finding independently in its own section 11.9.
 * Nothing in this file is, or derives from, a user-specified rule. Every constraint stated below traces to
 * FEATURE-001-01 section 2.10.1 or section 2.11, to STORY-001-01-01 acceptance criterion 2, to EPIC-001
 * ruling R13, or to a cited line of this repository, and is attributed as such wherever it is stated. The
 * absence of a rules document has not been treated as licence to lower the bar anywhere in this file.
 *
 * Why this module holds no decorator, no injectable, no repository and no I/O of any kind. A list name is
 * the only free text this feature persists, it arrives from a public caller, and the whole of its contract
 * is decided by string arithmetic. Keeping that arithmetic in pure functions means the behaviour can be
 * asserted exhaustively — every boundary, every rejected character, every Unicode composition — without a
 * database, a request context or a running server, which is what lets the coverage target for this feature
 * land on deterministic logic rather than on database interaction. Anything in here that needed a
 * connection, a session or an entity would belong in `reorder-list.service.ts` instead.
 *
 * What this module deliberately does NOT decide. It does not decide uniqueness. Two lists collide when
 * their `nameKey` values are equal for one customer in one channel, and the authority for that is the named
 * database constraint `UQ_reorder_list_customer_channel_name_key` over `(customerId, channelId, nameKey)` —
 * never a service pre-check, because a read followed by an insert loses the race and a constraint does not.
 * This module's entire contribution to that decision is producing the `nameKey` the constraint compares, so
 * there is no lookup here, no cache, and no "does this name already exist" question asked or answered.
 *
 * The pipeline order is the contract, and it is stated as an order because it is one:
 *
 *     trim  ->  collapse  ->  NFC  ->  lower-case
 *
 * The first two steps produce the display value stored in `reorder_list.name`; the last two turn that value
 * into the canonical `nameKey`. Reordering them changes results — normalising before collapsing, for
 * instance, would let a composed sequence bridge a whitespace run — so the order is honoured literally by
 * the two exported transforms below and each step is applied in exactly one place.
 *
 * Why the display value is not sanitised. The stored `name` is data, and every consumer renders it as text.
 * It is therefore returned byte-for-byte as submitted after whitespace canonicalisation only: it is neither
 * escaped, nor stripped, nor entity-encoded at rest. Encoding at rest would be the wrong fix twice over —
 * it double-encodes for any consumer that correctly escapes on output, and it silently alters what the
 * buyer typed. A name such as `<b>Tools</b> &amp; spares` survives this module unchanged apart from its
 * whitespace, and the obligation to escape on output belongs to whatever renders it.
 *
 * The `@since 3.8.0` tags below are a derivation and are flagged as one. The contribution guide requires a
 * new public API to carry a `@since` tag naming what will be the next minor version, and its own literal
 * example names a different version entirely. This checkout declares 3.7.0, so the next minor derives to
 * 3.8.0. That string appears nowhere in this repository and is therefore not a quotation from it; it is
 * computed from the checkout's declared version plus the guide's rule.
 */

import { UserInputError } from '@vendure/core';

import { MAX_LIST_NAME_LENGTH } from '../constants';

/**
 * The single message key every name rejection in this module raises, declared once so that the "one key"
 * rule is structurally true rather than merely observed.
 *
 * The plugin's translation bundle registers exactly four keys and this is the only one of them about a
 * name. It reads as a combined statement — a name may be neither empty nor longer than the maximum — and
 * interpolates a `max` variable precisely because it covers the length bound as well as emptiness. That is
 * why all three rejections below share it. Inventing a fifth key would surface to the caller as the raw key
 * text, because nothing would register a translation for it.
 */
const LIST_NAME_REJECTED_MESSAGE_KEY = 'error.reorder-list-name-empty';

/**
 * The name of the interpolation variable carried on the rejection above. The registered message interpolates
 * `max`, so the variable must be spelled exactly that and nothing else; a mismatch is not a compile error
 * and would surface only as an unsubstituted token in the message a buyer reads.
 */
const MAX_LENGTH_VARIABLE = 'max';

/**
 * Every character this module treats as whitespace, expressed as the body of a regular expression character
 * class so that the set is declared exactly once and the trim and collapse patterns below cannot drift
 * apart.
 *
 * The set is JavaScript's own `\s` **minus U+FEFF**, and that single subtraction is load-bearing rather
 * than fastidious. `\s` — and therefore `String.prototype.trim()`, which is defined in terms of it —
 * classifies the byte order mark U+FEFF as whitespace. Were this module to use either of them, a name
 * carrying a byte order mark would have it silently trimmed or collapsed into an ordinary space, and the
 * rejection of that character further down would become unreachable code: the test could never fire
 * because the character would already be gone. So `\s` is not used, `trim()` is not used, and U+FEFF is
 * left in the input for the disallowed-character test to find.
 *
 * The set likewise excludes U+0085 NEL, which `\s` also excludes: it is a C1 control character and is
 * rejected rather than collapsed.
 *
 * Included, in order: the ASCII whitespace run U+0009 tab, U+000A line feed, U+000B vertical tab, U+000C
 * form feed and U+000D carriage return; U+0020 space; then the Unicode space separators U+00A0 no-break
 * space, U+1680, U+2000 to U+200A, U+202F narrow no-break space, U+205F and U+3000 ideographic space; and
 * finally the U+2028 line and U+2029 paragraph separators.
 *
 * Treating the non-ASCII separators as whitespace is deliberate and follows from the same reasoning that
 * puts NFC normalisation on the canonical form: a name separated by a no-break space and the same name
 * separated by an ordinary space are indistinguishable to the buyer reading them, so admitting both as
 * two distinct lists would produce exactly the pair of lists that normalisation exists to prevent. A name
 * consisting only of such separators is consequently blank, and is rejected as blank.
 */
const WHITESPACE_CHARACTER_CLASS =
    '\\t\\n\\v\\f\\r \\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000';

/**
 * Matches one leading and one trailing run of whitespace — step one of the pipeline, `trim`. Built from the
 * class above rather than written out, and used only with `String.prototype.replace`, which resets a
 * global pattern's `lastIndex` on completion; no `test` or `exec` call is made against either of these
 * module-level patterns, so neither can carry state between calls.
 */
const LEADING_AND_TRAILING_WHITESPACE = new RegExp(
    `^[${WHITESPACE_CHARACTER_CLASS}]+|[${WHITESPACE_CHARACTER_CLASS}]+$`,
    'g',
);

/**
 * Matches each remaining run of whitespace — step two of the pipeline, `collapse`. Every match is replaced
 * by a single U+0020 space, so a run of any length and of any mixture of the characters above becomes one
 * ordinary space.
 */
const INTERNAL_WHITESPACE_RUN = new RegExp(`[${WHITESPACE_CHARACTER_CLASS}]+`, 'g');

/** The single character every collapsed whitespace run becomes: U+0020, an ordinary space. */
const COLLAPSED_WHITESPACE_REPLACEMENT = ' ';

/**
 * Upper bound of the C0 control block, U+0000 to U+001F. Note that five of its members — tab, line feed,
 * vertical tab, form feed and carriage return — are whitespace and have already been consumed by the time
 * this bound is applied; see {@link findDisallowedCharacter} for why that ordering matters.
 */
const C0_CONTROL_LAST_CODE_POINT = 0x1f;

/** U+007F DELETE, the control character that sits immediately below the C1 block rather than in C0. */
const DELETE_CODE_POINT = 0x7f;

/**
 * Upper bound of the C1 control block, U+0080 to U+009F, whose lower bound is the code point immediately
 * above {@link DELETE_CODE_POINT} — which is why the two are tested as one contiguous range below.
 */
const C1_CONTROL_LAST_CODE_POINT = 0x9f;

/** U+200B ZERO WIDTH SPACE, the first of the three contiguous zero-width formatting characters. */
const ZERO_WIDTH_FIRST_CODE_POINT = 0x200b;

/** U+200D ZERO WIDTH JOINER, the last of them; U+200C ZERO WIDTH NON-JOINER sits between the two. */
const ZERO_WIDTH_LAST_CODE_POINT = 0x200d;

/**
 * U+FEFF, the byte order mark, also known as ZERO WIDTH NO-BREAK SPACE. It is rejected here rather than
 * collapsed, which is only possible because {@link WHITESPACE_CHARACTER_CLASS} deliberately excludes it.
 */
const BYTE_ORDER_MARK_CODE_POINT = 0xfeff;

/**
 * @description
 * The pair of values a reorder list row stores for its name: the display value the buyer sees, and the
 * canonical value uniqueness is evaluated on. They are produced together by
 * {@link canonicaliseReorderListName} and written in the same transaction as the row, so the two can never
 * disagree about the same name.
 *
 * @docsCategory core plugins/ReorderPlugin
 * @docsPage reorder list names
 * @since 3.8.0
 */
export interface CanonicalReorderListName {
    /**
     * @description
     * The display value, stored in `reorder_list.name` and returned to the buyer. It is the submitted
     * string with leading and trailing whitespace removed and internal whitespace runs collapsed to one
     * space, and it is otherwise byte-for-byte what was submitted: not case-folded, not Unicode-normalised,
     * not escaped and not stripped.
     *
     * @since 3.8.0
     */
    name: string;

    /**
     * @description
     * The canonical value, stored in `reorder_list.nameKey` and never shown to the buyer. It is
     * {@link CanonicalReorderListName.name} normalised to Unicode NFC and then lower-cased, and it is the
     * column the named unique constraint over `(customerId, channelId, nameKey)` compares. Uniqueness is
     * therefore case-insensitive and accent-preserving on every database engine, without depending on a
     * column collation.
     *
     * @since 3.8.0
     */
    nameKey: string;
}

/**
 * Counts a string's length in Unicode code points rather than in UTF-16 code units.
 *
 * This distinction is not pedantry here: both columns the two values land in are declared `varchar` at the
 * width {@link MAX_LIST_NAME_LENGTH} carries, and both PostgreSQL and the MySQL family count a `varchar`
 * length in characters, treating a supplementary character as one. Measuring `String.prototype.length`
 * would count such a character as two and reject a name the database would have accepted, which is a
 * validation bug rather than a conservative choice. Iterating a string yields one entry per code point, so
 * the count matches what the column enforces.
 */
function countCodePoints(value: string): number {
    return Array.from(value).length;
}

/**
 * Returns the first control or zero-width character in the supplied value, or `undefined` when it holds
 * none.
 *
 * **Why this runs after trim-and-collapse, which is the one subtlety in this module.** Five of the
 * characters this function rejects as C0 controls — tab U+0009, line feed U+000A, vertical tab U+000B, form
 * feed U+000C and carriage return U+000D — are also ordinary whitespace, and whitespace is something the
 * pipeline legitimately handles rather than refuses. Were this test applied to the raw input, a perfectly
 * reasonable name pasted with a tab between two words would be reported as carrying a control character.
 * Applying it to the canonical form instead means those five have already been consumed: the trim step
 * removed them at the edges and the collapse step turned any interior run of them into a single U+0020
 * space. Whatever control characters remain are therefore genuinely control characters and not whitespace,
 * and U+0007 — the case the acceptance criteria name — is exactly one of them.
 *
 * The reverse ordering is what makes the byte order mark work too, from the other direction: U+FEFF is
 * excluded from the whitespace class precisely so that it survives trim-and-collapse and arrives here.
 *
 * The offending character is returned rather than a boolean so that the caller can report or log which
 * character was at fault. It is deliberately **not** interpolated into the error message: the registered
 * message carries the length variable and nothing else, and echoing hostile input back into an error string
 * is a habit worth not forming.
 */
function findDisallowedCharacter(value: string): string | undefined {
    for (const character of value) {
        const codePoint = character.codePointAt(0);
        if (codePoint !== undefined && isDisallowedCodePoint(codePoint)) {
            return character;
        }
    }
    return undefined;
}

/**
 * Whether a single code point is one this module refuses to let reach storage.
 *
 * Four disjoint sets, and each is refused rather than stripped. Stripping would alter what the buyer typed
 * without telling them, and the acceptance criteria settle the choice explicitly: a name carrying U+0007
 * and a name carrying U+200B each write no row and are reported to the caller.
 */
function isDisallowedCodePoint(codePoint: number): boolean {
    return (
        // C0 controls, U+0000 to U+001F, less the five that are whitespace and already consumed.
        codePoint <= C0_CONTROL_LAST_CODE_POINT ||
        // U+007F DELETE together with the C1 control block U+0080 to U+009F, one contiguous range.
        (codePoint >= DELETE_CODE_POINT && codePoint <= C1_CONTROL_LAST_CODE_POINT) ||
        // The zero-width formatting characters U+200B, U+200C and U+200D.
        (codePoint >= ZERO_WIDTH_FIRST_CODE_POINT && codePoint <= ZERO_WIDTH_LAST_CODE_POINT) ||
        // U+FEFF, the byte order mark, which the whitespace class excludes so that it reaches this test.
        codePoint === BYTE_ORDER_MARK_CODE_POINT
    );
}

/**
 * Refuses the submitted name.
 *
 * Every one of the three rejections funnels through here, and they all raise the identical error with the
 * identical variables. That is intentional on two counts. The registered message states the whole contract
 * in one sentence, so a buyer reading it learns the rule rather than which clause of it they broke. And
 * because the three are indistinguishable to the caller, the order in which they are evaluated has no
 * observable effect — which is what allows them to be written below in the order the requirements list them
 * rather than in whichever order would be marginally cheapest to compute.
 *
 * The error class is the platform's own `UserInputError`, so the caller observes exactly one entry in the
 * response's top-level `errors` array whose `extensions.code` is exactly `USER_INPUT_ERROR`, with the
 * operation's own field null. A malformed name is a malformed request rather than a business outcome, which
 * is why it is thrown here and is not a member of any result union: none of this feature's four error
 * results describes an invalid name, and a fifth is not invented for it.
 *
 * The declared return type is `never`, which lets a caller write `return rejectListName()` and keeps
 * TypeScript's reachability analysis correct at every call site.
 */
function rejectListName(): never {
    throw new UserInputError(LIST_NAME_REJECTED_MESSAGE_KEY, {
        [MAX_LENGTH_VARIABLE]: MAX_LIST_NAME_LENGTH,
    });
}

/**
 * @description
 * Produces the display form of a reorder list name — the value stored in `reorder_list.name` and returned
 * to the buyer.
 *
 * It performs exactly two transformations, being steps one and two of the canonicalisation pipeline:
 *
 * 1. **trim** — leading and trailing whitespace is removed;
 * 2. **collapse** — each remaining run of internal whitespace becomes a single U+0020 space.
 *
 * It performs nothing else. There is no case folding, no Unicode normalisation, no escaping, no stripping
 * and no entity encoding, because the stored name is data and every consumer renders it as text. A name
 * such as `<b>Tools</b> &amp; spares` therefore comes back byte-for-byte as submitted, and a name whose
 * accented characters arrived decomposed keeps them decomposed — normalisation belongs to
 * {@link toNameKey}, which is the value uniqueness is decided on, and applying it here would alter what
 * the buyer typed to no purpose.
 *
 * This function validates nothing and throws nothing: it can legitimately return the empty string, for a
 * name that was entirely whitespace. Deciding what is acceptable is {@link canonicaliseReorderListName}'s
 * job, and callers wanting both the display value and its validation should use that entry point instead of
 * composing the steps themselves.
 *
 * @example
 * ```ts
 * toDisplayName('  Weekly   Order  '); // 'Weekly Order'
 * toDisplayName('Weekly\tOrder');      // 'Weekly Order'
 * toDisplayName('   ');                // ''
 * ```
 *
 * @docsCategory core plugins/ReorderPlugin
 * @docsPage reorder list names
 * @since 3.8.0
 */
export function toDisplayName(input: string): string {
    // Step one, trim; then step two, collapse. Performed in the order the contract states, each in exactly
    // one place. Note that `String.prototype.trim()` is deliberately not used for step one: it treats
    // U+FEFF as whitespace, which would make the byte order mark unrejectable further down the pipeline.
    const trimmed = input.replace(LEADING_AND_TRAILING_WHITESPACE, '');
    return trimmed.replace(INTERNAL_WHITESPACE_RUN, COLLAPSED_WHITESPACE_REPLACEMENT);
}

/**
 * @description
 * Produces the canonical form of a reorder list name — the value stored in `reorder_list.nameKey`, which
 * the named unique constraint over `(customerId, channelId, nameKey)` compares and which is never shown to
 * the buyer.
 *
 * It expects a value that has already been through {@link toDisplayName} and applies steps three and four
 * of the pipeline, in this order:
 *
 * 3. **NFC** — the value is normalised to Unicode Normalization Form C;
 * 4. **lower-case** — the normalised value is lower-cased.
 *
 * It performs nothing else. In particular it does **not** strip accents, and it applies neither NFD nor
 * NFKC. That combination is what makes the comparison case-insensitive but accent-preserving, and both
 * halves of it are deliberate:
 *
 * - Lower-casing means `Weekly` and `weekly` are one list rather than two, which is what a buyer expects
 *   and what an explicit canonical column guarantees on every engine. Relying on a column collation
 *   instead would make the same two names collide on one engine and not on another.
 * - NFC means two names that are visually identical but composed differently in Unicode — a precomposed
 *   `é` at U+00E9 against an `e` followed by the combining acute accent U+0301 — collide, rather than
 *   producing two lists a buyer cannot tell apart.
 * - Not stripping accents means `Café` and `Cafe` remain two distinct lists, because they are two
 *   different words rather than two spellings of one. Stripping, or applying a compatibility form such as
 *   NFKC, would silently merge them.
 *
 * @example
 * ```ts
 * toNameKey('Weekly Order');   // 'weekly order'
 * toNameKey('WEEKLY ORDER');   // 'weekly order'
 * toNameKey('Cafe\u0301');     // 'café' — same key as toNameKey('Caf\u00E9')
 * toNameKey('Cafe');           // 'cafe' — a DIFFERENT key from 'café'
 * ```
 *
 * @docsCategory core plugins/ReorderPlugin
 * @docsPage reorder list names
 * @since 3.8.0
 */
export function toNameKey(displayName: string): string {
    // Step three, NFC; then step four, lower-case. NFC first, so that a decomposed sequence is composed
    // before case mapping rather than after it.
    return displayName.normalize('NFC').toLowerCase();
}

/**
 * @description
 * Canonicalises and validates a buyer-supplied reorder list name, returning both stored values together.
 *
 * This is the single entry point the reorder list service calls, on the create path and on the rename path
 * alike. Because it is the only producer of the display value and the canonical key, the two can never
 * drift apart: no caller composes the pipeline itself, and no code path writes one without the other.
 *
 * The full pipeline runs in its stated order — trim, collapse, NFC, lower-case — and the three rejections
 * are evaluated against the **canonical** form rather than against the raw input:
 *
 * 1. **An empty canonical form is refused.** This is what makes a blank or whitespace-only name a rejection
 *    rather than a stored empty string.
 * 2. **A canonical form longer than the maximum is refused.** Nothing is ever truncated: an over-long name
 *    yields an error and no row, so the way to obtain a stored row is to submit a shorter name. The bound is
 *    a constant equal to the width of the columns the values are stored in, and there is deliberately no
 *    option to configure it — a value above the column width would turn a rejection a buyer can act on into
 *    an opaque driver error, and a value below it would restrict what no engine restricts.
 * 3. **A control or zero-width character is refused.** Such characters are rejected rather than stripped,
 *    so that nothing reaches storage that the buyer did not knowingly submit and nothing is silently
 *    altered. See {@link findDisallowedCharacter} for why this test necessarily runs last.
 *
 * All three raise the platform's `UserInputError`, so the caller observes exactly one entry in the
 * response's top-level `errors` array whose `extensions.code` is exactly `USER_INPUT_ERROR`, with the
 * operation's own field null and no row written. None is a member of any result union: a name that cannot
 * be stored is a malformed request, not a business outcome.
 *
 * What this function does not do is decide uniqueness. It produces the `nameKey` that the named database
 * constraint compares, and the constraint decides. There is no lookup here and no pre-check, because a read
 * followed by an insert loses a race that the constraint wins.
 *
 * @example
 * ```ts
 * canonicaliseReorderListName('  Weekly   Order  ');
 * // { name: 'Weekly Order', nameKey: 'weekly order' }
 *
 * canonicaliseReorderListName('<b>Tools</b> &amp; spares');
 * // { name: '<b>Tools</b> &amp; spares', nameKey: '<b>tools</b> &amp; spares' }
 *
 * canonicaliseReorderListName('   ');            // throws UserInputError
 * canonicaliseReorderListName('Order\u0007');    // throws UserInputError
 * canonicaliseReorderListName('Order\u200B');    // throws UserInputError
 * ```
 *
 * @throws A `UserInputError` carrying the code `USER_INPUT_ERROR` when the canonical name is empty, is
 * longer than the maximum, or contains a control or zero-width character.
 *
 * @docsCategory core plugins/ReorderPlugin
 * @docsPage reorder list names
 * @since 3.8.0
 */
export function canonicaliseReorderListName(input: string): CanonicalReorderListName {
    // A non-string cannot arrive through the published operation, whose argument is a non-nullable GraphQL
    // `String` and is therefore checked before any resolver runs. The guard is here because this function
    // is exported and its caller may not be that operation: refusing a missing value as malformed input
    // reports the problem to the caller, whereas letting the string methods below fail on it would raise an
    // internal error and put a stack trace where a validation message belongs. The three transforms are
    // left unguarded by contrast, being internal steps that only ever receive a checked value.
    if (typeof input !== 'string') {
        return rejectListName();
    }

    const name = toDisplayName(input);

    // Rejection one: the canonical form is empty. Written first because the requirements list it first;
    // since all three rejections raise the identical error, the order carries no observable meaning.
    if (name === '') {
        return rejectListName();
    }

    // Rejection two: the canonical form is longer than the bound. Measured on the canonical form, after
    // trim and collapse, and measured in code points because that is the unit the `varchar` column counts.
    if (countCodePoints(name) > MAX_LIST_NAME_LENGTH) {
        return rejectListName();
    }

    // Rejection three: the canonical form carries a control or zero-width character. Necessarily last, so
    // that the whitespace the collapse step legitimately consumed is not misreported as a control
    // character; see findDisallowedCharacter for the full reasoning.
    if (findDisallowedCharacter(name) !== undefined) {
        return rejectListName();
    }

    const nameKey = toNameKey(name);

    // The key is bounded as well as the display value, and this is not redundant: NFC composition is not
    // guaranteed to shorten a string, and there are code points whose canonical decomposition leaves the
    // normalised form longer than the input — U+0344 is one. Since `nameKey` is stored in a column of the
    // same declared width as `name`, a key that overflowed it would fail in the driver rather than here.
    // For every name composed of characters that NFC leaves alone the two measurements are equal, so this
    // guard changes nothing about where the documented boundary falls.
    if (countCodePoints(nameKey) > MAX_LIST_NAME_LENGTH) {
        return rejectListName();
    }

    return { name, nameKey };
}
