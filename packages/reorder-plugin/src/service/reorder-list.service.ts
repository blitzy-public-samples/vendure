/*
 * -------------------------------------------------------------------------------------------------------
 * The reorder list service — provenance, and the one property that makes it correct.
 * -------------------------------------------------------------------------------------------------------
 * Attribution. No user-specified rules were provided for this project: the rules document was read and
 * returned exactly that, and EPIC-001 reaches the same finding independently in its own section 11.9.
 * Nothing in this file is, or derives from, a user-specified rule. Every constraint stated below traces to
 * FEATURE-001-01 (sections 2.5 to 2.12), to one of STORY-001-01-01 through STORY-001-01-04, to an EPIC-001
 * settled ruling (R1, R2, R3, R8, R13, R14, R17, R19, R22), or to a cited line of this repository, and is
 * attributed as such wherever it is stated. The absence of a rules document has not been treated as licence
 * to lower the bar anywhere in this file.
 *
 * WHAT THIS FILE IS. It holds *every* read and write for `reorder_list` and `reorder_list_line`, which is a
 * deliberate structural choice rather than an accident of layering: the ownership rule below then has
 * exactly one implementation to review, and a second code path cannot disagree with it.
 *
 * THE ONE PROPERTY THAT MAKES IT CORRECT. `@Allow(Permission.Owner)` on the resolvers is NOT the access
 * control — the ownership-and-channel predicate in this file is. `Permission.Owner` is declared
 * `assignable: false, internal: true` (the `Owner` PermissionDefinition inside `DEFAULT_PERMISSIONS`,
 * `packages/core/src/common/constants.ts` L27-L32), so no session ever holds it; the guard merely marks the
 * request context `authorizedAsOwnerOnly` and then admits the request. The platform states the consequence
 * in its own source: a resolver using that permission *must* include owner-enforcing logic, or the effect is
 * the same as public access. Identifiers are sequential under the default id strategy, so the predicate —
 * and not an unguessable id — is what protects one buyer's data from another's.
 *
 * THREE SHAPES IN HERE LOOK LIKE STYLE AND ARE NOT. Each is load-bearing and each is easy to "tidy" into a
 * defect:
 *
 * 1. Ownership conjuncts are composed into the SAME `WHERE` clause as the row lookup, never applied to an
 *    already-loaded row. `findOne({ where: { id } })` followed by an in-memory check reads the row it was
 *    supposed to refuse — a row in process memory can reach a log line, an error message or a timing
 *    difference — and it passes every response-shaped assertion while doing so. The instrumented contract
 *    this satisfies is: exactly one statement against the addressed table, its predicate carrying the acting
 *    customer and the active channel alongside the row's own identifier, and exactly zero rows returned.
 * 2. Counters and quantities are changed by conditional statements whose affected-row count is read as the
 *    authority, never by read-compute-save. Read-compute-save cannot distinguish "applied" from "matched
 *    nothing", and on a counter it silently loses one of two concurrent writes.
 * 3. The deterministic sort tie-break is APPENDED to a caller-supplied sort rather than substituted for it.
 *    The mechanism is the platform's own `Object.assign({}, options.sort, extendedOptions.orderBy)`
 *    (`packages/core/src/service/helpers/list-query-builder/list-query-builder.ts` L309), so keys handed
 *    through `extendedOptions.orderBy` land last — which is literally what "appended" means here. Nothing
 *    else in the builder can append.
 *
 * WHAT IS DELIBERATELY ABSENT, so that each absence reads as a ruling rather than as an omission. There is
 * no scheduled task, no event class, no job-queue handler and no configurable strategy; no retention,
 * anonymisation or purge behaviour of any kind, the customer-data-lifecycle pass belonging to a later batch,
 * with the consequence stated plainly that a *soft*-deleted customer's list rows persist; no fifth error
 * result, because a malformed quantity is a bad request rather than a business outcome; no idempotency key,
 * claim column or request fingerprint, the add operation's delivery guarantee being at-least-once and the
 * absolute-set adjust operation being the remedy; no custom field on any core entity; no monetary value and
 * no stock state; and no service-level, latency, throughput, conversion or revenue figure anywhere,
 * including in these comments.
 *
 * WHY THE FOUR ERROR RESULTS BELOW EXTEND NOTHING. The platform's `TranslateErrorResultInterceptor` rewrites
 * an error result's `message` by looking up `errorResult.<message>` in the i18n catalogue, but it does so
 * only for instances of core's own generated `ErrorResult` base classes
 * (`packages/core/src/api/middleware/translate-error-result-interceptor.ts`), and the Shop-side base is not
 * exported from the `@vendure/core` package root at all. These four classes therefore extend neither base
 * and carry a finished English sentence, which passes through untouched. Carrying a message *key* here would
 * be the defect: this plugin's translation bundle registers exactly four keys and none of them describes an
 * error result, so the lookup would miss and the caller would read raw key text.
 *
 * The `@since 3.8.0` tags below are a derivation and are flagged as one. The contribution guide requires new
 * public API to carry a `@since` tag naming what will be the next minor version, and its own literal example
 * names a different version. This checkout declares 3.7.0, so the next minor derives to 3.8.0. That string
 * appears nowhere in this repository and is therefore not a quotation from it.
 * -------------------------------------------------------------------------------------------------------
 */

import { Inject, Injectable } from '@nestjs/common';
import { DeletionResponse, DeletionResult } from '@vendure/common/lib/generated-types';
import { PaginatedList } from '@vendure/common/lib/shared-types';
import {
    Customer,
    ForbiddenError,
    ID,
    InternalServerError,
    ListQueryBuilder,
    ListQueryOptions,
    Logger,
    ProductVariantService,
    RequestContext,
    TransactionalConnection,
    UserInputError,
} from '@vendure/core';
import { In } from 'typeorm';

import { loggerCtx, REORDER_PLUGIN_OPTIONS } from '../constants';
import { ReorderListLine } from '../entities/reorder-list-line.entity';
import { ReorderList } from '../entities/reorder-list.entity';
import { ReorderPluginOptions } from '../types';

import { canonicaliseReorderListName } from './reorder-list-name';

/**
 * The declared default for each plugin option, applied where a deployment supplies no value.
 *
 * These duplicate no validation. `ReorderPlugin.init()` validates every supplied value once, at plugin
 * initialisation, and merges the same declared defaults for the keys a deployment omits — so by the time this
 * service reads an option the value is either a validated integer or absent. The fallbacks below exist purely
 * so that every member of the options interface being optional does not make this class partial under
 * `strict`: an option resolving to `undefined` here would turn a bound into `NaN` comparisons, which is the
 * one failure mode worse than a wrong bound because nothing reports it.
 */
const DEFAULT_MAX_LISTS_PER_CUSTOMER = 25;
const DEFAULT_MAX_LINES_PER_LIST = 200;
const DEFAULT_MAX_QUANTITY_PER_LINE = 999;
const DEFAULT_REORDER_LISTS_PAGE_SIZE = 25;
const DEFAULT_REORDER_LIST_LINES_PAGE_SIZE = 50;

/**
 * The ONE database constraint name this service translates into a buyer-visible outcome.
 *
 * The match is narrow by requirement rather than by caution. `reorder_list_line` carries its own uniqueness
 * constraint, `UQ_reorder_list_line_list_variant`, and mapping "any unique-violation code" would report a
 * duplicate *line* as a duplicate *name* — a wrong answer that reads like a right one. The two constraints
 * are separate and are named separately, so the translation matches this name and nothing else.
 */
const NAME_CONFLICT_CONSTRAINT = 'UQ_reorder_list_customer_channel_name_key';

/**
 * The plugin-owned message keys this service raises, spelled exactly as the translation bundle registers
 * them. An unregistered key surfaces to the caller as the key text itself, so these three strings and the
 * bundle's own contents must agree; declaring them once here is what keeps that agreement checkable.
 *
 * There is deliberately no fourth key for a fifth failure mode: the bundle registers four keys in total, one
 * of which belongs to name canonicalisation and is raised by that module rather than by this one.
 */
const QUANTITY_MUST_BE_POSITIVE_KEY = 'error.reorder-list-line-quantity-must-be-positive';
const QUANTITY_ABOVE_MAXIMUM_KEY = 'error.reorder-list-line-quantity-above-maximum';
const VARIANT_NOT_FOUND_KEY = 'error.reorder-list-variant-not-found';

/**
 * The interpolation variable names the two interpolating messages carry. A mismatch here is not a compile
 * error and would surface only as an unsubstituted token in a message a buyer reads, which is why the names
 * are declared rather than written inline at each call site.
 */
const MAX_VARIABLE = 'max';
const ID_VARIABLE = 'id';

/**
 * The database engines against which a pessimistic row lock is both available and necessary, matching the
 * platform's own engine test in its shipped scheduler strategy
 * (`packages/core/src/plugin/default-scheduler-plugin/default-scheduler-strategy.ts` L278-L279).
 *
 * The SQLite family is absent for a reason that is a property of the driver rather than an optimism: the
 * in-process WebAssembly engine the test harness ships serves a single connection, so two transactions there
 * cannot interleave and a count-and-insert inside one transaction is sufficient on its own. Asking that
 * driver for a lock raises rather than degrades, so the branch is required and is not a micro-optimisation.
 */
const ENGINES_SUPPORTING_PESSIMISTIC_LOCKING: string[] = ['postgres', 'mysql', 'mariadb'];

/**
 * The generic, driver-free message a database failure this service cannot classify is re-raised with.
 *
 * A driver message can carry the schema, the column list, a SQL fragment and sometimes the conflicting
 * values, and a buyer-facing response is not a place to put any of them. The original is logged at error
 * level against the plugin's logger context instead, so the detail is retained server-side and is never
 * leaked, and nothing is ever swallowed.
 */
const UNCLASSIFIED_WRITE_FAILURE_MESSAGE = 'The reorder list could not be saved';

/**
 * @description
 * Input to {@link ReorderListService.createReorderList}, mirroring the published
 * `CreateReorderListInput` field for field.
 *
 * @docsCategory core plugins/ReorderPlugin
 * @docsPage ReorderListService
 * @since 3.8.0
 */
export interface CreateReorderListInput {
    /**
     * @description
     * The buyer-supplied list name. Canonicalised — trimmed, internal whitespace runs collapsed — before it
     * is stored, and refused as malformed input when its canonical form is empty, is longer than the fixed
     * bound, or carries a control or zero-width character. It is never truncated and never silently altered.
     *
     * @since 3.8.0
     */
    name: string;
}

