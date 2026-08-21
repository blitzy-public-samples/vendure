/**
 * The instrument that lets a barrier participant run **the production operation itself** inside the
 * transaction the barrier is holding open for it.
 *
 * ## The gap this closes
 *
 * `runBarrieredPair` gives each participant a query runner with its own transaction already open, runs both
 * prechecks, holds both participants at a rendezvous, releases them together, and only then lets either write.
 * That machinery is sound; what a race case does with it decides whether the claim holds. Running the
 * precheck on the participant's held connection and then sending the *write* somewhere else entirely — over
 * HTTP to the running server, which opens a transaction of its own on a connection the barrier has never
 * heard of, or through a hand-written statement that resembles the service's but is not it — proves something
 * else. One shape proves that two HTTP calls made at roughly the same time produce one winner; the other
 * proves that a statement the test wrote behaves as the test expects. Neither proves anything about the
 * interleaving the production code performs, because in neither case are the two production transactions the
 * two transactions the barrier held.
 *
 * It is often assumed that a participant cannot borrow the service's transaction, and must therefore issue
 * the statement itself on the connection the barrier holds. It can borrow it, and this module is how.
 *
 * ## How
 *
 * A Vendure service reaches the database through `TransactionalConnection`, which resolves its entity manager
 * from a symbol-keyed property on the `RequestContext`
 * (`packages/core/src/connection/transactional-connection.ts` L470-L472). `TransactionWrapper` reads the same
 * property and, finding a manager whose query runner is alive, **inherits that runner instead of creating one**
 * (`packages/core/src/connection/transaction-wrapper.ts` L36-L41). So attaching a barrier participant's own
 * manager to a request context and calling the real service method makes every statement of that method run on
 * the participant's connection, inside the transaction the barrier is holding.
 *
 * Three properties of that arrangement make it safe rather than merely clever, and all three were read out of
 * the installed sources rather than assumed:
 *
 * - **The service's own transaction nests instead of colliding.** Each of this plugin's write methods opens
 *   `connection.withTransaction(ctx, …)`, which reaches `startTransaction` on the inherited runner. TypeORM
 *   issues `SAVEPOINT typeorm_N` rather than a second `START TRANSACTION` when the depth is already non-zero
 *   (`node_modules/typeorm/driver/postgres/PostgresQueryRunner.js` L121-L130), and the matching commit issues
 *   `RELEASE SAVEPOINT` and leaves the outer transaction open (L141-L147).
 * - **The barrier keeps ownership of the transaction.** `TransactionWrapper` releases the query runner only
 *   when it created it (`transaction-wrapper.ts`, the `finally` block), so the participant's runner survives the
 *   call and the barrier commits or rolls it back exactly as it does for any other participant.
 * - **The locks the service takes are held for the whole window.** Because the outer transaction is still open
 *   when the service returns, a `SELECT … FOR UPDATE` the service issued is still held — which is the entire
 *   point. The sibling participant blocks on it until the barrier commits, and that is the production
 *   interleaving rather than a simulation of it.
 *
 * ## What the context is, and why it is not built by hand
 *
 * The context handed to the service is the one the platform's own guard would build:
 * `RequestContextService.fromRequest(request, undefined, [Permission.Owner], session)`, from a session resolved
 * out of a real Shop API auth token. `RequestContextService.create()` is deliberately not used — it hard-codes
 * `authorizedAsOwnerOnly` to false, whereas `fromRequest` is the path the `@Allow(Permission.Owner)` gate
 * itself takes, and this plugin's whole access control turns on that flag being set the way the gate sets it.
 * {@link resolveOwnerRequestContext} asserts the flag rather than trusting it, so a mis-wired gate fails at
 * setup with a diagnostic instead of yielding a race that quietly proves nothing.
 *
 * The obligations it serves are EPIC-001 section 7.8's requirement that a race claim rest on an explicit
 * barrier and section 11.6.3's exclusion of `e2e-sqljs` from concurrency evidence.
 *
 * @since 3.8.0
 */
import { Type } from '@nestjs/common';
import {
    ConfigService,
    Permission,
    RequestContext,
    RequestContextService,
    SessionService,
    TransactionalConnection,
} from '@vendure/core';
import { TRANSACTION_MANAGER_KEY } from '@vendure/core/dist/common/constants';
import { EntityManager, QueryRunner } from 'typeorm';

/**
 * The key discovered from the running platform by {@link resolveTransactionManagerKey}, cached because it is a
 * property of the loaded server rather than of any one call, and every participant in a suite binds against the
 * same server.
 */
let platformTransactionManagerKey: symbol | undefined;

