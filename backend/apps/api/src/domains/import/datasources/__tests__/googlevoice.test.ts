import fs from 'fs';
import os from 'os';
import path from 'path';

import type { StagedEntity } from '../../entities/StagedEntityEntity';
import { entityTypeFor } from '../../push/entities';
import { hashItem, resolveEntityType } from '../../staging/identity';
import { GoogleVoiceFileImporter, stripCopyIndex, threadKeyFor } from '../googlevoice';
import type { Entity, ImportParams, Relationship } from '../timeline';

import type { EmittedGraph } from './support/emitted';

const FIXTURES_DIR = path.join(__dirname, 'fixtures');

describe('call-log headings are not names', () => {
  // 2,025 of 6,673 Person entities on a real import were call-log headings —
  // 900 of them literally "Missed call from" with no name after the phrase.
  // The heading and the contact can share one `fn` span, so taking that span
  // verbatim files the whole heading as somebody's name.
  const callLogFile = async (
    inner: string,
    filename = 'Steven Stone - Missed - 2025-01-15T09_30_00Z.html',
  ): Promise<EmittedGraph['item']> => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gv-call-'));
    // The importer only walks `Calls/`. Writing the fixture at the top level
    // emits nothing, and every assertion below would then pass on `undefined`
    // without exercising a single line of the parser.
    fs.mkdirSync(path.join(dir, 'Calls'));
    fs.writeFileSync(
      path.join(dir, 'Calls', filename),
      `<html><body><div class="haudio">${inner}
         <abbr class="published" title="2025-01-15T09:30:00.000Z">Jan 15</abbr>
       </div></body></html>`,
    );

    const pipeline: EmittedGraph[] = [];
    await new GoogleVoiceFileImporter().fileImport({}, { filename: path.basename(dir), fullPath: dir }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);

    const items = pipeline.filter((p) => p.item);

    // Guard against the vacuous pass: no item means every assertion below is
    // checking `undefined` against `undefined`.
    expect(items).toHaveLength(1);

    return items[0].item;
  };

  it('records no contact when neither the markup nor the filename names anyone', async () => {
    const item = await callLogFile(
      '<span class="fn">Missed call from \n</span>',
      'Missed - 2025-01-15T09_30_00Z.html',
    );

    expect(item?.metadata?.Contact).toBeUndefined();
  });

  it('still falls back to the filename label when the markup names nobody', async () => {
    // Google Voice names each call file "<contact> - <Type> - <timestamp>.html",
    // so the filename is a better answer than the heading — and far better than
    // filing "Missed call from" as a person.
    const item = await callLogFile('<span class="fn">Missed call from \n</span>');

    expect(item?.metadata?.Contact).toBe('Steven Stone');
  });

  it('keeps the name when the heading and the name share one span', async () => {
    const item = await callLogFile('<span class="fn">Missed call from \nSteven Stone</span>');

    expect(item?.metadata?.Contact).toBe('Steven Stone');
  });

  it('prefers the name nested inside the tel anchor', async () => {
    const item = await callLogFile(
      '<span class="fn">Received call from <a class="tel" href="tel:+15551230000">' +
        '<span class="fn">Ada Lovelace</span></a></span>',
    );

    expect(item?.metadata?.Contact).toBe('Ada Lovelace');
  });

  it('does not duplicate the heading into the call content or metadata.Description', async () => {
    // The exact real-world corruption: 35,162 live rows read e.g. "Missed
    // call from Missed call from\nSteven Stone" because processCallLog()
    // wraps `contact` (which used to be the whole uncleaned heading+name
    // span) in a SECOND copy of the same "<CallType> call <preposition>"
    // template. Post-fix, `contact` is just the clean name, so the template
    // renders the heading exactly once.
    const item = await callLogFile('<span class="fn">Missed call from \nSteven Stone</span>');

    expect(item?.metadata?.Description).toBe('Missed call from Steven Stone');
    expect(item?.metadata?.Description).not.toMatch(/Missed call from.*Missed call from/s);

    const content = await item.content.data?.();
    expect(content?.toString('utf8')).toBe('Missed call from Steven Stone');
  });

  // processCallLog derives CallType from a FIVE-way alternation
  // (Missed|Placed|Received|Voicemail|Recorded), but the first repair covered
  // only three verbs — so "Voicemail from" and "Recorded call with" were still
  // reaching contact names and content. 2,891 + 188 live rows read
  // "Voicemail call from Voicemail from\nJudy Collins" /
  // "Recorded call from Recorded call with".
  it.each([
    ['Voicemail', 'Voicemail from', 'Voicemail call from Judy Collins'],
    ['Recorded', 'Recorded call with', 'Recorded call from Judy Collins'],
  ])('strips the %s heading too, so it is never doubled', async (type, heading, description) => {
    const item = await callLogFile(
      `<span class="fn">${heading} \nJudy Collins</span>`,
      `Judy Collins - ${type} - 2025-01-15T09_30_00Z.html`,
    );

    expect(item?.metadata?.Contact).toBe('Judy Collins');
    expect(item?.metadata?.Description).toBe(description);

    const content = await item.content.data?.();
    expect(content?.toString('utf8')).toBe(description);
  });

  it('files no contact at all when a Voicemail heading names nobody', async () => {
    const item = await callLogFile(
      '<span class="fn">Voicemail from \n</span>',
      'Voicemail - 2025-01-15T09_30_00Z.html',
    );

    expect(item?.metadata?.Contact).toBeUndefined();
  });
});