/**
 * @description
 * Input to {@link ReorderListService.updateReorderList}, mirroring the published
 * `UpdateReorderListInput` field for field. The operation renames a list and touches nothing else: no line
 * row is read and none is written.
 *
 * @docsCategory core plugins/ReorderPlugin
 * @docsPage ReorderListService
 * @since 3.8.0
 */
export interface UpdateReorderListInput {
    /**
     * @description
     * The identifier of the list to rename. Addressed together with the acting customer and the active
     * channel, so an identifier the caller does not own resolves to `ReorderListNotFoundError` rather than
     * to another buyer's row.
     *
     * @since 3.8.0
     */
    id: ID;

    /**
     * @description
     * The new name, subject to the identical canonicalisation and the identical uniqueness rule that governs
     * creation — so a rename can return `ReorderListNameConflictError`, and a blank rename is refused as
     * malformed input rather than stored.
     *
     * @since 3.8.0
     */
    name: string;
}

/**
 * @description
 * Input to {@link ReorderListService.addItemToReorderList}, mirroring the published
 * `AddItemToReorderListInput` field for field.
 *
 * **It declares exactly three fields, and the absence of a fourth is a ruling rather than an omission.**
 * There is no idempotency key and no request fingerprint, because a replay guarantee needs a durable
 * claim-and-response record and this plugin owns no row in which one could be kept. A published argument
 * with no store behind it would advertise a guarantee that cannot be kept, which is worse than making no
 * guarantee at all. The delivery guarantee is therefore at-least-once, stated plainly: two deliveries of one
 * add accumulate, and {@link ReorderListService.adjustReorderListLine} — which sets an absolute quantity
 * rather than adding to one — is the deterministic remedy.
 *
 * @docsCategory core plugins/ReorderPlugin
 * @docsPage ReorderListService
 * @since 3.8.0
 */
export interface AddItemToReorderListInput {
    /**
     * @description
     * The identifier of the list to add to.
     *
     * @since 3.8.0
     */
    reorderListId: ID;

    /**
     * @description
     * The identifier of the variant to add. Resolved in the active channel; an identifier that does not
     * resolve there is refused as malformed input.
     *
     * @since 3.8.0
     */
    productVariantId: ID;

    /**
     * @description
     * The quantity to add. A positive integer, and it is an *increment* on this operation: where the variant
     * is already on the list the value is added to the existing line's quantity, and the configured maximum
     * is applied to the resulting total rather than to this increment.
     *
     * @since 3.8.0
     */
    quantity: number;
}

/**
 * @description
 * Input to {@link ReorderListService.adjustReorderListLine}, mirroring the published
 * `AdjustReorderListLineInput` field for field.
 *
 * @docsCategory core plugins/ReorderPlugin
 * @docsPage ReorderListService
 * @since 3.8.0
 */
export interface AdjustReorderListLineInput {
    /**
     * @description
     * The identifier of the list the line belongs to. Resolved under the ownership predicate first, which is
     * what distinguishes `ReorderListNotFoundError` from `ReorderListLineNotFoundError`.
     *
     * @since 3.8.0
     */
    reorderListId: ID;

    /**
     * @description
     * The identifier of the line to adjust.
     *
     * @since 3.8.0
     */
    lineId: ID;

    /**
     * @description
     * The quantity to set. An ABSOLUTE value rather than an increment, which is what makes this operation
     * idempotent by construction: repeating the call any number of times leaves the same stored value.
     *
     * @since 3.8.0
     */
    quantity: number;
}

/**
 * @description
 * Input to {@link ReorderListService.removeReorderListLine}, mirroring the published
 * `RemoveReorderListLineInput` field for field.
 *
 * @docsCategory core plugins/ReorderPlugin
 * @docsPage ReorderListService
 * @since 3.8.0
 */
export interface RemoveReorderListLineInput {
    /**
     * @description
     * The identifier of the list the line belongs to.
     *
     * @since 3.8.0
     */
    reorderListId: ID;

    /**
     * @description
     * The identifier of the line to remove. A second remove of the same line is refused with
     * `ReorderListLineNotFoundError` rather than reported as a success.
     *
     * @since 3.8.0
     */
    lineId: ID;
}

/**
 * @description
 * Whether the caller reached a list by owning it or through a grant, mirroring the published
 * `ReorderListAccess` enum. `SHARED` is declared because the published enum declares it and a non-null field
 * references it; nothing in this plugin returns it yet, sharing arriving with a later feature.
 *
 * @docsCategory core plugins/ReorderPlugin
 * @docsPage ReorderListService
 * @since 3.8.0
 */
export type ReorderListAccess = 'OWNED' | 'SHARED';

/**
 * @description
 * A capability a grant may confer on a shared list, mirroring the published `ReorderListCapability` enum.
 * Declared because the published enum declares it; the collection that carries it is always empty here.
 *
 * @docsCategory core plugins/ReorderPlugin
 * @docsPage ReorderListService
 * @since 3.8.0
 */
export type ReorderListCapability = 'READ' | 'APPLY_TO_ORDER';

/**
 * @description
 * The per-requester provenance of a returned list, mirroring the published `ReorderListViewerAccess` object
 * type. It is nested under an object type rather than sitting as bare scalars on the list type precisely
 * because it is per-requester: a value that varies by caller may not enter the generated sort and filter
 * inputs, which are built from the row type's own scalar fields.
 *
 * @docsCategory core plugins/ReorderPlugin
 * @docsPage ReorderListService
 * @since 3.8.0
 */
export interface ReorderListViewerAccess {
    /**
     * @description
     * How the caller reached this list.
     *
     * @since 3.8.0
     */
    access: ReorderListAccess;

    /**
     * @description
     * The capabilities a grant conferred. Non-empty only where {@link ReorderListViewerAccess.access} is
     * `SHARED`, so always empty while no share row can exist.
     *
     * @since 3.8.0
     */
    grantedCapabilities: ReorderListCapability[];
}

/**
 * @description
 * Returned when a reorder list addressed by id is absent, owned by another customer, in another channel, or
 * not shared with the caller.
 *
 * **One result for all four cases, deliberately.** Under the platform's default id strategy identifiers are
 * sequential and therefore guessable, so distinguishing "no such list" from "not yours" would confirm the
 * existence of another buyer's row to anyone who counts. Reporting one indistinguishable outcome for every
 * inaccessible case discloses nothing.
 *
 * This result belongs to *mutations* only. A single-list read answers `null` for every inaccessible case
 * instead, because a caller who asked to write needs a reason and a caller who asked to read does not.
 *
 * @docsCategory core plugins/ReorderPlugin
 * @docsPage ReorderListService
 * @since 3.8.0
 */
export class ReorderListNotFoundError {
    /**
     * @description
     * The GraphQL type name. Required rather than decorative: the union type resolvers discriminate on it,
     * and the platform's own error-result predicate treats a value without it as not an error result at all.
     *
     * @since 3.8.0
     */
    readonly __typename = 'ReorderListNotFoundError';

    /**
     * @description
     * The stable, machine-readable code, being the upper-snake form of the type name — the convention every
     * shipped error result follows, and the member this declaration contributes to the published `ErrorCode`
     * enum.
     *
     * @since 3.8.0
     */
    readonly errorCode = 'REORDER_LIST_NOT_FOUND_ERROR';

    /**
     * @description
     * A finished English sentence rather than a message key, and carrying no driver text, no SQL fragment and
     * no constraint name.
     *
     * @since 3.8.0
     */
    readonly message = 'The requested reorder list could not be found';
}

/**
 * @description
 * Returned when the canonical form of a supplied list name is already held by this customer in this channel.
 *
 * The authority for the collision is the named database constraint over `(customerId, channelId, nameKey)`
 * and never a service pre-check alone: two concurrent creates may both read before either writes, so a
 * pre-check produces a friendlier message on the ordinary path while the constraint is what makes the rule
 * unbypassable. Both paths produce this same result.
 *
 * @docsCategory core plugins/ReorderPlugin
 * @docsPage ReorderListService
 * @since 3.8.0
 */
export class ReorderListNameConflictError {
    /**
     * @description
     * The GraphQL type name, discriminating this member of the two unions that carry it.
     *
     * @since 3.8.0
     */
    readonly __typename = 'ReorderListNameConflictError';

    /**
     * @description
     * The stable, machine-readable code.
     *
     * @since 3.8.0
     */
    readonly errorCode = 'REORDER_LIST_NAME_CONFLICT_ERROR';

    /**
     * @description
     * A finished English sentence, carrying no driver text, no SQL fragment and no constraint name — the
     * constraint's name is an implementation detail of the schema and is never reported to a caller.
     *
     * @since 3.8.0
     */
    readonly message = 'A reorder list with this name already exists';

    /**
     * @description
     * The canonical `nameKey` that collided.
     *
     * It echoes the caller's own input and discloses no other row: it is computed from the name the caller
     * submitted, so a client can explain precisely what collided without this field ever revealing anything
     * about the list that already holds it.
     *
     * @since 3.8.0
     */
    readonly conflictingNameKey: string;

    constructor(conflictingNameKey: string) {
        this.conflictingNameKey = conflictingNameKey;
    }
}

/**
 * @description
 * Returned when a write would take a customer over their maximum number of lists, or a list over its maximum
 * number of lines.
 *
 * Neither bound is enforced by a count-then-insert check, because that loses the race: two concurrent
 * requests both read a count below the maximum and both insert. The list bound is enforced by counting and
 * inserting inside one transaction under a row lock on the owning customer, and the line bound by a single
 * conditional counter update whose affected-row count decides — so no interleaving admits an extra row.
 *
 * @docsCategory core plugins/ReorderPlugin
 * @docsPage ReorderListService
 * @since 3.8.0
 */
export class ReorderListLimitError {
    /**
     * @description
     * The GraphQL type name, discriminating this member of the two unions that carry it.
     *
     * @since 3.8.0
     */
    readonly __typename = 'ReorderListLimitError';

    /**
     * @description
     * The stable, machine-readable code.
     *
     * @since 3.8.0
     */
    readonly errorCode = 'REORDER_LIST_LIMIT_ERROR';

    /**
     * @description
     * A finished English sentence. It states the kind of bound rather than its value, because the value is
     * carried as data in {@link ReorderListLimitError.maxItems} where a client can act on it without parsing
     * prose.
     *
     * @since 3.8.0
     */
    readonly message = 'This reorder list operation would exceed the configured maximum';

    /**
     * @description
     * The breached maximum, in the same shape the platform's own order-level limit error carries its own — so
     * a client can state the actual bound in a message rather than guessing at it.
     *
     * @since 3.8.0
     */
    readonly maxItems: number;

