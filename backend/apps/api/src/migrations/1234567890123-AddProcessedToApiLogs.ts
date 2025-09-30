import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddProcessedToApiLogs1234567890123 implements MigrationInterface {
  name = 'AddProcessedToApiLogs1234567890123';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "api_logs" 
      ADD COLUMN "processed" boolean DEFAULT false
    `);

    // Create index for efficient querying of unprocessed logs
    await queryRunner.query(`
      CREATE INDEX "IDX_api_logs_processed" 
      ON "api_logs" ("processed") 
      WHERE "processed" = false
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_api_logs_connection_processed" 
      ON "api_logs" ("connection_id", "processed") 
      WHERE "processed" = false
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_api_logs_user_processed" 
      ON "api_logs" ("user_id", "processed") 
      WHERE "processed" = false
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_api_logs_user_processed"`);
    await queryRunner.query(`DROP INDEX "IDX_api_logs_connection_processed"`);
    await queryRunner.query(`DROP INDEX "IDX_api_logs_processed"`);
    await queryRunner.query(`ALTER TABLE "api_logs" DROP COLUMN "processed"`);
  }
}
