/**
 * Every line write this service issues carries its ownership predicate in a correlated `EXISTS` sub-query over
 * the PARENT table, because a line row stores neither a customer nor a channel and the write must still be the
 * one statement whose affected-row count is the authority (FEATURE-001-01 section 2.11). That sub-query is a raw
 * fragment the service renders itself, and this suite exists for one property of it: **the table it names must
 * be the table the statement's own target names**, on a connection that qualifies its identifiers.
 *
 * ## Why a suite of its own, and why it cannot be folded into another
 *
 * TypeORM renders a statement's target from `EntityMetadata.tablePath`, which is
 * `driver.buildTableName(tableName, schema, database)`. On the default configuration nothing is configured, the
 * path is the bare table name, and a fragment naming `"reorder_list"` and one naming
 * `"public"."reorder_list"` behave identically — so **no test of a default deployment can see the difference**.
 * Configure PostgreSQL's `schema` (which `packages/dev-server/dev-config.ts` exposes as `DB_SCHEMA`) and the two
 * part company: the `UPDATE` and `DELETE` targets become qualified, while a bare sub-query resolves through the
 * connection's search path instead. Where no same-named table exists there, the statement fails; where one DOES
 * exist, the ownership question is answered from rows the deployment does not own. Identifiers are allocated
 * sequentially by the default strategy, so a row of the same id in a same-named table is ordinary rather than
 * contrived.
 *
 * Every other suite in this package runs on the harness's own configuration, which sets no schema. This one
 * therefore builds its own: an isolated database, the full entity set synchronised into a NON-PUBLIC schema, and
 * a DECOY set of the same tables in `public` carrying a row that would answer the ownership question wrongly.
 * The service is then constructed directly against that connection and its three line-writing paths are
 * exercised for real.
 *
 * ## What it proves and what it deliberately does not
 *
 * The observable direction is refusal. The real row in the configured schema belongs to the acting customer and
 * the decoy in `public` belongs to somebody else, so a sub-query that reads the decoy refuses a write the
 * contract requires to succeed — and that is visible end to end, on a real engine, as the wrong outcome.
 *
 * The opposite direction — a sub-query that AUTHORISES against the decoy — is not observable through the whole
 * operation, and saying so is more useful than implying otherwise: each line-writing path resolves the list
 * under the same three conjuncts through the query builder first, and that read is qualified by TypeORM, so it
 * refuses before any statement carrying the fragment is issued. The two mechanisms are deliberate defence in
 * depth (see `ReorderListService.ownedListExistsClause`), and the fragment's own correctness in that direction
 * is asserted where it can be: the unit spec renders it under a schema-qualified, a database-qualified and an
 * unqualified path, and refuses the two spellings that would break it.
 *
 * ## Engine scope
 *
 * PostgreSQL only, and the skip is a statement rather than an omission. A schema is what PostgreSQL qualifies
 * with; the MySQL family qualifies with a database, which the same rendering handles and which the unit spec
 * covers under a two-segment path; and the in-process SQLite engine has neither. The harness's initializers
 * offer no non-public-schema server, which is why this suite builds its connections itself rather than asking
 * for one.
 */
import { CurrencyCode, LanguageCode } from '@vendure/common/lib/generated-types';
import {
    Channel,
    Customer,
    DefaultEntityAccessControlStrategy,
    mergeConfig,
    Product,
    ProductVariant,
    RequestContext,
    RequestContextCacheService,
    TransactionalConnection,
    User,
} from '@vendure/core';
import { preBootstrapConfig } from '@vendure/core/dist/bootstrap';
import { TransactionWrapper } from '@vendure/core/dist/connection/transaction-wrapper';
import { DataSource, DataSourceOptions } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { testConfig } from '../../../e2e-common/test-config';
import { ReorderPlugin } from '../index';
import { ReorderListLine } from '../src/entities/reorder-list-line.entity';
import { ReorderList } from '../src/entities/reorder-list.entity';
import { ReorderListService } from '../src/service/reorder-list.service';
import { ReorderPluginOptions } from '../src/types';

import {
    attemptEveryCleanup,
    createIsolatedDatabase,
    IsolatedDatabase,
    openDataSource,
    restorePlatformConfig,
} from './fixtures/migration-state';

/** The non-public schema the real rows live in — the one a `DB_SCHEMA` deployment would configure. */
const CONFIGURED_SCHEMA = 'reorder_alt';

/** The schema a bare, unqualified reference resolves to through PostgreSQL's default search path. */
const SEARCH_PATH_SCHEMA = 'public';