    constructor(maxItems: number) {
        this.maxItems = maxItems;
    }
}

/**
 * @description
 * Returned when a line addressed by id is absent from the addressed list.
 *
 * Reaching this result means the *list* resolved under the ownership predicate and the line did not exist
 * within it. That two-step is exactly what distinguishes it from {@link ReorderListNotFoundError}, and it is
 * also how a second remove of the same line is refused rather than reported as a success.
 *
 * @docsCategory core plugins/ReorderPlugin
 * @docsPage ReorderListService
 * @since 3.8.0
 */
export class ReorderListLineNotFoundError {
    /**
     * @description
     * The GraphQL type name, discriminating this member of the two unions that carry it.
     *
     * @since 3.8.0
     */
    readonly __typename = 'ReorderListLineNotFoundError';

    /**
     * @description
     * The stable, machine-readable code.
     *
     * @since 3.8.0
     */
    readonly errorCode = 'REORDER_LIST_LINE_NOT_FOUND_ERROR';

    /**
     * @description
     * A finished English sentence, carrying no driver text and no SQL fragment.
     *
     * @since 3.8.0
     */
    readonly message = 'The requested reorder list line could not be found';
}

/**
 * @description
 * Result of {@link ReorderListService.createReorderList}.
 *
 * Per-operation membership is exact. A client can code against this union knowing that creation cannot
 * produce a line-level or not-found outcome, which "any of the four error results" would never have told it.
 *
 * @docsCategory core plugins/ReorderPlugin
 * @docsPage ReorderListService
 * @since 3.8.0
 */
export type CreateReorderListResult = ReorderList | ReorderListNameConflictError | ReorderListLimitError;

/**
 * @description
 * Result of {@link ReorderListService.updateReorderList}. It carries the name conflict because a rename
 * writes a name, and the not-found result because it addresses an existing row.
 *
 * @docsCategory core plugins/ReorderPlugin
 * @docsPage ReorderListService
 * @since 3.8.0
 */
export type UpdateReorderListResult = ReorderList | ReorderListNotFoundError | ReorderListNameConflictError;

/**
 * @description
 * Result of {@link ReorderListService.deleteReorderList}.
 *
 * The success member is the platform's existing `DeletionResponse`, reused verbatim rather than replaced by a
 * plugin-owned deletion payload — its `result` and nullable `message` are exactly what a deletion has to
 * report.
 *
 * @docsCategory core plugins/ReorderPlugin
 * @docsPage ReorderListService
 * @since 3.8.0
 */
export type DeleteReorderListResult = DeletionResponse | ReorderListNotFoundError;

/**
 * @description
 * Result of {@link ReorderListService.addItemToReorderList}. It carries the limit result because an add can
 * breach the line bound, and deliberately carries no line-level not-found result: an add either accumulates
 * onto an existing line or creates one, so there is no line it can fail to find.
 *
 * @docsCategory core plugins/ReorderPlugin
 * @docsPage ReorderListService
 * @since 3.8.0
 */
export type AddItemToReorderListResult = ReorderList | ReorderListNotFoundError | ReorderListLimitError;

/**
 * @description
 * Result of {@link ReorderListService.adjustReorderListLine}. It carries no limit result, because changing a
 * quantity on a line that already exists cannot breach a line-count bound.
 *
 * @docsCategory core plugins/ReorderPlugin
 * @docsPage ReorderListService
 * @since 3.8.0
 */
export type AdjustReorderListLineResult =
    | ReorderList
    | ReorderListNotFoundError
    | ReorderListLineNotFoundError;

/**
 * @description
 * Result of {@link ReorderListService.removeReorderListLine}.
 *
 * @docsCategory core plugins/ReorderPlugin
 * @docsPage ReorderListService
 * @since 3.8.0
 */
export type RemoveReorderListLineResult =
    | ReorderList
    | ReorderListNotFoundError
    | ReorderListLineNotFoundError;

/**
 * The customer-and-channel scope every operation in this service is evaluated against.
 *
 * It is resolved once per operation from the authenticated session and the request's active channel, and it
 * is never assembled from a caller-supplied argument — which is what makes "the caller cannot nominate a
 * different owner" a structural property rather than a validation rule.
 */
interface ReorderListOwnerScope {
    customerId: ID;
    channelId: ID;
}

/**
 * The window a nested page of lines resolves to, after the platform's builder has validated and clamped the
 * caller's request. Held as a value so that one batched statement can serve every parent on a page and each
 * parent's own window can then be taken from the partitioned result.
 */
interface ResolvedLinesWindow {
    take: number;
    skip: number;
}

/**
 * The ordering keys appended to a collection read's sort. Both members are optional because what gets
 * appended depends on what the caller already asked for: everything when they asked for nothing, the
 * identifier alone when they sorted by something else, and nothing at all when they already sorted by the
 * identifier.
 */
type AppendedReorderListOrder = { createdAt?: 'DESC'; id?: 'DESC' };

/** The line-collection counterpart of {@link AppendedReorderListOrder}, ascending rather than descending. */
type AppendedReorderListLineOrder = { createdAt?: 'ASC'; id?: 'ASC' };

/**
 * @description
 * Holds every read and write for the `reorder_list` and `reorder_list_line` tables: the two paginated Shop
 * reads, the six Shop mutations, and the three support members the entity field resolvers call.
 *
 * **The ownership-and-channel predicate in this class is the access control for all eight operations.** The
 * `@Allow(Permission.Owner)` decorator on the resolvers is not: that permission is declared unassignable and
 * internal, so no session holds it and the guard merely marks the request context and admits it. Every
 * operation below therefore resolves the acting customer from the authenticated session, composes that
 * customer and the request's active channel into the same `WHERE` clause as the row it addresses, and treats
 * the resulting row count as the authority on what happened.
 *
 * The two conventions the platform's shipped saved-list plugin establishes are followed exactly, and they
 * differ from each other on purpose. A **read** whose guard fails returns an empty page or `null`, never an
 * error, which is what makes a single-list read non-enumerable. A **write** whose guard fails lets
 * `ForbiddenError` propagate, so the caller observes one top-level error entry carrying the code `FORBIDDEN`
 * with the operation's own field null.
 *
 * @example
 * ```ts
 * \@Resolver()
 * export class ReorderListShopResolver {
 *     constructor(private reorderListService: ReorderListService) {}
 *
 *     \@Query()
 *     \@Allow(Permission.Owner)
 *     activeCustomerReorderLists(
 *         \@Ctx() ctx: RequestContext,
 *         \@Args() args: { options?: ListQueryOptions<ReorderList>; includeShared?: boolean },
 *     ): Promise<PaginatedList<ReorderList>> {
 *         return this.reorderListService.getReorderLists(ctx, args.options, args.includeShared);
 *     }
 * }
 * ```
 *
 * @docsCategory core plugins/ReorderPlugin
 * @docsPage ReorderListService
 * @docsWeight 0
 * @since 3.8.0
 */
@Injectable()
export class ReorderListService {
    constructor(
        private connection: TransactionalConnection,
        private productVariantService: ProductVariantService,
        private listQueryBuilder: ListQueryBuilder,
        @Inject(REORDER_PLUGIN_OPTIONS) private options: ReorderPluginOptions,
    ) {}

    /**
     * The maximum number of lists one customer may hold in one channel, resolved against its declared
     * default. Read only by {@link ReorderListService.createReorderList}.
     */
    private get maxListsPerCustomer(): number {
        return this.options.maxListsPerCustomer ?? DEFAULT_MAX_LISTS_PER_CUSTOMER;
    }

    /**
     * The maximum number of lines one list may hold, resolved against its declared default. Read only by
     * {@link ReorderListService.addItemToReorderList} — the adjust path deliberately never consults it,
     * because changing a quantity on an existing line adds no line and so cannot breach a line-count bound.
     */
    private get maxLinesPerList(): number {
        return this.options.maxLinesPerList ?? DEFAULT_MAX_LINES_PER_LIST;
    }

    /**
     * The maximum quantity one line may carry, resolved against its declared default. Applied by both
     * quantity-bearing operations to the RESULTING quantity rather than to the increment.
     */
    private get maxQuantityPerLine(): number {
        return this.options.maxQuantityPerLine ?? DEFAULT_MAX_QUANTITY_PER_LINE;
    }

    /**
     * The page size the collection read falls back to where a caller supplies no `take`, resolved against its
     * declared default. It is stricter than the platform's own substitution of the Shop list-query limit,
     * which is what keeps an omitted page size returning a bounded page rather than every row.
     */
    private get defaultReorderListsPageSize(): number {
        return this.options.defaultReorderListsPageSize ?? DEFAULT_REORDER_LISTS_PAGE_SIZE;
    }

    /**
     * The page size a nested page of lines falls back to where a caller supplies no `take`, resolved against
     * its declared default, and stricter than the platform's substitution for the same reason.
     */
    private get defaultReorderListLinesPageSize(): number {
        return this.options.defaultReorderListLinesPageSize ?? DEFAULT_REORDER_LIST_LINES_PAGE_SIZE;
    }

    /**
     * Whether the configured engine both supports and requires a pessimistic row lock.
     *
     * Read once per create rather than cached, because the connection's options are the authority and reading
     * them costs nothing; caching would only introduce a second place for the answer to live.
     */
    private get supportsPessimisticLocking(): boolean {
        return ENGINES_SUPPORTING_PESSIMISTIC_LOCKING.includes(this.connection.rawConnection.options.type);
    }

    // ---------------------------------------------------------------------------------------------------
    // The ownership-and-channel predicate. This is the access control for all eight operations.
    // ---------------------------------------------------------------------------------------------------

