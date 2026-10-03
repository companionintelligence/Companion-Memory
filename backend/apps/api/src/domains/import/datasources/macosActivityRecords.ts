import { createHash } from 'node:crypto';

import type Database from 'better-sqlite3';

import type { Item } from './timeline';

export type MacosSource = 'knowledge' | 'safari' | 'calls';
type Row = Record<string, unknown>;

const APPLE_EPOCH_MS = Date.UTC(2001, 0, 1);
const STREAMS: Record<string, string> = {
  '/app/usage': 'App usage',
  '/app/webUsage': 'Web usage',
  '/device/isLocked': 'Device locked state',
  '/display/isBacklit': 'Display backlight state',
};

/** Never reinterpret missing, nonnumeric or out-of-range dates as import time. */
export function appleDate(value: unknown): Date | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }

  const ms = APPLE_EPOCH_MS + value * 1000;
  if (ms < APPLE_EPOCH_MS || ms > Date.UTC(2100, 0, 1)) {
    return undefined;
  }

  return new Date(ms);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.replaceAll('\0', '').trim().slice(0, 2000) : '';
}

function columns(db: Database.Database, table: string, required: string[] = []): Set<string> {
  // Table names and required columns are constants, never manifest-controlled SQL.
  const names = new Set(
    (db.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[]).map((row) => row.name),
  );
  const missing = required.filter((name) => !names.has(name));
  if (missing.length) {
    throw new Error(`Unsupported macOS schema: ${table} lacks ${missing.join(', ')}`);
  }

  return names;
}

function optional(names: Set<string>, name: string, alias: string): string {
  return names.has(name) ? `${alias}."${name}"` : 'NULL';
}

/** Narrow, schema-checked projections; never export blobs or entire metadata bags. */
export function readMacosRows(db: Database.Database, source: MacosSource): IterableIterator<Row> {
  let sql: string;
  if (source === 'knowledge') {
    const names = columns(db, 'ZOBJECT', ['Z_PK', 'ZSTREAMNAME', 'ZSTARTDATE', 'ZENDDATE', 'ZVALUESTRING']);
    const metadata = columns(db, 'ZSTRUCTUREDMETADATA');
    const canJoin = names.has('ZSTRUCTUREDMETADATA') && metadata.has('Z_PK');
    const domain = canJoin ? optional(metadata, 'Z_DKDIGITALHEALTHMETADATAKEY__WEBDOMAIN', 'm') : 'NULL';
    sql = `SELECT o.Z_PK AS id, o.ZSTREAMNAME AS stream, o.ZSTARTDATE AS start,
      o.ZENDDATE AS end, o.ZVALUESTRING AS value,
      ${optional(names, 'ZVALUEINTEGER', 'o')} AS state,
      ${optional(names, 'ZUUID', 'o')} AS uuid, ${domain} AS domain
      FROM ZOBJECT o ${canJoin ? 'LEFT JOIN ZSTRUCTUREDMETADATA m ON m.Z_PK = o.ZSTRUCTUREDMETADATA' : ''}
      ORDER BY o.Z_PK`;
  } else if (source === 'safari') {
    columns(db, 'history_items', ['id', 'url']);
    const names = columns(db, 'history_visits', ['id', 'history_item', 'visit_time']);
    sql = `SELECT v.id, v.visit_time AS start, i.url, ${optional(names, 'title', 'v')} AS title
      FROM history_visits v JOIN history_items i ON i.id = v.history_item ORDER BY v.id`;
  } else {
    const names = columns(db, 'ZCALLRECORD', ['Z_PK', 'ZDATE', 'ZDURATION', 'ZORIGINATED']);
    sql = `SELECT c.Z_PK AS id, c.ZDATE AS start, c.ZDURATION AS duration,
      c.ZORIGINATED AS outgoing, ${optional(names, 'ZUNIQUE_ID', 'c')} AS uuid,
      ${optional(names, 'ZADDRESS', 'c')} AS address,
      ${optional(names, 'ZANSWERED', 'c')} AS answered,
      ${optional(names, 'ZSERVICE_PROVIDER', 'c')} AS provider
      FROM ZCALLRECORD c ORDER BY c.Z_PK`;
  }

  return db.prepare(sql).iterate() as IterableIterator<Row>;
}

