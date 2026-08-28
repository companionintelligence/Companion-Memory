import fs from 'fs';
import { tmpdir } from 'os';
import path from 'path';

import Database from 'better-sqlite3';

// The named import doubles as the side-effect import that registers the
// datasource with the registry `getImporter` reads.
import { imessageAttachmentCandidates } from '../imessage';
import { allDataSources } from '../registry';
import type { DirEntry } from '../registry';
import type { Graph, ImportParams, Relationship } from '../timeline';

import type { EmittedGraph } from './support/emitted';
import { metaAttachments } from './support/emitted';

function getImporter(name: string) {
  const ds = allDataSources().find((d) => d.name === name);
  if (!ds?.newFileImporter) {
    throw new Error('missing importer');
  }

  return ds.newFileImporter();
}

describe('imessage importer', () => {
  it('recognizes directory with chat.db and Attachments', async () => {
    const importer = getImporter('imessage');
    const dir = await fs.promises.mkdtemp(path.join(tmpdir(), 'imsg-'));
    await fs.promises.mkdir(path.join(dir, 'Attachments'));
    await fs.promises.writeFile(path.join(dir, 'chat.db'), '');
    const rec = await importer.recognize({}, { filename: dir, fullPath: dir } as DirEntry, {});
    expect(rec.confidence).toBeGreaterThan(0.8);
  });

  it('carries the attachment on the message as a MediaAttachments descriptor with the row MIME', async () => {
    const importer = getImporter('imessage');
    const dir = await fs.promises.mkdtemp(path.join(tmpdir(), 'imsg-'));

    // Write the attachment file under Attachments/ so it exists on disk.
    await fs.promises.mkdir(path.join(dir, 'Attachments'));
    const attachmentFilename = 'photo.jpg';
    await fs.promises.writeFile(path.join(dir, 'Attachments', attachmentFilename), 'jpeg-bytes');

    // Build a minimal chat.db with one message that has one attachment.
    const db = new Database(path.join(dir, 'chat.db'));
    db.exec(`
      CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT, date INTEGER, text TEXT, is_from_me INTEGER, service TEXT, handle_id INTEGER);
      CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
      CREATE TABLE attachment (ROWID INTEGER PRIMARY KEY, guid TEXT, filename TEXT, mime_type TEXT);
      CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER);
    `);
    db.prepare('INSERT INTO handle (ROWID, id) VALUES (1, ?)').run('+15551234567');
    db.prepare(
      'INSERT INTO message (ROWID, guid, date, text, is_from_me, service, handle_id) VALUES (1, ?, ?, ?, 0, ?, 1)',
    ).run('msg-guid-1', 700000000000000000, 'see attached', 'iMessage');
    db.prepare('INSERT INTO attachment (ROWID, guid, filename, mime_type) VALUES (1, ?, ?, ?)').run(
      'att-guid-1',
      attachmentFilename,
      'image/jpeg',
    );
    db.prepare('INSERT INTO message_attachment_join (message_id, attachment_id) VALUES (1, 1)').run();
    db.close();

    const pipeline: EmittedGraph[] = [];
    await importer.fileImport(
      {},
      { filename: dir, fullPath: dir } as DirEntry,
      {
        pipeline: { push: (g: Graph) => pipeline.push(g as EmittedGraph) },
        timeframe: {},
        log: () => {},
      } as unknown as ImportParams,
    );

    const messageGraph = pipeline.find((g) => g.item?.classification === 'message');
    expect(messageGraph).toBeDefined();
    // No attachment sub-item edge — that used to mint a duplicate ci.events row.
    expect(messageGraph!.edges?.some((e: Relationship) => e.relation === 'attachment')).toBeFalsy();
    const atts = metaAttachments(messageGraph!.item.metadata.MediaAttachments);
    expect(atts).toHaveLength(1);
    expect(atts[0].mimetype).toBe('image/jpeg');
    expect(atts[0].type).toBe('image');
    expect(atts[0].filename).toBe('photo.jpg');
    expect(atts[0].path.endsWith(path.join('Attachments', 'photo.jpg'))).toBe(true);
  });

  // chat.db does NOT store a bare basename. It stores the path the file had on
  // the Mac that wrote it — tilde-rooted on every modern macOS. The old code
  // joined that whole value onto `<chat.db dir>/Attachments/`, producing
  // `<dir>/Attachments/~/Library/Messages/Attachments/…`, which exists nowhere:
  // existsSync was false for essentially every attachment in a real export and
  // the descriptor was dropped on the floor.
  describe('imessageAttachmentCandidates', () => {
    it('resolves a tilde-rooted path against the export root', () => {
      const candidates = imessageAttachmentCandidates(
        '~/Library/Messages/Attachments/ab/12/AT-UUID/IMG_0042.HEIC',
        '/export/root',
        '/export/root/Library/Messages/chat.db',
      );

      expect(candidates[0]).toBe('/export/root/Library/Messages/Attachments/ab/12/AT-UUID/IMG_0042.HEIC');
      // Never the old nonsense shape.
      expect(candidates.some((c) => c.includes('Attachments/~/'))).toBe(false);
    });

    it('falls back to <chat.db dir>/Attachments/<store key> for a flat export', () => {
      // chat.db sits at the export root with its own sibling Attachments/ tree,
      // so the tilde prefix is meaningless — the store-relative tail is what
      // has to be joined on.
      const candidates = imessageAttachmentCandidates(
        '~/Library/Messages/Attachments/ab/12/AT-UUID/IMG_0042.HEIC',
        '/export/root',
        '/export/root/chat.db',
      );

      expect(candidates).toContain('/export/root/Attachments/ab/12/AT-UUID/IMG_0042.HEIC');
    });

    it('keeps an absolute path, and still offers the store-relative fallback', () => {
      const candidates = imessageAttachmentCandidates(
        '/Users/someone/Library/Messages/Attachments/ab/12/AT-UUID/IMG_0042.HEIC',
        '/export/root',
        '/export/root/chat.db',
      );

      expect(candidates[0]).toBe('/Users/someone/Library/Messages/Attachments/ab/12/AT-UUID/IMG_0042.HEIC');
      expect(candidates).toContain('/export/root/Attachments/ab/12/AT-UUID/IMG_0042.HEIC');
    });

    it('still handles the historical bare-basename shape', () => {
      expect(imessageAttachmentCandidates('photo.jpg', '/export/root', '/export/root/chat.db')).toContain(
        '/export/root/Attachments/photo.jpg',
      );
    });

    it('returns nothing for an empty filename', () => {
      expect(imessageAttachmentCandidates('   ', '/export/root', '/export/root/chat.db')).toEqual([]);
    });
  });

  it('resolves a tilde-rooted attachment path against the export root (real chat.db)', async () => {
    const importer = getImporter('imessage');
    const dir = await fs.promises.mkdtemp(path.join(tmpdir(), 'imsg-'));
    // Mirror a real Mac export: chat.db under Library/Messages, attachments in
    // the content-addressed store beside it.
    const messagesDir = path.join(dir, 'Library', 'Messages');
    const storeDir = path.join(messagesDir, 'Attachments', 'ab', '12', 'AT-UUID');
    await fs.promises.mkdir(storeDir, { recursive: true });
    await fs.promises.writeFile(path.join(storeDir, 'IMG_0042.HEIC'), 'heic-bytes');

    const db = new Database(path.join(messagesDir, 'chat.db'));
    db.exec(`
      CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT, date INTEGER, text TEXT, is_from_me INTEGER, service TEXT, handle_id INTEGER);
      CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
      CREATE TABLE attachment (ROWID INTEGER PRIMARY KEY, guid TEXT, filename TEXT, mime_type TEXT);
      CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER);
    `);
    db.prepare('INSERT INTO handle (ROWID, id) VALUES (1, ?)').run('+15551234567');
    db.prepare(
      'INSERT INTO message (ROWID, guid, date, text, is_from_me, service, handle_id) VALUES (1, ?, ?, ?, 0, ?, 1)',
    ).run('tilde-guid', 600000000, '\uFFFC', 'iMessage');
    db.prepare('INSERT INTO attachment (ROWID, guid, filename, mime_type) VALUES (1, ?, ?, ?)').run(
      'att-tilde',
      '~/Library/Messages/Attachments/ab/12/AT-UUID/IMG_0042.HEIC',
      'image/heic',
    );
    db.prepare('INSERT INTO message_attachment_join (message_id, attachment_id) VALUES (1, 1)').run();
    db.close();

    const pushed: EmittedGraph[] = [];
    await importer.fileImport(
      {},
      { filename: dir, fullPath: dir } as DirEntry,
      {
        pipeline: { push: (g: Graph) => pushed.push(g as EmittedGraph) },
        timeframe: {},
        log: () => {},
      } as unknown as ImportParams,
    );

    const atts = metaAttachments(
      pushed.find((g) => g.item?.id === 'tilde-guid')!.item.metadata.MediaAttachments,
    );
    expect(atts).toHaveLength(1);
    expect(atts[0].path).toBe(path.join(storeDir, 'IMG_0042.HEIC'));
    expect(atts[0].filename).toBe('IMG_0042.HEIC');
    expect(atts[0].guid).toBe('att-tilde');
    expect(atts[0].type).toBe('image');
  });

  // Regression for the 21,781 iMessage rows whose entire ci.communications
  // content was a bare U+FFFC: chat.db knew the guid, the filename and the MIME
  // type of the attachment that glyph stood for, and the importer threw all
  // three away because the BYTES were not on disk. The row then recorded
  // neither the text nor what replaced it.
  it('records the attachment descriptor even when the bytes are missing', async () => {
    const importer = getImporter('imessage');
    const dir = await fs.promises.mkdtemp(path.join(tmpdir(), 'imsg-'));
    const db = new Database(path.join(dir, 'chat.db'));
    db.exec(`
      CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT, date INTEGER, text TEXT, is_from_me INTEGER, service TEXT, handle_id INTEGER);
      CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
      CREATE TABLE attachment (ROWID INTEGER PRIMARY KEY, guid TEXT, filename TEXT, mime_type TEXT);
      CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER);
    `);
    db.prepare('INSERT INTO handle (ROWID, id) VALUES (1, ?)').run('+15551234567');
    db.prepare(
      'INSERT INTO message (ROWID, guid, date, text, is_from_me, service, handle_id) VALUES (1, ?, ?, ?, 0, ?, 1)',
    ).run('purged-guid', 600000000, '\uFFFC', 'iMessage');
    db.prepare('INSERT INTO attachment (ROWID, guid, filename, mime_type) VALUES (1, ?, ?, ?)').run(
      'att-purged',
      '~/Library/Messages/Attachments/cd/34/GONE-UUID/IMG_9999.HEIC',
      'image/heic',
    );
    db.prepare('INSERT INTO message_attachment_join (message_id, attachment_id) VALUES (1, 1)').run();
    db.close();

    const pushed: EmittedGraph[] = [];
    await importer.fileImport(
      {},
      { filename: dir, fullPath: dir } as DirEntry,
      {
        pipeline: { push: (g: Graph) => pushed.push(g as EmittedGraph) },
        timeframe: {},
        log: () => {},
      } as unknown as ImportParams,
    );

    const message = pushed.find((g) => g.item?.id === 'purged-guid')!;
    const atts = metaAttachments(message.item.metadata.MediaAttachments);
    expect(atts).toHaveLength(1);
    // No bytes to upload — the push lane drops path-less descriptors — but the
    // identity of what was attached survives.
    expect(atts[0].path).toBeUndefined();
    expect(atts[0].guid).toBe('att-purged');
    expect(atts[0].filename).toBe('IMG_9999.HEIC');
    expect(atts[0].mimetype).toBe('image/heic');
    expect(atts[0].type).toBe('image');
  });

  // Regression: reactions/replies used to emit a *placeholder* message item for
  // the referenced message — an item with the target's GUID but NO timestamp.
  // That husk landed dated-now (default time = now()) and, sharing the target's
  // GUID, out-competed the real target row in (data_source, content_hash) dedup,
  // flooding the "Today" view with `message_<GUID>.txt` comms. The fix records
  // the reference as metadata on the real (reacting/replying) message instead, so
  // no emitted item is ever timestamp-less.
  it('records reactions/replies as metadata, never as timestamp-less placeholder items', async () => {
    const importer = getImporter('imessage');
    const dir = await fs.promises.mkdtemp(path.join(tmpdir(), 'imsg-'));
    const db = new Database(path.join(dir, 'chat.db'));
    db.exec(`
      CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
      CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT, date INTEGER, text TEXT, is_from_me INTEGER, service TEXT, handle_id INTEGER,
        associated_message_guid TEXT, associated_message_type INTEGER, associated_message_emoji TEXT, reply_to_guid TEXT, thread_originator_guid TEXT);
      CREATE TABLE attachment (ROWID INTEGER PRIMARY KEY, guid TEXT, filename TEXT, mime_type TEXT);
      CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER);
    `);
    db.prepare('INSERT INTO handle (ROWID, id) VALUES (1, ?)').run('+15551234567');
    // Real target message, dated long ago.
    const cocoa2020 = Date.UTC(2020, 0, 1) / 1000 - Date.UTC(2001, 0, 1) / 1000;
    db.prepare(
      'INSERT INTO message (ROWID, guid, date, text, is_from_me, service, handle_id) VALUES (1, ?, ?, ?, 0, ?, 1)',
    ).run('target-guid', cocoa2020, 'the original message', 'iMessage');
    // Reaction row pointing at target-guid (part-prefixed, as real DBs store it).
    db.prepare(
      'INSERT INTO message (ROWID, guid, date, text, is_from_me, service, handle_id, associated_message_guid, associated_message_type) VALUES (2, ?, ?, NULL, 1, ?, 1, ?, ?)',
    ).run('reaction-guid', cocoa2020 + 60, 'iMessage', 'p:0/target-guid', 2000);
    // Reply row pointing at target-guid.
    db.prepare(
      'INSERT INTO message (ROWID, guid, date, text, is_from_me, service, handle_id, reply_to_guid, thread_originator_guid) VALUES (3, ?, ?, ?, 0, ?, 1, ?, ?)',
    ).run('reply-guid', cocoa2020 + 120, 'a reply', 'iMessage', 'target-guid', 'target-guid');
    db.close();

    const pushed: Graph[] = [];
    await importer.fileImport(
      {},
      { filename: dir, fullPath: dir } as DirEntry,
      { pipeline: { push: (g: Graph) => pushed.push(g as EmittedGraph) } } as unknown as ImportParams,
    );

    // Core guard: every emitted item carries a real timestamp — no husk defaults
    // to now() downstream.
    expect(pushed.every((g) => g.item?.timestamp instanceof Date)).toBe(true);
    // No placeholder husk for the referenced message.
    expect(pushed.some((g) => g.item?.content?.filename === 'message_target-guid.txt')).toBe(false);
    // Exactly one graph per GUID — the real target is not duplicated/overwritten.
    expect(pushed.filter((g) => g.item?.id === 'target-guid')).toHaveLength(1);

    // Real target survives with its real text and date.
    const target = pushed.find((g) => g.item?.id === 'target-guid')!;
    expect(target.item!.metadata!['Text']).toBe('the original message');
    expect(target.item!.timestamp!.getUTCFullYear()).toBe(2020);

    // Reaction linkage rides on the reacting message.
    const reaction = pushed.find((g) => g.item?.id === 'reaction-guid')!;
    expect(reaction.item!.metadata!['ReactionTo']).toBe('target-guid');
    expect(reaction.item!.metadata!['Reaction']).toBeTruthy();

    // Reply linkage rides on the replying message.
    const reply = pushed.find((g) => g.item?.id === 'reply-guid')!;
    expect(reply.item!.metadata!['ReplyTo']).toBe('target-guid');
    expect(reply.item!.metadata!['ThreadOriginator']).toBe('target-guid');
  });

  // Regression: without joining chat_handle_join, every group chat collapses to
  // "from sender, no recipients" — message.handle_id is just the sender (or
  // NULL on outbound), so the other participants vanish. We resolve the full
  // chat membership and emit Recipients[] minus the sender, plus ChatId /
  // GroupName so the conversation is identifiable downstream.
  //
  // ThreadId mirrors ChatId: push/inputs.ts's toCommunicationInput only reads
  // metadata.ThreadId (not ChatId) to populate ci.communications.thread_id,
  // so without ThreadId every iMessage row lands with thread_id NULL even
  // though chat.chat_identifier was resolved correctly.
  it('emits Recipients[] + ChatId/GroupName/ThreadId by joining chat_handle_join', async () => {
    const importer = getImporter('imessage');
    const dir = await fs.promises.mkdtemp(path.join(tmpdir(), 'imsg-'));
    const db = new Database(path.join(dir, 'chat.db'));
    db.exec(`
      CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
      CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT, date INTEGER, text TEXT, is_from_me INTEGER, service TEXT, handle_id INTEGER);
      CREATE TABLE attachment (ROWID INTEGER PRIMARY KEY, guid TEXT, filename TEXT, mime_type TEXT);
      CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER);
      CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, chat_identifier TEXT, display_name TEXT);
      CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
      CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
    `);
    db.prepare('INSERT INTO handle (ROWID, id) VALUES (?, ?)').run(1, '+15551110001');
    db.prepare('INSERT INTO handle (ROWID, id) VALUES (?, ?)').run(2, '+15551110002');
    db.prepare('INSERT INTO handle (ROWID, id) VALUES (?, ?)').run(3, '+15551110003');

    // 1:1 chat with handle 1
    db.prepare('INSERT INTO chat (ROWID, chat_identifier, display_name) VALUES (?, ?, ?)').run(
      100,
      '+15551110001',
      null,
    );
    db.prepare('INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (?, ?)').run(100, 1);
    // Group chat with handles 2 and 3
    db.prepare('INSERT INTO chat (ROWID, chat_identifier, display_name) VALUES (?, ?, ?)').run(
      200,
      'chat200',
      'Lunch Crew',
    );
    db.prepare('INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (?, ?)').run(200, 2);
    db.prepare('INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (?, ?)').run(200, 3);

    // 1:1 outbound to handle 1 — recipients = [+15551110001]
    db.prepare(
      'INSERT INTO message (ROWID, guid, date, text, is_from_me, service, handle_id) VALUES (?,?,?,?,?,?,?)',
    ).run(10, 'out11-guid', 600000000, 'hi', 1, 'iMessage', null);
    db.prepare('INSERT INTO chat_message_join (chat_id, message_id) VALUES (?, ?)').run(100, 10);
    // 1:1 inbound from handle 1 — sender = +15551110001, recipients = []
    db.prepare(
      'INSERT INTO message (ROWID, guid, date, text, is_from_me, service, handle_id) VALUES (?,?,?,?,?,?,?)',
    ).run(11, 'in11-guid', 600000001, 'hey', 0, 'iMessage', 1);
    db.prepare('INSERT INTO chat_message_join (chat_id, message_id) VALUES (?, ?)').run(100, 11);
    // Group outbound — recipients = all chat participants (+...0002, +...0003)
    db.prepare(
      'INSERT INTO message (ROWID, guid, date, text, is_from_me, service, handle_id) VALUES (?,?,?,?,?,?,?)',
    ).run(20, 'outg-guid', 600000002, 'lunch?', 1, 'iMessage', null);
    db.prepare('INSERT INTO chat_message_join (chat_id, message_id) VALUES (?, ?)').run(200, 20);
    // Group inbound from handle 2 — sender = +...0002, recipients = [+...0003]
    db.prepare(
      'INSERT INTO message (ROWID, guid, date, text, is_from_me, service, handle_id) VALUES (?,?,?,?,?,?,?)',
    ).run(21, 'ing-guid', 600000003, 'yes', 0, 'iMessage', 2);
    db.prepare('INSERT INTO chat_message_join (chat_id, message_id) VALUES (?, ?)').run(200, 21);
    db.close();

    const pushed: Graph[] = [];
    await importer.fileImport(
      {},
      { filename: dir, fullPath: dir } as DirEntry,
      { pipeline: { push: (g: Graph) => pushed.push(g as EmittedGraph) } } as unknown as ImportParams,
    );

    const out11 = pushed.find((g) => g.item?.id === 'out11-guid')!;
    expect(out11.item!.metadata!['Recipients']).toEqual(['+15551110001']);
    expect(out11.item!.metadata!['Sender']).toBeUndefined();
    expect(out11.item!.metadata!['ChatId']).toBe('+15551110001');
    expect(out11.item!.metadata!['ThreadId']).toBe('+15551110001');
    expect(out11.item!.metadata!['GroupName']).toBeUndefined();
    expect(out11.item!.metadata!['To']).toBeUndefined();

    const in11 = pushed.find((g) => g.item?.id === 'in11-guid')!;
    expect(in11.item!.metadata!['Sender']).toBe('+15551110001');
    expect(in11.item!.metadata!['Recipients']).toBeUndefined();
    expect(in11.item!.metadata!['ChatId']).toBe('+15551110001');
    expect(in11.item!.metadata!['ThreadId']).toBe('+15551110001');

    const outg = pushed.find((g) => g.item?.id === 'outg-guid')!;
    expect(outg.item!.metadata!['Recipients']).toEqual(['+15551110002', '+15551110003']);
    expect(outg.item!.metadata!['Sender']).toBeUndefined();
    expect(outg.item!.metadata!['ChatId']).toBe('chat200');
    expect(outg.item!.metadata!['ThreadId']).toBe('chat200');
    expect(outg.item!.metadata!['GroupName']).toBe('Lunch Crew');

    // Same chat (200) as outg — both messages in the group thread carry the
    // SAME ThreadId, which is the point: they group together in
    // ci.communications.thread_id.
    const ing = pushed.find((g) => g.item?.id === 'ing-guid')!;
    expect(ing.item!.metadata!['Sender']).toBe('+15551110002');
    expect(ing.item!.metadata!['Recipients']).toEqual(['+15551110003']);
    expect(ing.item!.metadata!['ThreadId']).toBe('chat200');
    expect(ing.item!.metadata!['GroupName']).toBe('Lunch Crew');
  });

  // Regression: the chat table resolves chat.chat_identifier per conversation,
  // but the original code only ever wrote it to metadata.ChatId — a key the
  // generic communications mapper (push/inputs.ts toCommunicationInput) never
  // reads. Every iMessage row landed with ci.communications.thread_id NULL
  // despite the source having a perfectly good, stable per-conversation
  // identifier. This asserts the fix directly.
  it('carries the resolved chat_identifier as ThreadId, not just ChatId', async () => {
    const importer = getImporter('imessage');
    const dir = await fs.promises.mkdtemp(path.join(tmpdir(), 'imsg-'));
    const db = new Database(path.join(dir, 'chat.db'));
    db.exec(`
      CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
      CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT, date INTEGER, text TEXT, is_from_me INTEGER, service TEXT, handle_id INTEGER);
      CREATE TABLE attachment (ROWID INTEGER PRIMARY KEY, guid TEXT, filename TEXT, mime_type TEXT);
      CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER);
      CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, chat_identifier TEXT, display_name TEXT);
      CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
      CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
    `);
    db.prepare('INSERT INTO handle (ROWID, id) VALUES (?, ?)').run(1, '+15559990000');
    db.prepare('INSERT INTO chat (ROWID, chat_identifier, display_name) VALUES (?, ?, ?)').run(
      300,
      'chat999threadkey',
      null,
    );
    db.prepare('INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (?, ?)').run(300, 1);
    db.prepare(
      'INSERT INTO message (ROWID, guid, date, text, is_from_me, service, handle_id) VALUES (?,?,?,?,?,?,?)',
    ).run(30, 'thread-guid', 600000000, 'hi', 0, 'iMessage', 1);
    db.prepare('INSERT INTO chat_message_join (chat_id, message_id) VALUES (?, ?)').run(300, 30);
    db.close();

    const pushed: Graph[] = [];
    await importer.fileImport(
      {},
      { filename: dir, fullPath: dir } as DirEntry,
      { pipeline: { push: (g: Graph) => pushed.push(g as EmittedGraph) } } as unknown as ImportParams,
    );

    const msg = pushed.find((g) => g.item?.id === 'thread-guid')!;
    expect(msg.item!.metadata!['ChatId']).toBe('chat999threadkey');
    expect(msg.item!.metadata!['ThreadId']).toBe('chat999threadkey');
  });

  it('maps the partner direction-aware: outbound -> To, inbound -> Sender', async () => {
    const importer = getImporter('imessage');
    const dir = await fs.promises.mkdtemp(path.join(tmpdir(), 'imsg-'));
    const dbPath = path.join(dir, 'chat.db');
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
      CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT, date INTEGER, text TEXT, is_from_me INTEGER, service TEXT, handle_id INTEGER);
      CREATE TABLE attachment (ROWID INTEGER PRIMARY KEY, guid TEXT, filename TEXT, mime_type TEXT);
      CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER);
    `);
    db.prepare('INSERT INTO handle (ROWID, id) VALUES (?, ?)').run(1, '+15551234567');
    // outbound (is_from_me=1): partner is the recipient
    db.prepare(
      'INSERT INTO message (ROWID, guid, date, text, is_from_me, service, handle_id) VALUES (?,?,?,?,?,?,?)',
    ).run(10, 'out-guid', 600000000, 'hi there', 1, 'iMessage', 1);
    // inbound (is_from_me=0): partner is the sender
    db.prepare(
      'INSERT INTO message (ROWID, guid, date, text, is_from_me, service, handle_id) VALUES (?,?,?,?,?,?,?)',
    ).run(11, 'in-guid', 600000001, 'hey back', 0, 'iMessage', 1);
    db.close();

    const pushed: Graph[] = [];
    await importer.fileImport(
      {},
      { filename: dir, fullPath: dir } as DirEntry,
      { pipeline: { push: (g: Graph) => pushed.push(g as EmittedGraph) } } as unknown as ImportParams,
    );

    const out = pushed.find((g) => g.item?.id === 'out-guid')!;
    const inb = pushed.find((g) => g.item?.id === 'in-guid')!;
    // outbound: partner rides as the recipient (To), not as Contact/Sender
    expect(out.item!.metadata!['To']).toBe('+15551234567');
    expect(out.item!.metadata!['Sender']).toBeUndefined();
    expect(out.item!.metadata!['Contact']).toBeUndefined();
    expect(out.item!.metadata!['From Me']).toBe(true);
    // inbound: partner rides as the sender, no recipient
    expect(inb.item!.metadata!['Sender']).toBe('+15551234567');
    expect(inb.item!.metadata!['To']).toBeUndefined();
    expect(inb.item!.metadata!['Contact']).toBeUndefined();
    expect(inb.item!.metadata!['From Me']).toBe(false);
  });

  // Regression: the participant edge's entity carried a bare `name` and no
  // `attributes`, so `entityIdentityKey()` (import/staging/identity.ts) found
  // no identity handle on it and `toGraphEntity` never populated
  // `properties.phones`/`.emails` — GraphIngestService.indexIdentifiers then
  // never wrote a ci.entity_identifiers row at all. The Person this became was
  // not merely un-cross-referenced against a vCard contact for the same
  // number; it was invisible to every phone/email lookup, forever. A live-DB
  // audit found 1,799 iMessage-sourced Person rows named after a bare phone
  // number with zero entity_identifiers rows between them, 331 of which had
  // the real name on a separate vCard-imported Person for the exact same
  // number. The participant entity must now carry an `identity: true`
  // phone/email attribute, exactly like googlevoice.ts's contact entities do.
  it('marks the participant entity with a phone/email identity attribute', async () => {
    const importer = getImporter('imessage');
    const dir = await fs.promises.mkdtemp(path.join(tmpdir(), 'imsg-'));
    const db = new Database(path.join(dir, 'chat.db'));
    db.exec(`
      CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
      CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT, date INTEGER, text TEXT, is_from_me INTEGER, service TEXT, handle_id INTEGER);
      CREATE TABLE attachment (ROWID INTEGER PRIMARY KEY, guid TEXT, filename TEXT, mime_type TEXT);
      CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER);
    `);
    db.prepare('INSERT INTO handle (ROWID, id) VALUES (?, ?)').run(1, '+15551234567');
    db.prepare('INSERT INTO handle (ROWID, id) VALUES (?, ?)').run(2, 'someone@icloud.com');
    // Inbound from the phone handle.
    db.prepare(
      'INSERT INTO message (ROWID, guid, date, text, is_from_me, service, handle_id) VALUES (?,?,?,?,?,?,?)',
    ).run(10, 'phone-guid', 600000000, 'hi', 0, 'iMessage', 1);
    // Inbound from the Apple-ID-email handle.
    db.prepare(
      'INSERT INTO message (ROWID, guid, date, text, is_from_me, service, handle_id) VALUES (?,?,?,?,?,?,?)',
    ).run(11, 'email-guid', 600000001, 'hi from mac', 0, 'iMessage', 2);
    db.close();

    const pushed: Graph[] = [];
    await importer.fileImport(
      {},
      { filename: dir, fullPath: dir } as DirEntry,
      { pipeline: { push: (g: Graph) => pushed.push(g as EmittedGraph) } } as unknown as ImportParams,
    );

    const phoneMsg = pushed.find((g) => g.item?.id === 'phone-guid')!;
    const participantEdge = phoneMsg.edges?.find((e: Relationship) => e.relation === 'participant');
    expect(participantEdge?.to.entity?.name).toBe('+15551234567');
    expect(participantEdge?.to.entity?.attributes).toEqual([
      { name: 'phone', value: '+15551234567', identity: true },
    ]);

    const emailMsg = pushed.find((g) => g.item?.id === 'email-guid')!;
    const emailEdge = emailMsg.edges?.find((e: Relationship) => e.relation === 'participant');
    expect(emailEdge?.to.entity?.name).toBe('someone@icloud.com');
    expect(emailEdge?.to.entity?.attributes).toEqual([
      { name: 'email', value: 'someone@icloud.com', identity: true },
    ]);
  });

  // Regression (defect F2): 16,325 outbound iMessages reached
  // ci.communications with from_entity_id NULL *and* to_entity_ids empty —
  // messages the owner sent, connected to nobody, with no way to tell who the
  // conversation was with.
  //
  // Two separate holes, both exercised here.
  //
  // 1. The `To` fallback was gated on `!chat`. A chat row that EXISTS but whose
  //    chat_handle_join rows do not (a partial export, an iOS backup that
  //    dropped the join table) gives `recipients = []` — so the Recipients
  //    branch does not fire — and `!chat` blocked the fallback, leaving the
  //    message with neither.
  // 2. Participant edges were staged only off `row.contact_id`, which is NULL
  //    on outbound (self has no handle row). Even when the chat DID list its
  //    members, an outbound message staged zero edges, so PushStage's
  //    resolveCorrespondents had nothing to resolve.
  it('names the recipient on outbound messages whose chat lists no participants', async () => {
    const importer = getImporter('imessage');
    const dir = await fs.promises.mkdtemp(path.join(tmpdir(), 'imsg-'));
    const db = new Database(path.join(dir, 'chat.db'));
    db.exec(`
      CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
      CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT, date INTEGER, text TEXT, is_from_me INTEGER, service TEXT, handle_id INTEGER);
      CREATE TABLE attachment (ROWID INTEGER PRIMARY KEY, guid TEXT, filename TEXT, mime_type TEXT);
      CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER);
      CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, chat_identifier TEXT, display_name TEXT);
      CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
      CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
    `);
    db.prepare('INSERT INTO handle (ROWID, id) VALUES (?, ?)').run(1, '+15551110001');
    // The chat exists and the message is joined to it, but its membership rows
    // are missing — exactly the shape that produced the 16,325 orphans.
    db.prepare('INSERT INTO chat (ROWID, chat_identifier, display_name) VALUES (?, ?, ?)').run(
      100,
      null,
      null,
    );
    db.prepare(
      'INSERT INTO message (ROWID, guid, date, text, is_from_me, service, handle_id) VALUES (?,?,?,?,?,?,?)',
    ).run(10, 'memberless-guid', 600000000, 'you around?', 1, 'iMessage', 1);
    db.prepare('INSERT INTO chat_message_join (chat_id, message_id) VALUES (?, ?)').run(100, 10);
    db.close();

    const pushed: Graph[] = [];
    await importer.fileImport(
      {},
      { filename: dir, fullPath: dir } as DirEntry,
      { pipeline: { push: (g: Graph) => pushed.push(g as EmittedGraph) } } as unknown as ImportParams,
    );

    const msg = pushed.find((g) => g.item?.id === 'memberless-guid')!;
    expect(msg).toBeDefined();
    expect(msg.item!.metadata!['Recipients']).toBeUndefined();
    expect(msg.item!.metadata!['To']).toBe('+15551110001');

    const edges = msg.edges?.filter((e: Relationship) => e.relation === 'participant') ?? [];
    expect(edges).toHaveLength(1);
    expect(edges[0].to.entity?.name).toBe('+15551110001');
    expect(edges[0].metadata?.direction).toBe('outgoing');
  });

  it('stages one outgoing participant edge per recipient of an outbound group message', async () => {
    const importer = getImporter('imessage');
    const dir = await fs.promises.mkdtemp(path.join(tmpdir(), 'imsg-'));
    const db = new Database(path.join(dir, 'chat.db'));
    db.exec(`
      CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
      CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT, date INTEGER, text TEXT, is_from_me INTEGER, service TEXT, handle_id INTEGER);
      CREATE TABLE attachment (ROWID INTEGER PRIMARY KEY, guid TEXT, filename TEXT, mime_type TEXT);
      CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER);
      CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, chat_identifier TEXT, display_name TEXT);
      CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
      CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
    `);
    db.prepare('INSERT INTO handle (ROWID, id) VALUES (?, ?)').run(1, '+15551110001');
    db.prepare('INSERT INTO handle (ROWID, id) VALUES (?, ?)').run(2, '+15551110002');
    db.prepare('INSERT INTO chat (ROWID, chat_identifier, display_name) VALUES (?, ?, ?)').run(
      200,
      'chat200',
      'Lunch Crew',
    );
    db.prepare('INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (?, ?)').run(200, 1);
    db.prepare('INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (?, ?)').run(200, 2);
    // Outbound: handle_id is NULL, the way chat.db records the owner's own row.
    db.prepare(
      'INSERT INTO message (ROWID, guid, date, text, is_from_me, service, handle_id) VALUES (?,?,?,?,?,?,?)',
    ).run(20, 'group-out-guid', 600000002, 'lunch?', 1, 'iMessage', null);
    db.prepare('INSERT INTO chat_message_join (chat_id, message_id) VALUES (?, ?)').run(200, 20);
    // Inbound from handle 1 — the sender must still be the ONLY participant
    // edge, because PushStage reads participants[0] as the sender.
    db.prepare(
      'INSERT INTO message (ROWID, guid, date, text, is_from_me, service, handle_id) VALUES (?,?,?,?,?,?,?)',
    ).run(21, 'group-in-guid', 600000003, 'yes', 0, 'iMessage', 1);
    db.prepare('INSERT INTO chat_message_join (chat_id, message_id) VALUES (?, ?)').run(200, 21);
    db.close();

    const pushed: Graph[] = [];
    await importer.fileImport(
      {},
      { filename: dir, fullPath: dir } as DirEntry,
      { pipeline: { push: (g: Graph) => pushed.push(g as EmittedGraph) } } as unknown as ImportParams,
    );

    const out = pushed.find((g) => g.item?.id === 'group-out-guid')!;
    const outEdges = out.edges?.filter((e: Relationship) => e.relation === 'participant') ?? [];
    expect(outEdges.map((e) => e.to.entity?.name)).toEqual(['+15551110001', '+15551110002']);
    expect(outEdges.every((e) => e.metadata?.direction === 'outgoing')).toBe(true);
    // Every recipient carries an identity attribute, or it can never be joined
    // to the same number arriving from a vCard.
    expect(outEdges[0].to.entity?.attributes).toEqual([
      { name: 'phone', value: '+15551110001', identity: true },
    ]);

    const inb = pushed.find((g) => g.item?.id === 'group-in-guid')!;
    const inEdges = inb.edges?.filter((e: Relationship) => e.relation === 'participant') ?? [];
    expect(inEdges.map((e) => e.to.entity?.name)).toEqual(['+15551110001']);
    expect(inEdges[0].metadata?.direction).toBe('incoming');
  });
});

/**
 * The conversation grouping key.
 *
 * chat.db resolves `chat.chat_identifier` per conversation, but the importer
 * only ever wrote it to `ChatId` — a key push/inputs.ts toCommunicationInput
 * does not read — so all 432,173 iMessage rows on the live database landed with
 * ci.communications.thread_id NULL. `ThreadId` is the key that reaches the
 * column.
 *
 * The interesting half is the messages with NO chat: 45,280 of those rows have
 * no chat_message_join entry at all. Their correspondent is usable as the
 * thread ONLY when iMessage itself already uses that handle as a 1:1 chat
 * identifier; otherwise the message could equally be an orphaned group message
 * and filing it under one participant would invent a conversation.
 */
describe('imessage thread ids', () => {
  const importFrom = async (build: (db: InstanceType<typeof Database>) => void): Promise<EmittedGraph[]> => {
    const importer = getImporter('imessage');
    const dir = await fs.promises.mkdtemp(path.join(tmpdir(), 'imsg-thread-'));
    const db = new Database(path.join(dir, 'chat.db'));
    db.exec(`
      CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
      CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT, date INTEGER, text TEXT, is_from_me INTEGER, service TEXT, handle_id INTEGER);
      CREATE TABLE attachment (ROWID INTEGER PRIMARY KEY, guid TEXT, filename TEXT, mime_type TEXT);
      CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER);
      CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, chat_identifier TEXT, display_name TEXT);
      CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
      CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
    `);
    build(db);
    db.close();

    const pushed: EmittedGraph[] = [];
    await importer.fileImport(
      {},
      { filename: dir, fullPath: dir } as DirEntry,
      { pipeline: { push: (g: Graph) => pushed.push(g as EmittedGraph) } } as unknown as ImportParams,
    );

    return pushed;
  };

  const insertMessage = (
    db: InstanceType<typeof Database>,
    row: { id: number; guid: string; handle?: number | null; fromMe?: number },
  ): void => {
    db.prepare(
      'INSERT INTO message (ROWID, guid, date, text, is_from_me, service, handle_id) VALUES (?,?,?,?,?,?,?)',
    ).run(row.id, row.guid, 600000000, 'hi', row.fromMe ?? 0, 'iMessage', row.handle ?? null);
  };

  it('carries chat_identifier as ThreadId, so every message in a chat groups together', async () => {
    const pushed = await importFrom((db) => {
      db.prepare('INSERT INTO handle (ROWID, id) VALUES (?, ?)').run(1, '+15551110002');
      db.prepare('INSERT INTO chat (ROWID, chat_identifier, display_name) VALUES (?,?,?)').run(
        200,
        'chat200',
        'Lunch Crew',
      );
      db.prepare('INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (?, ?)').run(200, 1);
      insertMessage(db, { id: 10, guid: 'in-guid', handle: 1 });
      insertMessage(db, { id: 11, guid: 'out-guid', fromMe: 1 });
      db.prepare('INSERT INTO chat_message_join (chat_id, message_id) VALUES (?, ?)').run(200, 10);
      db.prepare('INSERT INTO chat_message_join (chat_id, message_id) VALUES (?, ?)').run(200, 11);
    });

    expect(pushed.find((g) => g.item?.id === 'in-guid')!.item.metadata.ThreadId).toBe('chat200');
    expect(pushed.find((g) => g.item?.id === 'out-guid')!.item.metadata.ThreadId).toBe('chat200');
  });

  it('threads a chat-less message on its correspondent when that handle IS a 1:1 chat here', async () => {
    const pushed = await importFrom((db) => {
      db.prepare('INSERT INTO handle (ROWID, id) VALUES (?, ?)').run(1, '+15551110001');
      // A real 1:1 chat with this handle: chat_identifier IS the participant.
      db.prepare('INSERT INTO chat (ROWID, chat_identifier, display_name) VALUES (?,?,?)').run(
        100,
        '+15551110001',
        null,
      );
      db.prepare('INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (?, ?)').run(100, 1);
      insertMessage(db, { id: 20, guid: 'in-chat-guid', handle: 1 });
      db.prepare('INSERT INTO chat_message_join (chat_id, message_id) VALUES (?, ?)').run(100, 20);
      // Same correspondent, but this row never made it into chat_message_join.
      insertMessage(db, { id: 21, guid: 'orphan-guid', handle: 1 });
    });

    const orphan = pushed.find((g) => g.item?.id === 'orphan-guid')!;
    expect(orphan.item.metadata.ChatId).toBeUndefined();
    expect(orphan.item.metadata.ThreadId).toBe('+15551110001');
    // and it joins the chat its sibling is already in, rather than a new one
    expect(orphan.item.metadata.ThreadId).toBe(
      pushed.find((g) => g.item?.id === 'in-chat-guid')!.item.metadata.ThreadId,
    );
  });

  it('leaves a chat-less message unthreaded when its correspondent is only ever a group member', async () => {
    // The handle appears solely inside a group chat, so nothing in this
    // database says a 1:1 conversation with them exists. Filing the orphan
    // under their handle would invent one.
    const pushed = await importFrom((db) => {
      db.prepare('INSERT INTO handle (ROWID, id) VALUES (?, ?)').run(1, '+15551110002');
      db.prepare('INSERT INTO handle (ROWID, id) VALUES (?, ?)').run(2, '+15551110003');
      db.prepare('INSERT INTO chat (ROWID, chat_identifier, display_name) VALUES (?,?,?)').run(
        200,
        'chat200',
        'Lunch Crew',
      );
      db.prepare('INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (?, ?)').run(200, 1);
      db.prepare('INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (?, ?)').run(200, 2);
      insertMessage(db, { id: 30, guid: 'grouped-guid', handle: 1 });
      db.prepare('INSERT INTO chat_message_join (chat_id, message_id) VALUES (?, ?)').run(200, 30);
      insertMessage(db, { id: 31, guid: 'unknown-orphan-guid', handle: 1 });
    });

    expect(pushed.find((g) => g.item?.id === 'unknown-orphan-guid')!.item.metadata.ThreadId).toBeUndefined();
  });
});

// Recent macOS leaves `message.text` NULL and writes the body only into the
// binary `attributedBody` column. These cover the WIRING — that the column is
// selected, survives the `has(...)` schema guard, and reaches item metadata.
// The decoder itself is unit-tested in attributed_body.test.ts.
describe('imessage attributedBody bodies', () => {
  /** A typedstream blob shaped the way chat.db writes one. */
  function typedstream(text: string): Buffer {
    const body = Buffer.from(text, 'utf8');
    const len =
      body.length < 0x80
        ? Buffer.from([body.length])
        : (() => {
            const b = Buffer.alloc(3);
            b[0] = 0x81;
            b.writeUInt16LE(body.length, 1);
            return b;
          })();
    return Buffer.concat([
      Buffer.from([0x04, 0x0b]),
      Buffer.from('streamtyped', 'ascii'),
      Buffer.from([0x81, 0xe8, 0x03, 0x84, 0x01, 0x40, 0x84, 0x84, 0x84]),
      Buffer.from('NSMutableAttributedString', 'ascii'),
      Buffer.from([0x00, 0x84, 0x84, 0x08]),
      Buffer.from('NSObject', 'ascii'),
      Buffer.from([0x00, 0x85, 0x92, 0x84, 0x84, 0x84]),
      Buffer.from('NSString', 'ascii'),
      Buffer.from([0x01, 0x95, 0x84, 0x01, 0x2b]),
      len,
      body,
      Buffer.from([0x86, 0x84, 0x02, 0x69, 0x49, 0x01]),
    ]);
  }

  async function runImport(rows: Array<{ id: number; text: string | null; blob: Buffer | null }>) {
    const importer = getImporter('imessage');
    const dir = await fs.promises.mkdtemp(path.join(tmpdir(), 'imsg-ab-'));
    await fs.promises.mkdir(path.join(dir, 'Attachments'));
    const db = new Database(path.join(dir, 'chat.db'));
    db.exec(`
      CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT, date INTEGER, text TEXT,
                            attributedBody BLOB, is_from_me INTEGER, service TEXT, handle_id INTEGER);
      CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
      CREATE TABLE attachment (ROWID INTEGER PRIMARY KEY, guid TEXT, filename TEXT, mime_type TEXT);
      CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER);
    `);
    db.prepare('INSERT INTO handle (ROWID, id) VALUES (1, ?)').run('+15551234567');
    for (const r of rows) {
      db.prepare(
        `INSERT INTO message (ROWID, guid, date, text, attributedBody, is_from_me, service, handle_id)
         VALUES (?, ?, ?, ?, ?, 0, 'iMessage', 1)`,
      ).run(r.id, `guid-${r.id}`, 700000000000000000 + r.id, r.text, r.blob);
    }
    db.close();

    const pushed: EmittedGraph[] = [];
    await importer.fileImport(
      {},
      { filename: dir, fullPath: dir } as DirEntry,
      {
        pipeline: { push: (g: Graph) => pushed.push(g as EmittedGraph) },
        timeframe: {},
        log: () => {},
      } as unknown as ImportParams,
    );
    return pushed;
  }

  const textOf = (pushed: EmittedGraph[], id: number) =>
    pushed.find((g) => g.item?.id === `guid-${id}`)?.item.metadata.Text;

  it('recovers the body of a message that has no text column at all', async () => {
    const pushed = await runImport([{ id: 1, text: null, blob: typedstream('dinner at 8?') }]);
    expect(textOf(pushed, 1)).toBe('dinner at 8?');
  });

  it('recovers a body when text is present but empty', async () => {
    const pushed = await runImport([{ id: 2, text: '', blob: typedstream('on my way') }]);
    expect(textOf(pushed, 2)).toBe('on my way');
  });

  it('prefers the plain text column when both are populated', async () => {
    const pushed = await runImport([{ id: 3, text: 'plain wins', blob: typedstream('blob loses') }]);
    expect(textOf(pushed, 3)).toBe('plain wins');
  });

  it('leaves Text unset when neither source has a body', async () => {
    const pushed = await runImport([{ id: 4, text: null, blob: null }]);
    expect(textOf(pushed, 4)).toBeUndefined();
  });

  it('does not invent a body from an unreadable blob', async () => {
    const pushed = await runImport([{ id: 5, text: null, blob: Buffer.from('not a typedstream') }]);
    expect(textOf(pushed, 5)).toBeUndefined();
  });
});
