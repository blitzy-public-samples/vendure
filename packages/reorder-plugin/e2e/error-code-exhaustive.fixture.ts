/**
 * ERROR CODE EXHAUSTIVENESS FIXTURE — THIS FILE IS EXPECTED TO FAIL TYPE-CHECKING.
 *
 * 1. THE FAILURE IS THE ASSERTION, NOT A DEFECT.
 *    Nothing in this file is broken and nothing in it is to be "fixed". A clean compile here is a
 *    REGRESSION, because it would mean the published Shop `ErrorCode` enum stopped growing when
 *    `ReorderPlugin` declared its four error results. The assertion is owned by
 *    `packages/reorder-plugin/e2e/reorder-list-read.e2e-spec.ts`, and this file is compiled as the
 *    single entry of its own compiler project,
 *    `packages/reorder-plugin/e2e/tsconfig.error-code-exhaustive.json`, which extends the repository
 *    root configuration so that `strict` is inherited rather than redeclared [tsconfig.json:L13].
 *    That project is type-checked with the workspace's own pinned compiler [package.json:L64] and is
 *    asserted to exit NON-ZERO; its control sibling is asserted to exit zero. Two separate
 *    project-scoped runs are required because one invocation cannot produce two opposite exit
 *    statuses, and a bare `tsc --noEmit` would compile whatever the nearest ambient configuration
 *    happens to include rather than the single file named here
 *    [tickets/EPIC-001/FEATURE-001-01/STORY-001-01-04-read-reorder-lists-via-shop-api.md:§5 AC-8].
 *
 * 2. WHY IT FAILS, AND WHY THE DIAGNOSTIC NAMES THE NEW MEMBERS.
 *    The switch below carries exactly one `case` for each of the 32 `ErrorCode` members the Shop API
 *    publishes today [packages/common/src/generated-shop-types.ts:L989-L1022] and carries no `default`
 *    clause. It therefore handles none of the four members this plugin's SDL adds, so after the 32
 *    cases the narrowed type of `code` is the four-member `ReorderErrorCode` union rather than `never`,
 *    and the trailing `never`-typed assignment is refused with TS2322. That refusal prints the
 *    unhandled members BY NAME, which is what distinguishes the failure under test from an unrelated
 *    compile error. The growth itself is automatic and cannot be opted out of: the enum's members are
 *    derived from every object type implementing the `ErrorResult` interface
 *    [packages/core/src/api/config/generate-error-code-enum.ts:L9], matched by a filter over each
 *    type's declared interfaces [packages/core/src/api/config/generate-error-code-enum.ts:L17], and
 *    upper-snake-cased [packages/core/src/api/config/generate-error-code-enum.ts:L31-L33]. The four
 *    declarations live in `packages/reorder-plugin/src/api/api-extensions.ts`.
 *
 * 3. DOCUMENTED DIVERGENCE FROM AC-8 — RECORDED HERE RATHER THAN SILENTLY RESOLVED.
 *    AC-8 specifies that both fixtures compile "against types regenerated from the rebuilt schema by
 *    the repository's own generator, `bun run codegen`" [package.json:L22]
 *    [tickets/EPIC-001/FEATURE-001-01/STORY-001-01-04-read-reorder-lists-via-shop-api.md:§5 AC-8].
 *    That is UNREACHABLE in this change, and by design: the checked-in introspection snapshot is
 *    never edited and never regenerated (AAP §0.4.1.5), because the script that produces it declares
 *    its own configuration with `plugins: [AdminUiPlugin]` and never imports the dev-server config
 *    [scripts/codegen/download-introspection-schema.ts:L46], so no regeneration could ever observe
 *    this plugin. The faithful substitute — which preserves exactly what AC-8 measures, namely that an
 *    exhaustive consumer switch stops compiling once the enum grows — is to widen the imported
 *    32-member enum with a plugin-local literal union of the four members the generator would derive.
 *    Consequently: `bun run codegen` must NOT be run for this file's benefit, and `schema-shop.json`
 *    must remain byte-identical. The imported enum is therefore the pristine 32-member Shop baseline
 *    and contains no `REORDER_*` member, which is precisely why the union below is needed.
 *
 * 4. THIS FILE IS NEVER IMPORTED, SO IT CANNOT BREAK THE BUILD OR ANY TEST RUN.
 *    It is imported by NEITHER `packages/reorder-plugin/index.ts`, NOR anything under
 *    `packages/reorder-plugin/src/`, NOR any specification — it has no importer at all, by design.
 *    The package build emits only what is reachable from the barrel, because
 *    `tsconfig.build.json` names `./index.ts` as its single `files` entry, following the shipped sibling
 *    [packages/harden-plugin/tsconfig.build.json:L6-L8]; so `bun run build`, `bun run ci` and the unit
 *    suite never type-check this file. The end-to-end runner does not collect it either: it matches
 *    `**\/*.e2e-spec.ts` only [e2e-common/vitest.config.mts:L7], and the `.fixture.ts` suffix is
 *    deliberately outside that pattern. This file must not be renamed to `*.e2e-spec.ts`.
 *
 * 5. NO JSDoc VERSION TAG, DELIBERATELY.
 *    Every new public API surface in this package carries a derived JSDoc "since" tag naming version
 *    3.8.0. This file is a compiler fixture rather than public API — it is unreachable from the package
 *    barrel and is never published — so it carries no version tag at all, and the literal tag is kept
 *    out of this comment so that no documentation tool mistakes the explanation for a declaration. The
 *    omission is deliberate rather than overlooked.
 *
 * 6. THE RELATIONSHIP TO THE CONTROL SIBLING, STATED PRECISELY.
 *    `error-code-defaulted.fixture.ts` is this file with the SAME import, the same type names, the same
 *    function name, the same case order and the same returned strings; the one difference is its final
 *    branch. AC-8 describes the pair as this file carrying "a `never`-typed exhaustiveness check in its
 *    final branch and no `default`" and the sibling as "identical but carrying a `default` branch", so
 *    the final branch is SWAPPED rather than merely appended to. That distinction is load-bearing and
 *    was verified with the pinned compiler: a control that kept this trailing `never` assignment AND
 *    added a `default` clause still exits non-zero, because TypeScript type-checks the now-unreachable
 *    trailing statement against the declared type of `code` rather than against a narrowed one. Such a
 *    control would isolate nothing. The control must therefore replace the two trailing lines with the
 *    `default` clause, leaving non-exhaustiveness as the single difference between the two exit statuses.
 */

