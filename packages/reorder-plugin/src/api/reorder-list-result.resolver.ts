/**
 * The union-type resolution for the six result unions `@vendure/reorder-plugin` publishes.
 *
 * A GraphQL union carries no discriminator of its own. When a field's declared type is abstract, the
 * executor asks the schema which concrete object type the resolved value belongs to, and a union with
 * no `__resolveType` fails with `Abstract type "CreateReorderListResult" must resolve to an Object
 * type at runtime`. That failure arrives per *request* rather than at boot, so a build that compiles
 * and a server that starts both say nothing about it — which is why every union the SDL document
 * declares is represented in this file rather than only those a suite happens to exercise, and why
 * all six live in one place where a reader can count them against
 * [packages/reorder-plugin/src/api/api-extensions.ts].
 *
 * Core resolves its own result unions with plain resolver-map objects — see
 * `shopErrorOperationTypeResolvers` in [packages/core/src/common/error/generated-graphql-shop-errors.ts],
 * merged into the executable schema by [packages/core/src/api/config/generate-resolvers.ts]. A plugin
 * cannot take that route: the `resolvers` member of a plugin's API extension definition is typed as an
 * array of classes [packages/core/src/plugin/vendure-plugin.ts:L100], so the same map has to be
 * expressed as decorated methods. The discrimination *expression* below is deliberately the one core
 * uses, so a plugin-owned union and a platform-owned union behave identically for a client.
 *
 * Nothing in this file is re-exported from the package's root barrel. It is internal surface: the
 * plugin class registers it, and no consumer constructs it.
 */
import { ResolveField, Resolver } from '@nestjs/graphql';
import { isGraphQlErrorResult } from '@vendure/core';

import {
    AddItemToReorderListResult,
    AdjustReorderListLineResult,
    CreateReorderListResult,
    DeleteReorderListResult,
    RemoveReorderListLineResult,
    ReorderListLimitError,
    ReorderListLineNotFoundError,
    ReorderListNameConflictError,
    ReorderListNotFoundError,
    reportReorderListInternalFailure,
    UpdateReorderListResult,
} from '../service/reorder-list.service';

/**
 * The name of every result union this plugin publishes, spelled exactly as
 * [packages/reorder-plugin/src/api/api-extensions.ts] declares it.
 *
 * These strings are held here, once each, because each of them is needed in two places: as the parent
 * type of a field resolver, and in the diagnostic raised when a value cannot be discriminated. A
 * union name that disagrees with the SDL is not a compile error — it produces a resolver map keyed on
 * a type the schema does not have, which shows up only when a client executes the operation — so the
 * two uses are made to read from one constant rather than from two literals that can drift apart.
 */
const RESULT_UNION = {
    createReorderList: 'CreateReorderListResult',
    updateReorderList: 'UpdateReorderListResult',
    deleteReorderList: 'DeleteReorderListResult',
    addItemToReorderList: 'AddItemToReorderListResult',
    adjustReorderListLine: 'AdjustReorderListLineResult',
    removeReorderListLine: 'RemoveReorderListLineResult',
} as const;

/** The name of one of the six result unions declared by this plugin's SDL document. */
type ResultUnionName = (typeof RESULT_UNION)[keyof typeof RESULT_UNION];

/**
 * The success member of five of the six unions: the saved list itself, returned by every write that
 * leaves a list in place.
 */
const REORDER_LIST_TYPE_NAME = 'ReorderList';

/**
 * The success member of `DeleteReorderListResult`: the platform's own `DeletionResponse`, reused
 * verbatim rather than replaced by a plugin-owned deletion payload.
 *
 * The annotation is doing real work. It derives the permitted value from the service's own declaration
 * of the union's success member, so a mistyped literal here fails to *compile* instead of producing an
 * unresolvable type at run time. It is the one type name in this file that can be checked that way —
 * the other success member is a TypeORM entity class, which carries no `__typename` to derive from.
 */
const DELETION_RESPONSE_TYPE_NAME: NonNullable<
    Exclude<DeleteReorderListResult, ReorderListNotFoundError>['__typename']
> = 'DeletionResponse';

