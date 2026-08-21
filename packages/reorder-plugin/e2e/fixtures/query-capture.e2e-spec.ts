import { QueryRunner } from 'typeorm';
import { describe, expect, it } from 'vitest';

import {
    CapturedStatement,
    CorrelatedOwnershipRequirement,
    QueryCaptureLogger,
    whereMentionsColumns,
    whereRequiresCorrelatedOwnership,
    whereRequiresScopedPredicates,
} from './query-capture';

/**
 * The correlated-ownership verifier, tested as the load-bearing instrument it is.
 *
 * ★ **WHY THIS SPEC EXISTS.** Every future assertion that a `reorder_list_line` write is scoped to its
 * owner is decided by
 * {@link whereRequiresCorrelatedOwnership}: a line row stores its parent's identifier, a variant reference
 * and a quantity, so the acting customer and the active channel can only reach the statement through a
 * sub-query over the parent table (FEATURE-001-01 §2.11). If this parser certifies a statement that does
 * not really scope the row, every suite that trusts it passes while the write reaches rows nobody owns —
 * and it passes silently, because nothing else in the suite is looking. A verifier is therefore only worth
 * what its own negative cases prove, and those cases have to be COMMITTED to prove anything twice: a check
 * performed once by hand cannot fail when a later edit weakens the parser.
 *
 * ★ **WHICH RUNNER EXECUTES IT, AND WHY THAT ONE.** The `e2e-spec` suffix places this file in the
 * end-to-end run, whose configuration collects exactly the `.e2e-spec.ts` suffix
 * [e2e-common/vitest.config.mts:L7], and that same suffix is what keeps this file OUT of the unit run —
 * measured rather than assumed. This package's `vitest.config.mts` declares no `include` of its own, so
 * the unit run uses Vitest's default pattern, which requires a literal `.spec.` SEGMENT in the filename:
 * `query-capture.e2e-spec.ts` spells `e2e-spec` with a HYPHEN and so does not match, whereas a
 * `query-capture.spec.ts` sitting in this very directory does — verified by placing one here and watching
 * the unit run collect it. That is exactly what this file did before it was renamed, and it is a boundary
 * breach rather than a preference: the unit run supplies none of the server harness the sibling files in
 * this directory need. The inventory case in `src/reorder.plugin.spec.ts` is what fails if the suffix is
 * ever dropped. Nothing is lost by the move and nothing extra is required by it: the module under test is
 * pure — it imports `typeorm` types only, reaches no database and starts no server — so it needs none of
 * the machinery the end-to-end configuration supplies, and the e2e run applies the same `unplugin-swc`
 * decorator transform the unit run does.
 *
 * ★ **AN ADDITION TO THE PLANNED FILE SET, DECLARED HERE.** AAP §0.5.1.8 enumerates
 * `e2e/fixtures/query-capture.ts` as a fixture module and enumerates no spec for it; this file is
 * therefore an addition rather than a planned artefact, admitted by the in-scope pattern
 * `packages/reorder-plugin/e2e/fixtures/*.ts` (AAP §0.6.1.2) and declared under §0.8.2's
 * no-silent-deviation obligation. It is kept because an instrument whose negative cases are not
 * committed protects nothing against a later edit, and it is a fixture spec rather than a seventh
 * end-to-end suite: it boots no server, opens no database, seeds nothing and destroys nothing.
 *
 * **The statements are the real renderings**, not invented SQL. The PostgreSQL, MySQL/MariaDB and sql.js
 * forms below were taken from what TypeORM 0.3.28 actually emits for
 * `ReorderListService.ownedListExistsClause()` on each engine: `$n` and double-quoted identifiers on
 * PostgreSQL, positional `?` and backticks on the MySQL family, and inline numeric literals with an empty
 * parameter array on sql.js. Each is fed through {@link QueryCaptureLogger} exactly as a suite would
 * receive it, so the capture path is exercised alongside the parser and the dialect is read from the
 * runner's own connection rather than passed in beside it.
 */

/** The decoded identifiers a fixture would hold, standing in for rows it created. */
const CUSTOMER_ID = 5;
const CHANNEL_ID = 1;
const LIST_ID = 100;
const LINE_ID = 200;

/**
 * The ownership claim a line write must satisfy, built fresh per assertion so that no test can observe a
 * requirement another one mutated.
 */
