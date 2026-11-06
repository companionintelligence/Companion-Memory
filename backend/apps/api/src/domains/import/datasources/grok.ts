/* Grok — conversation history.

   TWO shapes, because xAI publishes no export of its own:

   1. THE REAL ONE — `data/grok-chat-item.js` inside an X (Twitter) archive.
      Verified against a June 2026 export; parsed by _x_archive.ts
      importGrokChats, which the twitter importer also calls so the Twitter card
      captures these chats as part of the whole archive. This card exists so a
      user who only wants their Grok history can drop the same .zip and get
      nothing else out of it.

   2. A standalone `grok*.json` array of conversations, kept below. No xAI export
      is known to produce this; it predates the archive shape above and stays as
      a tolerant fallback. It is NOT what an X archive contains — do not treat
      its field names as a reference.

   The fallback is intentionally tolerant of field-name variants:
     - title:    "title" | "name"
     - messages: "messages" | "responses" | "conversation"
     - role:     "role" | "sender"   (user/assistant/human/agent/USER, any case,
                 as a string or an enum object carrying {name}/{originalName})
     - text:     "message" | "content" | "text"
                 (content may be a string, {parts:[...]}, or {text:...})
     - time:     "create_time" | "created_at" | "createdAt" | "timestamp"
                 (unix seconds, unix ms, or ISO string)

   Recognition deliberately rejects ChatGPT exports (first element carries a
   `mapping` object) and Claude exports (first element carries a
   `chat_messages` array), both of which can share the conversations.json name.
*/
import crypto from 'node:crypto';
import fs from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { hasGrokChats, importGrokChats, GROK_CHAT_STORE } from './_x_archive';
import { parseFlexibleDate } from './dates';
import { readJsonFile } from './readers';
import type { FileImporter, Recognition, DirEntry } from './registry';
import { registerDataSource } from './registry';
import type { ImportParams } from './timeline';
import { textContent, timeframeContains } from './timeline';

interface GrokMessage {
  role?: unknown;
  sender?: unknown;
  message?: unknown;
  content?: unknown;
  text?: unknown;
  create_time?: unknown;
  created_at?: unknown;
  createdAt?: unknown;
  timestamp?: unknown;
}

interface GrokConversation {
  title?: unknown;
  name?: unknown;
  messages?: unknown;
  responses?: unknown;
  conversation?: unknown;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function getTitle(conv: GrokConversation): string | undefined {
  if (typeof conv.title === 'string' && conv.title) {
    return conv.title;
  }

  if (typeof conv.name === 'string' && conv.name) {
    return conv.name;
  }

  return undefined;
}

function getMessages(conv: GrokConversation): unknown[] {
  if (Array.isArray(conv.messages)) {
    return conv.messages;
  }

  if (Array.isArray(conv.responses)) {
    return conv.responses;
  }

  if (Array.isArray(conv.conversation)) {
    return conv.conversation;
  }

  return [];
}

// True when a parsed value looks like a Grok export: a non-empty array whose
// first element has a title-ish field AND a messages-ish array. ChatGPT
// (`mapping`) and Claude (`chat_messages`) shapes are explicitly rejected.
function isGrokExport(parsed: unknown): boolean {
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return false;
  }

  const first = parsed[0];
  if (!isPlainObject(first)) {
    return false;
  }

  if ('mapping' in first || 'chat_messages' in first) {
    return false;
  }

  const conv = first as GrokConversation;
  const hasTitle = typeof conv.title === 'string' || typeof conv.name === 'string';
  const hasMessages =
    Array.isArray(conv.messages) || Array.isArray(conv.responses) || Array.isArray(conv.conversation);

  return hasTitle && hasMessages;
}

function normalizeRole(raw: unknown): string | undefined {
  // X records the sender as an enum object, not a string — accept both, since a
  // standalone export could plausibly use either.
  if (isPlainObject(raw)) {
    return normalizeRole(raw.name ?? raw.originalName);
  }

  if (typeof raw !== 'string') {
    return undefined;
  }

  const r = raw.trim().toLowerCase();
  if (r === 'user' || r === 'human') {
    return 'user';
  }

  // 'agent' is what X calls Grok's side of a conversation.
  if (r === 'assistant' || r === 'agent' || r === 'grok' || r === 'ai' || r === 'bot' || r === 'model') {
    return 'assistant';
  }

  return undefined;
}

