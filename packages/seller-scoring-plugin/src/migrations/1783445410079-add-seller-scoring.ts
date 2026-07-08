/**
 * @description
 * Additive TypeORM migration for the SellerScoringPlugin. Creates the two new tables that
 * back the plugin's entities:
 *   - `seller_score`          — current composite score + per-metric state per seller.
 *   - `seller_score_snapshot` — immutable per-recalculation score history.
 *
 * This migration is STRICTLY ADDITIVE: it never alters, drops, or otherwise touches any
 * pre-existing table, column, relation, or index. `down()` reverses it by dropping ONLY the
 * two tables (and their indexes) created here.
 *
 * The DDL targets MySQL/MariaDB — the default database of the dev-server migration generator
 * (`packages/dev-server/migration.ts`, whose `getDbConfig()` defaults to `type: 'mariadb'`).
 * It mirrors the `SellerScore` and `SellerScoreSnapshot` entity column definitions exactly.
 * TypeORM migrations are dialect-specific; for a PostgreSQL/SQLite deployment, regenerate this
 * migration against that database (see the plugin README).
 *
 * @since 3.8.0
 */
import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddSellerScoring1783445410079 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            'CREATE TABLE `seller_score` (' +
                '`id` int NOT NULL AUTO_INCREMENT, ' +
                '`createdAt` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), ' +
                '`updatedAt` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6), ' +
                '`sellerId` int NOT NULL, ' +
                '`score` double precision NULL, ' +
                '`fulfillmentSla` double precision NULL, ' +
                '`cancellationReturnRate` double precision NULL, ' +
                '`lastCalculatedAt` datetime NULL, ' +
                '`flagged` tinyint NOT NULL DEFAULT 0, ' +
                'PRIMARY KEY (`id`)' +
                ') ENGINE=InnoDB',
        );
        await queryRunner.query(
            'CREATE UNIQUE INDEX `IDX_seller_score_sellerId` ON `seller_score` (`sellerId`)',
        );
        await queryRunner.query(
            'CREATE TABLE `seller_score_snapshot` (' +
                '`id` int NOT NULL AUTO_INCREMENT, ' +
                '`createdAt` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), ' +
                '`updatedAt` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6), ' +
                '`sellerId` int NOT NULL, ' +
                '`score` double precision NOT NULL, ' +
                '`fulfillmentSla` double precision NOT NULL, ' +
                '`cancellationReturnRate` double precision NOT NULL, ' +
                '`calculatedAt` datetime NOT NULL, ' +
                'PRIMARY KEY (`id`)' +
                ') ENGINE=InnoDB',
        );
        await queryRunner.query(
            'CREATE INDEX `IDX_seller_score_snapshot_sellerId` ON `seller_score_snapshot` (`sellerId`)',
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query('DROP INDEX `IDX_seller_score_snapshot_sellerId` ON `seller_score_snapshot`');
        await queryRunner.query('DROP TABLE `seller_score_snapshot`');
        await queryRunner.query('DROP INDEX `IDX_seller_score_sellerId` ON `seller_score`');
        await queryRunner.query('DROP TABLE `seller_score`');
    }
}
