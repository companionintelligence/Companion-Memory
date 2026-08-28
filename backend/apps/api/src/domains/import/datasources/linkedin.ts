/* LinkedIn — "Get a copy of your data" export (Connections.csv + messages.csv). */
import fs from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { parseCSV } from './csv';
import type { FileImporter, Recognition, DirEntry } from './registry';
import { registerDataSource } from './registry';
import { readHead } from './sniff';
import type { ImportParams } from './timeline';
import { timeframeContains } from './timeline';

// Message/note cells keep their whitespace verbatim; callers trim where needed.
const NO_TRIM = { trimValues: false } as const;

const MONTHS: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

// "15 Mar 2021" → Date (UTC). Returns undefined on anything unexpected.
function parseDDMonYYYY(s: string): Date | undefined {
  if (!s) {
    return undefined;
  }

  const parts = s.trim().split(/\s+/);
  if (parts.length < 3) {
    return undefined;
  }

  const [d, mon, y] = parts;
  const monthIdx = MONTHS[mon.slice(0, 3).toLowerCase()];
  if (monthIdx === undefined) {
    return undefined;
  }

  const day = Number(d),
    year = Number(y);
  if (!Number.isFinite(day) || !Number.isFinite(year)) {
    return undefined;
  }

  const date = new Date(Date.UTC(year, monthIdx, day));

  return isNaN(date.getTime()) ? undefined : date;
}

// "2024-01-01 12:00:00 UTC" → Date. Returns undefined on anything unexpected.
function parseLinkedInMessageDate(s: string): Date | undefined {
  if (!s) {
    return undefined;
  }

  const cleaned = s.trim().replace(/\s*UTC$/, '');
  const date = new Date(cleaned.replace(' ', 'T') + 'Z');

  return isNaN(date.getTime()) ? undefined : date;
}

// Read Connections.csv text, skipping the up-to-3-line "Notes:" preamble that
// precedes the real header (the first row whose first cell is "First Name").
function parseConnections(raw: string): Record<string, string>[] {
  return parseCSV(raw, {
    ...NO_TRIM,
    findHeader: (r) => (r[0] ?? '').trim().toLowerCase().startsWith('first name'),
  });
}

// Case-insensitive lookup of a filename within a directory.
function findFile(names: string[], target: string): string | undefined {
  const lower = target.toLowerCase();

  return names.find((n) => n.toLowerCase() === lower);
}

// Case-insensitive column lookup (Invitations.csv mixes casing styles:
// "Direction" but "inviterProfileUrl").
function col(row: Record<string, string>, name: string): string {
  const key = Object.keys(row).find((k) => k.toLowerCase() === name.toLowerCase());

  return key ? row[key] : '';
}

// Canonical form for comparing LinkedIn profile URLs (protocol, www, casing
// and trailing slash vary between files of the same export).
function normalizeProfileUrl(u: string): string {
  return u
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/+$/, '');
}

function splitRecipientUrls(s: string): string[] {
  return s.split(/[;,]/).map(normalizeProfileUrl).filter(Boolean);
}

/* The export nowhere states "this archive belongs to profile URL X" directly
 * (Profile.csv has no URL column), so the owner's URL is recovered from files
 * that imply it:
 *  - Invitations.csv: each row has Direction plus inviter/invitee profile
 *    URLs — on an OUTGOING row the inviter is the owner, on INCOMING the
 *    invitee is. Majority vote across rows.
 *  - messages.csv itself: draft rows are always authored by the owner; and
 *    across 2+ conversations the only participant present in every one is
 *    the owner. */
function ownerFromInvitations(raw: string): string | undefined {
  const counts = new Map<string, number>();
  for (const row of parseCSV(raw, NO_TRIM)) {
    const dir = col(row, 'Direction').trim().toUpperCase();
    const url =
      dir === 'OUTGOING'
        ? col(row, 'inviterProfileUrl')
        : dir === 'INCOMING'
          ? col(row, 'inviteeProfileUrl')
          : '';
    const n = normalizeProfileUrl(url);
    if (n) {
      counts.set(n, (counts.get(n) ?? 0) + 1);
    }
  }

  let best: string | undefined;
  let bestCount = 0;
  for (const [url, count] of counts) {
    if (count > bestCount) {
      best = url;
      bestCount = count;
    }
  }

  return best;
}