    /**
     * Resolves the customer-and-channel scope every operation is evaluated against, and refuses a request
     * carrying no active user.
     *
     * This is the third conjunct of the predicate — "the session carries an active user at all" — and it is
     * evaluated first because the other two are meaningless without it. It is deliberately the platform's own
     * `ForbiddenError`, which takes neither a message nor variables: it is hard-wired to the `error.forbidden`
     * key and the code `FORBIDDEN`. `FORBIDDEN` rather than `UNAUTHORIZED` is the correct code here and the
     * distinction is the platform's own — an unauthorized error is raised where credentials do not *match*,
     * whereas an absent session on a permission-gated operation is reported as forbidden.
     *
     * Callers differ in how they treat the throw, and the difference is the read/write convention rather than
     * inconsistency: a read catches it and answers with an empty page or `null`, a write lets it propagate.
     *
     * **The `customer` lookup below is outside the counted boundary, and that is not an oversight to
     * "optimise" away.** The statement-count contract this service is held to filters captured statements to
     * `reorder_list` and `reorder_list_line` *by table name*, precisely so that an unrelated session, channel
     * or customer statement can neither inflate nor mask the number. The lookup is narrowed to the id column
     * so that no relation is loaded and no customer field beyond the identifier reaches process memory —
     * which is a data-minimisation choice on top of a correctness one, since the only thing needed from the
     * row is the value the two plugin tables store.
     */
    private async getOwnerScope(ctx: RequestContext): Promise<ReorderListOwnerScope> {
        if (!ctx.activeUserId) {
            throw new ForbiddenError();
        }
        const customer = await this.connection.getRepository(ctx, Customer).findOne({
            where: { user: { id: ctx.activeUserId } },
            select: { id: true },
        });
        if (!customer) {
            // An active user with no customer row is a broken invariant rather than a caller error: the
            // session authenticated successfully, so something upstream created a user without its customer.
            // Reported as an internal error rather than a refusal, so it is not mistaken for a permission
            // problem, and carrying no identifier so nothing about the session is echoed to the caller.
            throw new InternalServerError('The authenticated user has no associated Customer');
        }
        return { customerId: customer.id, channelId: ctx.channelId };
    }

    /**
     * Resolves one list under the full predicate, in EXACTLY ONE statement, or answers `null`.
     *
     * **The shape of this method is the whole point of it, and the rejected alternative is worth naming.**
     * The acting customer and the active channel are conjuncts of the *same* `WHERE` clause as the row's own
     * identifier, so a request for a row the caller may not have issues one statement that returns zero rows.
     * The shape this exists to reject is `findOne({ where: { id } })` followed by an in-memory comparison of
     * `row.customerId`: that shape issues a statement whose predicate carries the identifier alone and whose
     * result set is one row — the row it was supposed to refuse — and it satisfies every response-shaped
     * assertion while having loaded another buyer's data into process memory, where it can reach a log line,
     * an error message or a timing difference.
     *
     * Every list-addressing operation goes through here, and `null` is therefore the single normalised answer
     * to "absent", "another customer's", "another channel's" and "not shared with the caller" alike. The two
     * kinds of caller then diverge: a read returns that `null` unchanged, and a mutation converts it into
     * `ReorderListNotFoundError` because a caller who asked to write needs a reason.
     *
     * It is deliberately not `getEntityOrThrow`, which raises an entity-not-found error — a distinguishable
     * refusal that would confirm the existence of another buyer's row to anyone who counts, given that
     * identifiers are sequential under the default id strategy.
     */
    private async findOwnedList(
        ctx: RequestContext,
        id: ID,
        scope: ReorderListOwnerScope,
    ): Promise<ReorderList | null> {
        return this.connection.getRepository(ctx, ReorderList).findOne({
            where: { id, customerId: scope.customerId, channelId: scope.channelId },
        });
    }

    // ---------------------------------------------------------------------------------------------------
    // Reads. A failed guard answers with an empty page or null, never with an error.
    // ---------------------------------------------------------------------------------------------------

    /**
     * @description
     * Returns a bounded, deterministically ordered page of the lists the authenticated customer owns in the
     * active channel.
     *
     * **A caller with no resolvable scope receives an empty page rather than an error**, which is the shipped
     * read convention: the guard's refusal is caught here and answered with `{ items: [], totalItems: 0 }`. It
     * costs zero statements against either plugin table, because the guard fails before any list statement is
     * built.
     *
     * **The scope is server-side and cannot be widened by a caller.** It is supplied through the builder's
     * `where` extension rather than merged into the caller's `filter`, so a filter arriving from the generated
     * options input is composed *with* the scope and can only narrow the result further.
     *
     * **Bounding is delegated to the platform, not reimplemented.** The page is resolved through
     * `ListQueryBuilder`, which clamps the requested page to the configured Shop maximum and refuses an
     * over-limit request outright with the platform's own input error and the platform's own message key.
     * `ignoreQueryLimits` is left unset — the option's own documentation records that an unlimited public list
     * query can become a denial-of-service vector. What this method contributes is a *stricter* fallback than
     * the platform's own: where a caller supplies no page size the plugin's configured default applies
     * instead of the platform substituting its maximum.
     *
     * **This read deliberately does NOT repair a stale `lineCount`, and that is specified behaviour rather
     * than an oversight.** A page of lists does not page each list's lines, so it has no observed total to
     * compare the stored counter against; it reports the column as it stands. The single-list read is where
     * the disagreement becomes visible for free, and that is where the repair lives. A list whose counter has
     * drifted therefore reports the stale value in a collection read until it is read singly, and naming that
     * window is the point — an unstated self-healing behaviour is worse than a stated one.
     *
     * @param ctx - The request context, whose active channel and authenticated session are the scope.
     * @param options - The generator-supplied list options: `skip`, `take`, `sort` and `filter`.
     * @param includeShared - Accepted at both values and, under this feature, answered identically. See the
     * note on {@link ReorderListService.getReorderList}.
     *
     * @since 3.8.0
     */
    async getReorderLists(
        ctx: RequestContext,
        options?: ListQueryOptions<ReorderList>,
        includeShared: boolean = false,
    ): Promise<PaginatedList<ReorderList>> {
        let scope: ReorderListOwnerScope;
        try {
            scope = await this.getOwnerScope(ctx);
        } catch (err: unknown) {
            // The read convention: an unauthenticated or unresolvable caller gets the empty page. Only the
            // guard is inside the try, so a genuine query failure below is never absorbed by this branch. A
            // refusal is the expected path and is not logged; anything else is a broken invariant and is,
            // because a silently empty page would otherwise be the only symptom.
            if (!(err instanceof ForbiddenError)) {
                Logger.warn(
                    `Returning an empty reorder list page because the owner scope could not be resolved: ${
                        err instanceof Error ? err.message : String(err)
                    }`,
                    loggerCtx,
                );
            }
            return { items: [], totalItems: 0 };
        }
        return this.listQueryBuilder
            .build(
                ReorderList,
                {
                    ...options,
                    // The plugin's stricter fallback. The platform substitutes its own Shop maximum for an
                    // absent page size, so merging the configured default here is the only place it can be
                    // applied without reimplementing the clamp that follows it.
                    take: options?.take ?? this.defaultReorderListsPageSize,
                },
                {
                    ctx,
                    where: { customerId: scope.customerId, channelId: scope.channelId },
                    orderBy: this.appendedListOrder(options?.sort),
                },
            )
            .getManyAndCount()
            .then(([items, totalItems]) => ({ items, totalItems }));
    }

    /**
     * @description
     * Returns one list addressed by id, or `null`.
     *
     * **`null` is the single answer for every inaccessible case** — an id that matches no row, a row owned by
     * another customer, a row in another channel, a row not shared with the caller, and a request carrying no
     * authenticated session at all. Those answers are indistinguishable from one another by design: with
     * sequential identifiers, a distinguishable refusal would confirm the existence of another buyer's row to
     * anyone who counts. This method therefore returns a bare `null` on every one of those paths, with no
     * error, no warning and no extension attached to distinguish them.
     *
     * `ReorderListNotFoundError` is deliberately not reachable from here. It belongs to the four
     * list-addressing *mutations*, where a caller who asked to write needs a reason and where the return type
     * is a union that can carry one.
     *
     * The lookup is exactly one statement, scoped in its own `WHERE` clause. See
     * {@link ReorderListService.findOwnedList} for why the shape matters.
     *
     * @param ctx - The request context, whose active channel and authenticated session are the scope.
     * @param id - The list identifier. A value the configured id strategy cannot decode matches no row and
     * takes the same normalised `null` path as every other inaccessible case.
     * @param includeShared - Accepted at both values and answered identically under this feature, because no
     * share row can exist until list sharing ships: the set the non-default value asks for is empty by
     * construction rather than withheld. The non-default value is therefore **not refused** — refusing it
     * would mean the same call changed from an error to a success later, which is a behaviour change on an
     * unchanged signature. Nothing here reads, writes or knows about a share row.
     *
     * @since 3.8.0
     */
    async getReorderList(
        ctx: RequestContext,
        id: ID,
        includeShared: boolean = false,
    ): Promise<ReorderList | null> {
        let scope: ReorderListOwnerScope;
        try {
            scope = await this.getOwnerScope(ctx);
        } catch (err: unknown) {
            // Same convention as the collection read, and the same reason: a null that is indistinguishable
            // from every other inaccessible case, at the cost of zero statements against either plugin table.
            if (!(err instanceof ForbiddenError)) {
                Logger.warn(
                    `Returning null for a reorder list because the owner scope could not be resolved: ${
                        err instanceof Error ? err.message : String(err)
                    }`,
                    loggerCtx,
                );
            }
            return null;
        }
        return this.findOwnedList(ctx, id, scope);
    }

    // ---------------------------------------------------------------------------------------------------
    // Support members for the entity field resolvers. Each is resolved once per page, never once per entry.
    // ---------------------------------------------------------------------------------------------------

