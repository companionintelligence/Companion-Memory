/* Telegram — Telegram Desktop "Export Telegram data" in JSON mode (result.json). */
import fs from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import type { FileImporter, Recognition, DirEntry } from './registry';
import { registerDataSource } from './registry';
import type { ImportParams } from './timeline';
import { timeframeContains } from './timeline';

interface TGContact {
  first_name?: string;
  last_name?: string;
  phone_number?: string;
  date?: string;
  date_unixtime?: string | number;
}

interface TGTextEntity {
  type?: string;
  text?: string;
}

interface TGMessage {
  id?: number;
  type?: string; // 'message' | 'service'
  date?: string;
  date_unixtime?: string | number;
  from?: string;
  from_id?: string;
  text?: string | Array<string | TGTextEntity>;
  text_entities?: TGTextEntity[];
}

interface TGChat {
  name?: string;
  type?: string;
  id?: number;
  messages?: TGMessage[];
}

interface TGPersonalInfo {
  user_id?: number;
  first_name?: string;
  last_name?: string;
}

interface TGExport {
  about?: string;
  personal_information?: TGPersonalInfo;
  contacts?: { list?: TGContact[] };
  chats?: { list?: TGChat[] };
}

function isTelegramExport(obj: unknown): obj is TGExport {
  if (!obj || typeof obj !== 'object') {
    return false;
  }

  const o = obj as Record<string, unknown>;
  const hasAbout = typeof o.about === 'string';
  const hasPersonal = o.personal_information != null && typeof o.personal_information === 'object';
  const hasChats = o.chats != null && typeof o.chats === 'object';

  return hasAbout && (hasPersonal || hasChats);
}

export class TelegramFileImporter implements FileImporter {
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
      if (path.basename(root).toLowerCase() !== 'result.json') {
        return { confidence: 0 };
      }

      const obj = await this.tryParse(root);

      return isTelegramExport(obj) ? { confidence: 0.95 } : { confidence: 0 };
    }

    if (st.isDirectory()) {
      try {
        const match = (await readdir(root)).find((n) => n.toLowerCase() === 'result.json');
        if (match) {
          const obj = await this.tryParse(path.join(root, match));
          if (isTelegramExport(obj)) {
            return { confidence: 0.9 };
          }
        }
      } catch {
        /* ignore */
      }

      return { confidence: 0, dir_threshold: 0.7 };
    }

    return { confidence: 0 };
  }

  private async tryParse(fpath: string): Promise<unknown> {
    try {
      return JSON.parse(await readFile(fpath, 'utf8'));
    } catch {
      return undefined;
    }
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

    let fpath: string | undefined;
    if (stat.isFile()) {
      fpath = root;
    } else if (stat.isDirectory()) {
      try {
        const match = fs.readdirSync(root).find((n) => n.toLowerCase() === 'result.json');
        if (match) {
          fpath = path.join(root, match);
        }
      } catch {
        return;
      }
    }

    if (!fpath) {
      return;
    }

    let raw: string;
    try {
      raw = await fs.promises.readFile(fpath, 'utf8');
    } catch (e) {
      params.log?.('error', 'Failed to read Telegram result.json', { error: (e as Error).message });

      return;
    }

    let data: TGExport;
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }

    if (!data || typeof data !== 'object') {
      return;
    }

    // Contacts → entities
    for (const c of data.contacts?.list ?? []) {
      if (!c || typeof c !== 'object') {
        continue;
      }

      const name = `${c.first_name ?? ''} ${c.last_name ?? ''}`.trim();
      if (!c.phone_number) {
        continue;
      }

      params.pipeline.push({
        entity: {
          name,
          attributes: [{ name: 'phone', value: c.phone_number, identity: true }],
          metadata: { Source: 'Telegram' },
        },
      });
    }

    // Owner id (from_id is the string 'user' + user_id) for direction derivation.
    const pi = data.personal_information;
    const ownerId = pi?.user_id != null ? `user${pi.user_id}` : undefined;
    const ownerName = pi ? `${pi.first_name ?? ''} ${pi.last_name ?? ''}`.trim() : '';

    // Messages → items
    for (const chat of data.chats?.list ?? []) {
      if (!chat || typeof chat !== 'object') {
        continue;
      }

      for (const [i, msg] of (chat.messages ?? []).entries()) {
        if (!msg || typeof msg !== 'object') {
          continue;
        }

        if (msg.type !== 'message') {
          params.pipeline.drop?.('non_message_type');
          continue;
        }

        let ts: Date | undefined;
        if (msg.date_unixtime != null) {
          ts = new Date(Number(msg.date_unixtime) * 1000);
        } else if (msg.date) {
          ts = new Date(msg.date);
        }

        if (ts && isNaN(ts.getTime())) {
          ts = undefined;
        }

        if (!timeframeContains(params.timeframe, ts)) {
          params.pipeline.drop?.('outside_timeframe');
          continue;
        }

        const text = this.extractText(msg.text);
        if (!text) {
          params.pipeline.drop?.('empty_after_parse');
          continue;
        }

        const isOutbound = ownerId != null && msg.from_id === ownerId;
        const direction = ownerId != null ? (isOutbound ? 'outbound' : 'inbound') : undefined;
        // 1:1 chat name is the counterpart; on outbound they are the recipient,
        // on inbound the owner is. recipientsFrom reads a single To string.
        const to =
          chat.type === 'personal_chat'
            ? isOutbound
              ? chat.name || undefined
              : ownerName || undefined
            : undefined;
        params.pipeline.push({
          item: {
            id: msg.id != null ? `telegram:${chat.id}:${msg.id}` : `telegram:${chat.id}:${ts?.getTime() ?? 'noTs'}:${i}`,
            classification: 'message',
            timestamp: ts,
            content: {
              filename: 'message.txt',
              mediaType: 'text/plain',
              data: async () => Buffer.from(text),
            },
            metadata: {
              Sender: msg.from || undefined,
              To: to,
              Direction: direction,
              Conversation: chat.name || undefined,
              Source: 'Telegram',
              Text: text || undefined,
            },
          },
        });
      }
    }
  }

  private extractText(text: TGMessage['text']): string {
    if (typeof text === 'string') {
      return text;
    }

    if (Array.isArray(text)) {
      return text.map((p) => (typeof p === 'string' ? p : p?.text || '')).join('');
    }

    return '';
  }
}

registerDataSource({
  name: 'telegram',
  title: 'Telegram',
  icon: '',
  description: 'Contacts and chat messages from a Telegram Desktop JSON export (result.json).',
  newFileImporter: () => new TelegramFileImporter(),
});