/**
 * How far the decoy owner's identifiers are moved away from the real owner's.
 *
 * Each schema has its own sequences, so rows seeded independently into the two are allocated the SAME
 * identifiers — which would make the decoy answer the ownership question correctly by coincidence and this suite
 * unable to fail. The offset is what makes the decoy's answer demonstrably the wrong one.
 */
const DECOY_OWNER_OFFSET = 1000;

/** The options the plugin declares, so the bounds these paths consult are the shipped ones. */
const DECLARED_OPTIONS: Readonly<Required<ReorderPluginOptions>> = {
    maxListsPerCustomer: 25,
    maxLinesPerList: 200,
    maxQuantityPerLine: 999,
    defaultReorderListsPageSize: 25,
    defaultReorderListLinesPageSize: 50,
};

const engine = String((testConfig().dbConnectionOptions as unknown as { type: string }).type);
const runsOnThisEngine = engine === 'postgres';

describe.skipIf(!runsOnThisEngine)(
    'the ownership predicate on a connection that qualifies its identifiers (PostgreSQL)',
    () => {
        let isolation: IsolatedDatabase;
        let configuredDataSource: DataSource;
        let decoyDataSource: DataSource;
        let service: ReorderListService;
        let ctx: RequestContext;
        let seeded: SeededRows;

        beforeAll(async () => {
            isolation = await createIsolatedDatabase(testConfig(), engine, 'schema_qualified');
            await createSchema(isolation, CONFIGURED_SCHEMA);

            // The full entity set, synchronised twice: once into the schema this deployment configures, and once
            // into `public`, which is where a bare reference would land. Both are real schemas carrying real
            // tables, so the difference between the two spellings is a difference between two live tables rather
            // than a hypothesis.
            configuredDataSource = await synchronisedDataSource(isolation, CONFIGURED_SCHEMA);
            decoyDataSource = await synchronisedDataSource(isolation, SEARCH_PATH_SCHEMA);

            seeded = await seedConfiguredSchema(configuredDataSource);
            await seedDecoySchema(decoyDataSource, seeded);

            service = buildService(configuredDataSource);
            ctx = buildContext(seeded);
        }, 240_000);

        afterAll(async () => {
            // Each resource its own attempted step: the two data sources are independent of one another and the
            // isolated database must be dropped whatever either of them does, or the next run inherits it.
            await attemptEveryCleanup([
                {
                    what: 'closing the configured-schema data source',
                    run: () => configuredDataSource?.destroy(),
                },
                { what: 'closing the decoy-schema data source', run: () => decoyDataSource?.destroy() },
                { what: 'dropping the isolated database', run: () => isolation?.dispose() },
                {
                    what: 'restoring the platform configuration this suite resolved',
                    run: () => restorePlatformConfig(testConfig()),
                },
            ]);
        }, 120_000);

        it('resolves the plugin tables to the configured schema, not to the search path', () => {
            // The premise every assertion below rests on, read off the live metadata rather than assumed: this
            // connection qualifies, and it qualifies with the schema this suite configured. Were this bare, the
            // suite would be testing nothing and would say so here.
            expect(configuredDataSource.getMetadata(ReorderList).tablePath).toBe(
                `${CONFIGURED_SCHEMA}.reorder_list`,
            );
            expect(configuredDataSource.getMetadata(ReorderListLine).tablePath).toBe(
                `${CONFIGURED_SCHEMA}.reorder_list_line`,
            );
            expect(decoyDataSource.getMetadata(ReorderList).tablePath).toBe(
                `${SEARCH_PATH_SCHEMA}.reorder_list`,
            );
        });

        it('carries a decoy list of the same id in the search-path schema, owned by somebody else', async () => {
            // The adversarial fixture itself, asserted rather than trusted. The decoy shares the real list's
            // identifier — sequential ids make that ordinary — and names a different customer, so a sub-query
            // that reads it cannot answer the ownership question correctly for this caller.
            const decoy = await decoyDataSource
                .createQueryBuilder()
                .select(['list.id AS id', 'list.customerId AS "customerId"'])
                .from(ReorderList, 'list')
                .where('list.id = :id', { id: seeded.listId })
                .getRawOne<{ id: number; customerId: number }>();
            expect(decoy, 'the decoy list row was not created').toBeDefined();
            expect(Number(decoy?.customerId)).not.toBe(seeded.customerId);
        });

        it('sets an absolute quantity on the configured schema, leaving the decoy untouched', async () => {
            const result = await service.adjustReorderListLine(ctx, {
                reorderListId: seeded.listId,
                lineId: seeded.lineId,
                quantity: 7,
            });

            expect(result).toBeInstanceOf(ReorderList);
            expect(await quantityIn(configuredDataSource, seeded.lineId)).toBe(7);
            expect(await quantityIn(decoyDataSource, seeded.lineId)).toBe(1);
        });

        it('accumulates onto an existing line of the configured schema', async () => {
            const before = await quantityIn(configuredDataSource, seeded.lineId);

            const result = await service.addItemToReorderList(ctx, {
                reorderListId: seeded.listId,
                productVariantId: seeded.variantId,
                quantity: 2,
            });

            expect(result).toBeInstanceOf(ReorderList);
            expect(before, 'the line this test accumulates onto is missing').toBeDefined();
            expect(await quantityIn(configuredDataSource, seeded.lineId)).toBe((before ?? 0) + 2);
            expect(await quantityIn(decoyDataSource, seeded.lineId)).toBe(1);
        });

        it('inserts a new line and claims capacity on the configured schema', async () => {
            const result = await service.addItemToReorderList(ctx, {
                reorderListId: seeded.listId,
                productVariantId: seeded.secondVariantId,
                quantity: 3,
            });

            expect(result).toBeInstanceOf(ReorderList);
            expect(await lineCountIn(configuredDataSource, seeded.listId)).toBe(2);
            // The parent counter of the decoy list is untouched, which is the same claim for the statement that
            // writes `lineCount` as the line assertions are for the statements that write a line.
            expect(await lineCountIn(decoyDataSource, seeded.listId)).toBe(1);
        });

        it('removes a line from the configured schema and decrements only its own counter', async () => {
            const result = await service.removeReorderListLine(ctx, {
                reorderListId: seeded.listId,
                lineId: seeded.lineId,
            });

            expect(result).toBeInstanceOf(ReorderList);
            expect(await quantityIn(configuredDataSource, seeded.lineId)).toBeUndefined();
            expect(await lineCountIn(configuredDataSource, seeded.listId)).toBe(1);
            // Still there, still one: nothing this suite ran addressed the search-path schema at all.
            expect(await quantityIn(decoyDataSource, seeded.lineId)).toBe(1);
            expect(await lineCountIn(decoyDataSource, seeded.listId)).toBe(1);
        });
    },
);

