/* Claude — conversation + memory export from a claude.ai data export.
   Conversations live in conversations.json: each conversation has a
   `chat_messages` array. The same conversations.json filename is also used by
   ChatGPT exports, which carry a `mapping` object instead; the presence of
   `chat_messages` (and absence of `mapping`) disambiguates a Claude export.

   Saved memories ship as a sibling memories.json since Claude's memory
   import/export rollout (Mar 2026 memory portability). Anthropic publishes no
   schema for it, so parsing is shape-tolerant (_ai_memory.ts); a memories file
   with no conversations.json next to it is attributed to Claude by its uuid
   fields / ISO timestamps — ChatGPT's export stamps epoch numbers instead.

   Media: chat_messages reference uploads via `files` ([{file_name}]) and
   `attachments` ([{file_name, file_type, extracted_content}]). When the export
   ships the bytes they sit in a sibling `files/` (or `attachments/`) folder —
   older exports reference names with nothing on disk. References that resolve
   to an on-disk photo/video become 'media' items attached to their message
   (_ai_media.ts); media-looking names with no file land in the drop ledger,
   while non-media names (the text-extraction attachments) stay silent.

   Projects ship as a sibling `projects/` directory, one `<uuid>.json` file per
   Claude Project (name, description, prompt_template/custom instructions, and
   a `docs` array of project-knowledge files). Anthropic publishes no schema
   for this either, so — same as memories — parsing is shape-tolerant and
   never assumes every field is present. The parent directory already
   recognizes at high confidence via conversations.json (or memories.json), so
   `projects/` is never independently offered to an importer by
   findImportRoots; it must be picked up here, as part of importing that
   already-recognized directory, or it is silently dropped. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import type { ResolvedAsset } from './_ai_media';
import { insideRoot, mediaAttachmentsFor, mediaItemForAsset } from './_ai_media';
import {
  parseMemoryEntries,
  memoryShapeHints,
  CHATGPT_SIBLINGS,
  CLAUDE_SIBLINGS,
  findName,
  importMemoriesFile,
  isMemoryFilename,
} from './_ai_memory';
import { parseFlexibleDate } from './dates';
import { readJsonFile } from './readers';
import type { FileImporter, Recognition, DirEntry } from './registry';
import { registerDataSource } from './registry';
import type { ImportParams, Item } from './timeline';
import { mimeForFile, textContent, timeframeContains } from './timeline';

interface ClaudeContentBlock {
  type?: string;
  text?: string;
}

interface ClaudeFileRef {
  file_name?: string;
}

interface ClaudeAttachment {
  file_name?: string;
  file_type?: string;
  extracted_content?: string;
}

interface ClaudeChatMessage {
  uuid?: string;
  text?: string;
  sender?: string;
  created_at?: string;
  content?: ClaudeContentBlock[];
  files?: ClaudeFileRef[];
  attachments?: ClaudeAttachment[];
}

interface ClaudeConversation {
  uuid?: string;
  name?: string;
  created_at?: string;
  updated_at?: string;
  chat_messages?: ClaudeChatMessage[];
}

// Shape-tolerant: Anthropic publishes no schema for the project export. Field
// names below are the ones observed in a real export; every read still goes
// through a defensive lookup rather than assuming presence.
interface ClaudeProjectDoc {
  uuid?: string;
  filename?: string;
  name?: string;
  title?: string;
  content?: string;
  text?: string;
  created_at?: string;
}

interface ClaudeProject {
  uuid?: string;
  name?: string;
  description?: string;
  prompt_template?: string;
  created_at?: string;
  updated_at?: string;
  docs?: ClaudeProjectDoc[];
}

// A parsed value is a Claude export when it is a non-empty array whose first
// element has a `chat_messages` array and does NOT have a `mapping` key (which
// would mark it as a ChatGPT export).
function isClaudeExport(parsed: unknown): boolean {
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return false;
  }

  const first = parsed[0];
  if (!first || typeof first !== 'object') {
    return false;
  }

  if ('mapping' in (first as Record<string, unknown>)) {
    return false;
  }

  return Array.isArray((first as ClaudeConversation).chat_messages);
}

/** Confidence that a parsed memories file is Claude's (0 = not, or ChatGPT's). */
function claudeMemoryConfidence(parsed: unknown): number {
  if (parseMemoryEntries(parsed).length === 0) {
    return 0;
  }

  const hints = memoryShapeHints(parsed);
  if (hints.numericTimes && !hints.uuids && !hints.isoTimes) {
    return 0;
  } // ChatGPT-shaped

  if (hints.uuids || hints.isoTimes) {
    return 0.9;
  }

  // No vendor markers at all (e.g. bare strings): claim weakly, just below
  // chatgpt's ambiguous claim so recognition sorts deterministically.
  return 0.4;
}

