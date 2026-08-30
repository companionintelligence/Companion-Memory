import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { GmailFileImporter } from '../gmail';
import type { DirEntry } from '../registry';
import type { Graph, ImportParams } from '../timeline';

import type { EmittedGraph } from './support/emitted';
import { metaText } from './support/emitted';

function makeParams() {
  const collected: EmittedGraph[] = [];

  return {
    params: { timeframe: undefined, pipeline: { push: (g: Graph) => collected.push(g as EmittedGraph) } },
    collected,
  };
}

// Quoted-printable and base64 multipart sample (simplified)
const SAMPLE = `From someone@example.com Sat Jan 01 00:00:00 2024\nDate: Sat, 01 Jan 2024 00:00:00 +0000\nFrom: Someone <someone@example.com>\nTo: Friend <friend@example.com>\nMessage-ID: <abc123@mx.example.com>\nSubject: First Mail\nContent-Type: multipart/alternative; boundary="b1"\n\n--b1\nContent-Type: text/plain\nContent-Transfer-Encoding: quoted-printable\n\nHello=2C world!\n--b1\nContent-Type: text/html\n\n<p>Hello world!</p>\n--b1--\nFrom other@example.com Sat Jan 01 00:10:00 2024\nDate: Sat, 01 Jan 2024 00:10:00 +0000\nFrom: Other <other@example.com>\nTo: Someone <someone@example.com>\nIn-Reply-To: <abc123@mx.example.com>\nReferences: <abc123@mx.example.com> <def456@mx.example.com>\nSubject: =?UTF-8?B?UmU6IEZpcnN0IE1haWw=?=\nContent-Transfer-Encoding: base64\n\nU2Vjb25kIGJvZHkgbGluZQ==\n`;

describe('Gmail advanced mbox parsing', () => {
  it('parses multiple messages with decoding and threading metadata', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-gmail-adv-'));
    const file = path.join(dir, 'mail.mbox');
    fs.writeFileSync(file, SAMPLE);
    const imp = new GmailFileImporter();
    const rec = await imp.recognize(undefined, { fullPath: file } as DirEntry);
    expect(rec.confidence).toBeGreaterThan(0.5);
    const { params, collected } = makeParams();
    await imp.fileImport(undefined, { fullPath: file } as DirEntry, params as unknown as ImportParams);
    const items = collected.filter((c) => c.item);
    expect(items.length).toBeGreaterThanOrEqual(2);
    const first = items.find((i) => i.item?.metadata?.MessageID === 'abc123@mx.example.com');
    expect(first?.item?.content).toBeTruthy();
    expect((await first?.item?.content.data?.())?.toString()).toContain('Hello, world!');
    const second = items.find((i) => metaText(i.item?.metadata?.InReplyTo).includes('abc123@mx.example.com'));
    expect(second?.item?.metadata?.References).toContain('abc123@mx.example.com');
    // ensure base64 body decoded ("Second body line" sample decodes to 'Second body line')
    expect((await second?.item?.content.data?.())?.toString()).toContain('Second body line');
    // The RFC 2047 encoded-word Subject ("=?UTF-8?B?...?=") is decoded, not
    // stored raw — parseHeaders now runs every header value through
    // decodeHeaderField (email_mime.ts).
    expect(second?.item?.metadata?.Subject).toBe('Re: First Mail');
    // Conversation key is the References root, not each message's own Message-ID.
    expect(first?.item?.metadata?.ThreadId).toBe('abc123@mx.example.com');
    expect(second?.item?.metadata?.ThreadId).toBe('abc123@mx.example.com');
  });
});
