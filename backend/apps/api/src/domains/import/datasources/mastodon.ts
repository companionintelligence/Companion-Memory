/* Mastodon — ActivityPub account export (outbox.json).
   The export is an ActivityPub OrderedCollection whose `orderedItems` holds the
   user's activities. We emit one 'post' event per "Create" activity wrapping a
   "Note" object; "Announce" activities (boosts) are skipped. The presence of an
   `orderedItems` array (and a corroborating actor.json alongside it) is what
   disambiguates a Mastodon export from other JSON exports.
*/
import fs from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { htmlToText } from './htmlToText';
import type { FileImporter, Recognition, DirEntry } from './registry';
import { registerDataSource } from './registry';
import type { ImportParams } from './timeline';
import { timeframeContains } from './timeline';

interface ActivityObject {
  type?: string;
  content?: string;
  url?: string;
  summary?: string | null;
}

interface Activity {
  type?: string;
  published?: string;
  object?: ActivityObject | string;
}

interface Outbox {
  '@context'?: unknown;
  id?: unknown;
  orderedItems?: unknown;
}

interface Actor {
  type?: unknown;
  preferredUsername?: unknown;
  outbox?: unknown;
}

async function readJson(fpath: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await readFile(fpath, 'utf8');
  } catch {
    return undefined;
  }

  if (raw.charCodeAt(0) === 0xfeff) {
    raw = raw.slice(1);
  }

  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

// An `orderedItems` array is the literal W3C ActivityPub OrderedCollection
// contract, not a Mastodon-specific signal — Pleroma, Akkoma, GoToSocial,
// PeerTube, and Pixelfed all export an outbox.json in this exact shape, so
// this alone only proves "some ActivityPub server produced this file."
function isOutbox(parsed: unknown): boolean {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return false;
  }

  return Array.isArray((parsed as Outbox).orderedItems);
}

// What only Mastodon's own serializer writes: the collection's `@context`
// carries Mastodon's OStatus-heritage namespace extension (`"ostatus":
// "http://ostatus.org#"`, `"atomUri": "ostatus:atomUri"`), inherited from its
// GNU-social/OStatus interop layer. The other ActivityPub projects here are
// independent implementations with their own namespace extensions (Pleroma's
// "litepub", GoToSocial's own vocabulary, …) and don't reproduce this
// specific pair.
function hasMastodonNamespace(parsed: unknown): boolean {
  if (!parsed || typeof parsed !== 'object') {
    return false;
  }

  const ctx = (parsed as Outbox)['@context'];
  if (!Array.isArray(ctx)) {
    return false;
  }

  return ctx.some((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return false;
    }

    const o = entry as Record<string, unknown>;

    return o.ostatus === 'http://ostatus.org#' || o.atomUri === 'ostatus:atomUri';
  });
}

// actor.json sitting beside outbox.json is only real corroboration when it's
// actually a Mastodon actor — a Person/Service whose own `outbox` field
// points back at this exact file — not merely a file with that name (any
// exporter could drop one).
function isMastodonActor(parsed: unknown, outboxId: unknown): boolean {
  if (!parsed || typeof parsed !== 'object') {
    return false;
  }

  const a = parsed as Actor;
  if ((a.type !== 'Person' && a.type !== 'Service') || typeof a.preferredUsername !== 'string') {
    return false;
  }

  return typeof outboxId !== 'string' || a.outbox === outboxId;
}


export class MastodonFileImporter implements FileImporter {
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
      if (path.basename(root).toLowerCase() !== 'outbox.json') {
        return { confidence: 0 };
      }

      const parsed = await readJson(root);
      if (!isOutbox(parsed)) {
        return { confidence: 0 };
      }

      // The generic OrderedCollection shape alone is shared by every
      // ActivityPub exporter, so it isn't enough to confidently label this
      // Mastodon. Only the namespace extension Mastodon's own serializer
      // writes earns the top tier; a generic-but-unconfirmed outbox.json
      // still gets picked up (nothing else in this codebase claims it), just
      // not confidently enough to beat a real competing importer.
      return hasMastodonNamespace(parsed) ? { confidence: 0.95 } : { confidence: 0.5 };
    }

    if (st.isDirectory()) {
      let names: string[];
      try {
        names = await readdir(root);
      } catch {
        names = [];
      }

      const outboxName = names.find((n) => n.toLowerCase() === 'outbox.json');
      if (!outboxName) {
        return { confidence: 0, dir_threshold: 0.7 };
      }

      const outbox = await readJson(path.join(root, outboxName));
      if (!isOutbox(outbox)) {
        return { confidence: 0, dir_threshold: 0.7 };
      }

      // actor.json alongside outbox.json is only real corroboration once its
      // own content is verified as a Mastodon actor pointing back at this
      // outbox — not merely a file with that name.
      const actorName = names.find((n) => n.toLowerCase() === 'actor.json');
      if (actorName && isMastodonActor(await readJson(path.join(root, actorName)), (outbox as Outbox).id)) {
        return { confidence: 0.97 };
      }

      if (hasMastodonNamespace(outbox)) {
        return { confidence: 0.95 };
      }

      return { confidence: 0.5 };
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

    let fpath: string | undefined;
    if (stat.isFile()) {
      fpath = root;
    } else if (stat.isDirectory()) {
      const match = (() => {
        try {
          return fs.readdirSync(root);
        } catch {
          return [];
        }
      })().find((n) => n.toLowerCase() === 'outbox.json');
      if (match) {
        fpath = path.join(root, match);
      }
    }

    if (!fpath) {
      return;
    }

    let raw: string;
    try {
      raw = await fs.promises.readFile(fpath, 'utf8');
    } catch (e) {
      params.log?.('error', 'Failed to read Mastodon outbox.json', { error: (e as Error).message });

      return;
    }

    if (raw.charCodeAt(0) === 0xfeff) {
      raw = raw.slice(1);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      params.log?.('error', 'Failed to parse Mastodon outbox.json', { error: (e as Error).message });

      return;
    }

    if (!isOutbox(parsed)) {
      return;
    }

    const items = (parsed as Outbox).orderedItems as unknown[];
    for (const it of items) {
      try {
        this.pushActivity(it as Activity, params);
      } catch (e) {
        params.log?.('error', 'Failed to import Mastodon activity', { error: (e as Error).message });
      }
    }
  }

  private pushActivity(act: Activity, params: ImportParams): void {
    if (!act || typeof act !== 'object') {
      return;
    }

    if (act.type !== 'Create') {
      return;
    } // skip "Announce" (boosts) and others

    const obj = act.object;
    if (!obj || typeof obj !== 'object') {
      return;
    }

    if (obj.type !== 'Note') {
      return;
    }

    let ts: Date | undefined = act.published ? new Date(act.published) : undefined;
    if (ts && isNaN(ts.getTime())) {
      ts = undefined;
    }

    if (!timeframeContains(params.timeframe, ts)) {
      return;
    }

    const text = htmlToText(obj.content || '');

    params.pipeline.push({
      item: {
        classification: 'post',
        timestamp: ts,
        content: {
          filename: 'post.txt',
          mediaType: 'text/plain',
          data: async () => Buffer.from(text),
        },
        metadata: {
          Source: 'Mastodon',
          URL: obj.url || undefined,
          Text: text || undefined,
          'Content Warning': obj.summary != null && obj.summary !== '' ? obj.summary : undefined,
        },
      },
    });
  }
}

registerDataSource({
  name: 'mastodon',
  title: 'Mastodon',
  icon: '',
  description: 'Posts from a Mastodon ActivityPub export (outbox.json).',
  newFileImporter: () => new MastodonFileImporter(),
});