/** First non-empty trimmed string among the candidates, else undefined. */
function firstText(...candidates: (string | undefined)[]): string | undefined {
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) {
      return c.trim();
    }
  }

  return undefined;
}

export class ClaudeFileImporter implements FileImporter {
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
        return isClaudeExport(await readJsonFile(root)) ? { confidence: 0.95 } : { confidence: 0 };
      }

      if (isMemoryFilename(base)) {
        const conf = claudeMemoryConfidence(await readJsonFile(root));

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
        if (isClaudeExport(await readJsonFile(path.join(root, conv)))) {
          return { confidence: 0.9 };
        }

        return { confidence: 0, dir_threshold: 0.7 };
      }

      const mem = findName(names, isMemoryFilename);
      if (mem && !findName(names, (n) => CHATGPT_SIBLINGS.includes(n))) {
        const conf = claudeMemoryConfidence(await readJsonFile(path.join(root, mem)));
        if (conf > 0) {
          const marked = !!findName(names, (n) => CLAUDE_SIBLINGS.includes(n));

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
    let projectsDir: string | undefined;
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

      const projects = findName(names, (n) => n === 'projects');
      if (projects) {
        const abs = path.join(root, projects);
        try {
          if (fs.statSync(abs).isDirectory()) {
            projectsDir = abs;
          }
        } catch {
          /* not a directory */
        }
      }
    }

    if (convPath) {
      await this.importConversations(convPath, params);
    }

    if (memPath) {
      await importMemoriesFile(memPath, params, {
        idPrefix: 'claude',
        source: 'Claude',
        label: 'Claude memories',
        preferEntryTitle: true,
      });
    }

    if (projectsDir) {
      await this.importProjects(projectsDir, params);
    }
  }

  private async importConversations(fpath: string, params: ImportParams): Promise<void> {
    let raw: string;
    try {
      raw = await fs.promises.readFile(fpath, 'utf8');
    } catch (e) {
      params.log?.('error', 'Failed to read Claude conversations', { error: (e as Error).message });

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

    const root = path.dirname(fpath);
    for (const c of convs) {
      this.pushConversation(c as ClaudeConversation, root, params);
    }
  }

  /** Resolve a message's file reference to the on-disk sidecar carrying its
      bytes: `files/<name>`, `attachments/<name>`, then the export root. */
  private resolveAsset(root: string, name: string): ResolvedAsset | undefined {
    const rel = name.replace(/\\/g, '/');
    for (const candidate of [`files/${rel}`, `attachments/${rel}`, rel]) {
      const abs = path.join(root, candidate);
      if (!insideRoot(root, abs)) {
        continue;
      }

      try {
        if (fs.statSync(abs).isFile()) {
          return { abs, relKey: candidate };
        }
      } catch {
        /* not on disk — try the next candidate */
      }
    }

    return undefined;
  }

  /** Media items for one message's `files` + `attachments` references. */
  private mediaForMessage(
    msg: ClaudeChatMessage,
    root: string,
    ts: Date | undefined,
    conv: ClaudeConversation,
    params: ImportParams,
  ): Item[] {
    const names = new Set<string>();
    for (const ref of [...(msg.files ?? []), ...(msg.attachments ?? [])]) {
      if (ref && typeof ref === 'object' && typeof ref.file_name === 'string' && ref.file_name) {
        names.add(ref.file_name);
      }
    }

    const media: Item[] = [];
    for (const name of names) {
      const asset = this.resolveAsset(root, name);
      if (!asset) {
        // Only a media-looking name is a loss worth ledgering — text/PDF
        // attachments ship as extracted_content, never as bytes.
        if (mimeForFile(name)?.match(/^(image|video)\//)) {
          params.pipeline.drop?.('media_asset_missing', name);
        }

        continue;
      }

      const item = mediaItemForAsset('claude:media', 'Claude', asset, ts, {
        Conversation: conv.name || undefined,
        ThreadId: conv.uuid || undefined,
      });
      if (item) {
        media.push(item);
      }
    }

    return media;
  }

  /** One `<uuid>.json` per Claude Project inside the sibling `projects/` dir. */
  private async importProjects(dir: string, params: ImportParams): Promise<void> {
    let names: string[];
    try {
      names = await fs.promises.readdir(dir);
    } catch (e) {
      params.log?.('error', 'Failed to read Claude projects directory', { error: (e as Error).message });

      return;
    }

    for (const name of names) {
      if (!name.toLowerCase().endsWith('.json')) {
        continue;
      }

      const fpath = path.join(dir, name);
      let raw: string;
      try {
        raw = await fs.promises.readFile(fpath, 'utf8');
      } catch (e) {
        params.log?.('error', 'Failed to read Claude project', { file: name, error: (e as Error).message });
        continue;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        continue;
      }

      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        continue;
      }

      this.pushProject(parsed as ClaudeProject, name, params);
    }
  }

  /** One item per project: name as title, description + custom instructions +
      every doc's content concatenated as the body. Docs are kept together in
      a single item (rather than exploded per-doc) to match how memories.json
      collapses into notes — a project is one coherent unit of saved context,
      not a set of independent records. */
  private pushProject(p: ClaudeProject, sourceFile: string, params: ImportParams): void {
    const rawName = firstText(p.name);
    const name = rawName || 'Untitled project';
    const ts = parseFlexibleDate(p.updated_at) ?? parseFlexibleDate(p.created_at);
    if (!timeframeContains(params.timeframe, ts)) {
      return;
    }

    const sections: string[] = [];
    const description = firstText(p.description);
    if (description) {
      sections.push(description);
    }

    const instructions = firstText(p.prompt_template);
    if (instructions) {
      sections.push(`Instructions:\n${instructions}`);
    }

    const docs = Array.isArray(p.docs) ? p.docs : [];
    for (const doc of docs) {
      if (!doc || typeof doc !== 'object') {
        continue;
      }

      const docContent = firstText(doc.content, doc.text);
      if (!docContent) {
        continue;
      }

      const docTitle = firstText(doc.filename, doc.name, doc.title) || 'Untitled document';
      sections.push(`--- ${docTitle} ---\n${docContent}`);
    }

    const text = sections.join('\n\n');
    // Neither a name nor any recoverable content: not a recognizable project
    // (e.g. an unrelated/empty JSON file that happens to sit in projects/).
    if (!rawName && !text) {
      return;
    }

    const key =
      firstText(p.uuid) ||
      path.basename(sourceFile, path.extname(sourceFile)) ||
      crypto
        .createHash('sha1')
        .update(name + text)
        .digest('hex')
        .slice(0, 24);
    params.pipeline.push({
      item: {
        id: `claude:project:${key}`,
        classification: 'note',
        timestamp: ts,
        content: textContent('project.txt', text),
        metadata: {
          Kind: 'project',
          Title: name,
          Source: 'Claude',
          Text: text,
        },
      },
    });
  }

  private pushConversation(conv: ClaudeConversation, root: string, params: ImportParams): void {
    if (!conv || !Array.isArray(conv.chat_messages)) {
      return;
    }

    conv.chat_messages.forEach((msg, index) => {
      const sender = msg?.sender;
      if (sender !== 'human' && sender !== 'assistant') {
        return;
      }

      const text =
        msg.text ||
        (Array.isArray(msg.content)
          ? msg.content
              .filter((b) => b && b.type === 'text')
              .map((b) => b.text ?? '')
              .join('\n')
          : '');

      const ts = msg.created_at ? new Date(msg.created_at) : undefined;
      if (!timeframeContains(params.timeframe, ts)) {
        return;
      }

      const media = this.mediaForMessage(msg, root, ts, conv, params);
      if (!text) {
        // Media-only message (an upload with no caption): the media items ARE
        // the record — push them standalone.
        for (const m of media) {
          params.pipeline.push({ item: m });
        }

        return;
      }

      // Media accompanying a message rides the message itself (the comms media
      // lane) — attachment sub-items minted duplicate ci.events rows.
      const mediaAttachments = mediaAttachmentsFor(media);
      params.pipeline.push({
        item: {
          id: msg.uuid || `claude:${conv.uuid ?? 'unknown'}:${index}`,
          classification: 'message',
          timestamp: ts,
          content: textContent('message.txt', text),
          metadata: {
            Role: sender === 'human' ? 'user' : 'assistant',
            Direction: sender === 'human' ? 'outgoing' : 'incoming',
            Conversation: conv.name || undefined,
            // The conversation UUID, not its name: a claude.ai conversation can
            // be renamed (and an untitled one has no name at all), so the uuid
            // is the stable thread key. mediaForMessage above already stamps it
            // this way — the message path did not, so its rows carried no
            // thread key at all and landed with thread_id NULL.
            ThreadId: conv.uuid || undefined,
            Source: 'Claude',
            Text: text || undefined,
            MediaAttachments: mediaAttachments.length ? mediaAttachments : undefined,
          },
        },
      });
    });
  }
}

registerDataSource({
  name: 'claude',
  title: 'Claude',
  icon: '',
  description:
    'Conversation history, saved memories, and Projects from an Anthropic/claude.ai data export (conversations.json, memories.json, projects/).',
  newFileImporter: () => new ClaudeFileImporter(),
});