/**
 * @description
 * The part of a Nest application this module needs: the ability to resolve a provider.
 *
 * Declared structurally rather than imported as `INestApplication` so that a caller can pass
 * `server.app` without this module taking a dependency on the whole application surface.
 */
export interface ProviderResolver {
    get<T>(typeOrToken: Type<T>): T;
}

/**
 * @description
 * The part of a barrier participant context this module needs: its label, for diagnostics, and the query
 * runner whose transaction the production operation is to run inside.
 *
 * Declared structurally so that this module and `concurrency-barrier.ts` need not import each other.
 */
export interface TransactionHost {
    readonly label: string;
    readonly queryRunner: QueryRunner;
}

/**
 * @description
 * Builds the gated, owner-only `RequestContext` the platform's own auth guard would build for a Shop API
 * request carrying `authToken` and `channelToken`.
 *
 * @param app - The running server's Nest application, for resolving `SessionService`, `RequestContextService`
 * and `ConfigService`.
 * @param authToken - A bearer token from a signed-in Shop API client.
 * @param channelToken - The channel token the request would carry, which decides the context's active channel
 * and therefore the channel half of this plugin's ownership predicate.
 * @throws Where the token resolves to no session, or where the resulting context is not marked owner-only —
 * either of which would make a race run against this context evidence of nothing.
 * @since 3.8.0
 */
export async function resolveOwnerRequestContext(
    app: ProviderResolver,
    authToken: string,
    channelToken: string,
): Promise<RequestContext> {
    const session = await app.get(SessionService).getSessionFromToken(authToken);
    if (session === undefined) {
        throw new Error(
            'the Shop API auth token resolved to no session, so no owner-only context can be built from it',
        );
    }
    const channelTokenKey = app.get(ConfigService).apiOptions.channelTokenKey ?? 'vendure-token';
    const request = { query: {}, headers: { [channelTokenKey]: channelToken } };
    const ctx = await app
        .get(RequestContextService)
        .fromRequest(request as never, undefined, [Permission.Owner], session);
    if (ctx.authorizedAsOwnerOnly !== true) {
        throw new Error(
            'the resolved context is not marked authorizedAsOwnerOnly, so it is not the context the ' +
                '@Allow(Permission.Owner) gate produces and a race run against it evidences nothing',
        );
    }
    if (ctx.channel.token !== channelToken) {
        throw new Error(
            `the resolved context's active channel token is "${ctx.channel.token}" rather than ` +
                `"${channelToken}"`,
        );
    }
    // The transaction-manager key is resolved HERE, from the running platform, because this is the one call
    // every racing suite already makes and the one place that holds the application. See
    // {@link resolveTransactionManagerKey} for why it is discovered rather than imported.
    await resolveTransactionManagerKey(app, ctx);
    return ctx;
}

/**
 * @description
 * The symbol-keyed property the RUNNING platform reads its transactional entity manager from, discovered from
 * the platform itself rather than trusted from an import.
 *
 * ★ WHY THIS IS DISCOVERED AND NOT IMPORTED, and why the fixture carries a post-condition for it.
 * `TRANSACTION_MANAGER_KEY` is `Symbol('TRANSACTION_MANAGER')` — a fresh, unique value each time that module
 * is instantiated. Setting the binding under the symbol reached by the deep import
 * `@vendure/core/dist/common/constants` is the same value as the server's ONLY while both load a single
 * instance of that module. Under the e2e runner they do not: the suite's import is transformed by Vite while
 * the server reaches the same file through Node's own CommonJS require, so two `Symbol()` values exist and a
 *
 * @param providers - The running server's Nest application, for resolving `TransactionalConnection`.
 * @param ctx - Any valid context; it is neither mutated nor written through.
 * @throws Where the platform's own transaction context carries no entity-manager-bearing symbol, which would
 * mean this mechanism no longer matches the platform and every race in these suites must be re-derived rather
 * than silently degraded.
 * @since 3.8.0
 */
export async function resolveTransactionManagerKey(
    providers: ProviderResolver,
    ctx: RequestContext,
): Promise<symbol> {
    if (platformTransactionManagerKey !== undefined) {
        return platformTransactionManagerKey;
    }
    let discovered: symbol | undefined;
    await providers.get(TransactionalConnection).withTransaction(ctx, (transactionCtx: RequestContext) => {
        discovered = Object.getOwnPropertySymbols(transactionCtx).find(candidate => {
            const value = (transactionCtx as unknown as Record<symbol, unknown>)[candidate];
            return value instanceof EntityManager;
        });
        return Promise.resolve();
    });
    if (discovered === undefined) {
        throw new Error(
            'the platform opened a transaction without leaving an EntityManager under any symbol on the ' +
                'context it handed the callback, so the transaction-manager binding this fixture relies on no ' +
                'longer exists; the race suites cannot run the production path inside a held transaction until ' +
                'this is re-derived against the installed @vendure/core',
        );
    }
    platformTransactionManagerKey = discovered;
    return discovered;
}

