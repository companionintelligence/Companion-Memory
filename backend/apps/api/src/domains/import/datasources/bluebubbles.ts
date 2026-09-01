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
import { decodeAttributedBody } from './attributed_body';
import { BlueBubblesApiClient, type BlueBubblesChat, type BlueBubblesMessage } from './bluebubblesApiClient';
import type { APIImporter, SettingsAccess } from './registry';
import { registerDataSource } from './registry';
import type { AttachmentDescriptor, Entity, Graph, ImportParams, Item } from './timeline';
import { timeframeContains } from './timeline';

/** Rows requested per `/message/query` page. A short page is the drain signal. */
const PAGE_LIMIT = 1000;

/**
 * Attempts at the chat directory before the run gives up.
 *
 * One failed `queryChats()` used to fall through with an EMPTY map, and the
 * cost of that is not a degraded field or two: every message in the run then
 * loses its participants, `ChatId`, `ThreadId` and `GroupName`, and every
 * OUTBOUND message loses its participant edges entirely — the exact bug
 * `imessage.ts` documents fixing, quantified there at 16,325 messages that
 * reached `ci.communications` naming nobody. A directory fetch is one HTTP
 * call at the very start of a pass, so a retry costs nothing and covers the
 * failure that actually happens (a Mac mid-wake); anything that survives three
 * attempts is a real outage, and a real outage must fail the run rather than
 * quietly import a corpus with no people in it.
 */
const CHAT_DIRECTORY_ATTEMPTS = 3;

/** Backoff between chat-directory attempts. Short: this is a wake-up, not a queue. */
const CHAT_DIRECTORY_RETRY_MS = 2_000;

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
 * The plain-text body of one message.
 *
 * `message.text` first, then `attributedBody`. Recent macOS leaves `text` NULL
 * and writes the body ONLY into the binary NSAttributedString — the switch
 * documented in `attributed_body.ts` (0.3% of 2023–24 messages, 33% of 2025,
 * 64% of 2026) — and reading `text` alone therefore loses most of the current
 * year. On the live 433,398-message corpus that is 42,170 rows (9.7%) that
 * ingested completely empty.
 *
 * Three shapes, because BlueBubbles has shipped the field as all three:
 *
 *  - its own decoded projection, `[{ string, runs }]` (or the bare object),
 *    which needs no decoder at all;
 *  - base64 of the raw typedstream blob;
 *  - a JSON-serialized Buffer, `{ type: 'Buffer', data: [...] }`.
 *
 * The last two are the chat.db bytes verbatim, which is why `imessage.ts`'s
 * `decodeAttributedBody` is reused rather than reimplemented: same blob, same
 * typedstream format, and it is framework-free so a datasource may import it.
 */
export function blueBubblesBodyText(message: BlueBubblesMessage): string | undefined {
  if (message.text) {
    return message.text;
  }

  const body = message.attributedBody;

  if (body == null) {
    return undefined;
  }

  // BlueBubbles' own decoded form. `runs` (the style spans) are deliberately
  // discarded: staging keeps a plain body, and nothing downstream renders them.
  const decoded = Array.isArray(body) ? body[0] : body;
  const stringField = (decoded as { string?: unknown } | null)?.string;

  if (typeof stringField === 'string') {
    return stringField || undefined;
  }

  if (typeof body === 'string') {
    return decodeAttributedBody(Buffer.from(body, 'base64'));
  }

  const bufferData = (body as { type?: unknown; data?: unknown }).data;

  if (Array.isArray(bufferData)) {
    return decodeAttributedBody(Buffer.from(bufferData as number[]));
  }

  return undefined;
}

/** Options the BULK importer can supply that a single webhook delivery cannot. */
export interface BlueBubblesMapOptions {
  /**
   * Handles BlueBubbles itself uses as the identifier of a 1:1 chat — the same
   * evidence `imessage.ts`'s `oneToOneChatIdentifiers` collects, and used for
   * the same fallback: a message with no resolvable chat still belongs to a
   * conversation that demonstrably exists when its correspondent IS such an
   * identifier. Absent for a webhook delivery, which carries its own chat.
   */
  oneToOneChatIdentifiers?: ReadonlySet<string>;
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
  options: BlueBubblesMapOptions = {},
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