describe('Google Voice datasource', () => {
  it('recognizes Google Voice export directory', async () => {
    const exportDir = path.join(FIXTURES_DIR, 'google-voice-export');
    const fi = new GoogleVoiceFileImporter();
    const rec = await fi.recognize({}, { filename: 'google-voice-export', fullPath: exportDir });
    expect(rec.confidence).toBeGreaterThan(0.7);
  });

  it('imports Google Voice conversations', async () => {
    const exportDir = path.join(FIXTURES_DIR, 'google-voice-export');
    const fi = new GoogleVoiceFileImporter();
    const pipeline: EmittedGraph[] = [];
    await fi.fileImport({}, { filename: 'google-voice-export', fullPath: exportDir }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);

    const items = pipeline.filter((p) => p.item);
    expect(items.length).toBeGreaterThan(0);
    expect(items[0].item.classification).toBe('message');
    expect(items[0].item.metadata?.Source).toBe('GoogleVoice');
  });

  it('sets direction and recipient for inbound and outbound messages', async () => {
    const exportDir = path.join(FIXTURES_DIR, 'google-voice-export');
    const fi = new GoogleVoiceFileImporter();
    const pipeline: EmittedGraph[] = [];
    await fi.fileImport({}, { filename: 'google-voice-export', fullPath: exportDir }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);

    const msgs = pipeline.filter((p) => p.item).map((p) => p.item.metadata);
    // Inbound: from the contact, recipient is the owner (from Phones.vcf).
    const inbound = msgs.find((m) => m.Sender === 'Bob Smith');
    expect(inbound?.Direction).toBe('incoming');
    expect(inbound?.To).toBe('My Phone');
    // Outbound: sender 'Me', recipient is the conversation contact.
    const outbound = msgs.find((m) => m.Sender === 'Me');
    expect(outbound?.Direction).toBe('outgoing');
    expect(outbound?.To).toBe('Bob Smith');
  });

  it('parses the real send time out of an image attachment filename', async () => {
    // "Bob Smith - Text - 2025-01-15T09_33_00Z-3-1.jpg" — colons swapped for
    // underscores. Previously every image attachment got timestamp: undefined
    // and CI-Server defaulted to ingestion time.
    const exportDir = path.join(FIXTURES_DIR, 'google-voice-export');
    const fi = new GoogleVoiceFileImporter();
    const pipeline: EmittedGraph[] = [];
    await fi.fileImport({}, { filename: 'google-voice-export', fullPath: exportDir }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);

    const attachment = pipeline.find((p) => p.item?.metadata?.Attachment === 'image');
    expect(attachment).toBeDefined();
    expect(attachment!.item.timestamp).toBeInstanceOf(Date);
    expect(attachment!.item.timestamp!.toISOString()).toBe('2025-01-15T09:33:00.000Z');
  });

  // MMS image attachments were pushed with classification 'message' and no
  // way to be recognized as file-bearing, so 0 of them ever uploaded even
  // though the message itself landed. MediaAttachments is the same
  // descriptor shape (and the same MediaStage attachment leg) that already
  // carries a voicemail recording — see 'voicemail recordings' below.
  it('attaches the MMS image via MediaAttachments so MediaStage can upload it', async () => {
    const exportDir = path.join(FIXTURES_DIR, 'google-voice-export');
    const fi = new GoogleVoiceFileImporter();
    const pipeline: EmittedGraph[] = [];
    await fi.fileImport({}, { filename: 'google-voice-export', fullPath: exportDir }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);

    const attachment = pipeline.find((p) => p.item?.metadata?.Attachment === 'image');
    expect(attachment).toBeDefined();
    const mediaAttachments = attachment!.item.metadata?.MediaAttachments as
      | Array<{ path: string; filename: string; type: string; mimetype: string }>
      | undefined;
    expect(mediaAttachments).toHaveLength(1);
    expect(mediaAttachments![0].type).toBe('image');
    expect(mediaAttachments![0].mimetype).toBe('image/jpeg');
    expect(mediaAttachments![0].filename).toBe(attachment!.item.content?.filename);

    // Left '' on purpose: a real MIME here would make MediaStage's primary
    // media leg upload the same bytes a SECOND time via a separate, orphaned
    // path — only the attachment leg (gated on MediaAttachments) should ever
    // see this item as file-bearing.
    expect(attachment!.item.content?.mediaType).toBe('');
  });

  it('imports call and voicemail records (haudio markup) as classification "call" instead of dropping them', async () => {
    // Real Google Voice "Missed"/"Placed"/"Voicemail" HTML files use
    // <div class="haudio"> markup with no <q> text body and no <div
    // class="message">, so the SMS/MMS message loop never matches them at
    // all. Before this fix, every one of these files produced zero pipeline
    // items and zero log/drop trace.
    const exportDir = path.join(FIXTURES_DIR, 'google-voice-export-calls');
    const fi = new GoogleVoiceFileImporter();
    const pipeline: EmittedGraph[] = [];
    await fi.fileImport({}, { filename: 'google-voice-export-calls', fullPath: exportDir }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);

    const calls = pipeline.filter((p) => p.item?.classification === 'call').map((p) => p.item);
    expect(calls.length).toBe(3);
    // None of the call/voicemail items should have been silently dropped or
    // misclassified as a generic message.
    expect(pipeline.filter((p) => p.item?.classification === 'message').length).toBe(0);

    const missed = calls.find((c) => c.metadata.CallType === 'Missed');
    expect(missed).toBeDefined();
    expect(missed!.metadata.Direction).toBe('missed');
    expect(missed!.metadata.Contact).toBe('Alice Jones');
    expect(missed!.metadata.Number).toBe('+15551230000');
    expect(missed!.metadata.Duration).toBe(0);
    expect(missed!.timestamp).toBeInstanceOf(Date);
    expect(missed!.timestamp!.toISOString()).toBe('2025-02-01T10:00:00.000Z');

    const placed = calls.find((c) => c.metadata.CallType === 'Placed');
    expect(placed).toBeDefined();
    expect(placed!.metadata.Direction).toBe('outgoing');
    expect(placed!.metadata.Duration).toBe(30);

    const voicemail = calls.find((c) => c.metadata.CallType === 'Voicemail');
    expect(voicemail).toBeDefined();
    expect(voicemail!.metadata.Direction).toBe('incoming');
    expect(voicemail!.metadata.Duration).toBe(75);
    expect(voicemail!.metadata.DurationUnit).toBe('seconds');
    expect(voicemail!.metadata.Transcript).toBe("Hey it's Alice, call me back when you get a chance.");
    expect(voicemail!.metadata.Source).toBe('GoogleVoice');
  });

  // Regression: metadata.Conversation (the per-file contact/number label —
  // Google Voice exports one HTML file per conversation) was only ever used
  // for display. The generic communications mapper (push/inputs.ts
  // toCommunicationInput) reads metadata.ThreadId, not Conversation, to
  // populate ci.communications.thread_id — so every Google Voice message and
  // call/voicemail record landed with thread_id NULL despite the file itself
  // being a perfectly good per-conversation grouping key. This asserts
  // ThreadId now mirrors Conversation on both paths.
  it('mirrors Conversation onto ThreadId for a properly-named message file', async () => {
    // Use a realistic Google Voice filename ("<contact> - Text - <ts>.html")
    // rather than the shared google-voice-export fixture's conversation-1.html
    // — that name carries no contact prefix at all, so `conversation` is
    // correctly `undefined` there (see the "call-log headings are not names"
    // describe block above for why a filename that names nobody must not be
    // used as one) and would not exercise the mirroring this test is after.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gv-thread-'));
    fs.mkdirSync(path.join(dir, 'Calls'));
    fs.writeFileSync(
      path.join(dir, 'Calls', 'Jane Doe - Text - 2025-03-01T10_00_00Z.html'),
      `<html><body><div class="message">
         <abbr class="dt" title="2025-03-01T10:00:00.000Z">Mar 1</abbr>:
         <cite class="sender vcard"><a class="tel" href="tel:+15551230099"><span class="fn">Jane Doe</span></a></cite>:
         <q>hi there</q>
       </div></body></html>`,
    );

    const pipeline: EmittedGraph[] = [];
    await new GoogleVoiceFileImporter().fileImport({}, { filename: path.basename(dir), fullPath: dir }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);

    const msg = pipeline.find((p) => p.item?.metadata?.Text === 'hi there')!;
    expect(msg).toBeDefined();
    expect(msg.item.metadata!.Conversation).toBe('Jane Doe');
    expect(msg.item.metadata!.ThreadId).toBe('Jane Doe');
  });

  it('mirrors Conversation onto ThreadId for call/voicemail records', async () => {
    const callsExportDir = path.join(FIXTURES_DIR, 'google-voice-export-calls');
    const fiCalls = new GoogleVoiceFileImporter();
    const callsPipeline: EmittedGraph[] = [];
    await fiCalls.fileImport({}, { filename: 'google-voice-export-calls', fullPath: callsExportDir }, {
      pipeline: callsPipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);

    const calls = callsPipeline.filter((p) => p.item?.classification === 'call').map((p) => p.item.metadata);
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(c.ThreadId).toBeDefined();
      expect(c.ThreadId).toBe(c.Conversation);
    }
  });

  // The shared fixture's conversation-1.html has no contact prefix in its
  // filename, so `conversation` is honestly undefined for its messages (see
  // above).
  //
  // An earlier revision asserted ThreadId mirrored that — undefined — on the
  // grounds that a fabricated contact name would be a lie. It would be, but a
  // NULL thread_id is also a lie: it says "this message belongs to no
  // conversation" when the export has one file per conversation and every
  // message in this file demonstrably shares one. `threadKeyFor` resolves it by
  // deriving a SYNTHETIC key from the file, prefixed `googlevoice:file:` so it
  // cannot be mistaken for a contact. Group conversations and unnamed call logs
  // group correctly; nothing claims to know who the counterpart is.
  it('derives a stable synthetic ThreadId when the filename names no contact', async () => {
    const exportDir = path.join(FIXTURES_DIR, 'google-voice-export');
    const fi = new GoogleVoiceFileImporter();
    const pipeline: EmittedGraph[] = [];
    await fi.fileImport({}, { filename: 'google-voice-export', fullPath: exportDir }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);

    const msgs = pipeline
      .filter((p) => p.item?.classification === 'message' && p.item.metadata?.Text !== undefined)
      .map((p) => p.item.metadata);
    expect(msgs.length).toBeGreaterThan(0);
    const threadIds = new Set<unknown>();

    for (const m of msgs) {
      expect(m.Conversation).toBeUndefined();
      expect(m.ThreadId).toEqual(expect.stringContaining('googlevoice:file:'));
      threadIds.add(m.ThreadId);
    }

    // Every message in one conversation file shares one thread — that is the
    // whole point of synthesizing the key rather than leaving it NULL.
    expect(threadIds.size).toBe(1);
  });

  it('does not corrupt metadata.To to a stray "\\r" when Phones.vcf is CRLF-terminated with a blank FN line', async () => {
    // A spec-compliant vCard uses CRLF line endings. The owner's own card in
    // this real-world shape has a blank "FN:\r\n" line. The original parser
    // split only on "\n", so the blank FN line parsed as the literal string
    // "\r" — truthy and non-empty — which then won the `this.owner.name ||
    // this.owner.phones?.[0]` fallback over the real phone number, corrupting
    // metadata.To for every incoming message.
    const exportDir = path.join(FIXTURES_DIR, 'google-voice-export-crlf-vcf');
    const fi = new GoogleVoiceFileImporter();
    const pipeline: EmittedGraph[] = [];
    await fi.fileImport({}, { filename: 'google-voice-export-crlf-vcf', fullPath: exportDir }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);

    const inbound = pipeline.find((p) => p.item?.metadata?.Sender === 'Carol Diaz');
    expect(inbound).toBeDefined();
    expect(inbound!.item.metadata.Direction).toBe('incoming');
    expect(inbound!.item.metadata.To).toBe('+15559998888');
    expect(inbound!.item.metadata.To).not.toBe('\r');
  });
});

