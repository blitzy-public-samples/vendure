/*
 * The one additive migration of `@vendure/reorder-plugin`, creating `reorder_list` and then
 * `reorder_list_line`.
 *
 * PROVENANCE. Emitted by the platform migration lifecycle, driven plugin-locally per conflict C-D option A
 * so that no file is written outside this package:
 *
 *   generateMigration(devConfig, { name: 'add-reorder-lists', outputDir: '../reorder-plugin/src/migrations' })
 *
 * run against PostgreSQL (`DB=postgres`), the designated generation engine: of the four targets it is the
 * only server engine on which TypeORM 0.3.28 emits both `CHK_` objects. Apply with `runMigrations(config)`
 * and reverse with `revertLastMigration(config)` (`packages/core/src/migrate.ts` L40 and L89).
 *
 * ENGINE SPECIFICITY. `generateMigration` serialises the emitted statements verbatim into
 * `queryRunner.query(<SQL>)` calls (`packages/core/src/migrate.ts` L127-L179), so what it writes is bound to
 * the engine it was generated against, and what is written here is PostgreSQL DDL. `SERIAL`,
 * `TIMESTAMP … DEFAULT now()` and `ALTER TABLE … ADD CONSTRAINT … FOREIGN KEY` are not legal on the SQLite
 * family, double-quoted identifiers are string literals on the MySQL family, and `down()` names the `public`
 * schema the generation connection was configured with. That is measured on the images the engine jobs use
 * rather than deduced: the first statement below, applied verbatim through each engine's own driver, is
 * accepted on PostgreSQL 16.15 and refused on MariaDB 11.5.2 and MySQL 8.0.43 with errno 1064
 * `ER_PARSE_ERROR` and on sql.js 1.13.0 and native SQLite 3.49.2 with `near "(": syntax error`.
 *
 * So the two halves of the lifecycle claim are inseparable, and either one read on its own reverses the
 * other's meaning: the data-bearing up → down → up round trip is verified on all four automated engines, and
 * it is verified through THIS file on PostgreSQL and through that engine's OWN emission — generated the same
 * way, from the same two entity classes — on the other three. This file applies on PostgreSQL alone. The
 * package README's migration section carries that per-engine split as a table, because a reader who consults
 * a coverage matrix alone is exactly the reader who would otherwise take "verified on all four" to mean
 * "this file applies on all four". Plan section 0.2.3.1 records the emitted form's engine binding as a known
 * limitation.
 *
 * Every table, column, name and referential action below is a literal read from no entity class, because the
 * generator serialises SQL rather than metadata lookups. A later change to `ReorderList` or
 * `ReorderListLine` therefore cannot alter what a replay of timestamp 1786838400000 produces.
 *
 * CONFLICT C-E — THE TWO NAMED CHECK CONSTRAINTS, UNRESOLVED AND REQUIRING A MAINTAINER RULING. On the
 * MySQL family the two `CHK_` objects cannot be produced at all, and that is TypeORM's limitation rather
 * than the engines': MySQL has supported `CHECK` since 8.0.16 and MariaDB since 10.2.1, but TypeORM 0.3.28
 * returns early for that family in `RdbmsSchemaBuilder.createNewChecks()` (L694-L698) and `dropOldChecks()`
 * (L333-L337) with no throw and no warning, all four check methods on `MysqlQueryRunner` throw
 * (L1153-L1172), and `MysqlQueryRunner.createTableSql` never reads `table.checks`. This file, generated
 * against PostgreSQL, carries both inline in its `CREATE TABLE` statements; a file generated against that
 * family would carry neither. Nothing here issues a compensating
 * `ALTER TABLE … ADD CONSTRAINT … CHECK`, because that is C-E option 2 and needs explicit sanction. No
 * behaviour depends on either check: the quantity bound is enforced portably by the service's
 * `UserInputError` on every write path, and the `lineCount` floor by its conditional counter update together
 * with its compare-and-set repair.
 *
 * ### What a ruling on option 2 would have to weigh
 *
 * Option 2 was built and measured against MySQL 8.0.43 and MariaDB 11.5.2 before being withdrawn, so
 * whoever rules on it does not have to rediscover its costs. It is technically reachable — both engines
 * accept `ALTER TABLE … ADD CONSTRAINT … CHECK` — but three properties make it a decision rather than an
 * oversight, and none of them is visible from the requirement alone.
 *
 * 1. **The frozen condition text cannot be reused verbatim.** The conditions below are written in ANSI
 *    form, with the column double-quoted. Both engines *accept* `CHECK ("quantity" > 0)` as valid DDL and
 *    then read `"quantity"` as a string literal, because neither engine's default `sql_mode` sets
 *    `ANSI_QUOTES`. The result is a constraint carrying the exactly correct name whose condition is
 *    nonsense, and the first *valid* insert is refused — MariaDB with `Truncated incorrect DECIMAL value:
 *    'quantity'`, MySQL with `Check constraint … is violated`. A shape assertion that looks only for the
 *    name would pass over it. Option 2 therefore requires per-dialect rendering, which is a second place
 *    the frozen schema is restated and can drift from this one.
 * 2. **A check can be present and inert, asymmetrically across the two engines.** MySQL 8 permits
 *    `ALTER TABLE … ALTER CHECK … NOT ENFORCED`, records it in `TABLE_CONSTRAINTS.ENFORCED`, and keeps
 *    reporting the original `CHECK_CLAUSE` unchanged — so verifying name and condition passes over a
 *    constraint that no longer refuses anything. MariaDB 11.5 has no `ENFORCED` column at all and answers
 *    that statement with a parse error, so the state is not merely unread there but unrepresentable. Any
 *    verification must probe `information_schema.COLUMNS` for the column rather than branch on the engine
 *    name, because a `mysql`-typed connection may be pointed at either engine.
 * 3. **Being effective costs availability.** The e2e initializers and the dev configuration provision the
 *    schema with `synchronize: true` rather than by replaying this file, so a mechanism confined to the
 *    migration leaves the constraint absent on exactly the paths most deployments and every test use. To
 *    cover both, the plugin has to issue DDL while starting up; a deployment whose database user lacks
 *    `ALTER` then either fails to boot, or continues silently without the constraint and back to the gap
 *    described above. Choosing which is an operational decision about someone else's deployment, and this
 *    plugin has no standing to take it unilaterally.
 *
 * For the record, so a later implementation need not re-measure: a duplicate `ADD CONSTRAINT` reports
 * errno 1826 on MariaDB and 3822 on MySQL, a violated check reports errno 4025 on MariaDB and 3819 on
 * MySQL, `information_schema.CHECK_CONSTRAINTS` carries `TABLE_NAME` on MariaDB but not on MySQL 8 (both
 * list `CHECK` rows in `TABLE_CONSTRAINTS`, which is joinable on catalog, schema and name), and the two
 * engines spell `CHECK_CLAUSE` differently — MariaDB `` `quantity` > 0 ``, MySQL `` (`quantity` > 0) ``.
 *
 * All five named objects appear below under their exact names, one of which —
 * `UQ_reorder_list_customer_channel_name_key` — the service matches by name to raise
 * `ReorderListNameConflictError`. The withdrawn replay-claim columns, the seats counter FEATURE-001-06 adds
 * in its own later migration, and every retention or purge column are absent. TypeORM orders migrations by
 * the digits trailing the class name, so those digits and the filename's agree.
 */