function ownedLineScope(): CorrelatedOwnershipRequirement {
    return {
        table: 'reorder_list',
        correlation: { column: 'id', outerColumn: 'reorderListId' },
        predicates: [
            { column: 'customerId', value: CUSTOMER_ID },
            { column: 'channelId', value: CHANNEL_ID },
        ],
    };
}

/**
 * Captures one statement the way a real run does: through the logger's own TypeORM hook, with a query
 * runner whose connection reports the engine.
 *
 * The runner is the smallest object the logger reads — `connection.options.type` for the dialect and
 * `isTransactionActive` for the transaction flag — and it is cast rather than constructed because
 * TypeORM's `QueryRunner` is a large interface and none of the rest of it is consulted.
 */
function captureOne(query: string, parameters: unknown[], engine: string): CapturedStatement {
    const capture = new QueryCaptureLogger();
    capture.enable();
    const runner = {
        connection: { options: { type: engine } },
        isTransactionActive: true,
    } as unknown as QueryRunner;
    capture.logQuery(query, parameters, runner);
    const [statement] = capture.statements;
    expect(statement).toBeDefined();
    expect(statement.dialect).toBe(engine);
    return statement;
}

/** The correlated `EXISTS` PostgreSQL receives, with its identifiers double-quoted and its values bound. */
const POSTGRES_EXISTS =
    'EXISTS (SELECT 1 FROM "reorder_list" "owned_list_scope" ' +
    'WHERE "owned_list_scope"."id" = "reorderListId" ' +
    'AND "owned_list_scope"."customerId" = $4 AND "owned_list_scope"."channelId" = $5)';

/** The same clause as the MySQL family receives it: backticks, and positional placeholders. */
const MYSQL_EXISTS =
    'EXISTS (SELECT 1 FROM `reorder_list` `owned_list_scope` ' +
    'WHERE `owned_list_scope`.`id` = `reorderListId` ' +
    'AND `owned_list_scope`.`customerId` = ? AND `owned_list_scope`.`channelId` = ?)';

/** The same clause as sql.js receives it: double-quoted identifiers, and the values written inline. */
const SQLJS_EXISTS =
    'EXISTS (SELECT 1 FROM "reorder_list" "owned_list_scope" ' +
    'WHERE "owned_list_scope"."id" = "reorderListId" ' +
    `AND "owned_list_scope"."customerId" = ${CUSTOMER_ID} ` +
    `AND "owned_list_scope"."channelId" = ${CHANNEL_ID})`;

/** A PostgreSQL adjust whose `EXISTS` clause is supplied, so one shape can be varied at a time. */
function postgresAdjust(existsClause: string): CapturedStatement {
    return captureOne(
        'UPDATE "reorder_list_line" SET "quantity" = $1 ' +
            `WHERE "id" = $2 AND "reorderListId" = $3 AND ${existsClause}`,
        [7, LINE_ID, LIST_ID, CUSTOMER_ID, CHANNEL_ID],
        'postgres',
    );
}

