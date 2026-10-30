import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { Request, Response } from 'express';
import { DataSource, QueryRunner } from 'typeorm';
import { validate as isUuid, v4 as uuidv4 } from 'uuid';

import { type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import config from '@ci/configuration';
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
  UserColumn,
  UserDataArchive,
  UserProfileSnapshot,
  UserScopedTable,
} from '../types';
import {
  type AccountLink,
  DISCOVER_INSERTABLE_COLUMNS_SQL,
  DISCOVER_LINK_REFERENCES_SQL,
  DISCOVER_UNDECLARED_ENTITY_LINKS_SQL,
  DISCOVER_USER_TABLES_SQL,
  type DiscoveredEntityLink,
  type DiscoveredLinkReference,
  type DiscoveredUserColumn,
  EXCLUDED_TABLES,
  type LinkTable,
  USER_DATA_SCHEMAS,
  findAccountLinks,
  findLinkTables,
  groupUserTables,
  linkOutOfAccountMessage,
  qualifiedName,
  quoteIdentifier,
  quotedTableName,
} from '../userDataTables';

/**
 * Rows of a {@link LinkTable} the import moved into a temporary table, to put
 * back once their rows are in.
 */
interface SetAsideLinks {
  table: LinkTable;
  /** The `pg_temp` table holding them, quoted; dropped when the transaction ends. */
  stash: string;
  rows: number;
}

const ARCHIVE_VERSION = 1 as const;
/** The one user-scoped table whose rows point at object storage. */
const FILES_TABLE = 'ci.files';
const EXPORT_ROW_PAGE_SIZE = 500;

interface PendingFileImport {
  /** The key the ARCHIVE names — resolved through the import's FileKeyMap at write time. */
  archivedKey: string;
  total: number;
  parts: Map<number, string>;
}

/**
 * Decides, for one import, which object-store key each archived file lands
 * under — and thereby which `ci.files` row points where.
 *
 * The archive names a `bucket` and `key` per file. Neither may be trusted:
 * the bucket is always this appliance's configured one, and a key is honoured
 * only if THIS account already owned a file at that key on THIS box before the
 * import began (so a same-box restore rewrites the person's own objects in
 * place, exactly as before). Any other key — another account's, a guess, a
 * value from a different appliance — is replaced by a freshly minted UUID, the
 * same way an upload mints one. The replacement is stable within the import,
 * so a file's row and its chunks agree on the key whichever arrives first.
 *
 * What this closes: with the archive's key written verbatim, an import could
 * overwrite any object in the store (write), and a `ci.files` row carrying
 * someone else's key was then served back as the importer's own file by every
 * by-key reader, export included (read). A foreign key now never survives the
 * import, in either direction.
 */
class FileKeyMap {
  private readonly minted = new Map<string, string>();

  constructor(private readonly ownedKeys: ReadonlySet<string>) {}

  resolve(archivedKey: string): string {
    if (this.ownedKeys.has(archivedKey)) {
      return archivedKey;
    }

    let key = this.minted.get(archivedKey);

    if (!key) {
      key = uuidv4();
      this.minted.set(archivedKey, key);
    }

    return key;
  }
}

/**
 * The "You" person an archive's manifest names, when it names one. Only a
 * well-formed id: anything else would fail the uuid cast in
 * reattachSelfEntity and take the whole import down with it.
 */
function profileEntityId(profile: Record<string, unknown> | null): string | null {
  const entityId = profile?.entityId;

  return typeof entityId === 'string' && isUuid(entityId) ? entityId : null;
}

/** A link an INSERT left empty, set once every row is in ({@link UserDataPortabilityService.restoreLinks}). */
interface PendingLink {
  table: UserScopedTable;
  column: string;
  /** The column that names the row being linked, and its value there. */
  rowKeyColumn: string;
  rowKey: unknown;
  value: unknown;
  /** Where the link points: another row of `table`, or a row of a table filled later. */
  parent: { schema: string; table: string; key: string; userColumn: UserColumn };
}

