/* iMessage datasource (TypeScript port)
   Consolidated minimal importer: fetches messages with basic metadata, timeframe filtering.
*/
import fs from 'fs';
import { stat } from 'node:fs/promises';
import path from 'path';

import Database from 'better-sqlite3';

import { isShortCode } from '../staging/identity';

import { attachmentMediaKind } from './attachment_extract';
import { decodeAttributedBody } from './attributed_body';
import type { FileImporter, Recognition, DirEntry } from './registry';
import { registerDataSource } from './registry';
import type { AttachmentDescriptor, Entity, Graph, ImportParams, Item } from './timeline';
import { timeframeContains } from './timeline';

interface iMessageOptions {
  ownerEntityId?: number;
}

// Apple's Cocoa epoch (January 1, 2001) to Unix epoch conversion
const COCOA_EPOCH_OFFSET = Date.UTC(2001, 0, 1) / 1000;

function parseCocoaDate(cocoaTimestamp: number): Date {
  // macOS ≤10.12 stores message.date as seconds since 2001-01-01; macOS
  // 10.13+/iOS 11+ stores nanoseconds. Seconds stay below ~1e10 for
  // centuries, so anything larger is a nanosecond value.
  const seconds = cocoaTimestamp > 1e11 ? cocoaTimestamp / 1e9 : cocoaTimestamp;
  const unixSeconds = COCOA_EPOCH_OFFSET + seconds;

  return new Date(unixSeconds * 1000);
}

/** The store-relative key inside an `Attachments/` tree, e.g. `ab/12/<UUID>/IMG_0042.HEIC`. */
const ATTACHMENTS_SEGMENT = 'Attachments/';

/**
 * Every on-disk path an `attachment.filename` from chat.db could plausibly
 * name, most specific first. The caller takes the first one that exists.
 *
 * chat.db does NOT store a bare basename: it stores the path the file had on
 * the Mac that wrote it, which is tilde-rooted
 * (`~/Library/Messages/Attachments/ab/12/<UUID>/IMG_0042.HEIC`) on every
 * modern macOS, and absolute (`/Users/<name>/Library/...`) on older ones. The
 * previous code joined that whole value onto `<chat.db dir>/Attachments/`,
 * yielding `<dir>/Attachments/~/Library/Messages/Attachments/ab/12/...` — a
 * path that exists nowhere. `existsSync` was therefore false for essentially
 * every attachment in a real export, and the descriptor was silently dropped,
 * which is how 21,781 messages ended up recording neither their text (a bare
 * U+FFFC) nor the attachment that replaced it.
 *
 * The candidates, in order:
 *  1. tilde form resolved against the EXPORT ROOT — the export mirrors the home
 *     directory, so `~/Library/...` lives at `<root>/Library/...`;
 *  2. an absolute path as-is (only hits when importing on the same Mac);
 *  3. the store-relative tail joined onto `<chat.db dir>/Attachments/` — the
 *     layout-independent fallback, and the one that works for a flat export
 *     where chat.db sits next to its own `Attachments/` tree;
 *  4. the same tail under `<export root>/Attachments/`;
 *  5. a genuinely relative value under the export root, then under
 *     `<chat.db dir>/Attachments/` (the historical behaviour, kept so a bare
 *     `photo.jpg` still resolves).
 */
export function imessageAttachmentCandidates(
  rawFilename: string,
  exportRoot: string,
  chatDbPath: string,
): string[] {
  const raw = rawFilename.trim();
  if (!raw) {
    return [];
  }

  const attachmentsDir = path.join(path.dirname(chatDbPath), 'Attachments');
  const out: string[] = [];
  const add = (candidate: string): void => {
    if (!out.includes(candidate)) {
      out.push(candidate);
    }
  };

  const tilde = raw.startsWith('~/');
  const absolute = path.isAbsolute(raw);

  if (tilde) {
    add(path.join(exportRoot, raw.slice(2)));
  } else if (absolute) {
    add(raw);
  }

  const at = raw.lastIndexOf(ATTACHMENTS_SEGMENT);
  const tail = at === -1 ? null : raw.slice(at + ATTACHMENTS_SEGMENT.length);
  if (tail) {
    add(path.join(attachmentsDir, tail));
    add(path.join(exportRoot, 'Attachments', tail));
  }

  if (!tilde && !absolute) {
    add(path.join(exportRoot, raw));
    add(path.join(attachmentsDir, raw));
  }

  return out;
}