/**
 * @description
 * Returns a copy of `ctx` whose database access is bound to `queryRunner`'s already-open transaction.
 *
 * @throws Where the runner is released or has no open transaction, because binding to either would let the
 * service silently open a transaction of its own and reintroduce the very gap this module closes.
 * @since 3.8.0
 */
export function boundToTransaction(ctx: RequestContext, queryRunner: QueryRunner): RequestContext {
    if (queryRunner.isReleased) {
        throw new Error('cannot bind a context to a released query runner');
    }
    if (!queryRunner.isTransactionActive) {
        throw new Error(
            'cannot bind a context to a query runner with no open transaction; the barrier opens one before ' +
                'it invokes a participant phase, so this means the runner is not the one the barrier handed over',
        );
    }
    const bound = ctx.copy();
    // The key the RUNNING platform reads, where it has been discovered; the deep import only as a fallback for
    // a caller that binds without having resolved an owner context first. See
    // {@link resolveTransactionManagerKey} for why the imported symbol is not trusted on its own.
    (bound as unknown as Record<symbol, unknown>)[platformTransactionManagerKey ?? TRANSACTION_MANAGER_KEY] =
        queryRunner.manager;
    return bound;
}

/**
 * @description
 * Runs `operation` — a call to the real service method — inside `host`'s own open transaction, and verifies
 * afterwards that the transaction is still this participant's to commit.
 *
 * The post-conditions are the ones that distinguish "the service ran in my transaction" from "the service ran
 * somewhere else and I did not notice": a service that had opened and committed a transaction of its own would
 * leave this runner untouched but its own locks released, and a service that had committed *this* transaction
 * would leave `isTransactionActive` false and the barrier with nothing to commit. Both are refused here rather
 * than left to surface as a puzzling race outcome.
 *
 * @param host - The barrier participant whose transaction the operation is to run inside.
 * @param ctx - An owner-only context from {@link resolveOwnerRequestContext}. It is not mutated; a bound copy
 * is made for the call.
 * @param operation - Invokes the production service method with the context it is handed. It must pass that
 * context straight through: substituting another one puts the statements back on a connection of the
 * platform's choosing.
 * @since 3.8.0
 */
export async function runInParticipantTransaction<T>(
    host: TransactionHost,
    ctx: RequestContext,
    operation: (serviceCtx: RequestContext) => Promise<T>,
): Promise<T> {
    const bound = boundToTransaction(ctx, host.queryRunner);
    /*
     * ★ THE POST-CONDITION THAT MAKES THE CLAIM FALSIFIABLE, and it exists because the previous revision's
     * post-conditions did not. Those two checked that this runner still had an open transaction afterwards —
     * which is exactly as true when the service ran somewhere else entirely, since a service that opens and
     * commits a transaction of its own leaves this runner untouched. The binding could therefore fail silently
     * and every assertion downstream still passed, because the outcomes a barrier produces from two concurrent
     * service calls on their own connections often match the outcomes it produces from two held transactions.
     */
    const runner = host.queryRunner as QueryRunner & { query: QueryRunner['query'] };
    const uninstrumentedQuery = runner.query.bind(runner);
    let statementsOnThisRunner = 0;
    runner.query = ((...args: Parameters<QueryRunner['query']>) => {
        statementsOnThisRunner += 1;
        return uninstrumentedQuery(...args);
    }) as QueryRunner['query'];
    let result: T;
    try {
        result = await operation(bound);
    } finally {
        runner.query = uninstrumentedQuery;
    }
    if (statementsOnThisRunner === 0) {
        throw new Error(
            `${host.label}: the production operation issued no statement on the barrier's own query runner, so ` +
                'it ran on a connection the barrier does not hold and no lock it took is inside this ' +
                'transaction. The context binding did not reach the platform — check that the transaction ' +
                'manager key was resolved from the running server rather than imported, which ' +
                'resolveTransactionManagerKey exists to guarantee.',
        );
    }
    if (host.queryRunner.isReleased) {
        throw new Error(
            `${host.label}: the production operation released the barrier's query runner; the barrier can no ` +
                'longer commit or roll back its own transaction',
        );
    }
    if (!host.queryRunner.isTransactionActive) {
        throw new Error(
            `${host.label}: the production operation committed or rolled back the barrier's own transaction ` +
                'rather than the savepoint it opened inside it, so no lock it took is still held and the ' +
                'interleaving this case claims did not happen',
        );
    }
    return result;
}