// Extract text from "message" | "content" | "text"; content may be a plain
// string, an object with {parts:[...]} (array of strings or {text} objects),
// or an object with {text:...}.
function extractText(msg: GrokMessage): string {
  for (const candidate of [msg.message, msg.content, msg.text]) {
    const t = textFromValue(candidate);
    if (t) {
      return t;
    }
  }

  return '';
}

function textFromValue(value: unknown): string {
  if (typeof value === 'string') {
    return value.trim();
  }

  if (Array.isArray(value)) {
    return value.map(textFromValue).filter(Boolean).join('\n').trim();
  }

  if (isPlainObject(value)) {
    if (Array.isArray(value.parts)) {
      return textFromValue(value.parts);
    }

    if (typeof value.text === 'string') {
      return value.text.trim();
    }
  }

  return '';
}

// Parse "create_time" | "created_at" | "timestamp" — accepts unix seconds,
// unix ms, or an ISO string.
function extractTimestamp(msg: GrokMessage): Date | undefined {
  for (const raw of [msg.create_time, msg.created_at, msg.createdAt, msg.timestamp]) {
    const d = parseTimestamp(raw);
    if (d) {
      return d;
    }
  }

  return undefined;
}

function parseTimestamp(raw: unknown): Date | undefined {
  return parseFlexibleDate(raw, { epoch: 'auto', numericStrings: true });
}

export class GrokFileImporter implements FileImporter {
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

    if (st.isFile()) {
      const base = path.basename(root).toLowerCase();
      if (path.extname(base) !== '.json') {
        return { confidence: 0 };
      }

      const parsed = await readJsonFile(root);
      if (!isGrokExport(parsed)) {
        return { confidence: 0 };
      }

      // The filename is REQUIRED, not merely a bonus.
      //
      // `isGrokExport` matches any array whose first object has a title/name and
      // a messages/responses/conversation array — and as the header says, no
      // xAI export is known to produce this shape at all. So a JSON file that
      // merely fits it is not evidence of Grok; it is evidence of JSON. Scoring
      // it 0.85 let this importer outrank real ones on their own archives.
      return base.startsWith('grok') ? { confidence: 0.97 } : { confidence: 0 };
    }

    if (st.isDirectory()) {
      // Same rule as the file branch, and this is the one that actually bit.
      //
      // A real X archive of 6,997 files was claimed by THIS importer at 0.85,
      // because `findExport` reached some unrelated JSON of the tolerant shape
      // within two levels and the non-grok-named branch scored it above
      // twitter's 0.9. The import produced 17 messages out of 1.1GB — precisely
      // the outcome the comment below warns about. Requiring the filename keeps
      // the deliberate 0.3 X-archive ranking underneath in charge.
      const found = await this.findExport(root, 2);
      if (found && path.basename(found).toLowerCase().startsWith('grok')) {
        return { confidence: 0.95 };
      }

      // An X archive. Deliberately LOW, and deliberately not zero.
      //
      // Not zero, because findImportRoots resolves an explicitly-chosen
      // importer's roots with `confidence > 0` — this is what lets the Grok card
      // accept the X .zip and import only the chats out of it.
      //
      // Low, because dataSourcesRecognize ranks by confidence, and a bare drop
      // of an X archive should go to the twitter importer (0.9+), which imports
      // the whole archive INCLUDING these chats. Ranking above it would silently
      // reduce a Twitter import to Grok messages alone.
      if (await hasGrokChats(root)) {
        return { confidence: 0.3 };
      }

      return { confidence: 0, dir_threshold: 0.7 };
    }