// The enum is imported from the published `lib` entry point of the `@vendure/common` package. The
// repository's import guard rejects any reference to a workspace package's internal source tree in
// every `.ts` file under `packages/` — and it matches the whole file, not just import statements
// [scripts/check-imports.ts:L12-L16]. This is the SHOP catalogue and it must stay the Shop catalogue:
// the Admin catalogue publishes 47 members, and importing it instead would silently destroy the
// 32-to-36 arithmetic this fixture exists to evidence.
import { ErrorCode } from '@vendure/common/lib/generated-shop-types';

/**
 * The four members `ReorderPlugin` adds to the published Shop `ErrorCode` enum.
 *
 * Each is the upper-snake derivation of one of the four error-result object types the plugin declares
 * in its Shop API extensions — `ReorderListNotFoundError`, `ReorderListNameConflictError`,
 * `ReorderListLimitError` and `ReorderListLineNotFoundError` — produced by the platform's own
 * conversion of the declared type name [packages/core/src/api/config/generate-error-code-enum.ts:L31-L33].
 *
 * They are declared here as string literals rather than read from a generated enum for the reason
 * given in note 3 of the file header: the checked-in snapshot is never regenerated, so no generated
 * artefact in this repository will ever carry them.
 */
type ReorderErrorCode =
    | 'REORDER_LIST_NOT_FOUND_ERROR'
    | 'REORDER_LIST_NAME_CONFLICT_ERROR'
    | 'REORDER_LIST_LIMIT_ERROR'
    | 'REORDER_LIST_LINE_NOT_FOUND_ERROR';

/**
 * The Shop `ErrorCode` vocabulary a storefront faces once `ReorderPlugin` is registered.
 *
 * The arithmetic this fixture evidences: 32 published members + 4 plugin-declared members = 36. No
 * existing member is removed or renamed, so the widening is additive — and an additive widening is
 * still a breaking change for a consumer that switches exhaustively without a `default` branch, which
 * is exactly what the compile failure below demonstrates as a number rather than as a claim.
 */
type ShopErrorCodeWithReorder = ErrorCode | ReorderErrorCode;