/**
 * The four error results this feature owns. They are imported rather than restated: the service
 * declares each one with its own `readonly __typename`, and a second declaration of the same type
 * would be a second authority for it.
 */
type ReorderListErrorResult =
    | ReorderListLimitError
    | ReorderListLineNotFoundError
    | ReorderListNameConflictError
    | ReorderListNotFoundError;

/** The success member of a result union: a saved list, or the platform deletion payload. */
type ReorderListSuccessTypeName = typeof REORDER_LIST_TYPE_NAME | typeof DELETION_RESPONSE_TYPE_NAME;

/**
 * Every concrete type name a `__resolveType` in this file can return — the two success members plus
 * the four error results, the last derived from the error classes themselves so the four names are
 * never spelled out a second time.
 */
type ReorderListResultTypeName = ReorderListSuccessTypeName | ReorderListErrorResult['__typename'];

/**
 * Any value that may arrive for discrimination: the union of all six published result unions, which
 * reduces to a saved list, the deletion payload, or one of the four error results.
 */
type ReorderListResult =
    | AddItemToReorderListResult
    | AdjustReorderListLineResult
    | CreateReorderListResult
    | DeleteReorderListResult
    | RemoveReorderListLineResult
    | UpdateReorderListResult;

/**
 * @description
 * Resolves the concrete object type of every result union published by the `ReorderPlugin`, so that a
 * client can select on `... on ReorderList`, `... on DeletionResponse` or any of the four error
 * results and have the executor pick the right one.
 *
 * Registered through the plugin's `shopApiExtensions.resolvers` array alongside the operation and
 * field resolvers. It holds no state, injects nothing, and issues no database statement: the answer is
 * already present in the value the service returned.
 *
 * Every one of the six unions has exactly one success member, so the discrimination is a single
 * question — is this an error result? — and the platform's own predicate answers it. There is no
 * guessing at a success payload's shape, because the negative branch of that question is already the
 * answer.
 *
 * @example
 * ```ts
 * // In the plugin metadata:
 * shopApiExtensions: {
 *     schema: shopApiExtensions,
 *     resolvers: [ReorderListShopResolver, ReorderListEntityResolver, ReorderListResultResolver],
 * }
 * ```
 *
 * @docsCategory core plugins/ReorderPlugin
 * @docsPage ReorderListResultResolver
 * @since 3.8.0
 */