class iMessageFileImporter implements FileImporter {
  async recognize(_ctx: unknown, entry: DirEntry): Promise<Recognition> {
    const baseDir = entry.fullPath || entry.fsRoot || entry.filename;
    if (!baseDir) {
      return { confidence: 0 };
    }

    // Look for chat.db file in various locations
    const chatDbPaths = [
      path.join(baseDir, 'chat.db'),
      path.join(baseDir, 'Library/Messages/chat.db'),
      path.join(baseDir, '3d/3d0d7e5fb2ce288813306e4d4636395e047a3d28'), // iPhone backup path
    ];

    for (const dbPath of chatDbPaths) {
      try {
        await stat(dbPath);

        return { confidence: 0.9 };
      } catch {
        /* not present */
      }
    }

    return { confidence: 0 };
  }

  async fileImport(_ctx: unknown, entry: DirEntry, params: ImportParams): Promise<void> {
    const baseDir = entry.fullPath || entry.fsRoot || entry.filename;
    if (!baseDir) {
      return;
    }

    // Find chat.db
    const chatDbPaths = [
      path.join(baseDir, 'chat.db'),
      path.join(baseDir, 'Library/Messages/chat.db'),
      path.join(baseDir, '3d/3d0d7e5fb2ce288813306e4d4636395e047a3d28'),
    ];

    let chatDbPath: string | null = null;
    for (const dbPath of chatDbPaths) {
      if (fs.existsSync(dbPath)) {
        chatDbPath = dbPath;
        break;
      }
    }

    if (!chatDbPath) {
      params.log?.('error', 'chat.db not found', { searchPaths: chatDbPaths });

      return;
    }

    let db: Database.Database | undefined;
    try {
      db = new Database(chatDbPath, { readonly: true });
    } catch (e) {
      params.log?.('error', 'Failed to open chat.db', { error: (e as Error).message });

      return;
    }

    try {
      // Dynamic column presence checking for newer DBs (reactions, threads)
      let columns: string[] = [];
      try {
        const colsStmt = db.prepare('PRAGMA table_info(message)');
        columns = (colsStmt.all() as Array<{ name: string }>).map((r) => r.name);
      } catch {
        /* ignore */
      }

      const has = (c: string) => columns.includes(c);

      // Build a chat lookup so we can resolve the full participant list per
      // message. The `message` row only carries ONE handle_id (the sender for
      // inbound, NULL for outbound), so without joining chat_handle_join we
      // collapse every group chat to "from sender, no recipients" and lose all
      // recipient info on outbound 1:1s. macOS stores the conversation in `chat`
      // and links it via chat_message_join / chat_handle_join — self has no
      // handle row, so chat_handle_join lists only the OTHER participants.
      const chatById = new Map<
        number,
        { identifier: string | null; displayName: string | null; participants: string[] }
      >();
      const chatIdByMessage = new Map<number, number>();
      /**
       * Handles that iMessage itself uses as the identifier of a 1:1 chat —
       * `chat.chat_identifier` equal to the chat's single other participant.
       *
       * This is the evidence the thread fallback below needs. A message with no
       * `chat_message_join` row has no conversation of its own, but if its
       * correspondent is a handle that IS a 1:1 chat identifier in this same
       * database, then the thread it belongs to is not a guess — it is a chat
       * that demonstrably exists, under the exact key its other messages
       * already use. When the correspondent is NOT such an identifier the
       * message might equally be an orphaned group message, so nothing is
       * invented and the thread stays empty. On the live corpus that splits
       * 45,280 chat-less rows into 8,099 recoverable and 37,181 that honestly
       * cannot be placed.
       */
      const oneToOneChatIdentifiers = new Set<string>();
      try {
        const chatRows = db
          .prepare(
            `
          SELECT c.ROWID AS chat_id, c.chat_identifier AS chat_identifier, c.display_name AS display_name, h.id AS handle_id
          FROM chat c
          LEFT JOIN chat_handle_join chj ON chj.chat_id = c.ROWID
          LEFT JOIN handle h ON h.ROWID = chj.handle_id
        `,
          )
          .all() as Array<{
          chat_id: number;
          chat_identifier: string | null;
          display_name: string | null;
          handle_id: string | null;
        }>;
        for (const r of chatRows) {
          let entry = chatById.get(r.chat_id);
          if (!entry) {
            entry = {
              identifier: r.chat_identifier ?? null,
              displayName: r.display_name ?? null,
              participants: [],
            };
            chatById.set(r.chat_id, entry);
          }

          if (r.handle_id && !entry.participants.includes(r.handle_id)) {
            entry.participants.push(r.handle_id);
          }
        }

        for (const r of db
          .prepare('SELECT message_id, chat_id FROM chat_message_join')
          .iterate() as Iterable<{ message_id: number; chat_id: number }>) {
          chatIdByMessage.set(r.message_id, r.chat_id);
        }

        for (const entry of chatById.values()) {
          if (
            entry.identifier &&
            entry.participants.length === 1 &&
            entry.participants[0] === entry.identifier
          ) {
            oneToOneChatIdentifiers.add(entry.identifier);
          }
        }
      } catch (e) {
        // Older / partial chat.db dumps (and test fixtures) may not have these
        // tables. Degrade to per-message handle only rather than abort the import.
        params.log?.('debug', 'chat participant index unavailable; falling back to per-message handle', {
          error: (e as Error).message,
        });
      }

      const selectCols = [
        'message.ROWID as message_id',
        'message.guid as guid',
        'message.date as message_date',
        'message.text as message_text',
        has('attributedBody') && 'message.attributedBody as attributed_body',
        'message.is_from_me',
        'message.service',
        has('date_read') && 'message.date_read',
        has('date_delivered') && 'message.date_delivered',
        has('is_spam') && 'message.is_spam',
        has('associated_message_guid') && 'message.associated_message_guid',
        has('associated_message_type') && 'message.associated_message_type',
        has('associated_message_emoji') && 'message.associated_message_emoji',
        has('reply_to_guid') && 'message.reply_to_guid',
        has('thread_originator_guid') && 'message.thread_originator_guid',
      ]
        .filter(Boolean)
        .join(', ');

      const stmt = db.prepare(`
        SELECT ${selectCols}, handle.id as contact_id,
               a.guid AS attachment_guid, a.filename AS attachment_filename, a.mime_type AS attachment_mime_type
        FROM message
        LEFT JOIN handle ON message.handle_id = handle.ROWID
        LEFT JOIN message_attachment_join maj ON maj.message_id = message.ROWID
        LEFT JOIN attachment a ON a.ROWID = maj.attachment_id
        ORDER BY message.date
      `);

      /**
       * One row of the message × handle × attachment join. Most columns are
       * selected conditionally (see `has(...)` above) because chat.db's schema
       * varies across macOS releases, so all but the id are optional.
       */
      interface Row {
        message_id: number;
        guid?: string | null;
        message_date?: number | null;
        message_text?: string | null;
        attributed_body?: Buffer | null;
        is_from_me?: number | null;
        service?: string | null;
        date_read?: number | null;
        date_delivered?: number | null;
        is_spam?: number | null;
        associated_message_guid?: string | null;
        associated_message_type?: number | null;
        associated_message_emoji?: string | null;
        reply_to_guid?: string | null;
        thread_originator_guid?: string | null;
        contact_id?: string | null;
        attachment_guid?: string | null;
        attachment_filename?: string | null;
        attachment_mime_type?: string | null;
      }
      const pending: Record<number, Graph> = {};
      // Resolution rate for the attachment bytes. Reported once at the end
      // rather than per row: a real export joins tens of thousands of
      // attachments, and a silently-zero rate is exactly the failure this
      // importer had before imessageAttachmentCandidates existed.
      let attachmentsSeen = 0;
      let attachmentsResolved = 0;

      for (const row of stmt.iterate() as Iterable<Row>) {
        const cocoa = row.message_date;
        // A row with no numeric date can't be placed on the timeline; record it
        // in the drop ledger instead of letting it vanish silently.
        if (typeof cocoa !== 'number') {
          params.pipeline.drop?.('invalid_timestamp');
          continue;
        }

        const timestamp = parseCocoaDate(cocoa);
        if (!timeframeContains(params.timeframe, timestamp)) {
          continue;
        }

        let graph = pending[row.message_id];
        if (!graph) {
          const chatId = chatIdByMessage.get(row.message_id);
          const chat = chatId != null ? chatById.get(chatId) : undefined;
          // Sender = the per-message handle when present. On outbound, handle_id
          // is NULL (self has no handle row), so sender is null even in groups.
          const senderHandle = row.is_from_me === 1 ? null : (row.contact_id ?? null);
          // Recipients = chat participants minus the sender. chat_handle_join
          // excludes self, so on outbound the participant list IS the recipient
          // list; on inbound the only thing to subtract is the sender.
          const recipients: string[] = chat
            ? senderHandle
              ? chat.participants.filter((p) => p !== senderHandle)
              : chat.participants.slice()
            : [];
          // The conversation grouping key. `chat.chat_identifier` is Apple's
          // own stable per-conversation id and is used whenever the message has
          // a chat. When it does NOT — no chat_message_join row — the only
          // other evidence is the correspondent handle, and it is trusted only
          // when iMessage itself already uses that handle as a 1:1 chat
          // identifier (see oneToOneChatIdentifiers). Anything else stays
          // undefined rather than risk filing an orphaned group message into
          // one participant's private thread.
          const correspondent = row.contact_id ?? null;
          const threadIdentifier =
            chat?.identifier ??
            (correspondent && oneToOneChatIdentifiers.has(correspondent) ? correspondent : undefined);
          // Recent macOS leaves `text` NULL and stores the body only in the
          // binary `attributedBody` column, so the plain column alone loses
          // most of the current year (see decodeAttributedBody).
          const bodyText = row.message_text || decodeAttributedBody(row.attributed_body);
          const item: Item = {
            id: row.guid ? row.guid : `imessage_${row.message_id}`,
            classification: 'message',
            timestamp,
            content: { filename: `message_${row.message_id}.txt` },
            metadata: {
              Source: 'iMessage',
              ...(bodyText && { Text: bodyText }),
              'From Me': row.is_from_me === 1,
              Service: row.service,
              ...(senderHandle && { Sender: senderHandle }),
              // Prefer the resolved chat participant list (handles group chats
              // and outbound recipients). Fall back to the row-level partner
              // handle whenever that list came back EMPTY, so older / stripped
              // dumps still record the 1:1 recipient on outbound messages.
              //
              // The fallback used to be gated on `!chat` as well, which made it
              // unreachable in the case it most needed to cover: a chat row that
              // exists but whose `chat_handle_join` rows do not (a partial
              // export, an iOS backup that dropped the join table, a chat whose
              // membership Apple never wrote). `recipients` is then `[]`, the
              // first branch does not fire, and `!chat` blocked the second — so
              // the message reached ci.communications naming nobody at all.
              // `recipients.length` already encodes "the chat told us nothing",
              // so the extra clause only ever suppressed a recipient we had.
              // The branches stay mutually exclusive, so `To` can never
              // duplicate a handle already listed in `Recipients`.
              ...(recipients.length
                ? { Recipients: recipients }
                : row.is_from_me === 1 && row.contact_id
                  ? { To: row.contact_id }
                  : {}),
              ...(chat?.identifier && { ChatId: chat.identifier }),
              // ChatId is display metadata; push/inputs.ts toCommunicationInput
              // only reads ThreadId (then Thread/Conversation/MessageID) to
              // populate ci.communications.thread_id, so without this key every
              // iMessage row landed with thread_id NULL despite chat.db
              // carrying a perfectly good conversation id.
              ...(threadIdentifier && { ThreadId: threadIdentifier }),
              ...(chat?.displayName && { GroupName: chat.displayName }),
              ...(row.date_read && { ReadAt: parseCocoaDate(row.date_read).toISOString() }),
              ...(row.date_delivered && { DeliveredAt: parseCocoaDate(row.date_delivered).toISOString() }),
              ...(row.is_spam != null && { Spam: row.is_spam === 1 }),
            },
          };
          graph = { item, edges: [] };
          pending[row.message_id] = graph;

          // Link the message to its conversation counterpart(s) so the graph
          // view has a real item↔entity edge, and so PushStage's
          // `resolveCorrespondents` can fill from_entity_id / to_entity_ids at
          // push time instead of leaving the row to a later linking sweep.
          //
          // `handle.id` is the OTHER party — but only on inbound. Outbound rows
          // have `message.handle_id` NULL (the owner has no handle row), so
          // `row.contact_id` is usually null there and staging edges off it
          // alone left every message the owner ever sent pointing at nobody:
          // 16,325 outbound iMessages in the live corpus reached
          // ci.communications with from_entity_id NULL *and* to_entity_ids
          // empty. On outbound the recipients are the chat participants — the
          // same list `Recipients` already carries — so stage one edge each.
          //
          // Deliberately only the outbound side fans out. On inbound the SENDER
          // must be the first `participant` edge (resolveCorrespondents reads
          // `others[0]` as the sender), and the rest of a group's membership are
          // this message's recipients, which `Recipients` already reports.
          const counterparts =
            row.is_from_me === 1
              ? // Union, deduped: `recipients` is authoritative, and
                // `row.contact_id` is the 1:1 partner some exports still put on
                // the outbound row. Both are handles read straight from
                // chat.db, so neither invents a participant.
                Array.from(new Set([...recipients, ...(row.contact_id ? [row.contact_id] : [])]))
              : row.contact_id
                ? [row.contact_id]
                : [];

          for (const handle of counterparts) {
            graph.edges!.push({
              relation: 'participant',
              to: { entity: contactEntity(handle) },
              metadata: { direction: row.is_from_me === 1 ? 'outgoing' : 'incoming' },
            });
          }
        }

        // Attachments ride the message itself as metadata.MediaAttachments —
        // the comms media lane (upload + content row + the message's
        // attachments column; see graphql.ts withCommunicationMedia). They
        // used to be separate sub-items routed by MIME to events, which minted
        // a duplicate ci.events row per attachment at the message's timestamp.
        // A message with several attachments arrives as several joined rows,
        // so descriptors append to the existing array.
        //
        // The descriptor is recorded whether or not the BYTES resolve. chat.db
        // knows the guid, the filename and the MIME type of every attachment it
        // ever carried, including ones whose files were long since purged off
        // the Mac; throwing all three away because `existsSync` said no left the
        // row recording neither the message text (macOS replaced it with a bare
        // U+FFFC placeholder) nor what had replaced it. A path-less descriptor
        // is skipped by the upload lane (push/canonical.ts
        // communicationMediaAttachments drops entries with no `path`), so this
        // costs nothing downstream and keeps the fact of the attachment.
        if (row.attachment_guid || row.attachment_filename) {
          try {
            const meta = graph.item!.metadata as Record<string, unknown>;
            const atts = (meta.MediaAttachments as AttachmentDescriptor[] | undefined) ?? [];
            const rawName = row.attachment_filename ?? '';
            const resolved = rawName
              ? imessageAttachmentCandidates(rawName, baseDir, chatDbPath).find((c) => fs.existsSync(c))
              : undefined;
            attachmentsSeen += 1;
            if (resolved) {
              attachmentsResolved += 1;
            }

            atts.push({
              ...(resolved ? { path: resolved } : {}),
              ...(row.attachment_guid ? { guid: row.attachment_guid } : {}),
              ...(rawName ? { filename: path.basename(rawName) } : {}),
              type: attachmentMediaKind(row.attachment_mime_type ?? undefined),
              ...(row.attachment_mime_type ? { mimetype: row.attachment_mime_type } : {}),
            });
            meta.MediaAttachments = atts;
          } catch (e) {
            params.log?.('debug', 'attachment read failed', { error: (e as Error).message });
          }
        }

        // Reactions (tapbacks) are their own message row pointing at the message
        // they react to. Record the reference + reaction INLINE on this message
        // rather than emitting a separate graph for the target. A target
        // placeholder carries no timestamp, so it lands dated-now; worse, it
        // shares the target's GUID, so it out-competes the real, correctly-dated
        // target row in (data_source, content_hash) dedup and overwrites it with a
        // now-dated `message_<GUID>.txt` husk. The real target is already ingested
        // with its own timestamp; we only need a reference to it. Strip the
        // "p:<part>/" part-prefix so the reference is the bare message GUID.
        if (row.associated_message_guid && row.associated_message_type) {
          const reaction = row.associated_message_emoji || this.mapReactionType(row.associated_message_type);
          if (reaction) {
            const targetGuid = (row.associated_message_guid as string).replace(/^p:\d+\//, '');
            graph.item!.metadata!.ReactionTo = targetGuid;
            graph.item!.metadata!.Reaction = reaction;
          }
        }

        // Replies / threads — same reasoning as reactions: record the referenced
        // GUIDs on THIS (replying) message instead of emitting a placeholder item
        // for the parent. The parent is already ingested with its own timestamp; a
        // placeholder would be timestamp-less and collide with it on GUID.
        if (row.reply_to_guid && row.thread_originator_guid) {
          graph.item!.metadata!.ReplyTo = row.reply_to_guid;
          graph.item!.metadata!.ThreadOriginator = row.thread_originator_guid;
        }
      }

      if (attachmentsSeen > 0) {
        params.log?.('info', 'imessage attachments', {
          seen: attachmentsSeen,
          bytesResolved: attachmentsResolved,
          descriptorOnly: attachmentsSeen - attachmentsResolved,
        });
      }

      // Push accumulated graphs
      Object.values(pending).forEach((g) => params.pipeline.push(g));
    } catch (error) {
      params.log?.('error', 'Failed to query iMessage database', { error: (error as Error).message });
    } finally {
      try {
        db?.close();
      } catch {
        /* ignore */
      }
    }
  }

  // Map integer reaction type codes to human-readable fallback (subset)
  // Based on Go implementation heuristic (2006 reaction placed)
  private mapReactionType(code: number): string | undefined {
    const mapping: Record<number, string> = {
      2000: 'love',
      2001: 'like',
      2002: 'dislike',
      2003: 'laugh',
      2004: 'emphasize',
      2005: 'question',
      2006: 'emoji',
    };

    return mapping[code];
  }
}

/**
 * The conversation-partner entity for one iMessage `handle.id` — a phone
 * number or an Apple ID email, never anything else (chat.db has no other
 * handle shape).
 *
 * `attributes` with `identity: true` is what makes this a CONTACT rather than
 * a bare name. Without it, `entityIdentityKey()` (import/staging/identity.ts)
 * finds no identity handle on the entity, `naturalKeyFor` falls back to
 * keying it by NAME instead, and `toGraphEntity` never populates
 * `properties.phones`/`.emails` — so `GraphIngestService.indexIdentifiers`
 * never writes a `ci.entity_identifiers` row for it at all. That is a
 * different (and worse) failure than the usual "first writer wins" race: the
 * entity isn't merely un-cross-referenced against a vCard contact for the
 * same number, it is INVISIBLE to every lookup that resolves people by phone
 * or email, forever — a live-DB audit found 1,799 iMessage-sourced Person
 * rows named after a bare phone number, EVERY ONE of them with zero
 * `entity_identifiers` rows, and of those, 330 had the real name sitting on a
 * DIFFERENT Person entity (predominantly from a `vcard` import) for the exact
 * same number — unreachable because there was no identifier to join on.
 *
 * Mirrors the identical pattern `googlevoice.ts` already uses correctly
 * (`attributes: [{ name: 'phone', value: p.phone, identity: true }]`).
 *
 * ## Why the type is not always 'contact'
 *
 * It was, unconditionally, and `push/entities.ts entityTypeFor` maps 'contact'
 * to `Person` — so every SMS SHORT CODE the owner has ever been texted by
 * landed in the address book as a person. On the QA corpus that was 269 rows:
 * "888222", "72524", "9119", "457", "1112" — 2FA senders, alert services,
 * directory assistance. Nothing downstream objects, by design:
 * `isNonNameParticipant` (`domains/graph/utils/participantSanity.ts`)
 * deliberately lets a bare number through ("a short handle, a bare phone
 * number, a single token — all still pass"), so a `Person` named "411" reaches
 * the person search index and `DUPLICATE_DETECT_SOURCE`'s candidate set
 * unchallenged.
 *
 * chat.db has no field that says which a handle is, and no more evidence is
 * needed than the number itself: a short code is too short to be a line a
 * person can be reached on, which is the same fact `normalizeHandle` already
 * uses to refuse to key on it. `isShortCode` is that one threshold, shared with
 * `googlevoice.ts`, whose participants have exactly this problem and whose
 * `participantType` is the same rule under a different parser.
 *
 * `short_code` is unmapped in `ENTITY_TYPES`, so it falls to
 * `DEFAULT_ENTITY_TYPE` — `Concept` — which is what that default is documented
 * to mean: a thing worth a node that is neither a person nor a place. The
 * attribute is still staged, and still `identity: true`, because it is an
 * honest record of what chat.db held; `identityHandles` filters it out on its
 * own (`normalizeHandle` returns '' below seven digits), so the entity keys on
 * its name either way and `properties.phones` stays empty — the same shape the
 * Google Voice short codes already have.
 *
 * Short codes are staged rather than dropped because they are real
 * correspondents: 2,622 communications on the QA corpus have one as their
 * `from_entity_id`.
 *
 * Repairing the rows that already landed is
 * `20260819150902_retype_imessage_short_code_people_as_concepts.sql`, which
 * must move `linked_id` as well as `entity_type` — `naturalKeyFor` folds the
 * staged type into the key, so this change moves the coordinate these entities
 * resolve at.
 */
function contactEntity(handle: string): Entity {
  const isEmail = handle.includes('@');

  return {
    // `contact` maps to `Person`, and "888222" is a service. See above.
    type: isShortCode(handle) ? 'short_code' : 'contact',
    name: handle,
    attributes: [{ name: isEmail ? 'email' : 'phone', value: handle, identity: true }],
  };
}

registerDataSource({
  name: 'imessage',
  title: 'iMessage',
  icon: 'imessage.svg',
  description: 'Import messages from iMessage chat.db',
  newOptions: () => ({ ownerEntityId: undefined }) as iMessageOptions,
  newFileImporter: () => new iMessageFileImporter(),
});