/**
 * A representative storefront consumer: it maps a Shop `ErrorCode` to a short description, exhaustively
 * and without a `default` branch.
 *
 * Every arm references `ErrorCode.<MEMBER>` rather than a bare string literal, so that a renamed or
 * removed platform member breaks this fixture loudly instead of silently degrading it into a set of
 * unreachable string comparisons.
 *
 * @param code A published Shop error code, or one of the four this plugin adds.
 * @returns A short description of the supplied code.
 */
export function describeShopErrorCode(code: ShopErrorCodeWithReorder): string {
    switch (code) {
        case ErrorCode.ALREADY_LOGGED_IN_ERROR:
            return 'already logged in';
        case ErrorCode.COUPON_CODE_EXPIRED_ERROR:
            return 'coupon code expired';
        case ErrorCode.COUPON_CODE_INVALID_ERROR:
            return 'coupon code invalid';
        case ErrorCode.COUPON_CODE_LIMIT_ERROR:
            return 'coupon code usage limit reached';
        case ErrorCode.COUPON_REMOVED_DURING_CHECKOUT_ERROR:
            return 'coupon removed during checkout';
        case ErrorCode.EMAIL_ADDRESS_CONFLICT_ERROR:
            return 'email address already in use';
        case ErrorCode.GUEST_CHECKOUT_ERROR:
            return 'guest checkout not permitted';
        case ErrorCode.IDENTIFIER_CHANGE_TOKEN_EXPIRED_ERROR:
            return 'identifier change token expired';
        case ErrorCode.IDENTIFIER_CHANGE_TOKEN_INVALID_ERROR:
            return 'identifier change token invalid';
        case ErrorCode.INELIGIBLE_PAYMENT_METHOD_ERROR:
            return 'payment method ineligible';
        case ErrorCode.INELIGIBLE_SHIPPING_METHOD_ERROR:
            return 'shipping method ineligible';
        case ErrorCode.INSUFFICIENT_STOCK_ERROR:
            return 'insufficient stock';
        case ErrorCode.INVALID_CREDENTIALS_ERROR:
            return 'invalid credentials';
        case ErrorCode.MISSING_PASSWORD_ERROR:
            return 'password missing';
        case ErrorCode.NATIVE_AUTH_STRATEGY_ERROR:
            return 'native authentication strategy not configured';
        case ErrorCode.NEGATIVE_QUANTITY_ERROR:
            return 'negative quantity';
        case ErrorCode.NOT_VERIFIED_ERROR:
            return 'account not verified';
        case ErrorCode.NO_ACTIVE_ORDER_ERROR:
            return 'no active order';
        case ErrorCode.ORDER_INTERCEPTOR_ERROR:
            return 'an order interceptor refused the change';
        case ErrorCode.ORDER_LIMIT_ERROR:
            return 'order limit reached';
        case ErrorCode.ORDER_MODIFICATION_ERROR:
            return 'order cannot be modified';
        case ErrorCode.ORDER_PAYMENT_STATE_ERROR:
            return 'order is in the wrong payment state';
        case ErrorCode.ORDER_STATE_TRANSITION_ERROR:
            return 'order state transition refused';
        case ErrorCode.PASSWORD_ALREADY_SET_ERROR:
            return 'password already set';
        case ErrorCode.PASSWORD_RESET_TOKEN_EXPIRED_ERROR:
            return 'password reset token expired';
        case ErrorCode.PASSWORD_RESET_TOKEN_INVALID_ERROR:
            return 'password reset token invalid';
        case ErrorCode.PASSWORD_VALIDATION_ERROR:
            return 'password failed validation';
        case ErrorCode.PAYMENT_DECLINED_ERROR:
            return 'payment declined';
        case ErrorCode.PAYMENT_FAILED_ERROR:
            return 'payment failed';
        case ErrorCode.UNKNOWN_ERROR:
            return 'unknown error';
        case ErrorCode.VERIFICATION_TOKEN_EXPIRED_ERROR:
            return 'verification token expired';
        case ErrorCode.VERIFICATION_TOKEN_INVALID_ERROR:
            return 'verification token invalid';
    }
    // THE ASSERTION. `code` is `ReorderErrorCode` here, not `never`, so this assignment is refused with
    // TS2322 and the diagnostic names the four unhandled members. Do not add a `default` clause, a type
    // assertion or a suppression comment to silence it — any of those would relocate the failure and
    // destroy the evidence. The control that compiles cleanly is the sibling fixture, which replaces
    // these two lines with a `default` clause.
    const unhandled: never = code;
    return unhandled;
}