@Resolver()
export class ReorderListResultResolver {
    /*
     * THE DECORATOR ORDER BELOW IS LOAD-BEARING. DO NOT SWAP THE TWO LINES.
     *
     * `@Resolver(name)` in its method form writes BOTH the resolver-type metadata and the resolver-
     * NAME metadata [@nestjs/graphql/dist/decorators/resolvers.utils.js: addResolverMetadata], while
     * `@ResolveField(propertyName)` writes the resolver-name metadata and the property-resolver flag
     * [@nestjs/graphql/dist/decorators/resolve-field.decorator.js]. They write the same name key, and
     * TypeScript applies decorators bottom-up, so the TOPMOST one writes last and wins.
     *
     *   @ResolveField('__resolveType')   ← applied last  ⇒ name  = '__resolveType'   ✔
     *   @Resolver('CreateReorderListResult')  ← applied first ⇒ type = the union name  ✔
     *
     * Reversed, the name stays the union's own name and the resolver map becomes
     * `{ CreateReorderListResult: { CreateReorderListResult: fn } }` — a field named after the union
     * and no `__resolveType` at all. Nothing fails to compile and the server still boots; the first
     * client to execute the mutation gets `Abstract type ... must resolve to an Object type at
     * runtime`.
     *
     * Both decorators are also required, for two separate reasons. The method-level `@Resolver(name)`
     * supplies the parent type — it takes precedence over the class-level one
     * [@nestjs/graphql/dist/utils/extract-metadata.util.js], which is what lets one class serve six
     * different unions. And `@ResolveField` sets the property-resolver flag, without which the
     * explorer's filter drops the method entirely, because the parent type is not Query, Mutation or
     * Subscription [@nestjs/graphql/dist/services/resolvers-explorer.service.js].
     *
     * The six method names are consequently distinct and none of them is `__resolveType`: a class
     * cannot declare that method six times, which is exactly why the named overload of
     * `@ResolveField` is used. Renaming any of them to `__resolveType` would work, but only one could
     * be — so they stay named after the union they serve.
     *
     * No `@Allow` and no parameter decorator appears on any of them, and neither is an oversight. A
     * union's `__resolveType` runs on a payload produced by an operation that has already passed its
     * own gate, so there is nothing left to authorise. The platform's guard does run on these
     * methods: `configure-graphql-module.ts:L105` sets `fieldResolverEnhancers: ['guards']`, which
     * ENABLES guards on field resolvers rather than disabling them, and the framework's own exemption
     * — `{ guards: false, filters: false, interceptors: false }` — is applied only to a handler whose
     * method name is literally `__resolveType`
     * [@nestjs/graphql/dist/services/resolvers-explorer.service.js], which none of these six is, for
     * the reason above.
     *
     * What makes the guard harmless is therefore the branch it takes, not an exemption.
     * `AuthGuard.canActivate` parses the execution context first, asks whether the target is a field
     * resolver, reads the permissions metadata off the handler, and returns `true` immediately for a
     * field resolver that declares none — before it extracts a session or resolves a request context
     * [packages/core/src/api/middleware/auth-guard.ts]. So a permissionless field resolver is admitted
     * by that early return, having had only its context parsed. Core's own entity field resolvers rely
     * on the same branch; the handful that do declare `@Allow` — `tax-rate-entity.resolver.ts` among
     * them — deliberately take the session path instead, which is exactly the difference these six
     * must not have.
     *
     * Adding `@Allow` would put permissions metadata on the handler, which is exactly what steers the
     * guard past that early return and into its session-handling path — where a type resolution has
     * no request to offer it: the executor calls a type resolver as
     * `(value, context, info, abstractType)`, one argument ahead of the field-resolver shape the
     * platform reads a request from. Leaving the parameters bare is what keeps the payload in the
     * first position, since Nest passes the executor's own arguments straight through when a handler
     * decorates none of them.
     */

    /**
     * @description
     * Discriminates `CreateReorderListResult`: the created list, a name conflict, or the
     * per-customer list limit.
     *
     * @since 3.8.0
     */
    @ResolveField('__resolveType')
    @Resolver(RESULT_UNION.createReorderList)
    createReorderListResult(value: CreateReorderListResult): ReorderListResultTypeName {
        return this.resolveTypeName(value, REORDER_LIST_TYPE_NAME, RESULT_UNION.createReorderList);
    }

    /**
     * @description
     * Discriminates `UpdateReorderListResult`: the renamed list, a list that did not resolve under the
     * ownership predicate, or a name conflict.
     *
     * @since 3.8.0
     */
    @ResolveField('__resolveType')
    @Resolver(RESULT_UNION.updateReorderList)
    updateReorderListResult(value: UpdateReorderListResult): ReorderListResultTypeName {
        return this.resolveTypeName(value, REORDER_LIST_TYPE_NAME, RESULT_UNION.updateReorderList);
    }

    /**
     * @description
     * Discriminates `DeleteReorderListResult`. This is the one union whose success member is not a
     * saved list: a deletion has no list left to return, so it reports the platform's own
     * `DeletionResponse` instead.
     *
     * @since 3.8.0
     */
    @ResolveField('__resolveType')
    @Resolver(RESULT_UNION.deleteReorderList)
    deleteReorderListResult(value: DeleteReorderListResult): ReorderListResultTypeName {
        return this.resolveTypeName(value, DELETION_RESPONSE_TYPE_NAME, RESULT_UNION.deleteReorderList);
    }

    /**
     * @description
     * Discriminates `AddItemToReorderListResult`: the list the line was added to or accumulated onto,
     * a list that did not resolve, or the per-list line limit.
     *
     * @since 3.8.0
     */
    @ResolveField('__resolveType')
    @Resolver(RESULT_UNION.addItemToReorderList)
    addItemToReorderListResult(value: AddItemToReorderListResult): ReorderListResultTypeName {
        return this.resolveTypeName(value, REORDER_LIST_TYPE_NAME, RESULT_UNION.addItemToReorderList);
    }