    /**
     * @description
     * Returns one page of lines for each list on a page of lists, resolved by a single batched statement over
     * the page's identifier set.
     *
     * **This method exists because the alternative satisfies every row-count criterion while being wrong.** A
     * page of a hundred lists whose `lines` field is resolved per entry issues a hundred and one statements:
     * pagination bounds the number of *rows* a request returns and says nothing about the number of
     * *statements* they cost. So the batch key is the page and never the entry, and the assertion that
     * matters is non-growth — a page of three lists and a page of six lists issue the same number of
     * statements against the plugin's tables.
     *
     * **How the single statement is achieved, and why the window is applied in process.** A per-parent window
     * cannot be expressed in one portable statement across every supported engine, so the permitted
     * alternative is taken: one statement reads the union of the parents' lines, the result is partitioned by
     * parent identifier, and each parent's own window is then taken from its partition. Two properties follow
     * for free. Each parent's `totalItems` is the exact size of its partition, so no second grouped-count
     * statement is issued at all — one statement serves the whole page. And the read is bounded rather than
     * unbounded, because the number of lines a list may hold is itself capped at write time by the configured
     * line maximum, and the number of parents is capped by the outer page.
     *
     * **Clamping and the over-limit refusal are the platform's.** The builder is asked for the caller's
     * window first, which is what raises the platform's own input error — with the platform's own message key
     * — when the requested page size exceeds the configured Shop maximum; the clamped values are then read
     * back off the built query and applied per parent. Building a query issues no statement, so this costs
     * nothing. The window is cleared from the query before it executes precisely because a single statement
     * serving many parents must not carry one parent's `LIMIT`.
     *
     * Every identifier passed in appears in the returned map, with an empty page where that list has no lines,
     * so a caller never has to distinguish "no lines" from "not resolved".
     *
     * @param ctx - The request context, joined so the read runs inside any open transaction.
     * @param listIds - The identifiers of the lists on the page being resolved.
     * @param options - The generator-supplied options for the nested collection.
     *
     * @since 3.8.0
     */
    async getLinesForLists(
        ctx: RequestContext,
        listIds: ID[],
        options?: ListQueryOptions<ReorderListLine>,
    ): Promise<Map<ID, PaginatedList<ReorderListLine>>> {
        const pages = new Map<ID, PaginatedList<ReorderListLine>>();
        for (const listId of listIds) {
            pages.set(listId, { items: [], totalItems: 0 });
        }
        const parentIds = Array.from(pages.keys());
        if (parentIds.length === 0) {
            return pages;
        }

        let scope: ReorderListOwnerScope;
        try {
            scope = await this.getOwnerScope(ctx);
        } catch (err: unknown) {
            // The read convention again: every requested identifier keeps its pre-seeded empty page, and no
            // statement is issued against either plugin table.
            if (!(err instanceof ForbiddenError)) {
                Logger.warn(
                    `Returning empty reorder list line pages because the owner scope could not be resolved: ${
                        err instanceof Error ? err.message : String(err)
                    }`,
                    loggerCtx,
                );
            }
            return pages;
        }

        const queryBuilder = this.listQueryBuilder.build(
            ReorderListLine,
            {
                ...options,
                // The same stricter fallback as the collection read, applied to the nested collection.
                take: options?.take ?? this.defaultReorderListLinesPageSize,
            },
            {
                ctx,
                // The parent scope is carried in the SAME `WHERE` clause as the identifier set, expressed as a
                // condition on the parent relation. The identifiers reaching this method always come from a
                // page this service already resolved under the predicate, so this conjunct is defence in depth
                // — but it is defence that costs nothing: a relation condition is realised as a join inside the
                // one statement rather than as a second statement, so the per-page count is unchanged. It also
                // makes the method safe in its own right rather than safe by virtue of its caller, which
                // matters for a member the api layer reaches directly.
                where: {
                    reorderListId: In(parentIds),
                    reorderList: { customerId: scope.customerId, channelId: scope.channelId },
                },
                orderBy: this.appendedLineOrder(options?.sort),
            },
        );
        // Read the window the platform resolved — which is where an over-limit request has already been
        // refused — and then clear it, so the one statement below is not limited to a single parent's page.
        const window: ResolvedLinesWindow = {
            take: queryBuilder.expressionMap.take ?? this.defaultReorderListLinesPageSize,
            skip: queryBuilder.expressionMap.skip ?? 0,
        };
        queryBuilder.take(undefined).skip(undefined);

        const rows = await queryBuilder.getMany();

        // Partition by parent. Keyed on the stringified identifier because the configured id strategy decides
        // whether an id is a number or a string, and a map keyed on the raw value would miss across the two.
        const partitions = new Map<string, ReorderListLine[]>();
        for (const row of rows) {
            const key = String(row.reorderListId);
            const partition = partitions.get(key);
            if (partition) {
                partition.push(row);
            } else {
                partitions.set(key, [row]);
            }
        }
        for (const listId of parentIds) {
            const partition = partitions.get(String(listId)) ?? [];
            pages.set(listId, {
                items: partition.slice(window.skip, window.skip + window.take),
                // Exact, and free: the union read carries every line of every parent on the page, so the
                // partition's length IS the parent's total and no counting statement is needed.
                totalItems: partition.length,
            });
        }
        return pages;
    }

    /**
     * @description
     * Repairs a stored line counter that disagrees with the line total actually observed, by a single
     * compare-and-set statement — and issues nothing at all when the two agree.
     *
     * **Called from the single-list read only.** That request already knows the observed total for the list it
     * returned, so the disagreement is visible for free there; a page of lists has no observed total to
     * compare against and therefore does not repair. Nothing else in this service calls it.
     *
     * **Why a counter can drift at all, and why the answer is "almost never".** Every plugin write path
     * maintains the counter inside the same transaction as the row change. The one path no plugin code sees is
     * a *hard* deletion of a `product_variant` row, which cascades line rows away underneath the plugin
     * without the counter being told. The platform's own variant deletion is a *soft* delete that flags the
     * row and leaves every line in place, so this drift is unreachable through any shipped operation and is
     * reachable only by a direct database deletion or by a future platform change. It is not therefore
     * ignored.
     *
     * **Why compare-and-set rather than a plain assignment.** The statement's `WHERE` names the stale value it
     * expects to find, so it is idempotent and two concurrent repairs cannot fight: whichever runs second
     * finds the guard value already changed and affects no row. A `lineCount` that a competing writer moved in
     * the meantime is therefore left alone rather than clobbered with a total observed before that write. The
     * non-negative check constraint on the column is what stops a defective repair writing a negative value.
     *
     * @param ctx - The request context.
     * @param listId - The list whose counter is being reconciled.
     * @param storedLineCount - The counter value that arrived with the row, and the guard the update compares.
     * @param observedTotal - The line total this request actually observed.
     * @returns The value the caller should report: the observed total when the two disagreed, and the stored
     * value when they agreed.
     *
     * @since 3.8.0
     */
    async reconcileLineCount(
        ctx: RequestContext,
        listId: ID,
        storedLineCount: number,
        observedTotal: number,
    ): Promise<number> {
        if (storedLineCount === observedTotal) {
            // The overwhelmingly common path: zero statements.
            return storedLineCount;
        }
        const result = await this.connection
            .getRepository(ctx, ReorderList)
            .createQueryBuilder('reorderlist')
            .update()
            .set({ lineCount: observedTotal })
            .where('id = :id', { id: listId })
            .andWhere('lineCount = :storedLineCount', { storedLineCount })
            .execute();
        if (!result.affected) {
            // A competing writer moved the counter between the read and this statement. The observed total is
            // still the truthful answer for what this request saw, and the writer's own value now stands in
            // the row, so nothing is retried and nothing is overwritten.
            Logger.debug(
                `Skipped a lineCount repair on reorder list ${String(listId)} because the stored value changed concurrently`,
                loggerCtx,
            );
        }
        return observedTotal;
    }

    /**
     * @description
     * Returns the per-requester provenance of a list, at a cost of zero statements.
     *
     * Every list this service hands back has already passed the ownership predicate, so under this feature
     * `access` is unconditionally `OWNED` and `grantedCapabilities` is unconditionally empty — those are the
     * truthful values while no share row can exist, rather than placeholders. The derivation is from the row
     * already loaded and the session already resolved, so no statement is issued: a per-entry access check
     * that issued one would make the statement count grow with the page size while every published bound
     * stayed satisfied, which is the shape this whole family of members exists to avoid.
     *
     * Sharing will make this conditional in a later feature. It is deliberately not anticipated here: no share
     * table is read, no grant field is declared, and nothing about the shape of a grant is assumed.
     *
     * @param list - The list being described. It is the value the derivation reads once sharing makes this
     * conditional, and it is part of the published signature for that reason; while `OWNED` is the only
     * reachable value, no field of it is consulted.
     *
     * @since 3.8.0
     */
    getViewerAccess(list: ReorderList): ReorderListViewerAccess {
        return { access: 'OWNED', grantedCapabilities: [] };
    }

    // ---------------------------------------------------------------------------------------------------
    // Deterministic ordering. The identifier tie-break is APPENDED to a caller's sort, never substituted.
    // ---------------------------------------------------------------------------------------------------

    /**
     * Builds the ordering the collection read hands to the builder as its `orderBy` extension, which is the
     * one channel through which keys can be *appended*: the builder merges `options.sort` first and the
     * extension second, so extension keys land last.
     *
     * A total order matters because a partial one makes every count assertion a coincidence. Two lists created
     * inside the same clock tick carry equal timestamps — which one seeded fixture or two inserts in a single
     * transaction produce routinely — and an order equal on every column it names leaves the engine free to
     * return those rows in either order on either request. Across two offset pages that means a row can be
     * returned twice or not at all. The row identifier is the only column that is always unique, so appending
     * it makes the order total.
     */
    private appendedListOrder(sort: ListQueryOptions<ReorderList>['sort']): AppendedReorderListOrder {
        if (!this.hasEffectiveSort(sort)) {
            // No caller sort: the whole declared default, newest first, tie-broken by identifier.
            return { createdAt: 'DESC', id: 'DESC' };
        }
        if (sort?.id != null) {
            // The caller already sorts by the identifier, so their order is total already. Appending here
            // would OVERWRITE their chosen direction rather than extend it, and overwriting is substitution —
            // which is the one thing this method exists not to do.
            return {};
        }
        return { id: 'DESC' };
    }

    /**
     * The line-collection counterpart of {@link ReorderListService.appendedListOrder}, ascending so that a
     * list's lines read in the order they were added, and tie-broken by identifier for the same reason.
     */
    private appendedLineOrder(sort: ListQueryOptions<ReorderListLine>['sort']): AppendedReorderListLineOrder {
        if (!this.hasEffectiveSort(sort)) {
            return { createdAt: 'ASC', id: 'ASC' };
        }
        if (sort?.id != null) {
            return {};
        }
        return { id: 'ASC' };
    }

    /**
     * Whether a caller's sort parameter actually orders anything.
     *
     * The generated sort input is nullable in every position, so a caller can legitimately send an object all
     * of whose directions are null — which orders nothing and must be treated as "no sort supplied", so that
     * the full default order applies rather than the tie-break alone.
     */
    private hasEffectiveSort(sort: { [key: string]: unknown } | null | undefined): boolean {
        return sort != null && Object.values(sort).some(direction => direction != null);
    }

    // ---------------------------------------------------------------------------------------------------
    // Writes over the list itself. A failed guard propagates, so an unauthenticated write is FORBIDDEN.
    // ---------------------------------------------------------------------------------------------------

