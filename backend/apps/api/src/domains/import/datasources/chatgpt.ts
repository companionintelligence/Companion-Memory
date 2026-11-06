/* ChatGPT — conversation + memory export from an OpenAI data export.
   Conversations live in conversations.json: each conversation has a `mapping`
   of nodes keyed by node id. This `mapping` key is what disambiguates a
   ChatGPT export from a Claude export, which uses the same conversations.json
   filename but a `chat_messages` array instead.

   Saved memories ship as a sibling memories.json (memory portability became a
   normalized expectation when Gemini/Claude added cross-vendor memory import,
   Mar 2026). OpenAI publishes no schema for it, so parsing is shape-tolerant
   (_ai_memory.ts); a memories file with no conversations.json next to it is
   attributed to ChatGPT by its epoch-number timestamps — Claude's memory
   export stamps ISO strings and uuids instead.

   Media: image parts (user uploads, DALL-E/gpt-image generations) appear in
   `content.parts` as objects with an `asset_pointer` ("file-service://file-…"
   or "sediment://file_…"); DALL-E turns are authored by role 'tool'. The bytes
   ship as sidecar files named `<file id>-<suffix>.<ext>` at the export root or
   in subfolders (`dalle-generations/`, `files/`, per-user dirs), so pointers are
   resolved by file-id prefix against a one-time walk of the export directory
   (_ai_media.ts). Resolved photos/videos land as 'media' items attached to
   their message; pointers with no file on disk (expired assets OpenAI omits)
   are recorded in the drop ledger. */
import fs from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import type { ResolvedAsset } from './_ai_media';
import { mediaAttachmentsFor, mediaItemForAsset } from './_ai_media';
import {
  CHATGPT_SIBLINGS,
  CLAUDE_SIBLINGS,
  findName,
  importMemoriesFile,
  isMemoryFilename,
  memoryShapeHints,
  parseMemoryEntries,
} from './_ai_memory';
import { readJsonFile } from './readers';
import type { FileImporter, Recognition, DirEntry } from './registry';
import { registerDataSource } from './registry';
import type { ImportParams, Item } from './timeline';
import { textContent, timeframeContains } from './timeline';

interface ChatGPTMessage {
  author?: { role?: string };
  content?: { content_type?: string; parts?: unknown[] };
  create_time?: number | null;
}

// An image/audio part inside content.parts (content_type 'image_asset_pointer'
// or similar) — anything carrying an asset_pointer string.
interface ChatGPTAssetPart {
  content_type?: string;
  asset_pointer?: string;
  width?: number;
  height?: number;
  metadata?: { dalle?: { prompt?: string } | null } | null;
}

interface ChatGPTNode {
  id?: string;
  parent?: string | null;
  children?: string[];
  message?: ChatGPTMessage | null;
}

interface ChatGPTConversation {
  id?: string;
  conversation_id?: string;
  title?: string;
  create_time?: number | null;
  update_time?: number | null;
  mapping?: Record<string, ChatGPTNode>;
  current_node?: string;
}

// A parsed value is a ChatGPT export when it is a non-empty array whose first
// element carries a `mapping` object (the node graph).
function isChatGPTExport(parsed: unknown): boolean {
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return false;
  }

  const first = parsed[0];

  return (
    !!first &&
    typeof first === 'object' &&
    !!(first as ChatGPTConversation).mapping &&
    typeof (first as ChatGPTConversation).mapping === 'object'
  );
}

/** Confidence that a parsed memories file is ChatGPT's (0 = not, or Claude's). */
function chatgptMemoryConfidence(parsed: unknown): number {
  if (parseMemoryEntries(parsed).length === 0) {
    return 0;
  }

  const hints = memoryShapeHints(parsed);
  if (hints.uuids || (hints.isoTimes && !hints.numericTimes)) {
    return 0;
  } // Claude-shaped

  if (hints.numericTimes) {
    return 0.9;
  }

  // Entries with no vendor markers (e.g. bare strings): claim weakly, slightly
  // above claude's ambiguous claim so recognition sorts deterministically.
  return 0.5;
}

export class ChatGPTFileImporter implements FileImporter {
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
      if (base === 'conversations.json') {
        return isChatGPTExport(await readJsonFile(root)) ? { confidence: 0.95 } : { confidence: 0 };
      }

