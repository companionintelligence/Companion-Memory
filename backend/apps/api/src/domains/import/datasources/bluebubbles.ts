/* BlueBubbles datasource (ETL importer).
 *
 * BlueBubbles (https://github.com/BlueBubblesApp/bluebubbles-app) is a macOS
 * app that exposes one Mac's iMessage/SMS history over a REST API + webhooks.
 * This file is the first (and, at time of writing, only) implementation of
 * {@link APIImporter} — historical backfill runs through `apiImport`, and live
 * messages arrive later via a webhook that calls {@link mapBlueBubblesMessageToGraph}
 * directly (see `domains/bluebubbles/controllers/BlueBubblesWebhookController.ts`).
 *
 * Structurally mirrors `imessage.ts`'s message → Item/Entity mapping so the two
 * share metadata field names and downstream pipeline behavior (comms
 * participant edges, reaction/reply inlining, media attachment descriptors).
 * The only real difference is where the messages come from — a live REST API
 * instead of a local chat.db — and that BlueBubbles' timestamps are already
 * standard Unix milliseconds, never the Cocoa epoch chat.db stores.
 *
 * The actual BlueBubbles HTTP protocol (auth, pagination, the envelope shape)
 * is NOT reimplemented here: it lives once in `BlueBubblesApiClient`
 * (`./bluebubblesApiClient.ts`, same domain), a plain DI-free class with
 * no NestJS imports, so it is safe to use from this framework-free module too.
 */
import fs from 'node:fs';
import path from 'node:path';

import { isShortCode } from '../staging/identity';

import { attachmentMediaKind, sanitizeAttachmentFilename } from './attachment_extract';
import { BlueBubblesApiClient, type BlueBubblesChat, type BlueBubblesMessage } from './bluebubblesApiClient';
import type { APIImporter, SettingsAccess } from './registry';
import { registerDataSource } from './registry';
import type { AttachmentDescriptor, Entity, Graph, ImportParams, Item } from './timeline';
import { timeframeContains } from './timeline';

/** Rows requested per `/message/query` page. A short page is the drain signal. */
const PAGE_LIMIT = 1000;

/**
 * The conversation-partner entity for one BlueBubbles handle address — a phone
 * number or an Apple ID email, never anything else.
 *
 * Deliberately duplicated from `imessage.ts`'s `contactEntity()` rather than
 * shared, matching the established convention (`googlevoice.ts` independently
 * reimplements the identical pattern with a comment citing `imessage.ts`) —
 * cross-source entity dedup happens at the canonical layer via the shared
 * `identity` attribute, not by sharing this helper. See `contactEntity` in
 * `imessage.ts` for the full rationale (short codes must stay Concepts, not
 * Persons, and why `identity: true` is what makes this a contact at all).
 */
function handleEntity(address: string): Entity {
  const isEmail = address.includes('@');

  return {
    type: isShortCode(address) ? 'short_code' : 'contact',
    name: address,
    attributes: [{ name: isEmail ? 'email' : 'phone', value: address, identity: true }],
  };
}

/** BlueBubbles `chat.style`: 43 = group, 45 = direct message. */
const GROUP_CHAT_STYLE = 43;