    /**
     * @description
     * Creates an empty named list for the authenticated customer in the active channel.
     *
     * **Ownership is derived, never nominated.** The stored row's customer comes from the authenticated
     * session and its channel from the request's active channel, and this operation exposes no argument that
     * could name a different owner — so "a caller cannot create a list for somebody else" is a structural
     * property rather than a validation rule.
     *
     * **The name is canonicalised in exactly one place.** The display value stored is the submitted string
     * with its whitespace canonicalised and nothing else altered — not escaped, not stripped, not
     * entity-encoded — so a name carrying markup-significant characters round-trips byte for byte. A name
     * whose canonical form cannot be stored is refused as malformed input by that same helper, which throws;
     * nothing is ever truncated.
     *
     * **The list bound is enforced by counting and inserting inside one transaction, under a row lock on the
     * owning customer where the engine supports one** — so a second concurrent creator waits and then counts
     * the first one's row, rather than both reading a count below the maximum and both inserting.
     *
     * **The name-uniqueness rule has two halves and both are needed.** The pre-check produces the precise
     * conflict result on the ordinary path, including for a name that differs from a stored one only along a
     * dimension the canonical form collapses — case, surrounding whitespace, or Unicode composition. But two
     * concurrent creates may both read before either writes, so the pre-check alone cannot decide the race:
     * the named database constraint is the authority, and its violation is caught and translated. A list is
     * created with a line count of exactly zero.
     *
     * @param ctx - The request context, whose active channel and authenticated session become the row's scope.
     * @param input - The submitted name.
     * @throws A `ForbiddenError` when the request carries no authenticated session, and a `UserInputError`
     * when the submitted name cannot be stored. Neither is a member of the returned union: they are request
     * failures rather than business outcomes.
     *
     * @since 3.8.0
     */
    async createReorderList(
        ctx: RequestContext,
        input: CreateReorderListInput,
    ): Promise<CreateReorderListResult> {
        // Not wrapped in try/catch: an unauthenticated write must surface the propagated FORBIDDEN error.
        const scope = await this.getOwnerScope(ctx);
        // Canonicalisation and its three rejections live in one place, so no second code path can disagree
        // about what a stored name is. This throws for a name that cannot be stored.
        const { name, nameKey } = canonicaliseReorderListName(input.name);

        return this.connection.withTransaction(ctx, async transactionCtx => {
            // The lock comes first, inside this transaction, so the count below observes any competing
            // creator's committed row rather than racing it.
            await this.acquireCustomerLock(transactionCtx, scope.customerId);
            const listRepository = this.connection.getRepository(transactionCtx, ReorderList);

            const heldLists = await listRepository.count({
                where: { customerId: scope.customerId, channelId: scope.channelId },
            });
            if (heldLists >= this.maxListsPerCustomer) {
                // At the maximum as well as over it: holding exactly the maximum means there is no room for
                // one more. Nothing has been written at this point.
                return new ReorderListLimitError(this.maxListsPerCustomer);
            }

            const conflicting = await listRepository.count({
                where: { customerId: scope.customerId, channelId: scope.channelId, nameKey },
            });
            if (conflicting > 0) {
                return new ReorderListNameConflictError(nameKey);
            }

            try {
                return await listRepository.save(
                    new ReorderList({
                        customerId: scope.customerId,
                        channelId: scope.channelId,
                        name,
                        nameKey,
                        // Exactly zero, and stated explicitly rather than left to the column default, because
                        // a freshly created list reporting a count of zero is part of the published contract.
                        lineCount: 0,
                    }),
                );
            } catch (err: unknown) {
                // The race the pre-check above cannot win. Only the one named constraint is translated; every
                // other database failure is re-raised, sanitised, by the helper.
                return this.translateNameConflict(err, nameKey);
            }
        });
    }

    /**
     * @description
     * Renames an existing list, and changes nothing else about it.
     *
     * The rename is a **single conditional statement** whose predicate names the row identifier together with
     * the acting customer and the active channel, and whose affected-row count is the authority: one means the
     * rename applied, and zero means there was no such row for this caller — reported as
     * `ReorderListNotFoundError`, the same normalised outcome an unknown identifier produces. A read followed
     * by a write would leave a window in which the row is removed by a concurrent request, and could not tell
     * "applied" from "matched nothing".
     *
     * **No line row is read and none is written.** A rename touches the two name columns and the inherited
     * update timestamp, so a list's line count and every one of its lines are returned unchanged.
     *
     * The new name is subject to the identical canonicalisation and the identical uniqueness rule that governs
     * creation, so this operation can return `ReorderListNameConflictError` — and a blank new name is refused
     * as malformed input rather than stored.
     *
     * @param ctx - The request context.
     * @param input - The list identifier and the new name.
     * @throws A `ForbiddenError` when the request carries no authenticated session, and a `UserInputError`
     * when the new name cannot be stored.
     *
     * @since 3.8.0
     */
    async updateReorderList(
        ctx: RequestContext,
        input: UpdateReorderListInput,
    ): Promise<UpdateReorderListResult> {
        const scope = await this.getOwnerScope(ctx);
        const { name, nameKey } = canonicaliseReorderListName(input.name);

        return this.connection.withTransaction(ctx, async transactionCtx => {
            const listRepository = this.connection.getRepository(transactionCtx, ReorderList);

            // The pre-check, for the same reason as on the create path: it produces the precise conflict
            // result for a name that collides only under the canonical comparison. It excludes the row being
            // renamed, so renaming a list to the name it already holds is not reported as a conflict with
            // itself. The named constraint remains the authority for the race.
            const conflicting = await listRepository.count({
                where: { customerId: scope.customerId, channelId: scope.channelId, nameKey },
            });
            if (conflicting > 0) {
                const alreadyOwnsThisName = await listRepository.count({
                    where: {
                        id: input.id,
                        customerId: scope.customerId,
                        channelId: scope.channelId,
                        nameKey,
                    },
                });
                if (!alreadyOwnsThisName) {
                    return new ReorderListNameConflictError(nameKey);
                }
            }

            let affected: number | null | undefined;
            try {
                const result = await listRepository
                    .createQueryBuilder('reorderlist')
                    .update()
                    .set({ name, nameKey })
                    .where('id = :id', { id: input.id })
                    .andWhere('customerId = :customerId', { customerId: scope.customerId })
                    .andWhere('channelId = :channelId', { channelId: scope.channelId })
                    .execute();
                affected = result.affected;
            } catch (err: unknown) {
                return this.translateNameConflict(err, nameKey);
            }

            if (affected !== 1) {
                return new ReorderListNotFoundError();
            }
            return this.reloadOwnedList(transactionCtx, input.id, scope);
        });
    }

    /**
     * @description
     * Deletes a list together with its lines.
     *
     * The delete is a **single conditional statement** whose predicate names the row identifier together with
     * the acting customer and the active channel, with the affected-row count as the authority. One means the
     * list was deleted; zero means there was no such row for this caller, which is both how a foreign or
     * unknown identifier is refused and how a **repeat delete** is refused rather than reported as a success.
     *
     * **The lines go with it through the declared cascade on the line table's parent reference, in the same
     * statement.** Nothing here loops over lines, and nothing deletes them individually: the delete is issued
     * against the parent row and the engine removes the children, so no line row is ever observable without
     * its parent.
     *
     * The success payload is the platform's own `DeletionResponse`, reused verbatim rather than replaced by a
     * plugin-owned deletion type. Its `message` field is nullable and is deliberately omitted — a successful
     * deletion has nothing to add to the result it already reports. The type name is set explicitly so that
     * the union this value belongs to is discriminated on the same field as its error member.
     *
     * @param ctx - The request context.
     * @param id - The identifier of the list to delete.
     * @throws A `ForbiddenError` when the request carries no authenticated session.
     *
     * @since 3.8.0
     */
    async deleteReorderList(ctx: RequestContext, id: ID): Promise<DeleteReorderListResult> {
        const scope = await this.getOwnerScope(ctx);

        return this.connection.withTransaction(ctx, async transactionCtx => {
            const result = await this.connection
                .getRepository(transactionCtx, ReorderList)
                .createQueryBuilder('reorderlist')
                .delete()
                .where('id = :id', { id })
                .andWhere('customerId = :customerId', { customerId: scope.customerId })
                .andWhere('channelId = :channelId', { channelId: scope.channelId })
                .execute();

            if (result.affected !== 1) {
                return new ReorderListNotFoundError();
            }
            // No counter maintenance is needed or possible: the counter lived on the row that has just been
            // removed, and the lines went with it through the cascade.
            return { __typename: 'DeletionResponse', result: DeletionResult.DELETED };
        });
    }

    // ---------------------------------------------------------------------------------------------------
    // Writes over a list's lines.
    // ---------------------------------------------------------------------------------------------------