    /**
     * @description
     * Discriminates `AdjustReorderListLineResult`: the list carrying the adjusted line, a list that
     * did not resolve, or a line absent from the addressed list.
     *
     * @since 3.8.0
     */
    @ResolveField('__resolveType')
    @Resolver(RESULT_UNION.adjustReorderListLine)
    adjustReorderListLineResult(value: AdjustReorderListLineResult): ReorderListResultTypeName {
        return this.resolveTypeName(value, REORDER_LIST_TYPE_NAME, RESULT_UNION.adjustReorderListLine);
    }

    /**
     * @description
     * Discriminates `RemoveReorderListLineResult`: the list the line was removed from, a list that did
     * not resolve, or a line absent from the addressed list.
     *
     * @since 3.8.0
     */
    @ResolveField('__resolveType')
    @Resolver(RESULT_UNION.removeReorderListLine)
    removeReorderListLineResult(value: RemoveReorderListLineResult): ReorderListResultTypeName {
        return this.resolveTypeName(value, REORDER_LIST_TYPE_NAME, RESULT_UNION.removeReorderListLine);
    }

    /**
     * Names the concrete type of one resolved union value.
     *
     * The expression is core's own: an error result reports the type name it already carries, and
     * anything else is the union's single success member. Reading the name off the value rather than
     * mapping an error code to it means a name can only ever be wrong in the one place it is
     * declared, and the platform's predicate is what decides which branch applies — a value is an
     * error result when it carries an error code, a message and a type name
     * [packages/core/src/common/error/error-result.ts].
     *
     * The success branch deliberately does not inspect the payload. Every union here has exactly one
     * success member, so "not an error result" already identifies it; probing for a `name`, a
     * `lineCount` or a `result` field would add a second, weaker answer to a question that has
     * already been answered, and would misreport a valid payload the day a column is renamed.
     *
     * A value that is not an object at all cannot be discriminated either way, so it raises rather
     * than resolving to a guess — the treatment core gives an unresolvable union value
     * [packages/core/src/api/config/generate-resolvers.ts]. The executor calls a type resolver only
     * for a non-null value, so this is unreachable through the published operations; it is here
     * because the alternative to raising is answering `ReorderList` for something that is not one,
     * and that surfaces far from its cause.
     *
     * **The diagnostic goes to the log and the caller gets the plugin's one generic internal error.**
     * That split is what `reportReorderListInternalFailure` exists for, and it closes two things a
     * locally-constructed error would leave open. The API-visible message carries no part of the
     * value: the union name says which operation misbehaved, which is server detail, and the payload
     * itself can hold buyer-supplied text. And the returned error's frame list is replaced, because
     * this file's own log line is not the last one written about it — the platform's exception filter
     * logs `exception.stack` for every error a resolver raises, so an error sanitised here and thrown
     * with its frames intact would still deposit absolute build paths and internal call structure in
     * the application log. The log line carries a fixed sentence naming the union, the shape received
     * as one of a closed set of type words, and a fresh correlation id.
     *
     * @param value - The value the operation resolved to.
     * @param successTypeName - The name of the union's single success member.
     * @param unionTypeName - The union being discriminated, named in the logged diagnostic only.
     * @throws The plugin's generic, stack-sanitised `InternalServerError` when the value is not an
     * object.
     */
    private resolveTypeName(
        value: ReorderListResult,
        successTypeName: ReorderListSuccessTypeName,
        unionTypeName: ResultUnionName,
    ): ReorderListResultTypeName {
        if (value == null || typeof value !== 'object') {
            // `typeof` for everything else, so the logged shape is one of a fixed set of words rather
            // than anything derived from the value itself.
            const received = value === null ? 'null' : typeof value;
            throw reportReorderListInternalFailure(
                `No __resolveType could be determined for the "${unionTypeName}" union: ` +
                    `expected an object payload but received "${received}"`,
            );
        }
        if (isGraphQlErrorResult(value)) {
            return value.__typename;
        }
        return successTypeName;
    }
}