/**
 * The grouping key, which is NOT the same question as "who is this contact".
 *
 * `Conversation` doubles as the contact name, so it has to stay undefined when
 * the filename names nobody — that is what stopped 241 Person entities being
 * minted from .html filenames. But a thread id has no such constraint, and
 * leaving it undefined too meant 12,962 items across 1,655 "Group
 * Conversation" files (up to 265 messages each) landed with
 * ci.communications.thread_id NULL and no grouping at all.
 */
describe('Google Voice thread ids', () => {
  const importDir = async (dir: string): Promise<EmittedGraph[]> => {
    const pipeline: EmittedGraph[] = [];
    await new GoogleVoiceFileImporter().fileImport({}, { filename: path.basename(dir), fullPath: dir }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);

    return pipeline;
  };

  const writeConversation = (filename: string, body: string): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gv-thread-'));
    fs.mkdirSync(path.join(dir, 'Calls'));
    fs.writeFileSync(path.join(dir, 'Calls', filename), `<html><body>${body}</body></html>`);

    return dir;
  };

  const messageBlock = (text: string, name: string): string =>
    `<div class="message">
       <abbr class="dt" title="2025-03-01T10:00:00.000Z">Mar 1</abbr>:
       <cite class="sender vcard"><a class="tel" href="tel:+15551230099"><span class="fn">${name}</span></a></cite>:
       <q>${text}</q>
     </div>`;

  it('threads a contact-named file on the contact, the same value as Conversation', async () => {
    const dir = writeConversation(
      'Jane Doe - Text - 2025-03-01T10_00_00Z.html',
      messageBlock('hi', 'Jane Doe'),
    );

    const msg = (await importDir(dir)).find((p) => p.item?.metadata?.Text === 'hi')!;

    expect(msg.item.metadata.Conversation).toBe('Jane Doe');
    expect(msg.item.metadata.ThreadId).toBe('Jane Doe');
  });

  it('threads a group file on the file, since its name identifies nobody', async () => {
    // Every message in one exported group file is one conversation, so they
    // must share a thread id — while Conversation stays undefined, because the
    // filename is not a person and downstream reads Conversation as one.
    const dir = writeConversation(
      'Group Conversation - 2019-11-11T23_27_25Z.html',
      messageBlock('first', 'Nima Zeighami') + messageBlock('second', 'Shaw Walters'),
    );

    const msgs = (await importDir(dir)).filter((p) => p.item?.metadata?.Text);

    expect(msgs).toHaveLength(2);
    for (const m of msgs) {
      expect(m.item.metadata.Conversation).toBeUndefined();
      expect(m.item.metadata.ThreadId).toBe('googlevoice:file:Group Conversation - 2019-11-11T23_27_25Z');
    }
  });

  it('gives two different group files two different threads', async () => {
    const a = writeConversation('Group Conversation - 2019-11-11T23_27_25Z.html', messageBlock('a', 'Ann'));
    const b = writeConversation('Group Conversation - 2020-08-07T00_05_26Z.html', messageBlock('b', 'Bob'));

    const threadOf = async (dir: string): Promise<unknown> =>
      (await importDir(dir)).find((p) => p.item?.metadata?.Text)!.item.metadata.ThreadId;

    expect(await threadOf(a)).not.toBe(await threadOf(b));
  });

  it('threads an MMS attachment with its parent conversation, not with itself', async () => {
    // The attachment item carried neither Conversation nor ThreadId, so all
    // 7,427 attachment rows on the live database were detached from the
    // conversation they belong to. Its own filename carries a per-message
    // index suffix ("… -1-1.jpg"), which would mint one thread per attachment
    // — the key has to come from the parent HTML file.
    const dir = writeConversation(
      'Group Conversation - 2019-11-11T23_27_25Z.html',
      `${messageBlock('look', 'Ann')}<img src="Group Conversation - 2019-11-11T23_27_25Z-1-1" />`,
    );
    fs.writeFileSync(
      path.join(dir, 'Calls', 'Group Conversation - 2019-11-11T23_27_25Z-1-1.jpg'),
      Buffer.from([0xff, 0xd8, 0xff]),
    );

    const attachment = (await importDir(dir)).find((p) => p.item?.metadata?.Attachment === 'image')!;

    expect(attachment).toBeDefined();
    expect(attachment.item.metadata.ThreadId).toBe(
      'googlevoice:file:Group Conversation - 2019-11-11T23_27_25Z',
    );
  });

  it('threads a call record too, so a call and its texts are not orphaned', async () => {
    const dir = writeConversation(
      'Steven Stone - Missed - 2025-01-15T09_30_00Z.html',
      `<div class="haudio"><span class="fn">Missed call from <a class="tel" href="tel:+15551110000"><span class="fn">Steven Stone</span></a></span>
         <abbr class="published" title="2025-01-15T09:30:00.000Z">Jan 15</abbr></div>`,
    );

    const call = (await importDir(dir)).find((p) => p.item?.classification === 'call')!;

    expect(call.item.metadata.ThreadId).toBe('Steven Stone');
  });
});

