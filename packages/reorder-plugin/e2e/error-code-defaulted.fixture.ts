/**
 * ERROR CODE FIXTURE PAIR — ONE HALF IS EXPECTED TO FAIL TYPE-CHECKING AND THE OTHER TO PASS.
 *
 * This header is BYTE-IDENTICAL in both halves of the pair, as is everything below it down to the
 * terminal branch of the switch. That identity is not tidiness, it is the control — note 1 explains why,
 * and states which half of the pair this file is.
 *
 * 1. WHICH HALF IS WHICH, WHAT EACH EXIT STATUS ASSERTS, AND WHY THE TWO FILES MUST STAY IDENTICAL.
 *    `error-code-exhaustive.fixture.ts` ends its switch WITHOUT a `default` clause and carries a
 *    `never`-typed assignment after it. It is asserted to exit NON-ZERO, and its compile error IS the
 *    assertion rather than a defect: nothing in it is to be "fixed", and a clean compile there is a
 *    REGRESSION, because it would mean the published Shop `ErrorCode` enum stopped growing when
 *    `ReorderPlugin` declared its four error results.
 *    `error-code-defaulted.fixture.ts` ends its switch WITH a returning `default` clause and carries no
 *    statement after it. It is asserted to exit ZERO. A failure there is a genuine defect and must be
 *    fixed — the exact opposite of the standing instruction on the exhaustive half.
 *    Neither status means anything on its own: a fixture can exit non-zero because of a typo, a bad
 *    import, a missing type or a stale enum just as easily as because of the gap under test. What makes
 *    the pair evidence rather than assertion is that the two files are the SAME FILE apart from that one
 *    terminal branch, so a zero on one side and a non-zero on the other localises the difference to
 *    exhaustiveness and to nothing else. Any drift above the terminal branch — a changed import, a
 *    renamed type, a reordered or reworded arm, even a differing comment — dissolves that isolation and
 *    lets the two statuses diverge for a reason nobody is measuring. The two halves are therefore kept
 *    byte-identical everywhere except that branch: a diff between them contains only the terminal region
 *    at the end of the function, and every line above it matches.
 *
 * 2. HOW THE PAIR IS COMPILED.
 *    The assertion is owned by `packages/reorder-plugin/e2e/reorder-list-read.e2e-spec.ts`. Each half is
 *    the single entry of its own compiler project — `tsconfig.error-code-exhaustive.json` and
 *    `tsconfig.error-code-defaulted.json`, both beside these files under `packages/reorder-plugin/e2e/` —
 *    each extending the repository root configuration so that `strict` is inherited rather than
 *    redeclared [tsconfig.json:L13], and each type-checked with the workspace's own pinned compiler
 *    [package.json:L64]. Two separate project-scoped runs are required because one invocation cannot
 *    produce two opposite exit statuses, and a bare `tsc --noEmit` would compile whatever the nearest
 *    ambient configuration happens to include rather than the single file its project names
 *    [tickets/EPIC-001/FEATURE-001-01/STORY-001-01-04-read-reorder-lists-via-shop-api.md:§5 AC-8].
 *
 * 3. WHY THE TWO TERMINAL BRANCHES PRODUCE OPPOSITE STATUSES, AND WHY THE BRANCH IS SWAPPED RATHER THAN
 *    APPENDED TO.
 *    The switch below carries exactly one `case` for each of the 32 `ErrorCode` members the Shop API
 *    publishes WITHOUT this plugin. The enum it switches over is not that 32-member baseline, though: it
 *    is GENERATED FROM THE LIVE SCHEMA OF A SERVER CARRYING THIS PLUGIN and therefore has 36 members —
 *    see note 5, which is where that generation is described. With no `default` clause those 32 arms
 *    handle none of the four members the plugin's SDL added, so after the switch the narrowed type of
 *    `code` is those four members rather than `never` and the trailing `never`-typed assignment is refused
 *    with TS2322 — a diagnostic that prints the unhandled members BY NAME, which is what distinguishes the
 *    failure under test from an unrelated compile error. With a `default` clause those same four members
 *    are handled, nothing is left unhandled, and there is nothing for the compiler to refuse.
 *    AC-8 describes the exhaustive half as carrying "a `never`-typed exhaustiveness check in its final
 *    branch and no `default`" and the defaulted half as "identical but carrying a `default` branch", so
 *    what differs between them is the FINAL BRANCH ITSELF. Adding a `default` clause while retaining the
 *    trailing assignment does not produce the defaulted half: with a returning `default` present the
 *    statement after the switch is unreachable, and
 *    TypeScript type-checks unreachable code against the DECLARED type of the subject rather than against
 *    a narrowed one, so `const unhandled: never = code;` is refused with TS2322 naming the whole declared
 *    union — and a project electing `allowUnreachableCode: false` would additionally raise TS7027. A
 *    control shaped that way would exit non-zero for a reason having nothing to do with exhaustiveness
 *    and would isolate nothing, defeating the only purpose the pair has. The swap is consequently the
 *    minimal faithful reading of AC-8 and not a liberty taken with it. Restoring the trailing check to
 *    the defaulted half so that the two files match line-for-line destroys the evidence: the one
 *    difference between them is deliberate, and it is the only one permitted.
 *
 * 4. WHY THE ENUM GROWS AT ALL, AND WHY THAT CANNOT BE OPTED OUT OF.
 *    The enum's members are derived from every object type implementing the `ErrorResult` interface
 *    [packages/core/src/api/config/generate-error-code-enum.ts:L9], matched by a filter over each type's
 *    declared interfaces [packages/core/src/api/config/generate-error-code-enum.ts:L17], and
 *    upper-snake-cased [packages/core/src/api/config/generate-error-code-enum.ts:L31-L33]. The four
 *    declarations that widen it live in `packages/reorder-plugin/src/api/api-extensions.ts`. The
 *    defaulted half is what a storefront consumer is supposed to look like, and the ruling that requires
 *    it is explicit that every consuming example carries a default branch
 *    [tickets/EPIC-001-reorder-and-replenishment.md:§6.4 The Settled Rulings, R9].
 *
 * 5. WHERE THE ENUM COMES FROM: ISOLATED GENERATION FROM THE LIVE, PLUGIN-CARRYING SCHEMA.
 *    AC-8 requires both halves to compile "against types regenerated from the rebuilt schema by the
 *    repository's own generator"
 *    [tickets/EPIC-001/FEATURE-001-01/STORY-001-01-04-read-reorder-lists-via-shop-api.md:§5 AC-8], and
 *    that is what happens. Before either project is compiled, the specification that owns this pair
 *    introspects the SHOP API OF THE RUNNING SERVER IT BOOTED — a server carrying `ReorderPlugin` — with
 *    the same `getIntrospectionQuery({ inputValueDeprecation: true })` the repository's own download step
 *    uses [scripts/codegen/download-introspection-schema.ts:L71], and hands the result to the same
 *    `@graphql-codegen/cli` `generate()` entry point under the same plugin list and the same
 *    configuration the repository declares for `packages/common/src/generated-shop-types.ts`
 *    [scripts/codegen/generate-graphql-types.ts:L92-L102]. The output is written to
 *    `.generated/shop-error-codes.ts` at the package root, which is the module imported below. It sits
 *    outside `e2e/` because `e2e-common/test-config.ts` derives each suite's port from the index of its
 *    file in that directory, so a generated entry appearing there shifts ports and collides servers.
 *
 *    Two things are deliberately NOT done, and both are boundary conditions rather than preferences. The
 *    `bun run codegen` script itself is not invoked, because it writes the checked-in `schema-shop.json`
 *    and `packages/common/src/generated-shop-types.ts`, and neither may be edited or regenerated (AAP
 *    §0.4.1.5) — the snapshot is also structurally incapable of carrying this plugin, since the script
 *    that produces it declares its own configuration with `plugins: [AdminUiPlugin]` and never imports a
 *    plugin's [scripts/codegen/download-introspection-schema.ts:L46]. And nothing here declares the four
 *    added members. Widening the imported 32-member baseline with a plugin-local literal union spelling
 *    them out would make the exhaustive half's failure evidence of that local declaration rather than of
 *    the schema's growth — a fixture asserting its own premise. The members below arrive only because the
 *    live schema published them.
 *
 *    Consequently the generated module is a BUILD PRODUCT of the specification run: it is written before
 *    the two compilations and removed after them, it is git-ignored, and neither half of this pair can be
 *    type-checked outside that window. That is intended — the provenance of the enum is the evidence, so
 *    a copy of it checked in beside these files would defeat the purpose.
 *
 * 6. NEITHER HALF IS EVER IMPORTED, SO NEITHER CAN BREAK THE BUILD OR ANY TEST RUN.
 *    Neither file is imported by `packages/reorder-plugin/index.ts`, nor by anything under
 *    `packages/reorder-plugin/src/`, nor by any specification — they have no importer at all, by design.
 *    The package build emits only what is reachable from its two declared roots — `tsconfig.build.json`
 *    names `./index.ts`, the barrel, and the one migration under `src/migrations/`, which the manifest's
 *    `files` entry publishes and a deployment may register by glob — and neither half of this pair is
 *    reachable from either, so `bun run build`, `bun run ci` and the unit suite never type-check them. The end-to-end runner does not collect them either: it matches
 *    `**\/*.e2e-spec.ts` only [e2e-common/vitest.config.mts:L7], and the `.fixture.ts` suffix is
 *    deliberately outside that pattern. Neither file may be renamed to `*.e2e-spec.ts`. Each half's exit
 *    status is asserted by the specification that names its project rather than by being reachable from
 *    anything the build compiles, so deleting a project file would silently retire half the evidence.
 *
 * 7. NO JSDoc VERSION TAG, DELIBERATELY.
 *    Every new public API surface in this package carries a derived JSDoc "since" tag naming version
 *    3.8.0. These two files are compiler fixtures rather than public API — unreachable from the package
 *    barrel and never published — so they carry no version tag at all, and the literal tag is kept out of
 *    this comment so that no documentation tool mistakes the explanation for a declaration. The omission
 *    is deliberate rather than overlooked.
 */