/** What the configured schema was seeded with, carried to the decoy seeder and to the service builder. */
interface SeededRows {
    channelId: number;
    userId: number;
    customerId: number;
    listId: number;
    lineId: number;
    variantId: number;
    secondVariantId: number;
}

/**
 * Creates a schema in the isolated database.
 *
 * Nothing in TypeORM does this during synchronisation — `RdbmsSchemaBuilder` creates tables, indices, checks and
 * foreign keys and never a schema — so a configuration naming one that does not exist fails on its first
 * `CREATE TABLE`. It is issued on a maintenance connection carrying no entities, so it cannot synchronise
 * anything as a side effect.
 */
async function createSchema(isolation: IsolatedDatabase, schema: string): Promise<void> {
    const dataSource = new DataSource({
        ...(isolation.dbConnectionOptions as object),
        entities: [],
        subscribers: [],
        migrations: [],
        synchronize: false,
        migrationsRun: false,
        dropSchema: false,
        logging: false,
    } as unknown as DataSourceOptions);
    await dataSource.initialize();
    try {
        await dataSource.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    } finally {
        await dataSource.destroy();
    }
}

/**
 * Opens a data source addressing one schema of the isolated database, with the platform's whole entity set
 * synchronised into it.
 *
 * The entity set is resolved through the platform rather than listed here, so the tables created are the tables
 * a deployment would have — including the two plugin tables and the three core tables their foreign keys
 * reference.
 */
async function synchronisedDataSource(isolation: IsolatedDatabase, schema: string): Promise<DataSource> {
    const resolved = await preBootstrapConfig(
        mergeConfig(testConfig(), {
            plugins: [ReorderPlugin.init(DECLARED_OPTIONS)],
            dbConnectionOptions: {
                ...(isolation.dbConnectionOptions as object),
                schema,
                synchronize: false,
                migrationsRun: false,
                dropSchema: false,
                migrations: [],
            },
        } as never),
    );
    return openDataSource({
        ...(resolved.dbConnectionOptions as object),
        schema,
        synchronize: true,
    } as unknown as DataSourceOptions);
}