/*
 * Regression (defect F2): 7,318 Google Voice rows reached ci.communications
 * with from_entity_id NULL and to_entity_ids empty. Every one of them was an
 * image attachment, and every one carried exactly two metadata keys — Source
 * and Attachment. There was nothing for any later linking sweep to read,
 * because this importer staged no participant edges at all and the attachment
 * loop scanned the whole file with no idea which message each <img> came from.
 *
 * An image-only MMS has no <q> body, so the message loop's `continue` skipped
 * it — but its <div class="message"> block still names a sender.
 */
describe('Google Voice participants', () => {
  const importFixture = async (name: string): Promise<EmittedGraph[]> => {
    const pipeline: EmittedGraph[] = [];
    await new GoogleVoiceFileImporter().fileImport(
      {},
      { filename: name, fullPath: path.join(FIXTURES_DIR, name) },
      { pipeline, timeframe: {}, log: () => {} } as unknown as ImportParams,
    );

    return pipeline;
  };

  const importInline = async (html: string, attachments: string[] = []): Promise<EmittedGraph[]> => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gv-part-'));
    fs.mkdirSync(path.join(dir, 'Calls'));
    fs.writeFileSync(
      path.join(dir, 'Phones.vcf'),
      'BEGIN:VCARD\nVERSION:3.0\nFN:My Phone\nTEL:+15551234567\nEND:VCARD\n',
    );
    fs.writeFileSync(path.join(dir, 'Calls', 'Dana Wu - Text - 2025-03-01T12_00_00Z.html'), html);
    for (const a of attachments) {
      fs.writeFileSync(path.join(dir, 'Calls', a), 'jpeg-bytes');
    }

    const pipeline: EmittedGraph[] = [];
    await new GoogleVoiceFileImporter().fileImport({}, { filename: path.basename(dir), fullPath: dir }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);

    return pipeline;
  };

  const participantEdges = (g: EmittedGraph): Relationship[] =>
    (g.edges ?? []).filter((e) => e.relation === 'participant');

  it('attributes an image-only MMS to the sender of the block it came from', async () => {
    const pipeline = await importFixture('google-voice-export');
    const attachment = pipeline.find((p) => p.item?.metadata?.Attachment === 'image')!;
    expect(attachment).toBeDefined();

    // The third block of the fixture is Bob Smith's, and has no <q> body.
    expect(attachment.item.metadata.Sender).toBe('Bob Smith');
    expect(attachment.item.metadata.Direction).toBe('incoming');
    expect(attachment.item.metadata.To).toBe('My Phone');

    const edges = participantEdges(attachment);
    expect(edges).toHaveLength(1);
    expect(edges[0].to.entity?.name).toBe('Bob Smith');
    expect(edges[0].metadata?.direction).toBe('incoming');
    // Identity attribute, or the contact can never be joined to the same
    // number arriving from a vCard (see imessage.ts contactEntity).
    expect(edges[0].to.entity?.attributes).toEqual([
      { name: 'phone', value: '+15559876543', identity: true },
    ]);
  });

  it('stages a participant edge for text messages in both directions', async () => {
    const pipeline = await importFixture('google-voice-export');
    const graphs = pipeline.filter((p) => p.item?.metadata?.Text);

    const inbound = graphs.find((g) => g.item.metadata.Sender === 'Bob Smith')!;
    expect(participantEdges(inbound).map((e) => e.to.entity?.name)).toEqual(['Bob Smith']);
    expect(participantEdges(inbound)[0].metadata?.direction).toBe('incoming');

    // Outbound: the sender is the owner, so the edge names the RECIPIENT.
    const outbound = graphs.find((g) => g.item.metadata.Sender === 'Me')!;
    expect(participantEdges(outbound).map((e) => e.to.entity?.name)).toEqual(['Bob Smith']);
    expect(participantEdges(outbound)[0].metadata?.direction).toBe('outgoing');
  });

  it('attributes an image the owner sent to the owner, not to the contact', async () => {
    const pipeline = await importInline(
      `<html><body>
         <div class="message">
           <abbr class="dt" title="2025-03-01T12:00:00.000Z">Mar 1</abbr>:
           <cite class="sender vcard"><a class="tel" href="tel:+15558887777"><span class="fn">Dana Wu</span></a></cite>:
           <q>look at this</q>
         </div>
         <div class="message">
           <abbr class="dt" title="2025-03-01T12:01:00.000Z">Mar 1</abbr>:
           <cite class="sender vcard"><a class="tel" href="tel:+15551234567"><abbr class="fn" title="">Me</abbr></a></cite>:
           <img src="Dana Wu - Text - 2025-03-01T12_01_00Z-1-1">
         </div>
       </body></html>`,
      ['Dana Wu - Text - 2025-03-01T12_01_00Z-1-1.jpg'],
    );

    const attachment = pipeline.find((p) => p.item?.metadata?.Attachment === 'image')!;
    expect(attachment).toBeDefined();
    expect(attachment.item.metadata.Direction).toBe('outgoing');
    expect(attachment.item.metadata.Sender).toBe('Me');
    expect(attachment.item.metadata.To).toBe('Dana Wu');

    const edges = participantEdges(attachment);
    expect(edges).toHaveLength(1);
    expect(edges[0].to.entity?.name).toBe('Dana Wu');
    expect(edges[0].metadata?.direction).toBe('outgoing');
  });

  it('attributes EVERY image of a multi-image MMS, not just the first', async () => {
    // The real export wraps each attachment in its OWN div inside the message
    // block — the shape below is copied from a live conversation file. The lazy
    // `([\\s\\S]*?)<\\/div>` this replaced ended the block at the first of those
    // wrappers, so images 2..N were attributed to nobody: 274 rows on the live
    // corpus, every one an attachment with per-message index >= 2 and NOT ONE
    // with index 1.
    const stubs = [1, 2, 3, 4].map((n) => `Dana Wu - Text - 2025-03-01T12_01_00Z-1-${n}`);
    const pipeline = await importInline(
      `<html><body>
         <div class="hChatLog hfeed"><div class="message">
           <abbr class="dt" title="2025-03-01T12:01:00.000Z">Mar 1</abbr>:
           <cite class="sender vcard"><a class="tel" href="tel:+15558887777"><span class="fn">Dana Wu</span></a></cite>:
           <q></q>
           ${stubs.map((s) => `<div><img src="${s}" alt="Image MMS Attachment" /></div>`).join(' ')}
         </div></div>
       </body></html>`,
      stubs.map((s) => `${s}.jpg`),
    );

    const attachments = pipeline.filter((p) => p.item?.metadata?.Attachment === 'image');
    // Guard against the vacuous pass: four <img> in, four items out.
    expect(attachments).toHaveLength(4);

    for (const attachment of attachments) {
      expect(attachment.item.metadata.Sender).toBe('Dana Wu');
      expect(attachment.item.metadata.Direction).toBe('incoming');
      expect(attachment.item.metadata.To).toBe('My Phone');
      expect(participantEdges(attachment).map((e) => e.to.entity?.name)).toEqual(['Dana Wu']);
    }
  });

  it('does not attribute one message\u2019s attachments to the next message\u2019s sender', async () => {
    // Finding the block's real close means finding the RIGHT one. Resuming the
    // scan mid-block, or over-running into the following sibling, would file
    // Dana's pictures under Evan and hand the reader a confident wrong answer
    // in place of the old blank one.
    const pipeline = await importInline(
      `<html><body>
         <div class="hChatLog hfeed"><div class="message">
           <abbr class="dt" title="2025-03-01T12:01:00.000Z">Mar 1</abbr>:
           <cite class="sender vcard"><a class="tel" href="tel:+15558887777"><span class="fn">Dana Wu</span></a></cite>:
           <q></q>
           <div><img src="Dana Wu - Text - 2025-03-01T12_01_00Z-1-1" /></div>
           <div><img src="Dana Wu - Text - 2025-03-01T12_01_00Z-1-2" /></div>
         </div> <div class="message">
           <abbr class="dt" title="2025-03-01T12:05:00.000Z">Mar 1</abbr>:
           <cite class="sender vcard"><a class="tel" href="tel:+15550001111"><span class="fn">Evan Reed</span></a></cite>:
           <q></q>
           <div><img src="Dana Wu - Text - 2025-03-01T12_01_00Z-2-1" /></div>
         </div></div>
       </body></html>`,
      [
        'Dana Wu - Text - 2025-03-01T12_01_00Z-1-1.jpg',
        'Dana Wu - Text - 2025-03-01T12_01_00Z-1-2.jpg',
        'Dana Wu - Text - 2025-03-01T12_01_00Z-2-1.jpg',
      ],
    );

    const senderOf = (stub: string): unknown =>
      pipeline.find(
        (p) => p.item?.metadata?.Attachment === 'image' && p.item.content?.filename === `${stub}.jpg`,
      )?.item.metadata.Sender;

    expect(senderOf('Dana Wu - Text - 2025-03-01T12_01_00Z-1-1')).toBe('Dana Wu');
    expect(senderOf('Dana Wu - Text - 2025-03-01T12_01_00Z-1-2')).toBe('Dana Wu');
    expect(senderOf('Dana Wu - Text - 2025-03-01T12_01_00Z-2-1')).toBe('Evan Reed');
  });

  it('claims no sender for an image that sits outside every message block', async () => {
    // The filename label names the THREAD, never the author. Filing it as a
    // sender is how this importer previously minted 241 Person entities named
    // after .html files, so an unattributable image stays unattributed.
    const pipeline = await importInline(
      `<html><body>
         <img src="Dana Wu - Text - 2025-03-01T12_02_00Z-1-1">
       </body></html>`,
      ['Dana Wu - Text - 2025-03-01T12_02_00Z-1-1.jpg'],
    );

    const attachment = pipeline.find((p) => p.item?.metadata?.Attachment === 'image')!;
    expect(attachment).toBeDefined();
    expect(attachment.item.metadata.Conversation).toBe('Dana Wu');
    expect(attachment.item.metadata.Sender).toBeUndefined();
    expect(attachment.item.metadata.Direction).toBeUndefined();
    expect(attachment.item.metadata.To).toBeUndefined();
    expect(participantEdges(attachment)).toHaveLength(0);
  });
});