    /**
     * @description
     * Adds a variant to a list at an integer quantity, or accumulates onto the line that variant already has.
     *
     * **The order of the three steps is fixed, and it is what makes the duplicate-at-capacity case
     * deterministic:**
     *
     * 1. the existing line for this list-and-variant pair is resolved;
     * 2. the **resulting** quantity is validated — not the increment;
     * 3. only then is the line bound consulted, and only when a new line will actually be inserted.
     *
     * The consequence to preserve is that adding a variant **already on** a list that is at its line maximum
     * *succeeds* by accumulating: it creates no line, so it breaches no line-count bound. Consulting the bound
     * first would refuse a write that adds nothing to the collection the bound protects.
     *
     * **Accumulation is one atomic statement and never a read followed by a save.** The quantity is
     * incremented in the database, addressed by the line's own identifier, and the affected-row count is read.
     * The shipped saved-list precedent reads, computes and saves, which is safe for a boolean membership set
     * and unsafe for a counter: two concurrent two-unit adds would both read six, both compute twelve and both
     * store twelve, so the buyer asked for eighteen and holds twelve. The stored line count does not change on
     * this path, because no line was added.
     *
     * **On the insert path the counter claim is the first write of the transaction**, and the line is inserted
     * only if that claim succeeded — so a single statement decides whether there is room and no interleaving
     * admits an extra line.
     *
     * **No availability is read.** A saved list records intent rather than availability: no stock level is
     * consulted, nothing is allocated and nothing is reserved, so a variant whose saleable quantity is below
     * the requested one is added exactly as any other is. The variant is resolved for existence in the active
     * channel and for nothing else.
     *
     * **There is no idempotency key, and the delivery guarantee is stated rather than implied.** An atomic
     * increment makes concurrent adds correct, but it cannot distinguish a client that retried a timed-out
     * request from a buyer who genuinely pressed add twice — and a replay guarantee needs a durable
     * claim-and-response record, which this plugin owns no row for. Delivery is therefore **at-least-once**:
     * two deliveries of one add accumulate, and {@link ReorderListService.adjustReorderListLine} is the
     * deterministic remedy because it sets an absolute quantity rather than adding to one.
     *
     * @param ctx - The request context.
     * @param input - The list, the variant, and the quantity to add.
     * @throws A `ForbiddenError` when the request carries no authenticated session, and a `UserInputError`
     * when the variant cannot be resolved in the active channel or the resulting quantity is out of bounds.
     *
     * @since 3.8.0
     */
    async addItemToReorderList(
        ctx: RequestContext,
        input: AddItemToReorderListInput,
    ): Promise<AddItemToReorderListResult> {
        const scope = await this.getOwnerScope(ctx);

        return this.connection.withTransaction(ctx, async transactionCtx => {
            const list = await this.findOwnedList(transactionCtx, input.reorderListId, scope);
            if (!list) {
                // Indistinguishable for an unknown identifier, another customer's list and another channel's
                // list, and nothing has been written.
                return new ReorderListNotFoundError();
            }

            // Existence in the active channel, and nothing else. This is the only collaborator call this
            // operation makes: no saleable-stock read, no display-stock read and no available-stock read.
            const variant = await this.productVariantService.findOne(transactionCtx, input.productVariantId);
            if (!variant) {
                throw new UserInputError(VARIANT_NOT_FOUND_KEY, {
                    [ID_VARIABLE]: String(input.productVariantId),
                });
            }

            const lineRepository = this.connection.getRepository(transactionCtx, ReorderListLine);

            // Step one: resolve the existing line, scoped to this list so a line of another list cannot be
            // reached even by a variant they share.
            const existingLine = await lineRepository.findOne({
                where: { reorderListId: list.id, productVariantId: input.productVariantId },
            });

            // Step two: validate, and BOTH checks are needed rather than one being a superset of the other.
            // The increment must itself be a positive integer, or a caller could subtract by adding — and an
            // increment of zero onto a line already holding six would leave a resulting quantity that passes.
            // The resulting quantity must then be within the maximum, because the bound applies to what the
            // line would hold and not to what was asked for: an add of six onto a line already holding six is
            // refused at a maximum of ten even though the increment alone is legal.
            this.validateQuantity(input.quantity);
            const resultingQuantity = (existingLine?.quantity ?? 0) + input.quantity;
            this.validateQuantity(resultingQuantity);

            if (existingLine) {
                // Accumulate: one atomic statement addressed by the line's own identifier, whose affected-row
                // count is read. The line's identifier is unchanged, no second row is created, and the list's
                // stored line count is untouched because no line was added.
                const quantityColumn = this.escapeColumn('quantity');
                let accumulated: number | null | undefined;
                try {
                    const result = await lineRepository
                        .createQueryBuilder('reorderlistline')
                        .update()
                        .set({ quantity: () => `${quantityColumn} + :delta` })
                        .where('id = :lineId', { lineId: existingLine.id })
                        .andWhere('reorderListId = :reorderListId', { reorderListId: list.id })
                        .setParameter('delta', input.quantity)
                        .execute();
                    accumulated = result.affected;
                } catch (err: unknown) {
                    // Nothing a caller can provoke reaches here — the quantity was validated above — so this
                    // is a defect rather than an outcome, and is reported as one without leaking driver text.
                    return this.rethrowSanitisedWriteFailure(
                        err,
                        'accumulating a reorder list line quantity',
                    );
                }
                if (accumulated !== 1) {
                    // The line was removed by a concurrent request between resolving it and incrementing it.
                    // There is no state left to accumulate onto, so the truthful answer is that the line is
                    // gone — reported through the list-level result this union carries.
                    return new ReorderListNotFoundError();
                }
                return this.reloadOwnedList(transactionCtx, list.id, scope);
            }

            // Step three, and only now: claim room for a new line. This is the first write of the insert path,
            // so a refusal leaves nothing to undo.
            const claimed = await this.claimLineCapacity(transactionCtx, list.id);
            if (!claimed) {
                return new ReorderListLimitError(this.maxLinesPerList);
            }
            try {
                await lineRepository.save(
                    new ReorderListLine({
                        reorderListId: list.id,
                        productVariantId: input.productVariantId,
                        quantity: input.quantity,
                    }),
                );
            } catch (err: unknown) {
                // A duplicate line for this list-and-variant pair can only arrive here when two concurrent
                // adds both found no existing line and both inserted. The line-level uniqueness constraint
                // exists to make the deduplication rule unbypassable rather than to produce a buyer-visible
                // outcome, so a violation of it is an internal defect and is **never** translated into a name
                // conflict — the two constraints are separate and are named separately.
                return this.rethrowSanitisedWriteFailure(err, 'inserting a reorder list line');
            }
            return this.reloadOwnedList(transactionCtx, list.id, scope);
        });
    }

    /**
     * @description
     * Sets the quantity on an existing line to an absolute value.
     *
     * **The value is set rather than added, and that is what makes this operation idempotent by
     * construction** — repeating the call any number of times leaves the same stored quantity. It is therefore
     * the deterministic remedy for the at-least-once delivery of
     * {@link ReorderListService.addItemToReorderList}: a client that cannot tell whether its add committed
     * reads the list back and sets the quantity it intends.
     *
     * **It deliberately does not consult the line bound and does not change the stored line count**, because
     * changing a quantity on a line that already exists adds no line and therefore cannot breach a line-count
     * bound. Measuring it against that bound would refuse a write that adds nothing.
     *
     * The quantity is validated **before any statement is issued**, so a refused adjustment leaves the line at
     * exactly its prior value. A quantity of zero is refused rather than treated as a removal — removing the
     * line is what expresses "none of this", and there is a published operation for it.
     *
     * **The two not-found results are distinguished by a deliberate two-step.** The list is resolved first
     * under the ownership predicate: if that fails the answer is `ReorderListNotFoundError`, indistinguishable
     * for an unknown, foreign or other-channel list. Only if the list *did* resolve is the line addressed, by
     * its own identifier together with the parent list's, and a zero affected-row count then means the line
     * genuinely did not exist within a list the caller owns — which is `ReorderListLineNotFoundError`.
     *
     * @param ctx - The request context.
     * @param input - The list, the line, and the absolute quantity to set.
     * @throws A `ForbiddenError` when the request carries no authenticated session, and a `UserInputError`
     * when the quantity is out of bounds.
     *
     * @since 3.8.0
     */
    async adjustReorderListLine(
        ctx: RequestContext,
        input: AdjustReorderListLineInput,
    ): Promise<AdjustReorderListLineResult> {
        const scope = await this.getOwnerScope(ctx);
        // Before any statement, so a refused adjustment cannot have touched the line.
        this.validateQuantity(input.quantity);

        return this.connection.withTransaction(ctx, async transactionCtx => {
            const list = await this.findOwnedList(transactionCtx, input.reorderListId, scope);
            if (!list) {
                return new ReorderListNotFoundError();
            }

            const result = await this.connection
                .getRepository(transactionCtx, ReorderListLine)
                .createQueryBuilder('reorderlistline')
                .update()
                // An absolute set, not an increment. No raw expression, so no escaping is needed here.
                .set({ quantity: input.quantity })
                .where('id = :lineId', { lineId: input.lineId })
                .andWhere('reorderListId = :reorderListId', { reorderListId: list.id })
                .execute();

            if (result.affected !== 1) {
                return new ReorderListLineNotFoundError();
            }
            // The stored line count is deliberately untouched: no line was added or removed.
            return this.reloadOwnedList(transactionCtx, list.id, scope);
        });
    }

    /**
     * @description
     * Removes one line from a list.
     *
     * The delete is a **single conditional statement** addressed by the line's own identifier together with
     * the parent list's, issued only after the list itself has resolved under the ownership predicate — the
     * same two-step that distinguishes `ReorderListNotFoundError` from `ReorderListLineNotFoundError`. The
     * affected-row count is the authority: one means the line was removed, and zero means it was not there,
     * which is also how a **second remove of the same line** is refused rather than reported as a success.
     *
     * **The stored line count is decremented in the same transaction as the delete**, which is what keeps the
     * counter and the rows in agreement, and the decrement carries a floor guard so the column's non-negative
     * check constraint stays satisfiable even under a defect.
     *
     * @param ctx - The request context.
     * @param input - The list and the line to remove.
     * @throws A `ForbiddenError` when the request carries no authenticated session.
     *
     * @since 3.8.0
     */
    async removeReorderListLine(
        ctx: RequestContext,
        input: RemoveReorderListLineInput,
    ): Promise<RemoveReorderListLineResult> {
        const scope = await this.getOwnerScope(ctx);

        return this.connection.withTransaction(ctx, async transactionCtx => {
            const list = await this.findOwnedList(transactionCtx, input.reorderListId, scope);
            if (!list) {
                return new ReorderListNotFoundError();
            }

            const result = await this.connection
                .getRepository(transactionCtx, ReorderListLine)
                .createQueryBuilder('reorderlistline')
                .delete()
                .where('id = :lineId', { lineId: input.lineId })
                .andWhere('reorderListId = :reorderListId', { reorderListId: list.id })
                .execute();

            if (result.affected !== 1) {
                return new ReorderListLineNotFoundError();
            }
            // Same transaction as the delete above, so the counter and the rows cannot be observed disagreeing.
            await this.releaseLineCapacity(transactionCtx, list.id);
            return this.reloadOwnedList(transactionCtx, list.id, scope);
        });
    }

    // ---------------------------------------------------------------------------------------------------
    // Write-side conventions, shared by all six mutations so that none of them can quietly differ.
    // ---------------------------------------------------------------------------------------------------

    /**
     * Escapes a column identifier for the configured engine, for use inside a raw `SET` expression.
     *
     * **This is not optional politeness and the failure it prevents appears on exactly one engine.** Both
     * columns this service increments are camel-cased, and an unquoted camel-cased identifier inside a raw SQL
     * fragment is folded to lower case by PostgreSQL, where it then matches no column and the statement fails
     * at run time. The SQLite family, by contrast, resolves it happily — so an unescaped fragment passes the
     * in-process engine's tests and fails one engine job. The platform's own services escape through the
     * driver for the same reason.
     */
    private escapeColumn(columnName: string): string {
        return this.connection.rawConnection.driver.escape(columnName);
    }

    /**
     * Refuses a quantity that cannot be stored, before any statement is issued.
     *
     * **Both refusals are thrown rather than returned, and that is a contract rather than an implementation
     * choice.** A quantity outside its bounds is a malformed request and not a business outcome, so it reaches
     * the caller as a single top-level error entry carrying the code `USER_INPUT_ERROR` with the operation's
     * own field null — never as a member of a result union. This is precisely why this feature declares four
     * error results and not five.
     *
     * It is deliberately *not* the platform's negative-quantity error result: that type's own description is
     * about setting a negative quantity on an order line, the platform returns it for values below zero only,
     * it says nothing about zero, and it is about an order line rather than a list line. Reporting one
     * condition under another condition's name is worse than reporting it plainly.
     *
     * The maximum is applied to the value passed in, and callers pass the **resulting** quantity rather than an
     * increment — so an add of one onto a line already at the maximum is refused even though the increment
     * itself is one.
     *
     * @param resultingQuantity - The quantity the line would hold if the operation applied.
     */
    private validateQuantity(resultingQuantity: number): void {
        if (!Number.isInteger(resultingQuantity) || resultingQuantity <= 0) {
            // The registered message states the whole rule in one sentence and interpolates nothing, so no
            // variables are passed. A non-integer and a non-positive value are one condition to a caller:
            // the quantity is not a positive integer.
            throw new UserInputError(QUANTITY_MUST_BE_POSITIVE_KEY);
        }
        if (resultingQuantity > this.maxQuantityPerLine) {
            throw new UserInputError(QUANTITY_ABOVE_MAXIMUM_KEY, {
                [MAX_VARIABLE]: this.maxQuantityPerLine,
            });
        }
    }