      if (isMemoryFilename(base)) {
        const conf = chatgptMemoryConfidence(await readJsonFile(root));

        return conf > 0 ? { confidence: conf } : { confidence: 0 };
      }

      return { confidence: 0 };
    }

    if (st.isDirectory()) {
      let names: string[];
      try {
        names = await readdir(root);
      } catch {
        names = [];
      }

      const conv = findName(names, (n) => n === 'conversations.json');
      if (conv) {
        // conversations.json decides ownership of the whole directory: when it
        // is another vendor's shape the memories file next to it is theirs too.
        if (isChatGPTExport(await readJsonFile(path.join(root, conv)))) {
          return { confidence: 0.9 };
        }

        return { confidence: 0, dir_threshold: 0.7 };
      }

      const mem = findName(names, isMemoryFilename);
      if (mem && !findName(names, (n) => CLAUDE_SIBLINGS.includes(n))) {
        const conf = chatgptMemoryConfidence(await readJsonFile(path.join(root, mem)));
        if (conf > 0) {
          const marked = !!findName(names, (n) => CHATGPT_SIBLINGS.includes(n));

          return { confidence: marked ? 0.85 : Math.min(conf, 0.85) };
        }
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

    let stat: fs.Stats;
    try {
      stat = fs.statSync(root);
    } catch {
      return;
    }

    let convPath: string | undefined;
    let memPath: string | undefined;
    if (stat.isFile()) {
      const base = path.basename(root).toLowerCase();
      if (base === 'conversations.json') {
        convPath = root;
      } else if (isMemoryFilename(base)) {
        memPath = root;
      }
    } else if (stat.isDirectory()) {
      const names = (() => {
        try {
          return fs.readdirSync(root);
        } catch {
          return [];
        }
      })();
      const conv = findName(names, (n) => n === 'conversations.json');
      if (conv) {
        convPath = path.join(root, conv);
      }

      const mem = findName(names, isMemoryFilename);
      if (mem) {
        memPath = path.join(root, mem);
      }
    }

    if (convPath) {
      this.assetRoot = path.dirname(convPath);
      this.assetFiles = null;
      await this.importConversations(convPath, params);
    }

    if (memPath) {
      await importMemoriesFile(memPath, params, {
        idPrefix: 'chatgpt',
        source: 'ChatGPT',
        label: 'ChatGPT memories',
      });
    }
  }

  // ---- sidecar asset resolution -------------------------------------------
  private assetRoot = '';

  private assetFiles: ResolvedAsset[] | null = null;

  /** All files under the export root (skipping dot-entries), walked once and
      cached for the lifetime of one fileImport. */
  private listAssetFiles(): ResolvedAsset[] {
    if (this.assetFiles) {
      return this.assetFiles;
    }

    const out: ResolvedAsset[] = [];
    const walk = (dir: string, rel: string) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const e of entries) {
        if (e.name.startsWith('.')) {
          continue;
        }

        const abs = path.join(dir, e.name);
        const relPath = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) {
          walk(abs, relPath);
        } else if (e.isFile()) {
          out.push({ abs, relKey: relPath });
        }
      }
    };

    walk(this.assetRoot, '');
    this.assetFiles = out;

    return out;
  }

  /** Resolve an asset_pointer to the on-disk sidecar file that carries its
      bytes. The pointer's id ("file-service://file-ABC" → "file-ABC") prefixes
      the sidecar's basename, followed by nothing or a separator (an upload
      keeps its original name: `file-ABC-vacation.png`). */
  private resolveAsset(pointer: string): ResolvedAsset | undefined {
    const id = pointer.split('://').pop();
    if (!id || !/^file[-_][A-Za-z0-9_-]{3,}$/.test(id)) {
      return undefined;
    }

    return this.listAssetFiles().find((f) => {
      const base = path.basename(f.abs);
      if (!base.startsWith(id)) {
        return false;
      }

      const next = base.charAt(id.length);

      return next === '' || next === '.' || next === '-' || next === '_';
    });
  }

  /** Media items for a node's asset-pointer parts. Unresolvable pointers go to
      the drop ledger; resolved non-photo/video files (audio, docs) are out of
      scope and skipped silently, mirroring facebook.ts. */
  private mediaForParts(
    parts: unknown[],
    ts: Date | undefined,
    conv: ChatGPTConversation,
    convId: string,
    params: ImportParams,
  ): Item[] {
    const media: Item[] = [];
    for (const p of parts) {
      if (!p || typeof p !== 'object') {
        continue;
      }

      const part = p as ChatGPTAssetPart;
      if (typeof part.asset_pointer !== 'string') {
        continue;
      }

      const asset = this.resolveAsset(part.asset_pointer);
      if (!asset) {
        params.pipeline.drop?.('media_asset_missing', part.asset_pointer);
        continue;
      }

      const item = mediaItemForAsset('chatgpt:media', 'ChatGPT', asset, ts, {
        Conversation: conv.title || undefined,
        ThreadId: convId,
        Prompt: part.metadata?.dalle?.prompt || undefined,
        Width: typeof part.width === 'number' ? part.width : undefined,
        Height: typeof part.height === 'number' ? part.height : undefined,
      });
      if (item) {
        media.push(item);
      }
    }

    return media;
  }

  private async importConversations(fpath: string, params: ImportParams): Promise<void> {
    let raw: string;
    try {
      raw = await fs.promises.readFile(fpath, 'utf8');
    } catch (e) {
      params.log?.('error', 'Failed to read ChatGPT conversations', { error: (e as Error).message });

      return;
    }

    let convs: unknown;
    try {
      convs = JSON.parse(raw);
    } catch {
      return;
    }

    if (!Array.isArray(convs)) {
      return;
    }

    for (const c of convs) {
      this.pushConversation(c as ChatGPTConversation, params);
    }
  }

  private pushConversation(conv: ChatGPTConversation, params: ImportParams): void {
    if (!conv || !conv.mapping || typeof conv.mapping !== 'object') {
      return;
    }

    const convId = conv.id || conv.conversation_id || 'conv';
    for (const [nodeKey, node] of Object.entries(conv.mapping)) {
      const msg = node?.message;
      const role = msg?.author?.role;
      // 'tool' nodes carry no user-facing text but DO carry the DALL-E /
      // gpt-image generations as asset-pointer parts — media only.
      const isChat = role === 'user' || role === 'assistant';
      if (!isChat && role !== 'tool') {
        continue;
      }

      const parts = msg?.content?.parts;
      if (!Array.isArray(parts)) {
        continue;
      }

      const text = isChat ? parts.filter((p): p is string => typeof p === 'string').join('\n') : '';

      const ts =
        msg?.create_time != null
          ? new Date(msg.create_time * 1000)
          : conv.create_time != null
            ? new Date(conv.create_time * 1000)
            : undefined;
      if (!timeframeContains(params.timeframe, ts)) {
        continue;
      }

      const media = this.mediaForParts(parts, ts, conv, convId, params);
      if (!text) {
        // Media-only turn (a tool generation, or an upload with no caption):
        // the media items ARE the record — push them standalone.
        for (const m of media) {
          params.pipeline.push({ item: m });
        }

        continue;
      }

      const nodeId = node?.id || nodeKey;
      // Media accompanying a message rides the message itself (the comms media
      // lane) — attachment sub-items minted duplicate ci.events rows.
      const mediaAttachments = mediaAttachmentsFor(media);
      params.pipeline.push({
        item: {
          id: `chatgpt:${convId}:${nodeId}`,
          classification: 'message',
          timestamp: ts,
          content: textContent('message.txt', text),
          metadata: {
            Role: role,
            From: role === 'user' ? 'You' : 'ChatGPT',
            To: role === 'user' ? 'ChatGPT' : 'You',
            Direction: role === 'user' ? 'outgoing' : 'incoming',
            ThreadId: convId,
            Conversation: conv.title || undefined,
            Source: 'ChatGPT',
            Text: text || undefined,
            MediaAttachments: mediaAttachments.length ? mediaAttachments : undefined,
          },
        },
      });
    }
  }
}

registerDataSource({
  name: 'chatgpt',
  title: 'ChatGPT',
  icon: '',
  description:
    'Conversation history and saved memories from an OpenAI/ChatGPT data export (conversations.json, memories.json).',
  newFileImporter: () => new ChatGPTFileImporter(),
});