/*
 * A Google Voice conversation's other end is not a person by construction: SMS
 * SHORT CODES ("411", "99217", "227898") are the numbers services text from.
 *
 * Before this, nothing in the parser said so — the three entity pushes left
 * `type` to `resolveEntityType`, which infers 'contact' only from an attribute
 * long enough to be a handle, so a short code fell through to
 * `DEFAULT_ENTITY_TYPE`. 142 rows on the QA corpus landed as `Concept` that
 * way: the right answer, reached by accident, and the accident cut the other
 * way on the `participant` edge, which hard-coded 'contact' and would have
 * minted a `Person` named "411" on the next import.
 */
describe('a short code is a correspondent, not a person', () => {
  /**
   * Models the real chain: `StagedWriter` stores `resolveEntityType(entity)` as
   * the staged type and push's `entityTypeFor` maps that to
   * `ci.entities.entity_type`. Mirrors vcard.test.ts's `stagedEntityType`.
   */
  const graphType = (entity: Entity | undefined): string =>
    entityTypeFor({ type: resolveEntityType(entity ?? {}) } as StagedEntity);

  const stagedEntities = (pipeline: EmittedGraph[]): Entity[] =>
    pipeline.flatMap((g) => (g.entity ? [g.entity] : []));

  const edgeEntities = (pipeline: EmittedGraph[]): Entity[] =>
    pipeline.flatMap((g) =>
      (g.edges ?? [])
        .filter((e) => e.relation === 'participant')
        .flatMap((e) => (e.to.entity ? [e.to.entity] : [])),
    );

  const message = (tel: string, fn: string): string =>
    `<html><body><div class="hChatLog hfeed"><div class="message">
       <abbr class="dt" title="2025-03-01T12:00:00.000Z">Mar 1</abbr>:
       <cite class="sender vcard"><a class="tel" href="tel:${tel}"><span class="fn">${fn}</span></a></cite>:
       <q>your code is 402931</q>
     </div></div></body></html>`;

  const callLog = (tel: string, fn: string): string =>
    `<html><body><div class="haudio">
       <span class="fn">Received call from <a class="tel" href="tel:${tel}"><span class="fn">${fn}</span></a></span>
       <abbr class="published" title="2025-01-15T09:30:00.000Z">Jan 15</abbr>
     </div></body></html>`;

  const importHtml = async (html: string, filename: string): Promise<EmittedGraph[]> => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gv-code-'));
    fs.mkdirSync(path.join(dir, 'Calls'));
    fs.writeFileSync(
      path.join(dir, 'Phones.vcf'),
      'BEGIN:VCARD\nVERSION:3.0\nFN:My Phone\nTEL:+15551234567\nEND:VCARD\n',
    );
    fs.writeFileSync(path.join(dir, 'Calls', filename), html);

    const pipeline: EmittedGraph[] = [];
    await new GoogleVoiceFileImporter().fileImport({}, { filename: path.basename(dir), fullPath: dir }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);

    return pipeline;
  };

  it('does not file the sender of a short-code text as a Person', async () => {
    const pipeline = await importHtml(message('411', '411'), '411 - Text - 2025-03-01T12_00_00Z.html');
    const staged = stagedEntities(pipeline);

    // Guard against the vacuous pass: no entity means every assertion below
    // would be checking `undefined` against `undefined`.
    expect(staged.map((e) => e.name)).toEqual(['411']);
    expect(staged.map(graphType)).toEqual(['Concept']);
  });

  it('does not file the counterpart of a short-code text as a Person either', async () => {
    // The `participant` edge is the push that already declared a type, and the
    // one that had never run against the corpus — so this is where a `Person`
    // named "411" would first have appeared.
    const pipeline = await importHtml(message('411', '411'), '411 - Text - 2025-03-01T12_00_00Z.html');
    const edges = edgeEntities(pipeline);

    expect(edges.map((e) => e.name)).toEqual(['411']);
    expect(edges.map(graphType)).toEqual(['Concept']);
  });

  it('does not file a short-code caller as a Person', async () => {
    const pipeline = await importHtml(callLog('+411', '+411'), '411 - Received - 2025-01-15T09_30_00Z.html');
    const staged = stagedEntities(pipeline);

    // '+411' is the shape the second QA database holds: the punctuation must
    // not make it read as a name.
    expect(staged.map((e) => e.name)).toEqual(['+411']);
    expect(staged.map(graphType)).toEqual(['Concept']);
  });

  it('does not file a short code that arrives as the NAME as a Person', async () => {
    // The gap #2150 left. Google Voice names most exports
    // "<contact> - <Type> - <timestamp>.html" and that prefix becomes the
    // contact NAME, so a marketing sender frequently arrives with a short code
    // for a name and NO tel: at all. `participantType` read only the phone, so
    // this typed as `contact` and became a Person.
    //
    // Measured on a fresh full-corpus import: 141 short-code participants typed
    // correctly, 4 leaked through this path (1311, 14242, ...).
    const pipeline = await importHtml(
      `<html><body><div class="haudio">
         <span class="fn">Received call from 262966</span>
         <abbr class="published" title="2025-01-15T09:30:00.000Z">Jan 15</abbr>
       </div></body></html>`,
      '262966 - Received - 2025-01-15T09_30_00Z.html',
    );
    const staged = stagedEntities(pipeline);

    expect(staged.map((e) => e.name)).toEqual(['262966']);
    expect(staged.map(graphType)).toEqual(['Concept']);
  });

  /*
   * The cases that already worked, kept so the short-code rule cannot be
   * satisfied by simply refusing to type anybody.
   */
  it('still files a real phone number as a Person, from every push', async () => {
    const pipeline = await importHtml(
      message('+15558887777', 'Dana Wu'),
      'Dana Wu - Text - 2025-03-01T12_00_00Z.html',
    );

    expect(stagedEntities(pipeline).map(graphType)).toEqual(['Person']);
    expect(edgeEntities(pipeline).map(graphType)).toEqual(['Person']);
  });

  it('still files a caller the export named but gave no number as a Person', async () => {
    // No `tel:` at all, so `hasContactIdentity` finds nothing and only the
    // declared type can carry this row to `Person`.
    const pipeline = await importHtml(
      `<html><body><div class="haudio">
         <span class="fn">Received call from Ada Lovelace</span>
         <abbr class="published" title="2025-01-15T09:30:00.000Z">Jan 15</abbr>
       </div></body></html>`,
      'Ada Lovelace - Received - 2025-01-15T09_30_00Z.html',
    );
    const staged = stagedEntities(pipeline);

    expect(staged.map((e) => e.name)).toEqual(['Ada Lovelace']);
    expect(staged.some((e) => e.attributes?.length)).toBe(false);
    expect(staged.map(graphType)).toEqual(['Person']);
  });
});

