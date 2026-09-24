import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { Request, Response } from 'express';
import { DataSource, QueryRunner } from 'typeorm';

import { type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { FileService } from '@ci/domains/files';
import { UserService } from '@ci/domains/user';

import {
  FILE_CHUNK_BYTES,
  PORTABILITY_NDJSON_CONTENT_TYPE,
  readPortabilityNdjsonStream,
  serializePortabilityLine,
  type PortabilityStreamRecord,
} from '../portabilityNdjson';
import type {
  FileBlobSnapshot,
  ImportResult,
  UserDataArchive,
  UserProfileSnapshot,
  UserScopedTable,
} from '../types';
import {
  DISCOVER_USER_TABLES_SQL,
  USER_DATA_SCHEMAS,
  isExcluded,
  qualifiedName,
  quoteIdentifier,
} from '../userDataTables';

const ARCHIVE_VERSION = 1 as const;
const INSERT_CHUNK_SIZE = 200;
const EXPORT_ROW_PAGE_SIZE = 500;

interface PendingFileImport {
  bucket: string;
  key: string;
  total: number;
  parts: Map<number, string>;
}

@Injectable()
export class UserDataPortabilityService {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly fileService: FileService,
    private readonly userService: UserService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(UserDataPortabilityService.name);
  }

  async writeExportStream(context: UserServiceContext, res: Response): Promise<void> {
    const exportedAt = new Date().toISOString();
    const profile = await this.exportProfile(context);
    const filename = `ci-memory-export-${exportedAt.slice(0, 10)}.ndjson`;

    res.setHeader('Content-Type', PORTABILITY_NDJSON_CONTENT_TYPE);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    const manifest: PortabilityStreamRecord = {
      type: 'manifest',
      version: ARCHIVE_VERSION,
      format: 'ndjson',
      exportedAt,
      userId: context.userId,
      profile: profile as Record<string, unknown> | null,
    };

    res.write(`${serializePortabilityLine(manifest)}\n`);

    const tables = await this.discoverUserTables();

    for (const table of tables) {
      for await (const row of this.iterateUserRows(context.userId, table)) {
        const line: PortabilityStreamRecord = {
          type: 'row',
          table: qualifiedName(table),
          row: this.serializeRow(row),
        };
        res.write(`${serializePortabilityLine(line)}\n`);
      }
    }

    const fileRows = await this.selectUserRows(context.userId, {
      schema: 'ci',
      table: 'files',
      userColumn: 'user_id',
    });

    for (const row of fileRows) {
      await this.writeFileChunks(context, res, row);
    }

    res.end();
  }

  async importNdjsonStream(
    context: UserServiceContext,
    req: Request,
    confirmEmail: string,
  ): Promise<ImportResult> {
    await this.assertConfirmEmail(context, confirmEmail);

    const tables = await this.discoverUserTables();
    const tableByName = new Map(tables.map((table) => [qualifiedName(table), table]));
    const touchedTables = new Set<string>();
    const pendingFiles = new Map<string, PendingFileImport>();

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    let rowsImported = 0;
    let filesRestored = 0;
    let started = false;

    try {
      await readPortabilityNdjsonStream(req, async (record) => {
        if (record.type === 'manifest') {
          if (started) {
            throw new BadRequestException('Archive manifest must be the first record');
          }

          if (record.userId !== context.userId) {
            throw new BadRequestException('This archive belongs to a different account');
          }

          await this.setReplicationRole(queryRunner, 'replica');

          for (const table of [...tables].reverse()) {
            await this.deleteUserRows(queryRunner, context.userId, table);
          }

          started = true;

          return;
        }

        if (!started) {
          throw new BadRequestException('Archive manifest must be the first record');
        }

        if (record.type === 'row') {
          const table = tableByName.get(record.table);

          if (!table) {
            throw new BadRequestException(`Unknown table in archive: ${record.table}`);
          }

          rowsImported += await this.insertUserRows(queryRunner, context.userId, table, [record.row]);
          touchedTables.add(record.table);

          return;
        }

        const pending =
          pendingFiles.get(record.id) ??
          ({
            bucket: record.bucket,
            key: record.key,
            total: record.total,
            parts: new Map<number, string>(),
          } satisfies PendingFileImport);

        pending.parts.set(record.index, record.data);
        pendingFiles.set(record.id, pending);

        if (pending.parts.size === pending.total) {
          const ordered = Array.from({ length: pending.total }, (_, index) => {
            const part = pending.parts.get(index);

            if (!part) {
              throw new BadRequestException(`Missing file chunk ${index} for ${record.id}`);
            }

            return part;
          });

          await this.fileService.putObject(
            context,
            pending.bucket,
            pending.key,
            Buffer.concat(ordered.map((part) => Buffer.from(part, 'base64'))),
          );
          filesRestored += 1;
          pendingFiles.delete(record.id);
        }
      });

      if (!started) {
        throw new BadRequestException('Archive is missing a manifest record');
      }

      if (pendingFiles.size > 0) {
        throw new BadRequestException('Archive is missing one or more file chunks');
      }

      await this.setReplicationRole(queryRunner, 'origin');
      await queryRunner.commitTransaction();
    } catch (error) {
      await this.setReplicationRole(queryRunner, 'origin').catch(() => undefined);
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }

    return {
      tablesImported: touchedTables.size,
      rowsImported,
      filesRestored,
      format: 'ndjson',
    };
  }

  /** Legacy single-json export for small accounts and tests. */
  async exportArchive(context: UserServiceContext): Promise<UserDataArchive> {
    const tables = await this.discoverUserTables();
    const tableData: Record<string, Record<string, unknown>[]> = {};

    for (const table of tables) {
      const rows = await this.selectUserRows(context.userId, table);
      tableData[qualifiedName(table)] = rows.map((row) => this.serializeRow(row));
    }

    const profile = await this.exportProfile(context);
    const fileBlobs = await this.exportFileBlobs(context, tableData['ci.files'] ?? []);

    return {
      version: ARCHIVE_VERSION,
      exportedAt: new Date().toISOString(),
      userId: context.userId,
      profile,
      tables: tableData,
      fileBlobs,
    };
  }

  /** Legacy single-json import for small archives. */
  async importArchive(context: UserServiceContext, archive: UserDataArchive): Promise<ImportResult> {
    this.validateArchive(context, archive);

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    let rowsImported = 0;
    let filesRestored = 0;

    try {
      await this.setReplicationRole(queryRunner, 'replica');

      const tables = await this.discoverUserTables();
      for (const table of [...tables].reverse()) {
        await this.deleteUserRows(queryRunner, context.userId, table);
      }

      for (const table of tables) {
        const rows = archive.tables[qualifiedName(table)] ?? [];
        rowsImported += await this.insertUserRows(queryRunner, context.userId, table, rows);
      }

      filesRestored = await this.restoreFileBlobs(context, archive.fileBlobs);

      await this.setReplicationRole(queryRunner, 'origin');
      await queryRunner.commitTransaction();
    } catch (error) {
      await this.setReplicationRole(queryRunner, 'origin').catch(() => undefined);
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }

    return {
      tablesImported: Object.keys(archive.tables).length,
      rowsImported,
      filesRestored,
      format: 'json',
    };
  }

  private async assertConfirmEmail(context: UserServiceContext, confirmEmail: string): Promise<void> {
    const user = await this.userService.findById(context, context.userId);

    if (!user) {
      throw new BadRequestException('Account not found');
    }

    if (confirmEmail.trim().toLowerCase() !== user.email.trim().toLowerCase()) {
      throw new BadRequestException('Confirmation email does not match this account');
    }
  }

  private validateArchive(context: UserServiceContext, archive: UserDataArchive): void {
    if (archive.version !== ARCHIVE_VERSION) {
      throw new BadRequestException(`Unsupported archive version: ${archive.version}`);
    }

    if (archive.userId !== context.userId) {
      throw new BadRequestException('This archive belongs to a different account');
    }

    if (!archive.tables || typeof archive.tables !== 'object') {
      throw new BadRequestException('Archive is missing table data');
    }
  }

  private async discoverUserTables(): Promise<UserScopedTable[]> {
    const discovered = (await this.dataSource.query(DISCOVER_USER_TABLES_SQL, [USER_DATA_SCHEMAS])) as Array<{
      schema: string;
      table: string;
      user_column: string;
      columns?: string[] | null;
    }>;

    return discovered
      .filter((row) => !isExcluded(row))
      .map((row) => ({
        schema: row.schema,
        table: row.table,
        userColumn: row.user_column as UserScopedTable['userColumn'],
        // Fail closed: a row without a column list can accept no imported rows.
        columns: Array.isArray(row.columns) ? row.columns : [],
      }));
  }

  private async *iterateUserRows(
    userId: string,
    table: UserScopedTable,
  ): AsyncGenerator<Record<string, unknown>> {
    let offset = 0;

    for (;;) {
      const rows = (await this.dataSource.query(
        `SELECT * FROM "${table.schema}"."${table.table}"
         WHERE ${table.userColumn} = $1
         LIMIT $2 OFFSET $3`,
        [userId, EXPORT_ROW_PAGE_SIZE, offset],
      )) as Record<string, unknown>[];

      if (rows.length === 0) {
        break;
      }

      for (const row of rows) {
        yield row;
      }

      if (rows.length < EXPORT_ROW_PAGE_SIZE) {
        break;
      }

      offset += EXPORT_ROW_PAGE_SIZE;
    }
  }

  private async writeFileChunks(
    context: UserServiceContext,
    res: Response,
    row: Record<string, unknown>,
  ): Promise<void> {
    const id = String(row.id ?? '');
    const bucket = String(row.bucket ?? '');
    const key = String(row.key ?? '');

    if (!id || !bucket || !key) {
      return;
    }

    try {
      const content = await this.fileService.getFileContent(context, key);
      const buffer = Buffer.from(content);
      const total = Math.max(1, Math.ceil(buffer.length / FILE_CHUNK_BYTES));

      for (let index = 0; index < total; index += 1) {
        const start = index * FILE_CHUNK_BYTES;
        const chunk = buffer.subarray(start, start + FILE_CHUNK_BYTES);
        const line: PortabilityStreamRecord = {
          type: 'file-chunk',
          id,
          bucket,
          key,
          index,
          total,
          data: chunk.toString('base64'),
        };
        res.write(`${serializePortabilityLine(line)}\n`);
      }
    } catch (error) {
      this.logger.warn('Skipped file blob during export', {
        fileId: id,
        key,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async exportProfile(context: UserServiceContext): Promise<UserProfileSnapshot | null> {
    const user = await this.userService.findById(context, context.userId);

    if (!user) {
      return null;
    }

    return {
      id: user.id,
      name: user.name,
      email: user.email,
      entityId: user.entityId ?? null,
      onboarded: user.onboarded,
      onboardedAt: user.onboardedAt?.toISOString() ?? null,
      timezone: user.timezone,
      onboardingProgress: (user.onboardingProgress as Record<string, unknown> | null) ?? null,
      createdAt: user.createdAt.toISOString(),
      updatedAt: user.updatedAt.toISOString(),
    };
  }

  private async selectUserRows(
    userId: string,
    table: Pick<UserScopedTable, 'schema' | 'table' | 'userColumn'>,
  ): Promise<Record<string, unknown>[]> {
    return this.dataSource.query(
      `SELECT * FROM "${table.schema}"."${table.table}" WHERE ${table.userColumn} = $1`,
      [userId],
    );
  }

  private async deleteUserRows(
    queryRunner: QueryRunner,
    userId: string,
    table: UserScopedTable,
  ): Promise<void> {
    await queryRunner.query(`DELETE FROM "${table.schema}"."${table.table}" WHERE ${table.userColumn} = $1`, [
      userId,
    ]);
  }

  private async insertUserRows(
    queryRunner: QueryRunner,
    userId: string,
    table: UserScopedTable,
    rows: Record<string, unknown>[],
  ): Promise<number> {
    if (rows.length === 0) {
      return 0;
    }

    let inserted = 0;
    const target = `${quoteIdentifier(table.schema)}.${quoteIdentifier(table.table)}`;
    const knownColumns = new Set(table.columns);

    for (let offset = 0; offset < rows.length; offset += INSERT_CHUNK_SIZE) {
      const chunk = rows.slice(offset, offset + INSERT_CHUNK_SIZE);

      for (const row of chunk) {
        const normalized = this.normalizeImportRow(row, userId, table.userColumn);
        const columns = Object.keys(normalized);

        // The archive's keys become identifiers in the statement below. Only
        // names the catalog reports for this table may get there: anything else
        // is either drift between the exporting and importing schema (which the
        // INSERT would have rejected anyway, just later and less clearly) or an
        // attempt to break out of the identifier position. Reject before SQL.
        this.assertKnownColumns(table, columns, knownColumns);

        const values = Object.values(normalized);
        const placeholders = columns.map((_, index) => `$${index + 1}`).join(', ');
        const columnList = columns.map(quoteIdentifier).join(', ');

        await queryRunner.query(`INSERT INTO ${target} (${columnList}) VALUES (${placeholders})`, values);
        inserted += 1;
      }
    }

    return inserted;
  }

  private assertKnownColumns(
    table: UserScopedTable,
    columns: string[],
    knownColumns: ReadonlySet<string>,
  ): void {
    const unknown = columns.filter((column) => !knownColumns.has(column));

    if (unknown.length === 0) {
      return;
    }

    // Name a few so a genuine schema-drift case is diagnosable, but keep the
    // message bounded: the keys are caller-controlled and can be arbitrarily
    // long or numerous.
    const shown = unknown
      .slice(0, 5)
      .map((column) => JSON.stringify(column.length > 80 ? `${column.slice(0, 80)}…` : column))
      .join(', ');
    const more = unknown.length > 5 ? ` (+${unknown.length - 5} more)` : '';

    throw new BadRequestException(
      `Archive row for ${qualifiedName(table)} names column(s) that do not exist: ${shown}${more}`,
    );
  }

  private normalizeImportRow(
    row: Record<string, unknown>,
    userId: string,
    userColumn: UserScopedTable['userColumn'],
  ): Record<string, unknown> {
    return { ...row, [userColumn]: userId };
  }

  private serializeRow(row: Record<string, unknown>): Record<string, unknown> {
    const serialized: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(row)) {
      if (value instanceof Date) {
        serialized[key] = value.toISOString();
      } else if (Buffer.isBuffer(value)) {
        serialized[key] = value.toString('base64');
      } else if (value !== undefined) {
        serialized[key] = value;
      }
    }

    return serialized;
  }

  private async exportFileBlobs(
    context: UserServiceContext,
    fileRows: Record<string, unknown>[],
  ): Promise<FileBlobSnapshot[]> {
    const blobs: FileBlobSnapshot[] = [];

    for (const row of fileRows) {
      const id = String(row.id ?? '');
      const bucket = String(row.bucket ?? '');
      const key = String(row.key ?? '');

      if (!id || !bucket || !key) {
        continue;
      }

      try {
        const content = await this.fileService.getFileContent(context, key);
        blobs.push({
          id,
          bucket,
          key,
          contentBase64: Buffer.from(content).toString('base64'),
        });
      } catch (error) {
        this.logger.warn('Skipped file blob during export', {
          fileId: id,
          key,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return blobs;
  }

  private async restoreFileBlobs(context: UserServiceContext, blobs: FileBlobSnapshot[]): Promise<number> {
    let restored = 0;

    for (const blob of blobs) {
      try {
        await this.fileService.putObject(
          context,
          blob.bucket,
          blob.key,
          Buffer.from(blob.contentBase64, 'base64'),
        );
        restored += 1;
      } catch (error) {
        this.logger.warn('Skipped file blob during import', {
          fileId: blob.id,
          key: blob.key,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return restored;
  }

  private async setReplicationRole(queryRunner: QueryRunner, role: 'replica' | 'origin'): Promise<void> {
    // This GUC is superuser-only (or requires an explicit `GRANT SET ON
    // PARAMETER`), and the app's `companion` role has neither — so this
    // always fails outside a superuser connection. A plain try/catch is not
    // enough to make that non-fatal: Postgres poisons the REST of the
    // transaction the instant one statement errors, so the very next query
    // (the first `deleteUserRows` call) would throw "current transaction is
    // aborted, commands ignored until end of transaction block" even though
    // this method itself "succeeded" from the caller's point of view. The
    // savepoint isolates the failed SET so only it gets discarded, leaving
    // the surrounding delete/insert transaction healthy.
    await queryRunner.query('SAVEPOINT set_replication_role');

    try {
      await queryRunner.query(`SET session_replication_role = '${role}'`);
      await queryRunner.query('RELEASE SAVEPOINT set_replication_role');
    } catch (error) {
      await queryRunner.query('ROLLBACK TO SAVEPOINT set_replication_role');
      this.logger.debug('Could not set session_replication_role; continuing with FK order', {
        role,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