/**
 * Seeds the configured schema with the smallest set of rows the three line-writing paths need: a channel, a
 * user, the customer bound to it, a product, two variants, one list and one line.
 *
 * Rows are saved through the platform's own entities rather than by raw insert, so every not-null column and
 * every foreign key is satisfied the way production satisfies it.
 */
async function seedConfiguredSchema(dataSource: DataSource): Promise<SeededRows> {
    const channel = await dataSource.getRepository(Channel).save(
        new Channel({
            code: 'schema-qualified-channel',
            token: 'schema-qualified-token',
            defaultLanguageCode: LanguageCode.en,
            availableLanguageCodes: [LanguageCode.en],
            defaultCurrencyCode: CurrencyCode.USD,
            availableCurrencyCodes: [CurrencyCode.USD],
            pricesIncludeTax: true,
        }),
    );
    const user = await dataSource.getRepository(User).save(
        new User({
            identifier: 'schema-qualified@example.test',
            verified: true,
            authenticationMethods: [],
            roles: [],
        }),
    );
    const customer = await dataSource.getRepository(Customer).save(
        new Customer({
            firstName: 'Schema',
            lastName: 'Qualified',
            emailAddress: 'schema-qualified@example.test',
            user,
        }),
    );
    const product = await dataSource.getRepository(Product).save(new Product({ enabled: true }));
    const variants = await dataSource.getRepository(ProductVariant).save([
        new ProductVariant({
            enabled: true,
            sku: 'SCHEMA-QUALIFIED-1',
            productId: product.id as never,
            outOfStockThreshold: 0,
            useGlobalOutOfStockThreshold: true,
        }),
        new ProductVariant({
            enabled: true,
            sku: 'SCHEMA-QUALIFIED-2',
            productId: product.id as never,
            outOfStockThreshold: 0,
            useGlobalOutOfStockThreshold: true,
        }),
    ]);
    const list = await dataSource.getRepository(ReorderList).save(
        new ReorderList({
            customerId: customer.id,
            channelId: channel.id,
            name: 'Schema qualified list',
            nameKey: 'schema qualified list',
            lineCount: 1,
        }),
    );
    const line = await dataSource.getRepository(ReorderListLine).save(
        new ReorderListLine({
            reorderListId: list.id,
            productVariantId: variants[0].id,
            quantity: 1,
        }),
    );
    return {
        channelId: Number(channel.id),
        userId: Number(user.id),
        customerId: Number(customer.id),
        listId: Number(list.id),
        lineId: Number(line.id),
        variantId: Number(variants[0].id),
        secondVariantId: Number(variants[1].id),
    };
}

/**
 * Seeds the search-path schema with the decoy: a list carrying the SAME identifier as the real one but a
 * different customer, and a line carrying the same identifier as the real line.
 *
 * The list and line identifiers are forced rather than generated, because the whole point is a collision — a
 * sub-query that reads this schema instead of the configured one must FIND a row and find the WRONG answer on
 * it. The owner's identifiers are forced too, and in the other direction: each schema carries its own sequences,
 * so a customer saved here would otherwise be allocated the same id as the real one and the decoy would answer
 * the ownership question correctly by accident, which would make this whole suite pass either way.
 */