/*
 * The enum is imported from the module GENERATED FROM THE LIVE SHOP SCHEMA of a server carrying this
 * plugin — see note 5 of the shared header for how and when it is produced. It is the SHOP catalogue and
 * it must stay the Shop catalogue: the Admin catalogue publishes 47 members, and generating from the Admin
 * schema instead would silently destroy the 32-to-36 arithmetic this pair exists to evidence.
 *
 * The relative specifier is what keeps the two compiler projects honest. Each project names one of these
 * fixtures as its single `files` entry, and TypeScript follows this import to the generated module, so the
 * enum under test is the generated one and there is no ambient path mapping that could quietly substitute
 * another. The specifier also cannot reach into a workspace package's internal source tree, which the
 * repository's import guard rejects in every `.ts` file under `packages/` — and it matches the whole file,
 * not just import statements [scripts/check-imports.ts:L12-L16].
 */
import { ErrorCode } from '../.generated/shop-error-codes';

/*
 * THE ARITHMETIC THE PAIR EVIDENCES, and where each half of it comes from. The imported enum carries 36
 * members: the 32 the Shop API publishes without this plugin, plus the four upper-snake derivations of the
 * error-result object types the plugin's SDL declares — `ReorderListNotFoundError`,
 * `ReorderListNameConflictError`, `ReorderListLimitError` and `ReorderListLineNotFoundError` — produced by
 * the platform's own conversion of each declared type name
 * [packages/core/src/api/config/generate-error-code-enum.ts:L31-L33]. Nothing in this file names those four
 * members, and nothing in it widens the enum: they are in scope only because the live schema published them,
 * which is what makes 32-to-36 a measurement rather than a restatement. The specification that owns this
 * pair asserts the count and the membership of the generated enum directly, before compiling either project.
 *
 * No existing member is removed or renamed, so the widening is additive — and an additive widening is still
 * a breaking change for a consumer that switches exhaustively without a `default` branch, while being
 * survivable for one that carries a `default`. That is precisely the difference the pair's two exit statuses
 * isolate.
 */