/**
 * Links an INSERT could not set yet, and rows held back until they can.
 *
 * An export lists a table's rows in storage order, and an UPDATE moves a row to
 * the end: edit a message after it was answered and the export lists the reply
 * first, whose `parent_message_id` then names a row the import has not inserted
 * yet. Those foreign keys are checked at once and the app's role cannot switch
 * the checks off.
 *
 * Inserting such a row with the link empty and setting it at the end breaks
 * the partial unique indexes that read a link column: two cities of one name
 * listed before their regions collide on `entities_admin_place_uniq` (it keys
 * on `COALESCE(parent_place_id, …)`), and a merged product model listed before
 * the model it was merged into collides with it on
 * `product_models_brand_model_uniq` (`WHERE merged_into_product_id IS NULL`).
 * So the row waits here until the row it names is in, and goes in with the
 * link set. Only a link whose row never arrives (another account's, a row the
 * archive lacks, a row naming itself) goes in empty and lands in
 * {@link pending}.
 */
class ImportLinks {
  readonly pending: PendingLink[] = [];

  /** The table whose rows are held; rows are held for one table at a time. */
  heldTable: UserScopedTable | null = null;

  /** Held rows (already normalized), by the `${key column}\0${value}` of the row each waits for. */
  private readonly held = new Map<string, Array<Record<string, unknown>>>();

  hold(table: UserScopedTable, link: { column: string; key: string }, row: Record<string, unknown>): void {
    const waitsFor = `${link.key}\0${String(row[link.column])}`;
    const waiting = this.held.get(waitsFor);

    this.heldTable = table;

    if (waiting) {
      waiting.push(row);
    } else {
      this.held.set(waitsFor, [row]);
    }
  }

  /** The held rows that were waiting for `row`, which just went in. */
  release(table: UserScopedTable, row: Record<string, unknown>): Array<Record<string, unknown>> {
    const keys = new Set((table.selfReferences ?? []).map(({ key }) => key));

    return [...keys].flatMap((key) => {
      const waitsFor = `${key}\0${String(row[key])}`;
      const waiting = this.held.get(waitsFor) ?? [];

      this.held.delete(waitsFor);

      return waiting;
    });
  }

  /** The earliest held row, taken out, or null once none is left. */
  takeHeld(): Record<string, unknown> | null {
    const first = this.held.entries().next();

    if (first.done) {
      this.heldTable = null;

      return null;
    }

    const [waitsFor, [row, ...rest]] = first.value;

    if (rest.length > 0) {
      this.held.set(waitsFor, rest);
    } else {
      this.held.delete(waitsFor);
    }

    return row;
  }
}

/** What an import sets up before its first row and needs again after its last. */
interface ImportState {
  keyMap: FileKeyMap;
  selfEntityIds: Array<string | null>;
  setAside: SetAsideLinks[];
  links: ImportLinks;
  tables: readonly UserScopedTable[];
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
    let state: ImportState | null = null;