import { MigrationInterface, QueryRunner } from 'typeorm';

/*
 * eslint max-len is suspended for the emitted statements below, and re-enabled immediately after them.
 *
 * Six of the generated query source lines exceed 170 columns, and four of the SQL literal values they
 * carry exceed 170 characters. The longest source line is 589 columns and the longest SQL value 574
 * characters — the `CREATE TABLE` for `reorder_list`, which PostgreSQL takes with its columns, its named
 * unique constraint, its named check constraint and its primary key in one statement. Breaking a string to
 * fit would alter the emitted text, so the limit is suspended over these statements only rather than
 * relaxed for the package.
 */
/* eslint-disable max-len */
export class AddReorderLists1786838400000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<any> {
        await queryRunner.query(
            `CREATE TABLE "reorder_list" ("createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), "name" character varying(191) NOT NULL, "nameKey" character varying(191) NOT NULL, "lineCount" integer NOT NULL DEFAULT '0', "id" SERIAL NOT NULL, "customerId" integer NOT NULL, "channelId" integer NOT NULL, CONSTRAINT "UQ_reorder_list_customer_channel_name_key" UNIQUE ("customerId", "channelId", "nameKey"), CONSTRAINT "CHK_reorder_list_line_count_non_negative" CHECK ("lineCount" >= 0), CONSTRAINT "PK_e7ffb21ce7db08ffc9b097c02aa" PRIMARY KEY ("id"))`,
            undefined,
        );
        await queryRunner.query(
            `CREATE INDEX "IDX_reorder_list_customer_channel" ON "reorder_list" ("customerId", "channelId") `,
            undefined,
        );
        await queryRunner.query(
            `CREATE TABLE "reorder_list_line" ("createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), "quantity" integer NOT NULL, "id" SERIAL NOT NULL, "reorderListId" integer NOT NULL, "productVariantId" integer NOT NULL, CONSTRAINT "UQ_reorder_list_line_list_variant" UNIQUE ("reorderListId", "productVariantId"), CONSTRAINT "CHK_reorder_list_line_quantity_positive" CHECK ("quantity" > 0), CONSTRAINT "PK_d45c9e56d46616b11790b0a5f35" PRIMARY KEY ("id"))`,
            undefined,
        );
        await queryRunner.query(
            `ALTER TABLE "reorder_list" ADD CONSTRAINT "FK_0c7c5c80bfaa5a02595fd089bb8" FOREIGN KEY ("customerId") REFERENCES "customer"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
            undefined,
        );
        await queryRunner.query(
            `ALTER TABLE "reorder_list" ADD CONSTRAINT "FK_f93b8b846698345a4605da1ad8e" FOREIGN KEY ("channelId") REFERENCES "channel"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
            undefined,
        );
        await queryRunner.query(
            `ALTER TABLE "reorder_list_line" ADD CONSTRAINT "FK_19a7479a99a7bd9f3e3b6ecd97c" FOREIGN KEY ("reorderListId") REFERENCES "reorder_list"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
            undefined,
        );
        await queryRunner.query(
            `ALTER TABLE "reorder_list_line" ADD CONSTRAINT "FK_19516e9a2ca7a06037569466423" FOREIGN KEY ("productVariantId") REFERENCES "product_variant"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
            undefined,
        );
    }

    public async down(queryRunner: QueryRunner): Promise<any> {
        await queryRunner.query(
            `ALTER TABLE "reorder_list_line" DROP CONSTRAINT "FK_19516e9a2ca7a06037569466423"`,
            undefined,
        );
        await queryRunner.query(
            `ALTER TABLE "reorder_list_line" DROP CONSTRAINT "FK_19a7479a99a7bd9f3e3b6ecd97c"`,
            undefined,
        );
        await queryRunner.query(
            `ALTER TABLE "reorder_list" DROP CONSTRAINT "FK_f93b8b846698345a4605da1ad8e"`,
            undefined,
        );
        await queryRunner.query(
            `ALTER TABLE "reorder_list" DROP CONSTRAINT "FK_0c7c5c80bfaa5a02595fd089bb8"`,
            undefined,
        );
        await queryRunner.query(`DROP TABLE "reorder_list_line"`, undefined);
        await queryRunner.query(`DROP INDEX "public"."IDX_reorder_list_customer_channel"`, undefined);
        await queryRunner.query(`DROP TABLE "reorder_list"`, undefined);
    }
}
/* eslint-enable max-len */