// The transcript of a voicemail lived in `<span class="note">` in an older
// export shape, and the parser read that class. A current export does not
// contain it ONCE — 0 of 71,946 files in the reference corpus — so every
// voicemail fell back to the synthesized "<Type> call from <contact>" label
// and 2,521 real transcripts were never read.
//
// The reason this survived a green suite is worth stating: the existing
// fixture above was written to match the PARSER, using `class="note"`, so it
// could never falsify the parser's assumption. These fixtures use the markup a
// real export actually ships — `<span class="full-text">` nested in
// `<span class="description">`, with per-word timing spans as siblings AFTER
// it — so they fail against the old regex.
describe('voicemail transcripts in real export markup', () => {
  async function importRealMarkup() {
    const exportDir = path.join(FIXTURES_DIR, 'google-voice-export-realmarkup');
    const pipeline: EmittedGraph[] = [];
    await new GoogleVoiceFileImporter().fileImport(
      {},
      { filename: 'google-voice-export-realmarkup', fullPath: exportDir },
      { pipeline, timeframe: {}, log: () => {} } as unknown as ImportParams,
    );

    return pipeline.filter((p) => p.item?.classification === 'call').map((p) => p.item);
  }

  it('reads the transcript out of <span class="full-text">', async () => {
    const calls = await importRealMarkup();
    const bob = calls.find((c) => c.metadata.Contact === 'Bob Smith');
    expect(bob).toBeDefined();
    expect(bob!.metadata.Transcript).toBe("Hi it's Bob, the meeting moved to Thursday.");
  });

  it('does not swallow the per-word timing spans that follow it', async () => {
    // The <span class="word …"> siblings carry start-time/end-time/confidence.
    // A greedy match, or one that read the enclosing <span class="description">,
    // would splice those numbers into the sentence.
    const calls = await importRealMarkup();
    const bob = calls.find((c) => c.metadata.Contact === 'Bob Smith');
    const transcript = bob!.metadata.Transcript as string;
    expect(transcript).not.toMatch(/0\.98|0\.42/);
    expect(transcript).not.toMatch(/start-time|end-time|confidence/);
    expect(transcript.endsWith('Thursday.')).toBe(true);
  });

  it('uses the transcript as the item body, not the synthesized label', async () => {
    const calls = await importRealMarkup();
    const bob = calls.find((c) => c.metadata.Contact === 'Bob Smith');
    const body = await (bob!.content as { data: () => Promise<Buffer> }).data();
    expect(body.toString()).toBe("Hi it's Bob, the meeting moved to Thursday.");
    // The label is still recorded separately.
    expect(bob!.metadata.Description).toContain('Voicemail call from');
  });

  it('falls back to the label when the element is present but empty', async () => {
    // 297 of the 2,818 files in the corpus have an empty <span class="full-text">.
    // Those must keep the old behaviour rather than store an empty body.
    const calls = await importRealMarkup();
    const carol = calls.find((c) => c.metadata.Contact === 'Carol Diaz');
    expect(carol).toBeDefined();
    expect(carol!.metadata.Transcript).toBeUndefined();
    const body = await (carol!.content as { data: () => Promise<Buffer> }).data();
    expect(body.toString()).toContain('Voicemail call from');
  });

  it('still reads the legacy <span class="note"> shape', async () => {
    // An older export keeps working — the original fixture uses that markup.
    const exportDir = path.join(FIXTURES_DIR, 'google-voice-export-calls');
    const pipeline: EmittedGraph[] = [];
    await new GoogleVoiceFileImporter().fileImport(
      {},
      { filename: 'google-voice-export-calls', fullPath: exportDir },
      { pipeline, timeframe: {}, log: () => {} } as unknown as ImportParams,
    );
    const vm = pipeline
      .filter((p) => p.item?.classification === 'call')
      .map((p) => p.item)
      .find((c) => c.metadata.CallType === 'Voicemail');
    expect(vm!.metadata.Transcript).toBe("Hey it's Alice, call me back when you get a chance.");
  });
});