    return { confidence: 0 };
  }

  async fileImport(_ctx: unknown, entry: DirEntry, params: ImportParams): Promise<void> {
    const root = entry.fullPath || entry.fsRoot || entry.filename;
    if (!root) {
      return;
    }

    let isDir = false;
    let fpath: string | undefined;
    try {
      const stat = fs.statSync(root);
      isDir = stat.isDirectory();
      if (stat.isFile()) {
        fpath = root;
      } else if (isDir) {
        fpath = await this.findExport(root, 2);
      }
    } catch {
      return;
    }

    // An X archive: import ONLY the Grok chats out of it. The user picked the
    // Grok card, so tweets and DMs are not what they asked for — the Twitter
    // card is what imports the rest of the same .zip.
    if (isDir && (await hasGrokChats(root))) {
      importGrokChats(root, params);

      return;
    }

    if (!fpath) {
      params.log?.('warn', `Grok: no ${GROK_CHAT_STORE} (X archive) and no standalone export JSON found`);

      return;
    }

    let raw: string;
    try {
      raw = await fs.promises.readFile(fpath, 'utf8');
    } catch (e) {
      params.log?.('error', 'Failed to read Grok export', { error: (e as Error).message });

      return;
    }

    if (raw.charCodeAt(0) === 0xfeff) {
      raw = raw.slice(1);
    } // strip UTF-8 BOM

    let convs: unknown;
    try {
      convs = JSON.parse(raw);
    } catch (e) {
      params.log?.('error', 'Failed to parse Grok export', { error: (e as Error).message });

      return;
    }

    if (!Array.isArray(convs)) {
      return;
    }

    for (let ci = 0; ci < convs.length; ci++) {
      try {
        this.pushConversation(convs[ci] as GrokConversation, ci, params);
      } catch (e) {
        params.log?.('error', 'Failed to import Grok conversation', { error: (e as Error).message });
      }
    }
  }

  private pushConversation(conv: GrokConversation, convIndex: number, params: ImportParams): void {
    if (!isPlainObject(conv)) {
      return;
    }

    const title = getTitle(conv);
    const convKey = title || `conv${convIndex}`;
    const msgs = getMessages(conv);
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
      if (!isPlainObject(m)) {
        continue;
      }

      const msg = m as GrokMessage;
      const role = normalizeRole(msg.role ?? msg.sender);
      if (!role) {
        continue;
      }

      const text = extractText(msg);
      if (!text) {
        continue;
      }

      const ts = extractTimestamp(msg);
      if (!timeframeContains(params.timeframe, ts)) {
        continue;
      }

      const contentHash = crypto.createHash('sha1').update(`${role}\0${text}`).digest('hex').slice(0, 12);
      params.pipeline.push({
        item: {
          id: `grok:${convKey}:${i}:${contentHash}`,
          classification: 'message',
          timestamp: ts,
          content: textContent('message.txt', text),
          metadata: {
            Role: role,
            Direction: role === 'user' ? 'outgoing' : 'incoming',
            Conversation: title || undefined,
            Source: 'Grok',
            Text: text || undefined,
          },
        },
      });
    }
  }

  // Locate the export JSON. Prefers a grok*.json filename, then falls back to
  // any *.json whose contents look like a Grok export. Recurses up to `depth`
  // directory levels because real exports may nest the file in a subfolder.
  private async findExport(dir: string, depth: number): Promise<string | undefined> {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return undefined;
    }

    // 1) Strong filename match in this directory.
    for (const name of names) {
      if (name.toLowerCase().startsWith('grok') && name.toLowerCase().endsWith('.json')) {
        const full = path.join(dir, name);
        if (isGrokExport(await readJsonFile(full))) {
          return full;
        }
      }
    }

    // 2) Any *.json whose contents look like a Grok export.
    for (const name of names) {
      if (path.extname(name).toLowerCase() !== '.json') {
        continue;
      }

      const full = path.join(dir, name);
      if (isGrokExport(await readJsonFile(full))) {
        return full;
      }
    }

    // 3) Recurse into subdirectories.
    if (depth > 0) {
      for (const name of names) {
        const full = path.join(dir, name);
        try {
          if ((await stat(full)).isDirectory()) {
            const sub = await this.findExport(full, depth - 1);
            if (sub) {
              return sub;
            }
          }
        } catch {
          /* ignore */
        }
      }
    }

    return undefined;
  }
}

registerDataSource({
  name: 'grok',
  title: 'Grok',
  icon: '',
  description: 'Grok conversation history from inside an X (Twitter) archive.',
  newFileImporter: () => new GrokFileImporter(),
});