/** Strip the `p:<part>/` part-prefix BlueBubbles (like chat.db) puts on a tapback/reply target guid. */
function bareGuid(guid: string): string {
  return guid.replace(/^p:\d+\//, '');
}

/**
 * Map one BlueBubbles attachment to the shared {@link AttachmentDescriptor}
 * shape, without bytes — {@link downloadAttachments} fills `path` in
 * separately (this function stays pure so it can be shared with the webhook
 * handler, which downloads on its own schedule).
 */
function attachmentDescriptor(att: {
  guid: string;
  mimeType?: string | null;
  transferName?: string | null;
}): AttachmentDescriptor {
  return {
    guid: att.guid,
    ...(att.transferName ? { filename: att.transferName } : {}),
    type: attachmentMediaKind(att.mimeType ?? undefined),
    ...(att.mimeType ? { mimetype: att.mimeType } : {}),
  };
}

/**
 * Map one BlueBubbles message (with its resolved chat, when known) to a
 * {@link Graph}: the Item plus its participant edges.
 *
 * PURE and exported so both the bulk {@link BlueBubblesAPIImporter.apiImport}
 * loop and the live webhook handler share exactly one mapping implementation —
 * see the module doc comment above.
 *
 * Metadata field names are chosen to match `imessage.ts` VERBATIM ('Text',
 * 'From Me', 'Service', 'Sender', 'Recipients', 'ChatId', 'ThreadId',
 * 'GroupName', 'ReadAt', 'DeliveredAt', 'ReactionTo', 'Reaction', 'ReplyTo',
 * 'ThreadOriginator', 'MediaAttachments') so nothing downstream of staging
 * needs to know which of the two sources produced a given row.
 */
export function mapBlueBubblesMessageToGraph(
  message: BlueBubblesMessage,
  chat: BlueBubblesChat | undefined,
): Graph {
  const timestamp = message.dateCreated != null ? new Date(message.dateCreated) : new Date();
  const isFromMe = message.isFromMe === true;
  // Self has no handle on an outbound message, same as chat.db.
  const senderHandle = isFromMe ? null : (message.handle?.address ?? null);
  const participantAddresses = (chat?.participants ?? []).map((p) => p.address).filter(Boolean);
  // Recipients = chat participants minus the sender. On outbound the
  // participant list IS the recipient list (self carries no handle to
  // subtract); on inbound only the sender needs subtracting.
  const recipients = senderHandle
    ? participantAddresses.filter((address) => address !== senderHandle)
    : participantAddresses;

  const bodyText = message.text ?? undefined;
  const service = message.service ?? message.handle?.service ?? 'iMessage';
  const isGroup = chat?.style === GROUP_CHAT_STYLE;

  const item: Item = {
    // hashItem() short-circuits to item.id when present, so the message's own
    // guid gives correct cross-sync dedup (bulk backfill vs. webhook) for free.
    id: message.guid,
    classification: 'message',
    timestamp,
    content: { filename: `message_${message.guid}.txt` },
    metadata: {
      Source: 'BlueBubbles',
      ...(bodyText && { Text: bodyText }),
      'From Me': isFromMe,
      Service: service,
      ...(senderHandle && { Sender: senderHandle }),
      // Same mutual-exclusion rule as imessage.ts: `Recipients` when the chat
      // told us the participant list, `To` as the 1:1 fallback when it did not.
      ...(recipients.length
        ? { Recipients: recipients }
        : isFromMe && message.handle?.address
          ? { To: message.handle.address }
          : {}),
      ...(chat?.chatIdentifier && { ChatId: chat.chatIdentifier }),
      ...(chat?.guid && { ThreadId: chat.guid }),
      ...(isGroup && chat?.displayName && { GroupName: chat.displayName }),
      ...(message.dateRead != null && { ReadAt: new Date(message.dateRead).toISOString() }),
      ...(message.dateDelivered != null && { DeliveredAt: new Date(message.dateDelivered).toISOString() }),
    },
  };

  // Tapback / edit reference — recorded INLINE on this message rather than as
  // a separate placeholder item pointing at the target, mirroring imessage.ts:
  // the target already has its own timestamp, and a placeholder would collide
  // with it on guid. A '-remove' suffixed type is a tapback RETRACTION, not a
  // reaction to record.
  if (message.associatedMessageGuid && message.associatedMessageType) {
    if (!message.associatedMessageType.endsWith('-remove')) {
      item.metadata!.ReactionTo = bareGuid(message.associatedMessageGuid);
      item.metadata!.Reaction = message.associatedMessageType;
    }
  }

  // Replies / threads — same reasoning as reactions above.
  if (message.replyToGuid && message.threadOriginatorGuid) {
    item.metadata!.ReplyTo = message.replyToGuid;
    item.metadata!.ThreadOriginator = message.threadOriginatorGuid;
  }

  if (message.attachments?.length) {
    item.metadata!.MediaAttachments = message.attachments.map((att) => attachmentDescriptor(att));
  }

  const graph: Graph = { item, edges: [] };

  // Participant edges, mirroring imessage.ts: outbound fans out to every
  // recipient, inbound points at the sender alone (resolveCorrespondents reads
  // the first participant edge as the sender on inbound rows).
  const counterparts = isFromMe ? recipients : senderHandle ? [senderHandle] : [];

  for (const address of counterparts) {
    graph.edges!.push({
      relation: 'participant',
      to: { entity: handleEntity(address) },
      metadata: { direction: isFromMe ? 'outgoing' : 'incoming' },
    });
  }

  return graph;
}

/**
 * Download a message's attachment bytes (best-effort) and fill in `path` on
 * the descriptors {@link mapBlueBubblesMessageToGraph} already staged.
 *
 * Kept separate from the pure mapper above because it does I/O; called from
 * both the bulk importer loop and the webhook handler so a purged/unreachable
 * attachment still records guid/filename/mimetype (matching imessage.ts's
 * treatment of attachments whose bytes are gone) rather than being dropped.
 */
export async function downloadAttachments(
  graph: Graph,
  message: BlueBubblesMessage,
  client: BlueBubblesApiClient,
  mediaStoreDir: string | undefined,
  log?: ImportParams['log'],
): Promise<void> {
  const attachments = message.attachments;
  if (!attachments?.length || !mediaStoreDir) {
    return;
  }

  const descriptors = graph.item?.metadata?.MediaAttachments as AttachmentDescriptor[] | undefined;
  if (!descriptors?.length) {
    return;
  }

  for (let i = 0; i < attachments.length; i += 1) {
    const att = attachments[i];
    const descriptor = descriptors[i];
    if (!descriptor) {
      continue;
    }

    try {
      const bytes = await client.downloadAttachment(att.guid);
      if (!bytes || bytes.length === 0) {
        continue;
      }

      const name = sanitizeAttachmentFilename(att.transferName ?? undefined);
      const dir = path.join(mediaStoreDir, 'bluebubbles-attachments', att.guid);
      fs.mkdirSync(dir, { recursive: true });
      const dest = path.join(dir, name);
      fs.writeFileSync(dest, bytes);
      descriptor.path = dest;
    } catch (err) {
      log?.('debug', 'bluebubbles: attachment download failed', {
        guid: att.guid,
        error: (err as Error).message,
      });
    }
  }
}

/**
 * Exported (unlike most datasource importer classes) so
 * `BlueBubblesSyncService` — the DI-friendly wiring in `domains/bluebubbles/`
 * that gives this importer its first caller — can construct it directly,
 * per the implementation plan, rather than going through the registry.
 */
export class BlueBubblesAPIImporter implements APIImporter {
  async apiImport(settings: SettingsAccess, params: ImportParams): Promise<void> {
    const host = settings.getSetting('host');
    const portRaw = settings.getSetting('port');
    const password = settings.getSetting('password');

    if (!host || !portRaw || !password) {
      params.log?.('error', 'bluebubbles: host/port/password not configured; skipping sync');

      return;
    }

    const port = Number.parseInt(portRaw, 10);
    const useHttps = settings.getSetting('useHttps') === 'true';
    const lastSyncCursorRaw = settings.getSetting('lastSyncCursor');
    const after = lastSyncCursorRaw ? Number.parseInt(lastSyncCursorRaw, 10) : undefined;

    const client = new BlueBubblesApiClient({
      host,
      port: Number.isFinite(port) ? port : 1234,
      useHttps,
      password,
    });

    // A full chat directory (with participants), resolved ONCE per run rather
    // than per message — `/message/query`'s embedded `chats[]` entries are
    // often summaries with no participant list, and a message's participants
    // are needed for every row it produces.
    let chatsByGuid = new Map<string, BlueBubblesChat>();
    try {
      const chats = await client.queryChats();
      chatsByGuid = new Map(chats.map((c) => [c.guid, c]));
    } catch (err) {
      params.log?.('error', 'bluebubbles: failed to fetch chat directory', {
        error: (err as Error).message,
      });
    }

    let cursor = after;
    let seen = 0;

    for (;;) {
      let page: BlueBubblesMessage[];

      try {
        page = await client.queryMessages({ after: cursor, limit: PAGE_LIMIT });
      } catch (err) {
        params.log?.('error', 'bluebubbles: message page fetch failed', {
          error: (err as Error).message,
        });
        break;
      }

      for (const message of page) {
        const inlineChat = message.chats?.[0];
        const chat = (inlineChat && chatsByGuid.get(inlineChat.guid)) || inlineChat;

        if (message.dateCreated == null) {
          params.pipeline.drop?.('invalid_timestamp');
          continue;
        }

        const timestamp = new Date(message.dateCreated);
        if (!timeframeContains(params.timeframe, timestamp)) {
          continue;
        }

        const graph = mapBlueBubblesMessageToGraph(message, chat);
        await downloadAttachments(graph, message, client, params.mediaStoreDir, params.log);
        params.pipeline.push(graph);
        seen += 1;

        cursor = cursor == null ? message.dateCreated : Math.max(cursor, message.dateCreated);
      }

      if (page.length < PAGE_LIMIT) {
        break;
      }
    }

    params.log?.('info', 'bluebubbles: sync pass complete', { messages: seen, cursor });
  }
}

registerDataSource({
  name: 'bluebubbles',
  title: 'BlueBubbles (iMessage/SMS)',
  icon: 'bluebubbles.svg',
  description: 'Import iMessage/SMS history from a BlueBubbles server, and keep it in sync.',
  newAPIImporter: () => new BlueBubblesAPIImporter(),
});