// Google Voice ships each voicemail's recording as a sibling .mp3 named by an
// <audio src>. None of it was read: resolveAttachment only probes image
// extensions, and it is unreachable from a call file anyway because fileImport
// routes haudio to processCallLog and returns before the <img> loop. 3,066
// files name a recording, 2,718 resolve to bytes, and ci.files held no audio
// row from any source.
describe('voicemail recordings', () => {
  async function importRealMarkup() {
    const exportDir = path.join(FIXTURES_DIR, 'google-voice-export-realmarkup');
    const pipeline: EmittedGraph[] = [];
    await new GoogleVoiceFileImporter().fileImport(
      {},
      { filename: 'google-voice-export-realmarkup', fullPath: exportDir },
      { pipeline, timeframe: {}, log: () => {} } as unknown as ImportParams,
    );

    return pipeline.filter((p) => p.item?.classification === 'call').map((p) => p.item);
  }

  const attachmentsOf = (call: { metadata: Record<string, unknown> }) =>
    call.metadata.MediaAttachments as Array<Record<string, unknown>> | undefined;

  it('attaches the recording that sits beside the html', async () => {
    const calls = await importRealMarkup();
    const bob = calls.find((c) => c.metadata.Contact === 'Bob Smith')!;
    const atts = attachmentsOf(bob);
    expect(atts).toHaveLength(1);
    expect(atts![0].filename).toBe('Bob Smith - Voicemail - 2025-03-04T08_20_00Z.mp3');
    expect(atts![0].type).toBe('audio');
    expect(atts![0].mimetype).toBe('audio/mpeg');
    expect(fs.existsSync(atts![0].path as string)).toBe(true);
  });

  it('resolves a percent-encoded href whose accents are stored decomposed on disk', async () => {
    // Built at RUNTIME, not committed as a fixture: git's core.precomposeunicode
    // rewrites a decomposed filename to NFC on add, so a committed fixture would
    // arrive composed on a fresh checkout and this would silently stop testing
    // the thing it names.
    //
    // The export names the file composed (NFC) and percent-encoded, while macOS
    // stores it decomposed (NFD). Comparing raw strings finds nothing.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gv-nfd-'));
    const calls = path.join(dir, 'Calls');
    fs.mkdirSync(calls);
    const nfd = 'Renée Dupré - Voicemail - 2025-03-06T10_00_00Z.mp3'.normalize('NFD');
    const nfc = nfd.normalize('NFC');
    expect(nfd).not.toBe(nfc); // the case only exists if these differ
    fs.writeFileSync(path.join(calls, nfd), 'ID3fake');
    const href = encodeURIComponent(nfc);
    fs.writeFileSync(
      path.join(calls, 'Renee Dupre - Voicemail - 2025-03-06T10_00_00Z.html'),
      `<html><body><div class="haudio"><span class="album">Voicemail</span>` +
        `<span class="fn">Voicemail from <a class="tel" href="tel:+15551237777"><span class="fn">Renee Dupre</span></a></span>` +
        `<div class="contributor vcard"><a class="tel" href="tel:+15551237777"><span class="fn">Renee Dupre</span></a></div>` +
        `<abbr class="published" title="2025-03-06T10:00:00.000Z">Mar 6</abbr>` +
        `<span class="description"><span class="full-text">Accented filename case.</span></span><br />` +
        `<audio controls="controls" src="${href}"><a rel="enclosure" href="${href}">x</a></audio>` +
        `<abbr class="duration" title="PT00H00M09S">(00:00:09)</abbr></div></body></html>`,
    );

    const pipeline: EmittedGraph[] = [];
    await new GoogleVoiceFileImporter().fileImport({}, { filename: path.basename(dir), fullPath: dir }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);
    const renee = pipeline
      .filter((p) => p.item?.classification === 'call')
      .map((p) => p.item)
      .find((c) => c.metadata.Contact === 'Renee Dupre');
    expect(renee).toBeDefined();

    const atts = attachmentsOf(renee!);
    expect(atts).toHaveLength(1);

    // The path must be the byte sequence the DIRECTORY holds, not the one the
    // href spells. existsSync alone cannot show this on macOS, where APFS
    // compares filenames normalization-INSENSITIVELY and the NFC path resolves
    // regardless. The appliance runs Linux, where ext4 compares bytes and the
    // NFC path would simply not exist — so assert the bytes.
    const resolved = path.basename(atts![0].path as string);
    expect(fs.readdirSync(calls)).toContain(resolved);
    expect(fs.readFileSync(atts![0].path as string).length).toBeGreaterThan(0);
  });

  it('records no attachment when the export did not ship the audio', async () => {
    // Unlike imessage.ts, a path-less descriptor is NOT recorded here: chat.db
    // knows a purged attachment's name, type and guid, but a Voice export
    // missing its mp3 says nothing the call record does not already say.
    const calls = await importRealMarkup();
    const dan = calls.find((c) => c.metadata.Contact === 'Dan Vale')!;
    expect(dan).toBeDefined();
    expect(attachmentsOf(dan)).toBeUndefined();
  });

  it('still imports the call itself when the audio is missing', async () => {
    const calls = await importRealMarkup();
    const dan = calls.find((c) => c.metadata.Contact === 'Dan Vale')!;
    expect(dan.metadata.CallType).toBe('Voicemail');
    expect(dan.metadata.Transcript).toBe('Missing audio case.');
  });

  it('does not attach anything to a call with no audio element', async () => {
    // The legacy fixture's voicemail has a transcript but no <audio>.
    const exportDir = path.join(FIXTURES_DIR, 'google-voice-export-calls');
    const pipeline: EmittedGraph[] = [];
    await new GoogleVoiceFileImporter().fileImport(
      {},
      { filename: 'google-voice-export-calls', fullPath: exportDir },
      { pipeline, timeframe: {}, log: () => {} } as unknown as ImportParams,
    );
    const calls = pipeline.filter((p) => p.item?.classification === 'call').map((p) => p.item);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.metadata.MediaAttachments === undefined)).toBe(true);
  });
});