function inferOwnerFromMessages(rows: Record<string, string>[]): string | undefined {
  for (const row of rows) {
    if (col(row, 'IS MESSAGE DRAFT').trim().toLowerCase() === 'yes') {
      const sender = normalizeProfileUrl(row['SENDER PROFILE URL'] ?? '');
      if (sender) {
        return sender;
      }
    }
  }

  const convos = new Map<string, Set<string>>();
  for (const row of rows) {
    const id = row['CONVERSATION ID'] || row['CONVERSATION TITLE'];
    if (!id) {
      continue;
    }

    const participants = convos.get(id) ?? new Set<string>();
    const sender = normalizeProfileUrl(row['SENDER PROFILE URL'] ?? '');
    if (sender) {
      participants.add(sender);
    }

    for (const r of splitRecipientUrls(row['RECIPIENT PROFILE URLS'] ?? '')) {
      participants.add(r);
    }

    if (participants.size) {
      convos.set(id, participants);
    }
  }

  if (convos.size < 2) {
    return undefined;
  }

  let common: Set<string> | undefined;
  for (const participants of convos.values()) {
    common = common ? new Set([...common].filter((u) => participants.has(u))) : participants;
  }

  return common?.size === 1 ? [...common][0] : undefined;
}

export class LinkedInFileImporter implements FileImporter {
  async recognize(_ctx: unknown, entry: DirEntry): Promise<Recognition> {
    const root = entry.fullPath || entry.fsRoot || entry.filename;
    if (!root) {
      return { confidence: 0 };
    }

    let st: fs.Stats;
    try {
      st = await stat(root);
    } catch {
      return { confidence: 0 };
    }

    if (st.isDirectory()) {
      try {
        // Verify the HEAD of whichever signature file is present — both names
        // are generic enough to appear in other services' exports, and the
        // directory branch used to claim on the name alone. Connections.csv
        // carries a "Notes:" preamble before its header, so the check scans
        // lines rather than trusting line one.
        const names = await readdir(root);
        const connections = findFile(names, 'Connections.csv');
        const messages = findFile(names, 'messages.csv');
        const connectionsOk =
          connections != null &&
          ((await readHead(path.join(root, connections))) ?? '')
            .split(/\r?\n/)
            .some((line) => line.trim().toLowerCase().startsWith('first name,last name,url'));
        const messagesOk =
          messages != null &&
          (((await readHead(path.join(root, messages))) ?? '').split(/\r?\n/)[0] ?? '')
            .trim()
            .toUpperCase()
            .startsWith('CONVERSATION ID');

        if (connectionsOk || messagesOk) {
          return { confidence: 0.9 };
        }
      } catch {
        /* ignore */
      }

      return { confidence: 0, dir_threshold: 0.7 };
    }

    if (st.isFile()) {
      const base = path.basename(root).toLowerCase();
      let raw: string;
      try {
        raw = await readFile(root, 'utf8');
      } catch {
        return { confidence: 0 };
      }

      if (base === 'connections.csv') {
        const lines = raw.split(/\r?\n/);
        const header = lines.find((l) => l.trim().toLowerCase().startsWith('first name'))?.trim() ?? '';
        if (header.toLowerCase().startsWith('first name,last name,url')) {
          return { confidence: 0.85 };
        }
      } else if (base === 'messages.csv') {
        const firstLine = raw.split(/\r?\n/)[0]?.trim() ?? '';
        if (firstLine.toUpperCase().startsWith('CONVERSATION ID')) {
          return { confidence: 0.85 };
        }
      }

      return { confidence: 0 };
    }

    return { confidence: 0 };
  }

  async fileImport(_ctx: unknown, entry: DirEntry, params: ImportParams): Promise<void> {
    const root = entry.fullPath || entry.fsRoot || entry.filename;
    if (!root) {
      return;
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(root);
    } catch {
      return;
    }

    if (stat.isFile()) {
      const base = path.basename(root).toLowerCase();
      if (base === 'connections.csv') {
        await this.processConnections(root, params);
      } else if (base === 'messages.csv') {
        await this.processMessages(root, params, this.ownerFromDir(path.dirname(root)));
      }

      return;
    }

    if (!stat.isDirectory()) {
      return;
    }

    let names: string[];
    try {
      names = fs.readdirSync(root);
    } catch (e) {
      params.log?.('error', 'Failed to read LinkedIn export dir', { error: (e as Error).message });

      return;
    }

    const conn = findFile(names, 'Connections.csv');
    if (conn) {
      await this.processConnections(path.join(root, conn), params);
    }

    const msgs = findFile(names, 'messages.csv');
    if (msgs) {
      await this.processMessages(path.join(root, msgs), params, this.ownerFromDir(root));
    }
  }

  // Owner profile URL from Invitations.csv if the export includes it.
  private ownerFromDir(dir: string): string | undefined {
    try {
      const inv = findFile(fs.readdirSync(dir), 'Invitations.csv');
      if (!inv) {
        return undefined;
      }

      return ownerFromInvitations(fs.readFileSync(path.join(dir, inv), 'utf8'));
    } catch {
      return undefined;
    }
  }