/**
 * A representative storefront consumer: it maps a Shop `ErrorCode` to a short description through a
 * single `switch` carrying one arm per published member, terminated by the branch that differs between
 * the two halves of the pair — see note 1 of the shared header for which half this file is.
 *
 * Every arm references `ErrorCode.<MEMBER>` rather than a bare string literal, so that a renamed or
 * removed platform member breaks both halves loudly instead of silently degrading them into a set of
 * unreachable string comparisons.
 *
 * @param code A published Shop error code, taken from the generated enum — which includes the four this
 * plugin adds.
 * @returns A short description of the supplied code. In the defaulted half a code with no arm of its own
 * is described generically, which is what makes that consumer forward-compatible as the enum grows; in
 * the exhaustive half every member the enum admits must have an arm of its own, which is exactly what the
 * four added members make impossible.
 */
export function describeShopErrorCode(code: ErrorCode): string {
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
        // THE ASSERTION, DEFAULTED HALF. This clause absorbs the four members this plugin adds — and any
        // member a later feature adds — so the widened union is fully handled and the compile is clean. It
        // REPLACES the exhaustive half's two trailing statements rather than sitting alongside them, so do
        // not add a statement after this switch. This branch, and nothing above it, is what differs from
        // `error-code-exhaustive.fixture.ts` — see notes 1 and 3 of the shared header.
        default:
            return 'unrecognised error code';
    }
}