  // A message the sender UNSENT. Its text is still in the database (Apple keeps
  // the row and stamps the retraction), and staging it would republish a body
  // its author explicitly withdrew — so the retraction is recorded and the body
  // is not. The row itself stays: "a message was unsent here" is a real fact
  // about the conversation, and dropping it would leave a hole in a thread.
  const retracted = message.dateRetracted != null;
  const bodyText = retracted ? undefined : blueBubblesBodyText(message);
  // Passed through, never invented. This used to fall back to the literal
  // 'iMessage', which mislabels every SMS whose row happens to omit the field —
  // `imessage.ts` passes `message.service` through unchanged for that reason.
  const service = message.service ?? message.handle?.service ?? null;
  const isGroup = chat?.style === GROUP_CHAT_STYLE;
  // The conversation grouping key. `chat_identifier`, NOT `chat.guid`, so the
  // same conversation imported from a chat.db export and from BlueBubbles lands
  // in ONE thread: `imessage.ts` keys on `chat.chat_identifier`, and BlueBubbles'
  // guid is a different string for the same chat (`iMessage;-;+15551234567`).
  // The 1:1 fallback is the second half of the same alignment — see
  // BlueBubblesMapOptions.oneToOneChatIdentifiers.
  const correspondent = message.handle?.address ?? null;
  const threadIdentifier =
    chat?.chatIdentifier ??
    (correspondent && options.oneToOneChatIdentifiers?.has(correspondent) ? correspondent : undefined);

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
      ...(service && { Service: service }),
      ...(senderHandle && { Sender: senderHandle }),
      // Same mutual-exclusion rule as imessage.ts: `Recipients` when the chat
      // told us the participant list, `To` as the 1:1 fallback when it did not.
      ...(recipients.length
        ? { Recipients: recipients }
        : isFromMe && message.handle?.address
          ? { To: message.handle.address }
          : {}),
      ...(chat?.chatIdentifier && { ChatId: chat.chatIdentifier }),
      ...(threadIdentifier && { ThreadId: threadIdentifier }),
      ...(isGroup && chat?.displayName && { GroupName: chat.displayName }),
      ...(message.dateRead != null && { ReadAt: new Date(message.dateRead).toISOString() }),
      ...(message.dateDelivered != null && { DeliveredAt: new Date(message.dateDelivered).toISOString() }),
      // An edit rewrites `text` in place, so without this the row reads as if
      // the current wording was always what was sent.
      ...(message.dateEdited != null && { EditedAt: new Date(message.dateEdited).toISOString() }),
      ...(retracted && { RetractedAt: new Date(message.dateRetracted!).toISOString() }),
      // A group ACTION (rename, join, leave) rather than a message. Recorded as
      // metadata and no further: neither this importer nor `imessage.ts` models
      // membership changes as their own record type, and inventing one here
      // would give BlueBubbles a vocabulary its sibling does not share. Marking
      // them at least makes a body-less row explicable instead of looking lost.
      ...(message.itemType ? { ItemType: message.itemType } : {}),
      ...(message.groupActionType ? { GroupActionType: message.groupActionType } : {}),
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
  //
  // On outbound the recipients are UNIONED with the row's own handle, deduped —
  // the fix `imessage.ts` documents at length, ported here because this file
  // re-opened the bug it closed. When the chat directory yields no participants
  // (a chat BlueBubbles returned as a summary, a directory fetch that came back
  // thin) `recipients` is empty, and edges built from it alone leave every
  // message the owner ever sent pointing at nobody — 16,325 such rows in the
  // corpus that motivated the sibling's fix. Neither list invents a
  // participant: both are handles the server stated, which is why the union is
  // safe rather than merely convenient. The metadata half of this already used
  // `message.handle.address` on exactly this branch (the `To` key above); only
  // the edges were missing it.
  const counterparts = isFromMe
    ? Array.from(new Set([...recipients, ...(correspondent ? [correspondent] : [])]))
    : senderHandle
      ? [senderHandle]
      : [];

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
 * Where one attachment's bytes go under the media store, or `null` when the
 * server named a path that would leave it.
 *
 * BOTH segments are sanitized. The filename always was; the guid — which is the
 * DIRECTORY component — was interpolated raw, so a hostile or MITM'd server
 * answering `/message/query` with a guid of `../../../../home/node/.ssh` wrote
 * attacker-chosen bytes to an attacker-chosen path as the API process. That is
 * not a theoretical peer: `use_https` defaults to FALSE, so plain-HTTP over a
 * LAN is the expected deployment. The same guid was already treated as
 * untrusted one line away (`encodeURIComponent` on the download URL); this is
 * the same value, and now the same rule.
 *
 * The containment re-check after the join is deliberate belt-and-braces, the
 * same shape `MediaStage.withinScratch` applies before it opens a parser's
 * path: sanitizing and then PROVING containment means a future change to
 * either half cannot silently reintroduce an escape.
 */
export function attachmentDestination(
  mediaStoreDir: string,
  guid: string,
  transferName: string | undefined,
): string | null {
  const dest = path.resolve(
    path.join(
      mediaStoreDir,
      'bluebubbles-attachments',
      sanitizeAttachmentFilename(guid),
      sanitizeAttachmentFilename(transferName),
    ),
  );
  const relative = path.relative(path.resolve(mediaStoreDir), dest);

  return relative === '' || relative.startsWith('..') || path.isAbsolute(relative) ? null : dest;
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

      const dest = attachmentDestination(mediaStoreDir, att.guid, att.transferName ?? undefined);

      if (dest == null) {
        log?.('warn', 'bluebubbles: attachment path escaped the media store; skipping', {
          guid: att.guid,
        });
        continue;
      }

      fs.mkdirSync(path.dirname(dest), { recursive: true });
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

    // A throw, not a log-and-return. An importer invoked without credentials
    // cannot import anything, and returning normally makes the run that called
    // it report `completed` over zero messages — indistinguishable from a
    // successful sync of a quiet week. Whether BlueBubbles is CONFIGURED is a
    // question its caller can answer before spending a run at all, and
    // `BlueBubblesSyncService.runSync` now does; reaching here means something
    // drove this importer past that gate.
    if (!host || !portRaw || !password) {
      throw new Error('bluebubbles: host, port and password must all be configured');
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
    const chats = await fetchChatDirectory(client, params.log);
    const chatsByGuid = new Map(chats.map((c) => [c.guid, c]));
    const oneToOneChatIdentifiers = oneToOneIdentifiers(chats);

    let cursor = after;
    // Paired with `cursor`, and the reason the loop cannot spin. BlueBubbles
    // applies `date >= after`, so the highest-timestamped message of a page
    // comes back as the first row of the next one — and a page whose rows ALL
    // share the cursor's timestamp (a burst, a bulk-imported thread) leaves the
    // cursor exactly where it was, which re-issues a byte-identical request
    // forever. Skipping past what has already been read is the only exit that
    // works under BOTH readings of `after`, so the offset grows whenever the
    // cursor does not and resets the moment it does.
    let offset = 0;
    let seen = 0;
    // The ascending order this pass is ALLOWED to assume, checked instead of
    // assumed. A partial pass — the Mac sleeps at page 300 of 434 — still
    // pushes what it staged, and the caller then advances its ratcheting
    // cursor to MAX(occurred_at) over those rows. That is safe if and only if
    // what was staged is a contiguous ascending PREFIX of the history: if the
    // server ever answered out of order, the max could sit beyond messages
    // that were never fetched, and the ratchet would skip them permanently and
    // silently. `sort: 'ASC'` is requested, but a request is not a guarantee,
    // so a violation stops the pass right there — which leaves the staged rows
    // a verified prefix, and makes the cursor safe to advance either way.
    let previousDateCreated: number | null = null;

    for (;;) {
      const page = await client.queryMessages({ after: cursor, limit: PAGE_LIMIT, offset });
      const cursorBefore = cursor;

      for (const message of page) {
        const inlineChat = message.chats?.[0];
        const chat = (inlineChat && chatsByGuid.get(inlineChat.guid)) || inlineChat;

        if (message.dateCreated == null) {
          params.pipeline.drop?.('invalid_timestamp');
          continue;
        }

        // Checked against what the SERVER returned, before any of this pass's
        // own filtering — the invariant is about the order rows arrive in, not
        // the subset that survives a timeframe.
        if (previousDateCreated != null && message.dateCreated < previousDateCreated) {
          throw new Error(
            `bluebubbles: server returned messages out of order despite sort:'ASC' ` +
              `(${message.dateCreated} after ${previousDateCreated}, message ${message.guid}). ` +
              `Stopping this pass so the sync cursor only ever advances over a contiguous prefix.`,
          );
        }

        previousDateCreated = message.dateCreated;

        const timestamp = new Date(message.dateCreated);
        if (!timeframeContains(params.timeframe, timestamp)) {
          continue;
        }

        const graph = mapBlueBubblesMessageToGraph(message, chat, { oneToOneChatIdentifiers });
        await downloadAttachments(graph, message, client, params.mediaStoreDir, params.log);
        params.pipeline.push(graph);
        seen += 1;

        cursor = cursor == null ? message.dateCreated : Math.max(cursor, message.dateCreated);
      }

      if (page.length < PAGE_LIMIT) {
        break;
      }

      offset = cursor === cursorBefore ? offset + page.length : 0;
    }

    params.log?.('info', 'bluebubbles: sync pass complete', { messages: seen, cursor });
  }
}

/**
 * The chat directory, retried, and FATAL when it cannot be had.
 *
 * See {@link CHAT_DIRECTORY_ATTEMPTS} for why an empty directory is not an
 * acceptable degraded mode.
 */
async function fetchChatDirectory(
  client: BlueBubblesApiClient,
  log: ImportParams['log'],
): Promise<BlueBubblesChat[]> {
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= CHAT_DIRECTORY_ATTEMPTS; attempt += 1) {
    try {
      return await client.queryChats();
    } catch (err) {
      lastError = err as Error;
      log?.('warn', 'bluebubbles: chat directory fetch failed; retrying', {
        attempt,
        of: CHAT_DIRECTORY_ATTEMPTS,
        error: lastError.message,
      });

      if (attempt < CHAT_DIRECTORY_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, CHAT_DIRECTORY_RETRY_MS));
      }
    }
  }

  throw new Error(
    `bluebubbles: could not fetch the chat directory after ${CHAT_DIRECTORY_ATTEMPTS} attempts ` +
      `(${lastError?.message ?? 'unknown error'}); refusing to import messages with no participants`,
  );
}

/**
 * Handles BlueBubbles itself uses as the identifier of a 1:1 chat.
 *
 * Lifted from `imessage.ts`'s `oneToOneChatIdentifiers`, which explains what
 * makes this evidence rather than a guess: a message with no resolvable chat
 * belongs to a conversation that DEMONSTRABLY exists when its correspondent is
 * already the identifier of a one-participant chat in this same directory.
 * When it is not, the message might equally be an orphaned group message, so
 * nothing is invented and its thread stays empty.
 */
function oneToOneIdentifiers(chats: readonly BlueBubblesChat[]): Set<string> {
  const identifiers = new Set<string>();

  for (const chat of chats) {
    const participants = chat.participants ?? [];

    if (chat.chatIdentifier && participants.length === 1 && participants[0].address === chat.chatIdentifier) {
      identifiers.add(chat.chatIdentifier);
    }
  }

  return identifiers;
}

registerDataSource({
  name: 'bluebubbles',
  title: 'BlueBubbles (iMessage/SMS)',
  icon: 'bluebubbles.svg',
  description: 'Import iMessage/SMS history from a BlueBubbles server, and keep it in sync.',
  newAPIImporter: () => new BlueBubblesAPIImporter(),
});