describe('an export file replicated with a copy index is one record, not two', () => {
  /**
   * Google Voice call/voicemail items carry NO `item.id`, so `hashItem` keys
   * them on `sha1(dataSource, classification, content.filename, isoTimestamp)`
   * — the filename IS half the identity. A Drive/Takeout copy suffix therefore
   * minted a second provenance triple for one call, and the
   * `communications_source_triple_uniq` arbiter cannot collapse two different
   * triples: on the QA appliance one 2013-06-14T15:07:34 call from Chris
   * Spagnuolo sat in ci.communications three times, once per copy of its file.
   *
   * Asserted through `hashItem` rather than by eyeballing `content.filename`,
   * because the hash is what actually decides whether the two rows merge.
   */
  const importCalls = async (files: Record<string, string>): Promise<EmittedGraph['item'][]> => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gv-copy-'));
    fs.mkdirSync(path.join(dir, 'Calls'));
    for (const [filename, body] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, 'Calls', filename), body);
    }

    const pipeline: EmittedGraph[] = [];
    await new GoogleVoiceFileImporter().fileImport({}, { filename: path.basename(dir), fullPath: dir }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);

    return pipeline.filter((p) => p.item?.classification === 'call').map((p) => p.item);
  };

  const callLog = (isoTitle: string, contact: string): string =>
    `<html><body><div class="haudio">
       <span class="fn">Missed call from <a class="tel" href="tel:+15551230099"><span class="fn">${contact}</span></a></span>
       <abbr class="published" title="${isoTitle}">then</abbr>
       <abbr class="duration" title="00:00:30">(00:00:30)</abbr>
     </div></body></html>`;

  it('hashes " (2)" and "(1)" copies of one call to the SAME key as the original', async () => {
    const body = callLog('2013-06-14T15:07:34.000Z', 'Chris Spagnuolo');
    const items = await importCalls({
      'Chris Spagnuolo - Missed - 2013-06-14T15_07_34Z.html': body,
      'Chris Spagnuolo - Missed - 2013-06-14T15_07_34Z (2).html': body,
      // The space is optional — both forms occur in the same real corpus.
      'Chris Spagnuolo - Missed - 2013-06-14T15_07_34Z(3).html': body,
    });

    // Guard against a vacuous pass: three files must have produced three items
    // for the hash comparison below to mean anything.
    expect(items).toHaveLength(3);

    const hashes = new Set(items.map((item) => hashItem(item, 'google_voice')));
    expect(hashes.size).toBe(1);
  });

  it('keeps two calls apart when the copy index disambiguates a TRUNCATED name', async () => {
    // Google Voice cuts a long filename mid-timestamp and then appends its own
    // "(n)" to make the truncated names unique — 428 files in the reference
    // corpus, e.g. "…Turner - Missed - 2016-01-08T17_3(1).html" and "…(2)".
    // Those are two different calls minutes apart, and merging them would
    // delete one of them at staging.
    const items = await importCalls({
      'Elisabeth (Lisa) Turner - Missed - 2016-01-08T17_3(1).html': callLog(
        '2016-01-08T17:30:00.000Z',
        'Elisabeth Turner',
      ),
      'Elisabeth (Lisa) Turner - Missed - 2016-01-08T17_3(2).html': callLog(
        '2016-01-08T17:38:00.000Z',
        'Elisabeth Turner',
      ),
    });

    expect(items).toHaveLength(2);
    expect(new Set(items.map((item) => hashItem(item, 'google_voice'))).size).toBe(2);
  });

  it('strips only a copy index that follows a COMPLETE export timestamp', () => {
    // The anchor is the whole safety argument, so it is pinned directly.
    expect(stripCopyIndex('Chris Spagnuolo - 2013-06-14T15_07_34Z (2).html')).toBe(
      'Chris Spagnuolo - 2013-06-14T15_07_34Z.html',
    );
    expect(stripCopyIndex('+16124140453 - 2013-08-09T15_04_51Z(1).html')).toBe(
      '+16124140453 - 2013-08-09T15_04_51Z.html',
    );

    // Truncated name: the index is Google Voice's own collision breaker.
    expect(stripCopyIndex('Elisabeth (Lisa) Turner - Missed - 2016-01-08T17_3(1).html')).toBe(
      'Elisabeth (Lisa) Turner - Missed - 2016-01-08T17_3(1).html',
    );

    // A parenthesised number inside the contact label is part of the name.
    expect(stripCopyIndex('Elisabeth (Lisa) Turner - Text - 2016-01-08T17_30_00Z.html')).toBe(
      'Elisabeth (Lisa) Turner - Text - 2016-01-08T17_30_00Z.html',
    );

    // Nothing that is not a Google Voice export name is touched.
    expect(stripCopyIndex('IMG_0001 (1).jpg')).toBe('IMG_0001 (1).jpg');
  });

  it('threads a copied group-conversation file with the original', () => {
    // A file that names nobody threads on its own identity (GV_FILE_THREAD_PREFIX).
    // Two copies of one group chat must not become two conversations.
    expect(threadKeyFor('/Calls/Group Conversation - 2019-11-11T23_27_25Z (2).html', undefined)).toBe(
      threadKeyFor('/Calls/Group Conversation - 2019-11-11T23_27_25Z.html', undefined),
    );
  });
});