describe('whereRequiresCorrelatedOwnership', () => {
    describe('certifies the ownership sub-query the service writes', () => {
        it('certifies the PostgreSQL adjust, resolving both bound values through their placeholders', () => {
            const statement = postgresAdjust(POSTGRES_EXISTS);

            expect(whereRequiresCorrelatedOwnership(statement, ownedLineScope())).toBe(true);
        });

        it('certifies the MySQL accumulate, whose placeholders are positional', () => {
            // The `SET` clause binds ahead of the predicate, so the customer and channel are the fourth and
            // fifth parameters of the statement rather than the first two of the sub-query. Resolving them
            // requires the offset arithmetic the parser performs; a verifier that numbered the sub-query's
            // own placeholders from zero would read the quantity and the line id as the tenant.
            const statement = captureOne(
                'UPDATE `reorder_list_line` SET `quantity` = `quantity` + ? ' +
                    `WHERE \`id\` = ? AND \`reorderListId\` = ? AND ${MYSQL_EXISTS}`,
                [3, LINE_ID, LIST_ID, CUSTOMER_ID, CHANNEL_ID],
                'mysql',
            );

            expect(whereRequiresCorrelatedOwnership(statement, ownedLineScope())).toBe(true);
        });

        it('certifies the MariaDB remove, which is a delete rather than an update', () => {
            const statement = captureOne(
                `DELETE FROM \`reorder_list_line\` WHERE \`id\` = ? AND \`reorderListId\` = ? AND ${MYSQL_EXISTS}`,
                [LINE_ID, LIST_ID, CUSTOMER_ID, CHANNEL_ID],
                'mariadb',
            );

            expect(whereRequiresCorrelatedOwnership(statement, ownedLineScope())).toBe(true);
        });

        it('certifies the sql.js adjust, whose values are inline literals rather than parameters', () => {
            const statement = captureOne(
                `UPDATE "reorder_list_line" SET "quantity" = 7 WHERE "id" = ${LINE_ID} ` +
                    `AND "reorderListId" = ${LIST_ID} AND ${SQLJS_EXISTS}`,
                [],
                'sqljs',
            );

            expect(whereRequiresCorrelatedOwnership(statement, ownedLineScope())).toBe(true);
        });

        it('accepts a caller that names the alias and the outer relation exactly', () => {
            const statement = postgresAdjust(POSTGRES_EXISTS);
            const requirement = ownedLineScope();
            requirement.correlation.outerRelation = undefined;
            requirement.predicates[0].relation = 'owned_list_scope';
            requirement.predicates[1].relation = 'owned_list_scope';

            expect(whereRequiresCorrelatedOwnership(statement, requirement)).toBe(true);
        });

        it('refuses a caller that names an alias the sub-query did not use', () => {
            const statement = postgresAdjust(POSTGRES_EXISTS);
            const requirement = ownedLineScope();
            requirement.predicates[0].relation = 'reorder_list_line';

            expect(whereRequiresCorrelatedOwnership(statement, requirement)).toBe(false);
        });

        it('reads a raw statement string, resolving inline literals only', () => {
            const raw =
                `UPDATE "reorder_list_line" SET "quantity" = 7 WHERE "id" = ${LINE_ID} ` +
                `AND "reorderListId" = ${LIST_ID} AND ${SQLJS_EXISTS}`;

            expect(whereRequiresCorrelatedOwnership(raw, ownedLineScope(), 'sqljs')).toBe(true);
        });
    });

    describe('refuses a requirement whose scope values it cannot decide', () => {
        it('refuses a scope predicate with no expected value, rather than checking the column alone', () => {
            // The type forbids this, which is the first line of defence; the cast is the point of the test.
            // A suite compiled against an earlier shape, a plain-JavaScript caller, or a fixture identifier
            // that was never assigned can all present a predicate with no value — and the general predicate
            // helper reads an absent value as "require only that this column is compared", which certifies a
            // sub-query whose tenant parameters are bound the wrong way round.
            const requirement = {
                table: 'reorder_list',
                correlation: { column: 'id', outerColumn: 'reorderListId' },
                predicates: [{ column: 'customerId' }, { column: 'channelId', value: CHANNEL_ID }],
            } as unknown as CorrelatedOwnershipRequirement;

            expect(whereRequiresCorrelatedOwnership(postgresAdjust(POSTGRES_EXISTS), requirement)).toBe(
                false,
            );
        });

        it('refuses a scope predicate whose expected value is explicitly undefined', () => {
            const requirement = {
                table: 'reorder_list',
                correlation: { column: 'id', outerColumn: 'reorderListId' },
                predicates: [
                    { column: 'customerId', value: undefined },
                    { column: 'channelId', value: CHANNEL_ID },
                ],
            } as unknown as CorrelatedOwnershipRequirement;

            expect(whereRequiresCorrelatedOwnership(postgresAdjust(POSTGRES_EXISTS), requirement)).toBe(
                false,
            );
        });

        it('refuses the swapped tenant binding, which has the right shape and the wrong owner', () => {
            const requirement = ownedLineScope();
            requirement.predicates[0].value = CHANNEL_ID;
            requirement.predicates[1].value = CUSTOMER_ID;

            expect(whereRequiresCorrelatedOwnership(postgresAdjust(POSTGRES_EXISTS), requirement)).toBe(
                false,
            );
        });

        it('refuses a value no parameter carries, so a stale fixture identifier fails loudly', () => {
            const requirement = ownedLineScope();
            requirement.predicates[0].value = CUSTOMER_ID + 1;

            expect(whereRequiresCorrelatedOwnership(postgresAdjust(POSTGRES_EXISTS), requirement)).toBe(
                false,
            );
        });

        it('refuses an empty predicates list, because a correlation alone proves existence not ownership', () => {
            const requirement = ownedLineScope();
            requirement.predicates = [];

            expect(whereRequiresCorrelatedOwnership(postgresAdjust(POSTGRES_EXISTS), requirement)).toBe(
                false,
            );
        });

        it('refuses a malformed requirement instead of throwing', () => {
            const statement = postgresAdjust(POSTGRES_EXISTS);

            expect(
                whereRequiresCorrelatedOwnership(
                    statement,
                    undefined as unknown as CorrelatedOwnershipRequirement,
                ),
            ).toBe(false);
            expect(
                whereRequiresCorrelatedOwnership(statement, {
                    table: '',
                    correlation: { column: 'id', outerColumn: 'reorderListId' },
                    predicates: [{ column: 'customerId', value: CUSTOMER_ID }],
                }),
            ).toBe(false);
        });
    });

    describe('refuses a sub-query whose row count does not follow its predicate', () => {
        it('refuses an ungrouped aggregate projection, which is satisfied for every row', () => {
            // Every other part of the requirement is met: the right table, a real correlation, and both
            // scope comparisons bound to the right values. `COUNT(*)` without a `GROUP BY` still returns one
            // row — `0` — when nothing matched, so the `EXISTS` is true for a line nobody owns and the write
            // it guards reaches the whole table.
            const statement = postgresAdjust(POSTGRES_EXISTS.replace('SELECT 1', 'SELECT COUNT(*)'));

            expect(whereRequiresCorrelatedOwnership(statement, ownedLineScope())).toBe(false);
        });

        it('refuses an empty grouping set, which synthesises a row from no rows', () => {
            const statement = postgresAdjust(POSTGRES_EXISTS.replace(/\)$/, ' GROUP BY GROUPING SETS (()))'));

            expect(whereRequiresCorrelatedOwnership(statement, ownedLineScope())).toBe(false);
        });

        it('refuses a HAVING clause, whose group is not a row of the relation', () => {
            const statement = postgresAdjust(POSTGRES_EXISTS.replace(/\)$/, ' HAVING COUNT(*) >= 0)'));

            expect(whereRequiresCorrelatedOwnership(statement, ownedLineScope())).toBe(false);
        });

        it('refuses a row-limiting tail, which decouples the result in the other direction', () => {
            const statement = postgresAdjust(POSTGRES_EXISTS.replace(/\)$/, ' LIMIT 0)'));

            expect(whereRequiresCorrelatedOwnership(statement, ownedLineScope())).toBe(false);
        });

        it('refuses a projection this parser has not modelled, rather than reading through it', () => {
            for (const projection of ['SELECT *', 'SELECT DISTINCT 1', 'SELECT 1, 1', 'SELECT ol.id']) {
                const statement = postgresAdjust(POSTGRES_EXISTS.replace('SELECT 1', projection));

                expect(whereRequiresCorrelatedOwnership(statement, ownedLineScope())).toBe(false);
            }
        });

        it('refuses a set operator inside the sub-query, which answers for rows it never read', () => {
            const statement = postgresAdjust(POSTGRES_EXISTS.replace(/\)$/, ' UNION SELECT 1)'));

            expect(whereRequiresCorrelatedOwnership(statement, ownedLineScope())).toBe(false);
        });
    });

    describe('refuses a sub-query that scopes something other than the addressed row', () => {
        it('refuses a sub-query over the wrong table', () => {
            const statement = postgresAdjust(
                POSTGRES_EXISTS.replace('"reorder_list" "owned_list_scope"', '"customer" "owned_list_scope"'),
            );

            expect(whereRequiresCorrelatedOwnership(statement, ownedLineScope())).toBe(false);
        });

        it('refuses a second relation, which lets the correlation and the scope address different rows', () => {
            const statement = postgresAdjust(
                POSTGRES_EXISTS.replace(
                    '"reorder_list" "owned_list_scope"',
                    '"reorder_list" "owned_list_scope", "reorder_list" "other"',
                ),
            );

            expect(whereRequiresCorrelatedOwnership(statement, ownedLineScope())).toBe(false);
        });

        it('refuses a sub-query with no correlation, which any owned list satisfies', () => {
            const statement = postgresAdjust(
                'EXISTS (SELECT 1 FROM "reorder_list" "owned_list_scope" ' +
                    'WHERE "owned_list_scope"."customerId" = $4 AND "owned_list_scope"."channelId" = $5)',
            );

            expect(whereRequiresCorrelatedOwnership(statement, ownedLineScope())).toBe(false);
        });

        it('refuses a correlation compared to a bound parameter rather than to the outer column', () => {
            // `ol.id = $3` names whichever list that parameter carries. It is not a correlation at all, and a
            // statement addressing the line by its own identifier then reaches a line of any list.
            const statement = postgresAdjust(
                POSTGRES_EXISTS.replace(
                    '"owned_list_scope"."id" = "reorderListId"',
                    '"owned_list_scope"."id" = $3',
                ),
            );

            expect(whereRequiresCorrelatedOwnership(statement, ownedLineScope())).toBe(false);
        });

        it('refuses a correlation qualified by the sub-query own alias, which compares a row to itself', () => {
            const statement = postgresAdjust(
                POSTGRES_EXISTS.replace(
                    '"owned_list_scope"."id" = "reorderListId"',
                    '"owned_list_scope"."id" = "owned_list_scope"."reorderListId"',
                ),
            );

            expect(whereRequiresCorrelatedOwnership(statement, ownedLineScope())).toBe(false);
        });

        it('refuses a scope comparison that is only a disjunct of the sub-query predicate', () => {
            const statement = postgresAdjust(
                POSTGRES_EXISTS.replace(
                    'AND "owned_list_scope"."channelId" = $5',
                    'AND ("owned_list_scope"."channelId" = $5 OR "owned_list_scope"."id" = $3)',
                ),
            );

            expect(whereRequiresCorrelatedOwnership(statement, ownedLineScope())).toBe(false);
        });
    });

    describe('refuses an EXISTS that the outer predicate does not require', () => {
        it('refuses an EXISTS under a disjunction', () => {
            const statement = captureOne(
                `UPDATE "reorder_list_line" SET "quantity" = $1 WHERE "id" = $2 OR ${POSTGRES_EXISTS}`,
                [7, LINE_ID, LIST_ID, CUSTOMER_ID, CHANNEL_ID],
                'postgres',
            );

            expect(whereRequiresCorrelatedOwnership(statement, ownedLineScope())).toBe(false);
        });

        it('refuses a negated EXISTS, which requires the row NOT to be owned', () => {
            const statement = postgresAdjust(`NOT ${POSTGRES_EXISTS}`);

            expect(whereRequiresCorrelatedOwnership(statement, ownedLineScope())).toBe(false);
        });

        it('refuses an EXISTS that is only part of its leaf', () => {
            const statement = postgresAdjust(`${POSTGRES_EXISTS} IS NOT NULL`);

            expect(whereRequiresCorrelatedOwnership(statement, ownedLineScope())).toBe(false);
        });

        it('refuses a perfect sub-query standing beside an always-true disjunct', () => {
            const statement = captureOne(
                'UPDATE "reorder_list_line" SET "quantity" = $1 ' +
                    `WHERE "id" = $2 AND (1 = 1 OR ${POSTGRES_EXISTS})`,
                [7, LINE_ID, LIST_ID, CUSTOMER_ID, CHANNEL_ID],
                'postgres',
            );

            expect(whereRequiresCorrelatedOwnership(statement, ownedLineScope())).toBe(false);
        });

        it('refuses a statement carrying no EXISTS at all', () => {
            const statement = captureOne(
                'UPDATE "reorder_list_line" SET "quantity" = $1 WHERE "id" = $2 AND "reorderListId" = $3',
                [7, LINE_ID, LIST_ID],
                'postgres',
            );

            expect(whereRequiresCorrelatedOwnership(statement, ownedLineScope())).toBe(false);
        });
    });

    describe('complements the other two predicate helpers rather than duplicating them', () => {
        it('is the only one of the three that can read the sub-query', () => {
            const statement = postgresAdjust(POSTGRES_EXISTS);

            // Both of the others refuse the sub-query, deliberately and correctly for what each claims: one
            // recognises only `column <op> operand` as a comparison, and the other blanks any parenthesised
            // SELECT before it looks for a column name. Neither can state the claim a line write makes, which
            // is why the correlated helper exists — and why a suite must not fall back to them.
            expect(
                whereRequiresScopedPredicates(statement, [
                    { column: 'customerId', value: CUSTOMER_ID },
                    { column: 'channelId', value: CHANNEL_ID },
                ]),
            ).toBe(false);
            expect(whereMentionsColumns(statement, ['customerId'])).toBe(false);

            // What they DO answer for is the row's own identifier, which the correlated helper does not
            // assert — so a complete line-write claim uses both.
            expect(whereMentionsColumns(statement, ['id', 'reorderListId'])).toBe(true);
            expect(whereRequiresCorrelatedOwnership(statement, ownedLineScope())).toBe(true);
        });
    });
});
