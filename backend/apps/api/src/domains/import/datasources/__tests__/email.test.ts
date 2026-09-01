import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { EmailFileImporter } from '../email';
import type { ImportParams, Relationship } from '../timeline';

import type { EmittedGraph } from './support/emitted';
import { metaAttachments } from './support/emitted';

// Scratch files go to the OS temp dir, not a repo-relative path: the standalone
// importer ran from `backend/`, so `process.cwd()/backend/tmp_test` landed outside
// the tree, but here it would litter backend/apps/api/backend/.
function makeTempFile(name: string, content: string): string {
  const dir = path.join(os.tmpdir(), 'ci-import-tests');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, name);
  fs.writeFileSync(f, content, 'utf8');

  return f;
}

describe('Generic Email datasource', () => {
  it('recognizes .eml file', async () => {
    const emlPath = makeTempFile(
      'sample.eml',
      'Subject: Test Email\nDate: Fri, 02 Jan 2025 10:00:00 -0000\nFrom: Alice <alice@example.com>\nTo: Bob <bob@example.com>\n\nHello Bob',
    );
    const fi = new EmailFileImporter();
    const rec = await fi.recognize({}, { filename: path.basename(emlPath), fullPath: emlPath });
    expect(rec.confidence).toBeGreaterThan(0.5);
  });

  it('imports single .eml message', async () => {
    const emlPath = makeTempFile(
      'single.eml',
      'Subject: Single Email\nDate: Fri, 02 Jan 2025 11:00:00 -0000\nFrom: Alice <alice@example.com>\nTo: Bob <bob@example.com>\n\nBody line',
    );
    const fi = new EmailFileImporter();
    const pipeline: EmittedGraph[] = [];
    await fi.fileImport({}, { filename: path.basename(emlPath), fullPath: emlPath }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);
    const items = pipeline.filter((p) => p.item);
    expect(items.length).toBe(1);
    expect(items[0].item.metadata.Subject).toBe('Single Email');
  });

  it('threads a reply onto the References root, not its own Message-ID', async () => {
    const emlPath = makeTempFile(
      'reply.eml',
      'Subject: Re: Single Email\n' +
        'Date: Fri, 02 Jan 2025 12:00:00 -0000\n' +
        'From: Bob <bob@example.com>\n' +
        'To: Alice <alice@example.com>\n' +
        'Message-ID: <reply@example.com>\n' +
        'In-Reply-To: <orig@example.com>\n' +
        'References: <orig@example.com>\n' +
        '\n' +
        'Sounds good',
    );
    const fi = new EmailFileImporter();
    const pipeline: EmittedGraph[] = [];
    await fi.fileImport({}, { filename: path.basename(emlPath), fullPath: emlPath }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);
    expect(pipeline[0].item.metadata.ThreadId).toBe('orig@example.com');
    expect(pipeline[0].item.metadata.MessageID).toBe('reply@example.com');
  });

  it('imports multiple messages from mbox', async () => {
    const mboxContent =
      'From someone@example.com Fri Jan 03 12:00:00 2025\nSubject: First\nDate: Fri, 03 Jan 2025 12:00:00 -0000\nFrom: A <a@example.com>\nTo: B <b@example.com>\n\nFirst body\n\nFrom other@example.com Fri Jan 03 13:00:00 2025\nSubject: Second\nDate: Fri, 03 Jan 2025 13:00:00 -0000\nFrom: C <c@example.com>\nTo: D <d@example.com>\n\nSecond body';
    const mboxPath = makeTempFile('multi.mbox', mboxContent);
    const fi = new EmailFileImporter();
    const pipeline: EmittedGraph[] = [];
    await fi.fileImport({}, { filename: path.basename(mboxPath), fullPath: mboxPath }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);
    const items = pipeline.filter((p) => p.item);
    expect(items.length).toBe(2);
  });

  it('imports extensionless mbox files by content sniff (Thunderbird folder-export regression)', async () => {
    // Thunderbird's ImportExportTools NG names exports after the mail folder
    // ("Inbox", "Sent") with NO extension. recognize() accepted these via the
    // 'From ' sniff but fileImport() dispatched on extension only, so they
    // imported zero records.
    const mboxContent =
      'From someone@example.com Fri Jan 03 12:00:00 2025\nSubject: First\nDate: Fri, 03 Jan 2025 12:00:00 -0000\nFrom: A <a@example.com>\nTo: B <b@example.com>\n\nFirst body\n\nFrom other@example.com Fri Jan 03 13:00:00 2025\nSubject: Second\nDate: Fri, 03 Jan 2025 13:00:00 -0000\nFrom: C <c@example.com>\nTo: D <d@example.com>\n\nSecond body';
    const mboxPath = makeTempFile('Inbox', mboxContent);
    const fi = new EmailFileImporter();
    const rec = await fi.recognize({}, { filename: path.basename(mboxPath), fullPath: mboxPath });
    expect(rec.confidence).toBeGreaterThan(0.5);
    const pipeline: EmittedGraph[] = [];
    await fi.fileImport({}, { filename: path.basename(mboxPath), fullPath: mboxPath }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);
    const items = pipeline.filter((p) => p.item);
    expect(items.length).toBe(2);
    expect(items.map((i) => i.item.metadata.Subject).sort()).toEqual(['First', 'Second']);
  });

  it('imports extensionless mbox files found while walking a directory', async () => {
    const dir = path.join(os.tmpdir(), 'ci-import-tests', 'tb_export');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'Sent'),
      'From me@example.com Fri Jan 03 14:00:00 2025\nSubject: Walked\nDate: Fri, 03 Jan 2025 14:00:00 -0000\nFrom: Me <me@example.com>\nTo: You <you@example.com>\n\nWalked body',
      'utf8',
    );
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'not an email', 'utf8');
    const fi = new EmailFileImporter();
    const pipeline: EmittedGraph[] = [];
    await fi.fileImport({}, { filename: 'tb_export', fullPath: dir }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);
    const items = pipeline.filter((p) => p.item);
    expect(items.length).toBe(1);
    expect(items[0].item.metadata.Subject).toBe('Walked');
  });

  it('streaming and whole-file mbox paths produce identical items', async () => {
    const mboxContent =
      'From someone@example.com Fri Jan 03 12:00:00 2025\nSubject: First\nDate: Fri, 03 Jan 2025 12:00:00 -0000\nFrom: A <a@example.com>\nTo: B <b@example.com>\nMessage-ID: <s1@example.com>\n\nFirst body\n\nFrom other@example.com Fri Jan 03 13:00:00 2025\nSubject: Second\nDate: Fri, 03 Jan 2025 13:00:00 -0000\nFrom: C <c@example.com>\nTo: D <d@example.com>\n\nSecond body';
    const mboxPath = makeTempFile('parity.mbox', mboxContent);
    const fi = new EmailFileImporter();
    const run = async (method: 'processMbox' | 'streamMbox') => {
      const pipeline: EmittedGraph[] = [];
      await (fi as unknown as Record<string, (p: string, params: ImportParams) => Promise<void>>)[method](
        mboxPath,
        {
          pipeline,
          timeframe: {},
          log: () => {},
        } as unknown as ImportParams,
      );

      return pipeline.filter((p) => p.item).map((p) => ({ id: p.item.id, subject: p.item.metadata.Subject }));
    };

    const whole = await run('processMbox'); // small file → whole-file path
    const streamed = await run('streamMbox');
    expect(streamed.length).toBe(2);
    expect(streamed).toEqual(whole); // ids match too: index fallback is aligned
  });

  it('assigns unique stable ids to same-second / Message-ID-less messages (dedup-collapse regression)', async () => {
    // Three messages share the SAME Date (same second), no Message-ID, and the
    // mbox archive gives every message the constant intermediateLocation +
    // content.filename. Pre-fix these collapse to one item via hashItem.
    const mboxContent = [
      'From a@example.com Fri Jan 03 12:00:00 2025\nSubject: One\nDate: Fri, 03 Jan 2025 12:00:00 -0000\nFrom: A <a@example.com>\nTo: B <b@example.com>\n\nBody one',
      'From a@example.com Fri Jan 03 12:00:00 2025\nSubject: Two\nDate: Fri, 03 Jan 2025 12:00:00 -0000\nFrom: A <a@example.com>\nTo: B <b@example.com>\n\nBody two',
      'From a@example.com Fri Jan 03 12:00:00 2025\nSubject: Three\nDate: Fri, 03 Jan 2025 12:00:00 -0000\nFrom: A <a@example.com>\nTo: B <b@example.com>\n\nBody three',
    ].join('\n\n');
    const mboxPath = makeTempFile('collapse.mbox', mboxContent);
    const fi = new EmailFileImporter();
    const run = async () => {
      const pipeline: EmittedGraph[] = [];
      await fi.fileImport({}, { filename: path.basename(mboxPath), fullPath: mboxPath }, {
        pipeline,
        timeframe: {},
        log: () => {},
      } as unknown as ImportParams);

      return pipeline.filter((p) => p.item).map((p) => p.item.id!);
    };

    const ids = await run();
    expect(ids.length).toBe(3);
    expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true); // (a) all ids truthy
    expect(new Set(ids).size).toBe(3); // (b) all distinct, no collapse
    const ids2 = await run();
    expect(ids2).toEqual(ids); // (c) re-import is idempotent
  });

  it('message carries From/To/Direction and attachment sub-item is NOT a communication (participants regression)', async () => {
    const eml = [
      'Subject: With Attachment',
      'Date: Fri, 02 Jan 2025 12:00:00 -0000',
      'From: Alice <alice@example.com>',
      'To: Bob <bob@example.com>',
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="b1"',
      '',
      '--b1',
      'Content-Type: text/plain',
      '',
      'Hello with file',
      '--b1',
      'Content-Type: application/pdf; name="doc.pdf"',
      'Content-Disposition: attachment; filename="doc.pdf"',
      'Content-Transfer-Encoding: base64',
      '',
      'SGVsbG8=',
      '--b1--',
    ].join('\n');
    const emlPath = makeTempFile('attach.eml', eml);
    const fi = new EmailFileImporter();
    const pipeline: EmittedGraph[] = [];
    await fi.fileImport({}, { filename: path.basename(emlPath), fullPath: emlPath }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);
    const items = pipeline.filter((p) => p.item);
    expect(items.length).toBe(1);
    // (a) the parent message routes to communications with populated participants
    const msg = items[0].item;
    expect(msg.classification).toBe('email');
    expect(msg.metadata.From).toBe('Alice <alice@example.com>');
    expect(msg.metadata.To).toBe('Bob <bob@example.com>');
    expect(typeof msg.metadata.Direction).toBe('string');
    // (b) the attachment rides the message itself as a MediaAttachments
    // descriptor (the comms media lane) — NOT as a sub-item edge, which used to
    // mint a duplicate ci.events row per attachment at the email's timestamp.
    expect(items[0].edges?.some((e: Relationship) => e.relation === 'attachment')).toBeFalsy();
    const atts = metaAttachments(msg.metadata.MediaAttachments);
    expect(atts).toHaveLength(1);
    expect(atts[0].filename).toBe('doc.pdf');
    expect(atts[0].mimetype).toBe('application/pdf');
    expect(atts[0].type).toBe('file'); // a PDF is not media
    // (c) the descriptor points at the attachment's own extracted bytes.
    expect(fs.readFileSync(atts[0].path, 'utf8')).toBe('Hello');
  });
});
