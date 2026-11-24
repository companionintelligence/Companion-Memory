import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import type { UserServiceContext } from '@ci/common/context';

import { ContentService } from './ContentService';

/** The search-index type names the explorer filters by (SearchInput.includeTypes). */
export type SourcedBrowseType =
  'event' | 'communication' | 'content' | 'browser-activity' | 'receipt' | 'product' | 'item';

export interface SourcedBrowseTable {
  type: SourcedBrowseType;
  table: string;
  userColumn: string;
  where?: string;
  /**
   * Part of the unfiltered browse. The other kinds are opt-in — the explorer
   * fetches them only when the What picker names them (SearchResolver
   * BROWSE_OPT_IN_TYPES) — so a source found only on those rows is not
   * offered until they are, or it would select nothing.
   */
  browsedByDefault: boolean;
}

/**
 * The tables the explorer browses that carry a `source_system` column, with
 * the user column each is scoped by. This is the "How" dimension's universe:
 * the picker lists the distinct values across the tables of the kinds in
 * play, and the search applies a selection to every one of them (see
 * SearchResolver.searchByTimedEntities and the `connectors` option on each
 * table's getEntitiesFor* / countEntitiesFor* pair).
 *
 * Files, notes, people, places, concepts and answers have no such column and
 * cannot match a source, so a How selection sets them aside.
 */
export const SOURCED_BROWSE_TABLES: ReadonlyArray<SourcedBrowseTable> = [
  {
    type: 'event',
    table: 'ci.events',
    userColumn: 'user_id',
    where: 'is_deleted = false',
    browsedByDefault: true,
  },
  { type: 'communication', table: 'ci.communications', userColumn: 'user_id', browsedByDefault: true },
  { type: 'content', table: 'ci.content', userColumn: 'user_id', browsedByDefault: true },
  { type: 'browser-activity', table: 'ci.browser_activity', userColumn: 'user_id', browsedByDefault: true },
  { type: 'receipt', table: 'ci.receipts', userColumn: 'user_id', browsedByDefault: false },
  { type: 'product', table: 'ci.product_models', userColumn: 'user_id', browsedByDefault: false },
  { type: 'item', table: 'ci.objects', userColumn: 'user_id', browsedByDefault: false },
];

/**
 * The tables whose sources the picker should offer for a given What
 * selection — the same include / exclude pair the search takes, resolved the
 * way the browse resolves it: an include list names the kinds exactly, an
 * exclude list drops from the default browse set, and no selection is the
 * default browse set. A kind with no source column simply contributes no
 * table, so "People only" yields an empty list, which the picker shows as
 * having no sources.
 */
export function sourcedTablesForTypes(
  includeTypes?: readonly string[],
  excludeTypes?: readonly string[],
): SourcedBrowseTable[] {
  const excluded = new Set(excludeTypes ?? []);

  if (includeTypes != null && includeTypes.length > 0) {
    const included = new Set(includeTypes);

    return SOURCED_BROWSE_TABLES.filter((leg) => included.has(leg.type) && !excluded.has(leg.type));
  }

  return SOURCED_BROWSE_TABLES.filter((leg) => leg.browsedByDefault && !excluded.has(leg.type));
}

@Injectable()
export class SourceSystemService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly contentService: ContentService,
  ) {}

  /**
   * Every distinct, non-null source the user has across the browsed tables of
   * the kinds in play, sorted. Until this existed the How picker read only
   * `ci.events.source_system` (EventResolver.eventSources), so an account
   * whose reddit import produced communications and content but no events
   * offered no source to pick at all.
   *
   * Content is the one kind not read from its column. A federated content row
   * carries the KIND there — every imported photo and document is `file` —
   * and the platform that delivered it lives in the `ci.record_sources`
   * ledger, so its leg is {@link ContentService.getSourceSystems}: the same
   * list the filter matches against. Read from the column, a document a
   * Dropbox sync fetched offered only "file", and Dropbox never appeared.
   */
  async getDistinctSourceSystems(
    context: UserServiceContext,
    options: { includeTypes?: string[]; excludeTypes?: string[] } = {},
  ): Promise<string[]> {
    const tables = sourcedTablesForTypes(options.includeTypes, options.excludeTypes);
    const contentSystems = tables.some(({ type }) => type === 'content')
      ? await this.contentService.getSourceSystems(context)
      : null;

    const legs = tables
      .filter(({ type }) => type !== 'content')
      .map(
        ({ table, userColumn, where }) =>
          `SELECT DISTINCT source_system FROM ${table} ` +
          `WHERE ${userColumn} = $1 AND source_system IS NOT NULL` +
          (where ? ` AND ${where}` : ''),
      );

    // Content alone (the library's picker) is already the sorted answer, and
    // a query with no column leg would have no use for `$1`.
    if (legs.length === 0) {
      return contentSystems ?? [];
    }

    const params: unknown[] = [context.userId];

    if (contentSystems != null) {
      params.push(contentSystems);
      legs.push(`SELECT unnest($${params.length}::text[]) AS source_system`);
    }

    const rows = await this.dataSource.query<Array<{ source_system: string }>>(
      `SELECT source_system FROM (${legs.join(' UNION ')}) AS sources ORDER BY source_system ASC`,
      params,
    );

    return rows.map((row) => row.source_system);
  }
}