    /**
     * Takes a pessimistic write lock on the owning customer row, where the engine both supports and needs one.
     *
     * This serialises concurrent creates for one customer so that the second creator waits and then counts the
     * first one's row — which is what makes a count-and-insert a correct enforcement of the list bound rather
     * than a race. The alternative, a conditional counter update, is unavailable for that bound: it would need
     * a plugin-owned per-customer counter row, this plugin owns none, the maximum counts list rows rather than
     * reading a stored total, and the customer table is a core table this feature may not add a column to. No
     * such counter is invented.
     *
     * **The lock is taken through the request-bound repository and never through the raw connection's own
     * transaction helper.** The shipped scheduler strategy uses the raw helper correctly, because it runs
     * outside any request; here that would open a transaction *separate from the request's* and destroy the
     * very atomicity the bound depends on — the count and the insert would then sit in a different transaction
     * from the lock that was supposed to protect them.
     *
     * On the in-process SQLite engine the lock is skipped, and that is required rather than an optimisation:
     * that driver serves a single connection so two transactions cannot interleave, and asking it for a lock
     * raises rather than degrades.
     */
    private async acquireCustomerLock(ctx: RequestContext, customerId: ID): Promise<void> {
        if (!this.supportsPessimisticLocking) {
            return;
        }
        await this.connection
            .getRepository(ctx, Customer)
            .createQueryBuilder('customer')
            .setLock('pessimistic_write')
            .where('customer.id = :customerId', { customerId })
            .getOne();
    }

    /**
     * Claims room for one more line on a list, by a single conditional counter update, and reports whether the
     * claim succeeded.
     *
     * **This statement IS the line bound.** It increments the counter only while it is still below the
     * configured maximum, and its affected-row count is the verdict: one means the room was claimed and the
     * line may now be inserted, zero means the list was already full. Because a single statement decides, no
     * interleaving can admit an extra line — which is exactly the assertion a count-then-insert check fails,
     * since two concurrent requests can both read a count below the maximum and both then insert.
     *
     * It is issued as the **first write of the transaction**, so a refusal leaves nothing to undo.
     *
     * @returns `true` when the counter was incremented and the caller may insert, `false` when the list is at
     * its maximum and the caller must refuse.
     */
    private async claimLineCapacity(ctx: RequestContext, listId: ID): Promise<boolean> {
        const lineCount = this.escapeColumn('lineCount');
        const result = await this.connection
            .getRepository(ctx, ReorderList)
            .createQueryBuilder('reorderlist')
            .update()
            .set({ lineCount: () => `${lineCount} + 1` })
            .where('id = :listId', { listId })
            .andWhere('lineCount < :maxLinesPerList', { maxLinesPerList: this.maxLinesPerList })
            .execute();
        return result.affected === 1;
    }

    /**
     * Releases one line's worth of counter, in the same transaction as the delete that removed the line.
     *
     * The floor guard in the predicate is what keeps the column's non-negative check constraint satisfiable
     * even under a defect: a decrement that would take the counter below zero affects no row instead of
     * writing a negative value. Since the caller only reaches this after a delete that affected exactly one
     * row, a zero affected-count here means the counter had already drifted, which is worth a log rather than
     * a failure — the rows are the truth and the single-list read repairs the counter.
     */
    private async releaseLineCapacity(ctx: RequestContext, listId: ID): Promise<void> {
        const lineCount = this.escapeColumn('lineCount');
        const result = await this.connection
            .getRepository(ctx, ReorderList)
            .createQueryBuilder('reorderlist')
            .update()
            .set({ lineCount: () => `${lineCount} - 1` })
            .where('id = :listId', { listId })
            .andWhere('lineCount > 0')
            .execute();
        if (!result.affected) {
            Logger.warn(
                `Reorder list ${String(listId)} had a lineCount of zero while a line was being removed from it`,
                loggerCtx,
            );
        }
    }

    /**
     * Re-reads a list through the same scoped predicate, for a mutation that has just changed it.
     *
     * Every mutation returning a list returns a freshly read row rather than the row it had in hand, so the
     * stored line counter and the update timestamp the caller receives are the post-write values rather than
     * the pre-write ones. The read goes through the ownership predicate again, so the row a caller receives is
     * one they own even in the impossible case that ownership changed mid-transaction.
     *
     * A row that has vanished between the write and this read is reported as not found rather than as an
     * internal error: from the caller's point of view a concurrent delete landing in that window is exactly
     * "the list is not there", which is the same normalised outcome every other inaccessible case produces.
     */
    private async reloadOwnedList(
        ctx: RequestContext,
        listId: ID,
        scope: ReorderListOwnerScope,
    ): Promise<ReorderList | ReorderListNotFoundError> {
        const list = await this.findOwnedList(ctx, listId, scope);
        return list ?? new ReorderListNotFoundError();
    }

    // ---------------------------------------------------------------------------------------------------
    // Database-failure translation: narrow where it is a buyer outcome, sanitised everywhere else.
    // ---------------------------------------------------------------------------------------------------

    /**
     * Translates a name-uniqueness violation into its buyer-visible result, and re-raises everything else.
     *
     * **The match is on ONE constraint name and nothing else, and the width of the match is the whole point.**
     * Mapping "any unique-violation error code" would look like a shortcut and behave like a defect: the line
     * table carries its own uniqueness constraint, so a duplicated line would be reported to the buyer as a
     * duplicated *list name* — a wrong answer that reads like a right one. The two constraints are separate,
     * are named separately, and only this one is a business outcome.
     *
     * The returned result carries the caller's **own** canonical key, computed from the name they submitted, so
     * a client can explain precisely what collided while the response discloses nothing about the row that
     * already holds it.
     *
     * Everything that is not this one constraint goes to
     * {@link ReorderListService.rethrowSanitisedWriteFailure}, so a driver message never reaches a caller.
     *
     * @param err - The caught driver failure.
     * @param nameKey - The canonical key the caller's own submitted name produced.
     */
    private translateNameConflict(err: unknown, nameKey: string): ReorderListNameConflictError {
        if (this.mentionsConstraint(err, NAME_CONFLICT_CONSTRAINT)) {
            return new ReorderListNameConflictError(nameKey);
        }
        return this.rethrowSanitisedWriteFailure(err, 'saving a reorder list');
    }

    /**
     * Re-raises a database failure this service cannot classify, with the detail retained server-side and none
     * of it exposed to the caller.
     *
     * **The failure is never swallowed and never leaked, and both halves matter.** A driver message can carry
     * the schema, the column list, a SQL fragment and sometimes the conflicting values, so the caller receives
     * a short generic message under the platform's internal-error code while the original — including its
     * stack — is logged at error level against the plugin's own logger context. An operator therefore has
     * everything needed to diagnose it and the caller learns nothing about the schema.
     *
     * An already-classified platform error is re-raised unchanged rather than re-wrapped. Nothing currently
     * routes one through here, but a future edit that widened a `try` block would otherwise turn a deliberate
     * input refusal into an internal error, and silently: the caller would see the wrong code for the right
     * reason.
     *
     * @param err - The caught failure.
     * @param operation - A short description of what was being attempted, for the log line only. It is never
     * returned to the caller.
     * @returns Never — the declared return type lets a caller write `return this.rethrowSanitisedWriteFailure(…)`
     * and keeps reachability analysis correct at every call site.
     */
    private rethrowSanitisedWriteFailure(err: unknown, operation: string): never {
        if (
            err instanceof UserInputError ||
            err instanceof ForbiddenError ||
            err instanceof InternalServerError
        ) {
            throw err;
        }
        Logger.error(
            `Unexpected database failure while ${operation}`,
            loggerCtx,
            err instanceof Error ? err.stack : String(err),
        );
        throw new InternalServerError(UNCLASSIFIED_WRITE_FAILURE_MESSAGE);
    }

    /**
     * Whether a caught driver failure names the given database constraint.
     *
     * **A textual, case-insensitive search is the portable test here, and that is a considered choice rather
     * than a lazy one.** Every supported engine reports a constraint identifier differently — in the message
     * body, in a driver-specific field, quoted, bracketed, or with a table prefix — and on the MySQL family a
     * named `UNIQUE` constraint materialises as a named unique *index* rather than as a constraint object,
     * under the same name. There is consequently no single structured field that carries the name on all four
     * engines, while the name itself appears on all four. The search therefore covers the message together with
     * the driver-specific fields the common drivers populate, and is case-insensitive because engines differ in
     * how they case an identifier they echo back.
     *
     * The search is for one exact constraint name supplied by the caller, never for an error class or a
     * vendor error code, which is what keeps the translation narrow.
     */
    private mentionsConstraint(err: unknown, constraintName: string): boolean {
        if (err == null || typeof err !== 'object') {
            return false;
        }
        const candidate = err as {
            message?: unknown;
            detail?: unknown;
            constraint?: unknown;
            sqlMessage?: unknown;
            driverError?: unknown;
        };
        const needle = constraintName.toLowerCase();
        const haystacks = [candidate.message, candidate.detail, candidate.constraint, candidate.sqlMessage];
        for (const haystack of haystacks) {
            if (typeof haystack === 'string' && haystack.toLowerCase().includes(needle)) {
                return true;
            }
        }
        // TypeORM wraps the driver's own error and exposes it, and some drivers put the constraint name only
        // there. One level of unwrapping is enough: no driver nests a second wrapper inside the first.
        const driverError = candidate.driverError;
        if (driverError != null && typeof driverError === 'object') {
            const inner = driverError as {
                message?: unknown;
                detail?: unknown;
                constraint?: unknown;
                sqlMessage?: unknown;
            };
            for (const haystack of [inner.message, inner.detail, inner.constraint, inner.sqlMessage]) {
                if (typeof haystack === 'string' && haystack.toLowerCase().includes(needle)) {
                    return true;
                }
            }
        }
        return false;
    }
}