  private async processConnections(fpath: string, params: ImportParams): Promise<void> {
    let raw: string;
    try {
      raw = await fs.promises.readFile(fpath, 'utf8');
    } catch (e) {
      params.log?.('error', 'Failed to read LinkedIn Connections.csv', { error: (e as Error).message });
      params.pipeline.drop?.('unreadable_file', path.basename(fpath));

      return;
    }

    const rows = parseConnections(raw);
    // The base, entity-level unit per row — every named row also offers a
    // SECOND thing (the connection event below), which is always attempted
    // when the row has a name, so it reports its own extra consumed() unit
    // right where it's attempted, additive to this one.
    params.pipeline.consumed?.(rows.length);
    for (const row of rows) {
      const name = ((row['First Name'] ?? '') + ' ' + (row['Last Name'] ?? '')).trim();
      if (!name) {
        params.pipeline.drop?.('unnamed_connection');

        continue;
      }

      const email = row['Email Address'];

      // Entity for the connection. A LinkedIn connection is, by definition, a
      // person you know — type it `contact` so graph-sync sends it to CI-Server
      // as a Person even though the export carries no email/phone for most rows.
      // Without an explicit type these land as `type = null` and (lacking an
      // identifier) are dropped by graph-sync's WHERE filter — the bug that
      // excluded ~1,940 of ~1,971 connections from the knowledge graph.
      params.pipeline.push({
        entity: {
          type: 'contact',
          name,
          attributes: [...(email ? [{ name: 'email', value: email, identity: true }] : [])],
          metadata: {
            Company: row.Company || undefined,
            Position: row.Position || undefined,
            URL: row.URL || undefined,
            ConnectedOn: row['Connected On'] || undefined,
            Source: 'LinkedIn',
          },
        },
      });

      // Connection event item — a second thing this row offers beyond the
      // entity above, so it gets its own consumed() unit here.
      params.pipeline.consumed?.(1);
      const ts = parseDDMonYYYY(row['Connected On'] ?? '');
      if (!timeframeContains(params.timeframe, ts)) {
        params.pipeline.drop?.('outside_timeframe');

        continue;
      }

      params.pipeline.push({
        item: {
          id: 'linkedin_conn_' + (row.URL || name),
          classification: 'social',
          timestamp: ts,
          content: {
            filename: 'connection.txt',
            mediaType: 'text/plain',
            data: async () => Buffer.from(name),
          },
          metadata: {
            Title: `Connected with ${name}`,
            Name: name,
            Person: name,
            Company: row.Company || undefined,
            Kind: 'connection',
            Source: 'LinkedIn',
          },
        },
      });
    }
  }

  private async processMessages(fpath: string, params: ImportParams, ownerHint?: string): Promise<void> {
    let raw: string;
    try {
      raw = await fs.promises.readFile(fpath, 'utf8');
    } catch (e) {
      params.log?.('error', 'Failed to read LinkedIn messages.csv', { error: (e as Error).message });
      params.pipeline.drop?.('unreadable_file', path.basename(fpath));

      return;
    }

    const rows = parseCSV(raw, NO_TRIM);
    params.pipeline.consumed?.(rows.length);
    const owner = ownerHint ?? inferOwnerFromMessages(rows);
    for (const row of rows) {
      const content = row.CONTENT ?? '';
      if (!content) {
        params.pipeline.drop?.('empty_after_parse');

        continue;
      }

      const ts = parseLinkedInMessageDate(row.DATE ?? '');
      if (!timeframeContains(params.timeframe, ts)) {
        params.pipeline.drop?.('outside_timeframe');

        continue;
      }

      const senderUrl = normalizeProfileUrl(row['SENDER PROFILE URL'] ?? '');
      params.pipeline.push({
        item: {
          classification: 'message',
          timestamp: ts,
          content: {
            filename: 'message.txt',
            mediaType: 'text/plain',
            data: async () => Buffer.from(content),
          },
          metadata: {
            Sender: row.FROM || undefined,
            To: row.TO || undefined,
            Direction: owner && senderUrl ? (senderUrl === owner ? 'outgoing' : 'incoming') : undefined,
            Conversation: row['CONVERSATION TITLE'] || row['CONVERSATION ID'] || undefined,
            Subject: row.SUBJECT || undefined,
            Source: 'LinkedIn',
            Text: content || undefined,
          },
        },
      });
    }
  }
}

registerDataSource({
  name: 'linkedin',
  title: 'LinkedIn',
  icon: '',
  description: 'Connections and messages from a LinkedIn "Get a copy of your data" export.',
  newFileImporter: () => new LinkedInFileImporter(),
});
