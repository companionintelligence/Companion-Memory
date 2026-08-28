/* The parts of an X (Twitter) archive that more than one importer reads.

   X ships every store as a JS assignment rather than JSON
   (`window.YTD.<store>.partN = […]`), optionally split across `-partN` files,
   with each row wrapped in a single-key envelope. Both the twitter importer and
   the grok importer have to parse that, so the readers live here.

   Grok lives inside the X archive too — xAI publishes no separate export — as
   `data/grok-chat-item.js`. It imports from BOTH cards on purpose: the Twitter
   card imports the whole archive including these chats, and the Grok card
   imports only these chats out of the same .zip (see grok.ts recognize()).
*/
import crypto from 'node:crypto';
import fs from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';

import { mediaItemForAsset, insideRoot } from './_ai_media';
import type { ImportParams } from './timeline';
import { timeframeContains } from './timeline';

/** The archive's per-store JS files: `<base>.js` plus `<base>-part1.js`, … */
export function partFiles(dataDir: string, base: string): string[] {
  const re = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(-part\\d+)?\\.js$`);
  let names: string[];
  try {
    names = fs.readdirSync(dataDir);
  } catch {
    return [];
  }

  return names
    .filter((n) => re.test(n))
    .sort()
    .map((n) => path.join(dataDir, n));
}

/** `window.YTD.<store>.partN = <json>` — strip the assignment, parse the value. */
export function readYtd<T>(file: string): T[] {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }

  const eq = raw.indexOf('=');
  if (eq === -1) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw.slice(eq + 1).trim());

    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

/**
 * `data/manifest.js`, which unlike every other store assigns an OBJECT rather
 * than an array — so readYtd, which requires an array, can't read it. Carries
 * the archive's generation date and the owner's identity.
 */
export interface XManifest {
  archiveInfo?: { generationDate?: string };
  userInfo?: { accountId?: string; userName?: string; displayName?: string };
}

export function readManifest(dataDir: string): XManifest | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(dataDir, 'manifest.js'), 'utf8');
  } catch {
    return undefined;
  }

  const eq = raw.indexOf('=');
  if (eq === -1) {
    return undefined;
  }

  try {
    return JSON.parse(raw.slice(eq + 1).trim()) as XManifest;
  } catch {
    return undefined;
  }
}

/** Read every part of a store and unwrap each row's single-key envelope. */
export function readStore<T>(dataDir: string, base: string, key: string): T[] {
  const out: T[] = [];
  for (const file of partFiles(dataDir, base)) {
    for (const row of readYtd<Record<string, T>>(file)) {
      const v = row?.[key];
      if (v) {
        out.push(v);
      }
    }
  }

  return out;
}

/* -------------------------------------------------------------------------- *
 * Grok chats
 * -------------------------------------------------------------------------- */

/** Where an X archive keeps Grok conversation history. */
export const GROK_CHAT_STORE = 'grok-chat-item.js';

/** True when `root` is an X archive that carries Grok chats. */
export async function hasGrokChats(root: string): Promise<boolean> {
  try {
    await stat(path.join(root, 'data', GROK_CHAT_STORE));

    return true;
  } catch {
    return false;
  }
}

/**
 * One Grok attachment. `url` is on `ton.x.com`, a host X no longer serves, so
 * it is never used as a source address — the bytes ship in the archive and the
 * file on disk is the only working copy. `fileName`'s extension disagrees with
 * the stored file's (a `.png` filed as `.jpg`), so media is matched on
 * `mediaId` alone.
 */
interface GrokAttachment {
  url?: string;
  fileName?: string;
  mimeType?: string;
  mediaId?: string;
  moderated?: boolean;
}

/**
 * A single message in a Grok chat, as `data/grok-chat-item.js` records it.
 * Verified against a June 2026 archive: one row per message, `sender` an
 * enum OBJECT (not a string), timestamps camelCase.
 */
interface GrokChatItem {
  accountId?: string;
  chatId?: string;
  createdAt?: string;
  /** `{ value: '1', name: 'User' | 'Agent', originalName: 'USER' | 'AGENT' }` */
  sender?: { name?: string; originalName?: string };
  grokMode?: { name?: string };
  message?: string;
  attachments?: GrokAttachment[];
}

/** 'User' → user, 'Agent' → assistant; anything else is unknown. */
function grokRole(sender: GrokChatItem['sender']): 'user' | 'assistant' | undefined {
  const name = (sender?.name ?? sender?.originalName ?? '').trim().toLowerCase();
  if (name === 'user' || name === 'human') {
    return 'user';
  }

  if (name === 'agent' || name === 'assistant' || name === 'grok') {
    return 'assistant';
  }

  return undefined;
}

/** filename → full path for the archive's Grok media folder. */
function grokMediaIndex(dataDir: string): Map<string, string> {
  const dir = path.join(dataDir, 'grok_chat_media');
  const out = new Map<string, string>();
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return out;
  }

  for (const n of names) {
    out.set(n, path.join(dir, n));
  }

  return out;
}

/**
 * The stored bytes for one attachment, found by `mediaId` prefix.
 *
 * The archive files an attachment as `<mediaId>-<stem>.<ext>` where `ext` is
 * the format actually stored — which is NOT always the one `fileName` claims —
 * so matching on the recorded filename or its extension misses the file.
 */
function findGrokMedia(index: Map<string, string>, a: GrokAttachment): string | undefined {
  if (!a.mediaId) {
    return undefined;
  }

  for (const [name, full] of index) {
    if (name.startsWith(`${a.mediaId}-`) || name.startsWith(`${a.mediaId}.`)) {
      return full;
    }
  }

  return undefined;
}

/**
 * Grok conversations from an X archive, as chat messages plus a media item per
 * attachment.
 *
 * Messages carry `Source: 'Grok'` — the wizard presents Grok as its own card,
 * so provenance has to match what the user was told they were importing, even
 * when the Twitter importer is what read the file.
 *
 * Turn order is ARRAY order, not timestamp order: a question and its answer
 * share one `createdAt` to the millisecond, so sorting by time would shuffle
 * them. That also makes the row's index within its chat part of its id.
 */
export function importGrokChats(root: string, params: ImportParams): void {
  const dataDir = path.join(root, 'data');
  const rows = readStore<GrokChatItem>(dataDir, 'grok-chat-item', 'grokChatItem');
  if (rows.length === 0) {
    return;
  }

  // How many rows grok-chat-item.js actually offered the parser — the floor
  // `reconciled` checks every produced/dropped row against. An attachment is
  // a SECOND thing a row can offer beyond its message text, and it always
  // resolves to its own push() or drop(), so it earns its own unit below,
  // additive to this one.
  params.pipeline.consumed?.(rows.length);

  const media = grokMediaIndex(dataDir);

  // Per-chat running index, assigned in the order the archive lists rows.
  const seen = new Map<string, number>();
  for (const row of rows) {
    const chatId = row.chatId;
    if (!chatId) {
      params.pipeline.drop?.('grok_unknown_conversation');
      continue;
    }

    const i = seen.get(chatId) ?? 0;
    seen.set(chatId, i + 1);

    const role = grokRole(row.sender);
    if (!role) {
      params.pipeline.drop?.('grok_unknown_sender', `${chatId} (${row.sender?.name ?? 'no sender'})`);
      continue;
    }

    const text = (row.message ?? '').trim();
    const ts = row.createdAt ? new Date(row.createdAt) : undefined;
    const when = ts && !isNaN(ts.getTime()) ? ts : undefined;
    if (!timeframeContains(params.timeframe, when)) {
      params.pipeline.drop?.('outside_timeframe');
      continue;
    }

    if (text) {
      // Same id shape the standalone-export path uses: namespace, conversation
      // key, position, then a content hash so an edited row is a new record.
      const hash = crypto.createHash('sha1').update(`${role}\0${text}`).digest('hex').slice(0, 12);
      params.pipeline.push({
        item: {
          id: `grok:${chatId}:${i}:${hash}`,
          classification: 'message',
          timestamp: when,
          content: { filename: 'message.txt', mediaType: 'text/plain', data: async () => Buffer.from(text) },
          metadata: {
            Role: role,
            From: role === 'user' ? 'You' : 'Grok',
            To: role === 'user' ? 'Grok' : 'You',
            Direction: role === 'user' ? 'outgoing' : 'incoming',
            ThreadId: chatId,
            Mode: row.grokMode?.name || undefined,
            Source: 'Grok',
            Text: text,
          },
        },
      });
    } else if ((row.attachments ?? []).length > 0) {
      // An image-only turn is not a loss — the attachment below fully
      // accounts for what this row actually contains — but the base unit
      // reported for this row above (rows.length) still has to resolve to
      // SOMETHING, and "no text" is that something, distinct from a row that
      // is genuinely empty.
      params.pipeline.drop?.('grok_media_only_turn');
    } else {
      // No text AND no attachments: genuinely nothing to show for this row.
      params.pipeline.drop?.('empty_after_parse');
    }

    for (const a of row.attachments ?? []) {
      // A second (or third, …) thing this row offers the parser beyond its
      // message text, and it always resolves to one push() or one drop().
      params.pipeline.consumed?.(1);

      const abs = findGrokMedia(media, a);
      // A referenced attachment whose bytes the archive didn't ship: record the
      // loss rather than dropping it silently.
      if (!abs || !insideRoot(root, abs)) {
        params.pipeline.drop?.('grok_attachment_missing', a.mediaId ?? a.fileName ?? chatId);
        continue;
      }

      const item = mediaItemForAsset('grok:media', 'Grok', { abs, relKey: path.relative(root, abs) }, when, {
        ThreadId: chatId,
        // The prompt that produced the image is the message it hangs on.
        Prompt: text || undefined,
        // X marks an image its own filter blocked; worth keeping on the row.
        Moderated: a.moderated === true ? true : undefined,
      });
      if (item) {
        params.pipeline.push({ item });
      } else {
        params.pipeline.drop?.('grok_attachment_unsupported', path.basename(abs));
      }
    }
  }
}