    try {
      await readPortabilityNdjsonStream(req, async (record) => {
        if (record.type === 'manifest') {
          if (state) {
            throw new BadRequestException('Archive manifest must be the first record');
          }

          if (record.userId !== context.userId) {
            throw new BadRequestException('This archive belongs to a different account');
          }

          await this.setReplicationRole(queryRunner, 'replica');
          state = await this.beginImport(queryRunner, context.userId, record.profile, tables);

          return;
        }

        if (!state) {
          throw new BadRequestException('Archive manifest must be the first record');
        }

        const { keyMap, links } = state;

        // Rows wait for rows of their own table only; anything else next means
        // that table is done.
        if (links.heldTable && (record.type !== 'row' || record.table !== qualifiedName(links.heldTable))) {
          rowsImported += await this.insertHeldRows(queryRunner, context.userId, links);
        }

        if (record.type === 'row') {
          const table = tableByName.get(record.table);

          if (!table) {
            // An archive written before a table joined EXCLUDED_TABLES still
            // carries its rows. They are dropped, not restored, and not an
            // error: refusing would make every older export unimportable.
            if (EXCLUDED_TABLES.has(record.table)) {
              return;
            }

            throw new BadRequestException(`Unknown table in archive: ${record.table}`);
          }

          rowsImported += await this.insertUserRows(
            queryRunner,
            context.userId,
            table,
            [record.row],
            keyMap,
            links,
          );
          touchedTables.add(record.table);

          return;
        }

        const pending =
          pendingFiles.get(record.id) ??
          ({
            archivedKey: record.key,
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
            config.staticfiles.bucket,
            keyMap.resolve(pending.archivedKey),
            Buffer.concat(ordered.map((part) => Buffer.from(part, 'base64'))),
          );
          filesRestored += 1;
          pendingFiles.delete(record.id);
        }
      });

      // A const copy: TypeScript does not follow the assignment in the callback.
      const begun = state as ImportState | null;

      if (!begun) {
        throw new BadRequestException('Archive is missing a manifest record');
      }

      if (pendingFiles.size > 0) {
        throw new BadRequestException('Archive is missing one or more file chunks');
      }

      rowsImported += await this.finishImport(queryRunner, context.userId, begun);
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
      // The archive's profile is any object here; profileEntityId takes only a string id.
      const state = await this.beginImport(
        queryRunner,
        context.userId,
        archive.profile as Record<string, unknown> | null,
        tables,
      );

      for (const table of tables) {
        const rows = archive.tables[qualifiedName(table)] ?? [];
        rowsImported += await this.insertUserRows(
          queryRunner,
          context.userId,
          table,
          rows,
          state.keyMap,
          state.links,
        );
        rowsImported += await this.insertHeldRows(queryRunner, context.userId, state.links);
      }

      rowsImported += await this.finishImport(queryRunner, context.userId, state);

      filesRestored = await this.restoreFileBlobs(context, archive.fileBlobs, state.keyMap);

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

  /**
   * Everything both import paths do before the first archive row: note which
   * file keys the account owns, unhook what would refuse the deletes, then
   * delete the account's rows, children first.
   */
  private async beginImport(
    queryRunner: QueryRunner,
    userId: string,
    profile: Record<string, unknown> | null,
    tables: readonly UserScopedTable[],
  ): Promise<ImportState> {
    // Must precede the deletes: "owned" means owned before this import
    // touched anything, and the archive has no say in it. See FileKeyMap.
    const keyMap = new FileKeyMap(await this.snapshotOwnedFileKeys(queryRunner, userId));
    const selfEntityIds = [profileEntityId(profile), await this.detachSelfEntity(queryRunner, userId)];
    const setAside = await this.setAsideLinkedRows(queryRunner, userId, tables);

    for (const table of [...tables].reverse()) {
      await this.deleteUserRows(queryRunner, userId, table);
    }

    return { keyMap, selfEntityIds, setAside, links: new ImportLinks(), tables };
  }

  /**
   * Everything both import paths do after the last archive row, before the
   * commit. Returns the rows it inserted (the ones still held back).
   */
  private async finishImport(queryRunner: QueryRunner, userId: string, state: ImportState): Promise<number> {
    const inserted = await this.insertHeldRows(queryRunner, userId, state.links);

    await this.restoreLinks(queryRunner, userId, state.links);
    await this.restoreLinkedRows(queryRunner, userId, state.setAside);
    await this.reattachSelfEntity(queryRunner, userId, state.selfEntityIds);
    await this.refuseLinksOutOfAccount(queryRunner, userId, state.tables);

    return inserted;
  }

  /**
   * Refuse the archive, naming the link, when a row it put in links to a row
   * another account owns. Every row of this account is the archive's by now
   * (the import deleted the rest first), so this reads what the archive set.
   *
   * A foreign key only asks that the parent exists, so an archive that named
   * someone's thread, person or place by id got the link and with it their
   * row in this account's chat, graph and known places. An export never
   * carries one, as its links are between the account's own rows. A row with
   * no owner, or an id that names no row at all (a column with no key can hold
   * one), is not another account's and imports as before.
   *
   * One pass over each table that has links, looking each one up by the key it
   * names, rather than one join per link.
   */
  private async refuseLinksOutOfAccount(
    queryRunner: QueryRunner,
    userId: string,
    tables: readonly UserScopedTable[],
  ): Promise<void> {
    const references = ((await queryRunner.query(DISCOVER_LINK_REFERENCES_SQL, [USER_DATA_SCHEMAS])) ??
      []) as DiscoveredLinkReference[];
    const entityLinks = ((await queryRunner.query(DISCOVER_UNDECLARED_ENTITY_LINKS_SQL, [
      USER_DATA_SCHEMAS,
    ])) ?? []) as DiscoveredEntityLink[];
    const byChild = new Map<string, AccountLink[]>();

    for (const link of findAccountLinks(references, entityLinks, tables)) {
      const name = qualifiedName(link.child);
      byChild.set(name, [...(byChild.get(name) ?? []), link]);
    }

    for (const links of byChild.values()) {
      const child = links[0].child;
      // The first id each link names that is a row of another account, or NULL.
      const foreign = links.map(
        ({ column, parent, array }) =>
          `(SELECT p.${quoteIdentifier(parent.column)}::text FROM ${quotedTableName(parent)} p
             WHERE p.${quoteIdentifier(parent.column)} ${array ? '= ANY' : '='} (c.${quoteIdentifier(column)})
               AND p.${quoteIdentifier(parent.userColumn)} <> $1
             LIMIT 1)`,
      );
      const [found] = ((await queryRunner.query(
        `SELECT * FROM (
           SELECT ${foreign.map((sql, index) => `${sql} AS l${index}`).join(',\n                  ')}
             FROM ${quotedTableName(child)} c
            WHERE c.${quoteIdentifier(child.userColumn)} = $1
         ) found
         WHERE ${foreign.map((_, index) => `l${index} IS NOT NULL`).join(' OR ')}
         LIMIT 1`,
        [userId],
      )) ?? []) as Array<Record<string, string | null>>;

      if (found) {
        const index = links.findIndex((_, at) => found[`l${at}`] != null);

        throw new BadRequestException(linkOutOfAccountMessage(links[index], found[`l${index}`]!));
      }
    }
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
    const discovered = (await this.dataSource.query(DISCOVER_USER_TABLES_SQL, [
      USER_DATA_SCHEMAS,
    ])) as DiscoveredUserColumn[];

    return groupUserTables(discovered);
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
      timeFormat: user.timeFormat,
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
    keyMap: FileKeyMap,
    links: ImportLinks,
  ): Promise<number> {
    let inserted = 0;
    const knownColumns = new Set(table.columns);

    for (const row of rows) {
      const normalized = this.normalizeImportRow(row, userId, table, keyMap);

      // The archive's keys become identifiers in the statements below. Only
      // names the catalog reports for this table may get there: anything else
      // is either drift between the exporting and importing schema (which the
      // INSERT would have rejected anyway, just later and less clearly) or an
      // attempt to break out of the identifier position. Reject before SQL.
      this.assertKnownColumns(table, Object.keys(normalized), knownColumns);

      // A reference into a table filled later cannot be set yet; it goes in
      // empty and restoreLinks sets it once that table is in.
      const rowKey = table.primaryKey ? normalized[table.primaryKey] : null;

      for (const { column, parent } of table.laterReferences ?? []) {
        if (normalized[column] != null && rowKey != null) {
          links.pending.push({
            table,
            column,
            rowKeyColumn: table.primaryKey!,
            rowKey,
            value: normalized[column],
            parent,
          });
          normalized[column] = null;
        }
      }

      inserted += await this.insertOrHold(queryRunner, userId, table, normalized, links, false);
    }

    return inserted;
  }

  /**
   * Insert one normalized row, or hold it in `links` while a row of the same
   * table that it names is not in yet. Every held row this one was the missing
   * row for goes in after it. With `force`, the row goes in regardless and the
   * links it cannot set yet wait in {@link ImportLinks.pending}.
   */
  private async insertOrHold(
    queryRunner: QueryRunner,
    userId: string,
    table: UserScopedTable,
    row: Record<string, unknown>,
    links: ImportLinks,
    force: boolean,
  ): Promise<number> {
    const target = quotedTableName(table);
    const queue: Array<{ row: Record<string, unknown>; force: boolean }> = [{ row, force }];
    let inserted = 0;

    while (queue.length > 0) {
      const next = queue.shift()!;
      const values = { ...next.row };
      const absent = await this.absentSelfTargets(queryRunner, userId, table, values);
      // A row naming itself can only be linked once it is in.
      const waitFor = absent.find(({ column, key }) => String(values[column]) !== String(values[key]));

      if (waitFor && !next.force) {
        links.hold(table, waitFor, next.row);
        continue;
      }

      for (const { column, key } of absent) {
        if (values[key] != null) {
          links.pending.push({
            table,
            column,
            rowKeyColumn: key,
            rowKey: values[key],
            value: values[column],
            parent: { schema: table.schema, table: table.table, key, userColumn: table.userColumn },
          });
        }

        values[column] = null;
      }

      const columns = Object.keys(values);
      const placeholders = columns.map((_, index) => `$${index + 1}`).join(', ');

      await queryRunner.query(
        `INSERT INTO ${target} (${columns.map(quoteIdentifier).join(', ')}) VALUES (${placeholders})`,
        Object.values(values),
      );
      inserted += 1;

      for (const waiting of links.release(table, values)) {
        queue.push({ row: waiting, force: false });
      }
    }

    return inserted;
  }

  /**
   * The links of `row` to other rows of its table whose row is not in yet as
   * one of this account's. The account's rows were all deleted before the
   * first insert, so "in" means this import put it there.
   */
  private async absentSelfTargets(
    queryRunner: QueryRunner,
    userId: string,
    table: UserScopedTable,
    row: Record<string, unknown>,
  ): Promise<Array<{ column: string; key: string }>> {
    const selfLinks = (table.selfReferences ?? []).filter(({ column }) => row[column] != null);

    if (selfLinks.length === 0) {
      return [];
    }

    const present = new Set<string>();

    for (const key of new Set(selfLinks.map((link) => link.key))) {
      const wanted = selfLinks.filter((link) => link.key === key).map(({ column }) => String(row[column]));
      const found = ((await queryRunner.query(
        `SELECT p.${quoteIdentifier(key)}::text AS key FROM ${quotedTableName(table)} p
          WHERE p.${quoteIdentifier(key)} = ANY($1) AND p.${quoteIdentifier(table.userColumn)} = $2`,
        [wanted, userId],
      )) ?? []) as Array<{ key: string }>;

      for (const { key: value } of found) {
        present.add(`${key}\0${value}`);
      }
    }

    return selfLinks.filter(({ column, key }) => !present.has(`${key}\0${String(row[column])}`));
  }

  /**
   * Put in the rows still held back once their table is done: the row each
   * waits for is not coming (or is held itself, in a cycle), so each goes in
   * with that link empty for restoreLinks, and lets in whatever waited on it.
   */
  private async insertHeldRows(
    queryRunner: QueryRunner,
    userId: string,
    links: ImportLinks,
  ): Promise<number> {
    const table = links.heldTable;
    let inserted = 0;

    if (!table) {
      return 0;
    }

    for (let row = links.takeHeld(); row; row = links.takeHeld()) {
      inserted += await this.insertOrHold(queryRunner, userId, table, row, links, true);
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
    table: UserScopedTable,
    keyMap: FileKeyMap,
  ): Record<string, unknown> {
    const normalized: Record<string, unknown> = { ...row, [table.userColumn]: userId };

    // Computed by the database, which refuses a value for them.
    for (const column of table.generatedColumns ?? []) {
      delete normalized[column];
    }

    // Every other user column too, or the archive decides it. A null stays null:
    // on these tables the second column is an attribution ("detected owner")
    // that may be unknown, and the importer is the only account a non-null
    // value may name.
    for (const column of table.userColumns) {
      if (normalized[column] != null) {
        normalized[column] = userId;
      }
    }

    // A file row's storage pointer is rewritten alongside its bytes so the two
    // stay consistent — see FileKeyMap for why neither is taken from the archive.
    if (qualifiedName(table) === FILES_TABLE) {
      if (typeof normalized.key === 'string' && normalized.key !== '') {
        normalized.key = keyMap.resolve(normalized.key);
      }

      if (normalized.bucket != null) {
        normalized.bucket = config.staticfiles.bucket;
      }
    }

    return normalized;
  }

  /**
   * The object keys this account's files pointed at before the import — the
   * only keys an archive is allowed to write to in place. Read inside the
   * import transaction, before its deletes.
   */
  private async snapshotOwnedFileKeys(queryRunner: QueryRunner, userId: string): Promise<Set<string>> {
    const rows = (await queryRunner.query(`SELECT key FROM ci.files WHERE user_id = $1 AND key IS NOT NULL`, [
      userId,
    ])) as Array<{ key: string }> | undefined;

    return new Set((rows ?? []).map((row) => String(row.key)));
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

  private async restoreFileBlobs(
    context: UserServiceContext,
    blobs: FileBlobSnapshot[],
    keyMap: FileKeyMap,
  ): Promise<number> {
    let restored = 0;

    for (const blob of blobs) {
      try {
        await this.fileService.putObject(
          context,
          config.staticfiles.bucket,
          keyMap.resolve(blob.key),
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

  /**
   * Set the links the INSERTs left empty ({@link ImportLinks.pending}), now that every row is in.
   *
   * Only between this account's own rows: the row being linked and the row it
   * points at both have to carry the importer in their table's user column. A
   * link the archive aims at another account's row refuses the whole archive
   * (see {@link refuseLinksOutOfAccount}); one whose row the archive lacks
   * stays empty.
   */
  private async restoreLinks(queryRunner: QueryRunner, userId: string, links: ImportLinks): Promise<void> {
    const dropped = new Map<string, number>();

    for (const { table, column, rowKeyColumn, rowKey, value, parent } of links.pending) {
      // node-postgres via TypeORM answers an UPDATE with [rows, affectedCount].
      const result = (await queryRunner.query(
        `UPDATE ${quotedTableName(table)} SET ${quoteIdentifier(column)} = $1
          WHERE ${quoteIdentifier(rowKeyColumn)} = $2
            AND ${quoteIdentifier(table.userColumn)} = $3
            AND EXISTS (SELECT 1 FROM ${quotedTableName(parent)} p
                         WHERE p.${quoteIdentifier(parent.key)} = $1 AND p.${quoteIdentifier(parent.userColumn)} = $3)`,
        [value, rowKey, userId],
      )) as [unknown, number] | undefined;

      if ((result?.[1] ?? 0) === 0) {
        const [foreign] = ((await queryRunner.query(
          `SELECT 1 FROM ${quotedTableName(parent)} p
            WHERE p.${quoteIdentifier(parent.key)} = $1 AND p.${quoteIdentifier(parent.userColumn)} <> $2
            LIMIT 1`,
          [value, userId],
        )) ?? []) as unknown[];

        if (foreign) {
          throw new BadRequestException(
            linkOutOfAccountMessage({ child: table, column, parent }, String(value)),
          );
        }

        const link = `${qualifiedName(table)}.${column}`;
        dropped.set(link, (dropped.get(link) ?? 0) + 1);
      }
    }

    if (dropped.size > 0) {
      // The import used to fail on these; now they stay empty, so say so.
      this.logger.warn("Import left links empty that name a row outside this account's restored data", {
        dropped: Object.fromEntries(dropped),
      });
    }
  }

  /**
   * Take out the {@link LinkTable} rows that hang off this account's rows, and
   * keep them. Left in place they refuse the deletes below; an archive does not
   * carry them, so dropping them would lose every tag on the account's things
   * and HBPE's clusters on a restore of its own export.
   */
  private async setAsideLinkedRows(
    queryRunner: QueryRunner,
    userId: string,
    userTables: readonly UserScopedTable[],
  ): Promise<SetAsideLinks[]> {
    const references = ((await queryRunner.query(DISCOVER_LINK_REFERENCES_SQL, [USER_DATA_SCHEMAS])) ??
      []) as DiscoveredLinkReference[];
    const setAside: SetAsideLinks[] = [];

    for (const [index, table] of findLinkTables(references, userTables).entries()) {
      const target = quotedTableName(table);
      const stashName = quoteIdentifier(`portability_set_aside_${index}`);
      const stash = `pg_temp.${stashName}`;
      const owned = table.references
        .filter(({ parent }) => parent.userColumn !== null)
        .map(
          ({ column, parent }) =>
            `EXISTS (SELECT 1 FROM ${quotedTableName(parent)} p
                      WHERE p.${quoteIdentifier(parent.column)} = c.${quoteIdentifier(column)}
                        AND p.${quoteIdentifier(parent.userColumn!)} = $1)`,
        )
        .join(' OR ');

      // Moved in one statement, server side: a link written between a SELECT
      // and a DELETE would be deleted without being kept, and the rows keep
      // their exact values (no round trip through JavaScript types).
      await queryRunner.query(`CREATE TEMP TABLE ${stashName} (LIKE ${target}) ON COMMIT DROP`);
      const [moved] = ((await queryRunner.query(
        `WITH moved AS (DELETE FROM ${target} c WHERE ${owned} RETURNING c.*),
              kept AS (INSERT INTO ${stash} SELECT * FROM moved RETURNING 1)
         SELECT count(*)::int AS n FROM kept`,
        [userId],
      )) ?? []) as Array<{ n: number }>;

      if ((moved?.n ?? 0) > 0) {
        setAside.push({ table, stash, rows: moved.n });
      }
    }

    return setAside;
  }

  /**
   * Put back the rows {@link setAsideLinkedRows} took out whose every foreign
   * key names a row that is back after the import, and in this account where
   * that row is in one of its tables. A cluster of an event the archive no
   * longer has, or a tag link to another account's tag, stays out. Only foreign
   * keys are checked: `ci_search.entity_tag.entity_id` has none (it names a row
   * of whichever table `entity_type` says), so a tag link to a note the archive
   * no longer has does come back.
   */
  private async restoreLinkedRows(
    queryRunner: QueryRunner,
    userId: string,
    setAside: readonly SetAsideLinks[],
  ): Promise<void> {
    const dropped: Record<string, number> = {};

    for (const { table, stash, rows } of setAside) {
      const columns = ((await queryRunner.query(DISCOVER_INSERTABLE_COLUMNS_SQL, [
        table.schema,
        table.table,
      ])) ?? []) as Array<{ column: string }>;
      const columnList = columns.map(({ column }) => quoteIdentifier(column));
      const usesUser = table.references.some(({ parent }) => parent.userColumn !== null);
      const conditions = table.references.map(({ column, parent }) => {
        const owner = parent.userColumn === null ? '' : ` AND p.${quoteIdentifier(parent.userColumn)} = $1`;

        return `(c.${quoteIdentifier(column)} IS NULL
                 OR EXISTS (SELECT 1 FROM ${quotedTableName(parent)} p
                             WHERE p.${quoteIdentifier(parent.column)} = c.${quoteIdentifier(column)}${owner}))`;
      });

      const [restored] = ((await queryRunner.query(
        `WITH restored AS (
           INSERT INTO ${quotedTableName(table)} (${columnList.join(', ')})
           SELECT ${columnList.map((column) => `c.${column}`).join(', ')}
             FROM ${stash} c
            WHERE ${conditions.length > 0 ? conditions.join(' AND ') : 'TRUE'}
           RETURNING 1)
         SELECT count(*)::int AS n FROM restored`,
        usesUser ? [userId] : [],
      )) ?? []) as Array<{ n: number }>;
      const missing = rows - (restored?.n ?? 0);

      if (missing > 0) {
        dropped[qualifiedName(table)] = missing;
      }
    }

    if (Object.keys(dropped).length > 0) {
      this.logger.warn('Import left out links whose rows the archive did not bring back', { dropped });
    }
  }

  /**
   * Clear the account's pointer to its own "You" person before the deletes.
   *
   * `ci.users.entity_id -> ci.entities` is NO ACTION and not deferrable, and
   * `ci.users` is not one of the tables an import replaces, so deleting the
   * account's entities with the pointer in place fails the whole import
   * (`users_entity_id_fkey`). Every onboarded account has that person.
   * `session_replication_role = replica` would skip the check, but the app's
   * role cannot set it (see {@link setReplicationRole}). Returns the id it
   * cleared, for {@link reattachSelfEntity}.
   */
  private async detachSelfEntity(queryRunner: QueryRunner, userId: string): Promise<string | null> {
    // NO KEY UPDATE, the lock the UPDATE below takes anyway. FOR UPDATE would
    // also block every foreign-key check on this account's row (FOR KEY SHARE),
    // so any other insert naming this user would wait for the whole import.
    const rows = (await queryRunner.query(`SELECT entity_id FROM ci.users WHERE id = $1 FOR NO KEY UPDATE`, [
      userId,
    ])) as Array<{ entity_id: string | null }> | undefined;

    await queryRunner.query(`UPDATE ci.users SET entity_id = NULL WHERE id = $1`, [userId]);

    return rows?.[0]?.entity_id ?? null;
  }

  /**
   * Point the account back at its "You" person once the archive's rows are in:
   * the first candidate (the archive's own profile, then the pointer the
   * account had before) that the import left as an entity this account owns.
   * With neither, the pointer stays empty rather than naming someone else.
   */
  private async reattachSelfEntity(
    queryRunner: QueryRunner,
    userId: string,
    candidates: Array<string | null>,
  ): Promise<void> {
    // Usually both candidates are the same id; try it once.
    for (const entityId of new Set(candidates)) {
      if (!entityId) {
        continue;
      }

      // node-postgres via TypeORM answers an UPDATE with [rows, affectedCount].
      const result = (await queryRunner.query(
        `UPDATE ci.users SET entity_id = $2
          WHERE id = $1
            AND EXISTS (SELECT 1 FROM ci.entities WHERE entity_id = $2 AND owner_user_id = $1)`,
        [userId, entityId],
      )) as [unknown, number] | undefined;

      if ((result?.[1] ?? 0) > 0) {
        return;
      }
    }
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