async function seedDecoySchema(dataSource: DataSource, real: SeededRows): Promise<void> {
    const channel = await dataSource.getRepository(Channel).save(
        new Channel({
            code: 'decoy-channel',
            token: 'decoy-token',
            defaultLanguageCode: LanguageCode.en,
            availableLanguageCodes: [LanguageCode.en],
            defaultCurrencyCode: CurrencyCode.USD,
            availableCurrencyCodes: [CurrencyCode.USD],
            pricesIncludeTax: true,
        }),
    );
    // The owner is saved the ordinary way and its key is then MOVED, which is the only form that works here.
    // A supplied primary key does not survive either route into the table: the column is generated, so TypeORM
    // leaves the allocation to the engine and both schemas' sequences hand out 1 — the very collision this suite
    // must not have, because a decoy owned by the same customer id answers the ownership question correctly by
    // accident and the suite could then not fail. Nothing references the row yet, so moving its key is safe, and
    // it is read back rather than assumed. It carries no bound user, which it does not need: nothing resolves a
    // session against this schema, and the question a sub-query would ask of this list is answered from the
    // list row's own two columns.
    const decoyCustomerId = real.customerId + DECOY_OWNER_OFFSET;
    const savedCustomer = await dataSource.getRepository(Customer).save(
        new Customer({
            firstName: 'Decoy',
            lastName: 'Owner',
            emailAddress: 'decoy@example.test',
        }),
    );
    const customerTable = dataSource.getMetadata(Customer).tablePath;
    await dataSource.query(
        `UPDATE "${SEARCH_PATH_SCHEMA}"."${customerTable.split('.').pop() ?? ''}" SET id = $1 WHERE id = $2`,
        [decoyCustomerId, savedCustomer.id],
    );
    const moved: { id: number } | undefined = (
        await dataSource.query(
            `SELECT id FROM "${SEARCH_PATH_SCHEMA}"."${customerTable.split('.').pop() ?? ''}" WHERE id = $1`,
            [decoyCustomerId],
        )
    )[0];
    if (moved === undefined) {
        throw new Error('the decoy owner could not be given an identifier distinct from the real owner');
    }
    const product = await dataSource.getRepository(Product).save(new Product({ enabled: true }));
    const variant = await dataSource.getRepository(ProductVariant).save(
        new ProductVariant({
            enabled: true,
            sku: 'DECOY-1',
            productId: product.id as never,
            outOfStockThreshold: 0,
            useGlobalOutOfStockThreshold: true,
        }),
    );
    await dataSource
        .createQueryBuilder()
        .insert()
        .into(ReorderList)
        .values({
            id: real.listId as never,
            customerId: decoyCustomerId,
            channelId: channel.id,
            name: 'Decoy list',
            nameKey: 'decoy list',
            lineCount: 1,
        })
        .execute();
    await dataSource
        .createQueryBuilder()
        .insert()
        .into(ReorderListLine)
        .values({
            id: real.lineId as never,
            reorderListId: real.listId as never,
            productVariantId: variant.id,
            quantity: 1,
        })
        .execute();
}

/**
 * Constructs the service against one data source, with the two collaborators these paths reach stubbed to the
 * narrowest behaviour they need.
 *
 * The service under test is the shipped class, unmodified: only its collaborators are stood in for, and only
 * those whose real implementations would require a Nest container. `ProductVariantService.findOne` answers the
 * existence question the add path asks, from this same connection. The list query builder is never reached, no
 * read path being exercised here. And the configuration is stood in for with the PRODUCTION default rather than
 * an empty object: `TransactionalConnection.getRepository` reads
 * `authOptions.entityAccessControlStrategy` on every call, and the shipped default declares no
 * `applyAccessControl`, so repositories come back unwrapped exactly as they do in a running server — which is
 * the behaviour these statements must be judged under.
 */
function buildService(dataSource: DataSource): ReorderListService {
    const configuration = {
        authOptions: { entityAccessControlStrategy: new DefaultEntityAccessControlStrategy() },
    };
    const connection = new TransactionalConnection(
        dataSource,
        new TransactionWrapper(),
        configuration as never,
    );
    const productVariantService = {
        findOne: async (_ctx: RequestContext, id: unknown) => {
            const found = await dataSource
                .getRepository(ProductVariant)
                .findOne({ where: { id: Number(id) as never } });
            return found ?? undefined;
        },
    };
    return new ReorderListService(
        connection,
        productVariantService as never,
        {} as never,
        new RequestContextCacheService(),
        DECLARED_OPTIONS,
    );
}

/** A shop context for the seeded customer's session, in the seeded channel. */
function buildContext(seeded: SeededRows): RequestContext {
    return new RequestContext({
        apiType: 'shop',
        channel: new Channel({ id: seeded.channelId, code: 'schema-qualified-channel' }),
        session: { user: { id: seeded.userId } } as never,
        isAuthorized: true,
        authorizedAsOwnerOnly: true,
    });
}

/** One line's stored quantity in one schema, or `undefined` where no such row exists there. */
async function quantityIn(dataSource: DataSource, id: number): Promise<number | undefined> {
    const row = await dataSource
        .createQueryBuilder()
        .select('line.quantity', 'quantity')
        .from(ReorderListLine, 'line')
        .where('line.id = :id', { id })
        .getRawOne<{ quantity: number }>();
    return row === undefined ? undefined : Number(row.quantity);
}

/** One list's stored counter in one schema. */
async function lineCountIn(dataSource: DataSource, id: number): Promise<number | undefined> {
    const row = await dataSource
        .createQueryBuilder()
        .select('list.lineCount', 'lineCount')
        .from(ReorderList, 'list')
        .where('list.id = :id', { id })
        .getRawOne<{ lineCount: number }>();
    return row === undefined ? undefined : Number(row.lineCount);
}