export type MacosRecordResult =
  { item: Item } | { drop: 'invalid_timestamp' | 'empty_after_parse' | 'macos_unsupported_stream' };

/** Preserve source identity across snapshot paths and repeated imports. */
export function macosItem(row: Row, source: MacosSource, deviceId: string): MacosRecordResult {
  const timestamp = appleDate(row.start);
  if (!timestamp) {
    return { drop: 'invalid_timestamp' };
  }

  const metadata: Record<string, string | number | boolean> = {
    Source: 'macOS activity',
    MacosSource: source,
    DeviceId: deviceId,
    SourceRecordId: String(row.id),
  };
  let classification: string;
  let end: Date | undefined;
  if (source === 'knowledge') {
    const stream = text(row.stream);
    const label = STREAMS[stream];
    if (!label) {
      return { drop: 'macos_unsupported_stream' };
    }

    end = row.end == null ? undefined : appleDate(row.end);
    if (row.end != null && (!end || end < timestamp)) {
      return { drop: 'invalid_timestamp' };
    }

    const value = text(row.value);
    const domain = text(row.domain);
    const state = row.state === 0 || row.state === 1 ? String(row.state) : '';
    if ((stream.startsWith('/app/') && !value && !domain) || (!stream.startsWith('/app/') && !state)) {
      return { drop: 'empty_after_parse' };
    }

    classification = 'macos_activity';
    metadata.Stream = stream;
    metadata.AppBundleId = value;
    const stateLabel =
      stream === '/device/isLocked'
        ? row.state === 1
          ? 'locked'
          : 'unlocked'
        : row.state === 1
          ? 'on'
          : 'off';
    metadata.Title = `${label}: ${domain || value || stateLabel}`;
    metadata.Description = `${metadata.Title}${domain && value ? ` (${value})` : ''}`;
    if (end) {
      metadata.DurationSeconds = (end.getTime() - timestamp.getTime()) / 1000;
    }
  } else if (source === 'safari') {
    const url = text(row.url);
    try {
      if (!['http:', 'https:'].includes(new URL(url).protocol)) {
        return { drop: 'empty_after_parse' };
      }
    } catch {
      return { drop: 'empty_after_parse' };
    }

    classification = 'page_view';
    metadata.URL = url;
    metadata.Title = text(row.title) || url;
    metadata.Browser = 'Safari';
  } else {
    if (
      typeof row.duration !== 'number' ||
      !Number.isFinite(row.duration) ||
      row.duration < 0 ||
      (row.outgoing !== 0 && row.outgoing !== 1)
    ) {
      return { drop: 'empty_after_parse' };
    }

    classification = 'call';
    end = new Date(timestamp.getTime() + row.duration * 1000);
    if (!Number.isFinite(end.getTime()) || end.getUTCFullYear() > 2100) {
      return { drop: 'invalid_timestamp' };
    }

    metadata.Direction = row.outgoing ? 'outgoing' : 'incoming';
    metadata.Duration = row.duration;
    metadata.Title = `${row.outgoing ? 'Outgoing' : 'Incoming'} call${text(row.address) ? ` with ${text(row.address)}` : ''}`;
    metadata.Description = `${metadata.Title}; ${row.duration} seconds${row.answered === 0 ? '; unanswered' : ''}`;
    metadata.ServiceProvider = text(row.provider);
  }

  // Include original occurrence time so reused SQLite row ids cannot collide.
  const identity = [deviceId, source, text(row.uuid) || String(row.id), row.start];
  const id = createHash('sha256').update(JSON.stringify(identity)).digest('hex');

  return { item: { id, classification, timestamp, timespanEnd: end, metadata } };
}
