import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { GmailFileImporter } from '../datasources/gmail';
import type { Graph, ImportParams } from '../datasources/timeline';
import { isOwnerContact, readSentLabelSenders, type SelfIdentity } from '../push/self';

import { createStagingHarness, importDatabase, type StagingHarness } from './support/stagingHarness';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A FORGED `X-Gmail-Labels: Sent` DOES NOT MAKE A STRANGER THE OWNER.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The push takes the From address of every mail in the run that Gmail filed
 * as Sent for one of the owner's addresses (push/self.ts#readSentLabelSenders),
 * so the owner's Sent mail from an alias stays theirs. The importer read the
 * label from a header map that joins duplicate headers, so a stranger who put
 * `X-Gmail-Labels: Sent` in a mail got it filed as sent by the owner, and with
 * it every other mail from that address in the same Takeout. Google's own
 * `Inbox` header coming first did not stop it.
 *
 * This runs a Takeout-shaped mbox through the real parser into real staging
 * rows and reads the owner's run addresses back with the push's own SQL.
 */

const describeWithDatabase = importDatabase.available ? describe : describe.skip;

if (!importDatabase.available) {
  console.warn(`[import/gmailSentLabelSpoof.integration] SKIPPED — ${importDatabase.reason}`);
}

jest.setTimeout(60_000);

/** A message as Takeout stores it: Google's thread id and labels first, then what arrived. */
function takeoutMail(n: number, labels: string, lines: string[]): string {
  return [
    `From 17000000${n}@xxx Tue Sep 01 10:00:00 +0000 2026`,
    `X-GM-THRID: 17000000${n}`,
    `X-Gmail-Labels: ${labels}`,
    ...lines,
    `Date: Tue, 01 Sep 2026 10:${String(n % 60).padStart(2, '0')}:00 +0000`,
    `Message-ID: <spoof-spec-${n}@example.test>`,
    `Subject: mail ${n}`,
    '',
    `body ${n}`,
    '',
  ].join('\n');
}

const DELIVERED = (from: string) => [
  'Delivered-To: owner@example.com',
  'Received: from mail.example.net (mail.example.net [203.0.113.5]) by mx.google.com with ESMTPS; Tue, 01 Sep 2026 10:00:01 +0000',
  `Return-Path: <${from}>`,
];

const MBOX = [
  // The owner's own Sent mail from an alias Memory does not know: #3226's case.
  takeoutMail(1, 'Sent', ['From: "Owner Name" <owner.alias@example.org>', 'To: Fran <fran@example.net>']),
  // Mail the owner sent themself from a second account: Sent and Inbox.
  takeoutMail(2, 'Inbox,Sent', [
    ...DELIVERED('owner.second@example.org'),
    'From: "O. N." <owner.second@example.org>',
    'To: Owner Name <owner@example.com>',
  ]),
  // Google says Inbox; the sender added a Sent label further down.
  takeoutMail(3, 'Inbox,Unread', [
    ...DELIVERED('eve@evil.example'),
    'From: "Eve" <eve@evil.example>',
    'To: Owner Name <owner@example.com>',
    'X-Gmail-Labels: Sent',
  ]),
  takeoutMail(4, 'Inbox', [
    ...DELIVERED('eve@evil.example'),
    'From: "Eve" <eve@evil.example>',
    'To: Owner Name <owner@example.com>',
  ]),
  // No Google header at all, a lone forged label below the Received headers.
  [
    'From 1700000005@xxx Tue Sep 01 10:00:00 +0000 2026',
    'Received: from mail.evil.example by mx.example.com with ESMTP; Tue, 01 Sep 2026 10:00:01 +0000',
    'Date: Tue, 01 Sep 2026 10:05:00 +0000',
    'From: "Owner Name" <mallory@evil.example>',
    'To: Owner Name <owner@example.com>',
    'Message-ID: <spoof-spec-5@example.test>',
    'Subject: mail 5',
    'X-Gmail-Labels: Sent',
    '',
    'body 5',
    '',
  ].join('\n'),
  // Many forgers in one archive.
  ...Array.from({ length: 20 }, (_, i) =>
    takeoutMail(10 + i, 'Inbox', [
      ...DELIVERED(`spoof${i}@evil.example`),
      `From: "Spoof ${i}" <spoof${i}@evil.example>`,
      'To: Owner Name <owner@example.com>',
      'X-Gmail-Labels: Sent,Important',
    ]),
  ),
].join('');

describeWithDatabase(`a forged Sent label in a Takeout (${importDatabase.target})`, () => {
  let harness: StagingHarness;
  let teardown: () => Promise<void>;
  let dir: string;
  let runId: string;

  beforeAll(async () => {
    ({ harness, teardown } = await createStagingHarness());

    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-spoof-'));
    const file = path.join(dir, 'All mail Including Spam and Trash.mbox');
    fs.writeFileSync(file, MBOX, 'utf8');

    const graphs: Graph[] = [];
    await new GmailFileImporter().fileImport({}, { filename: path.basename(file), fullPath: file }, {
      pipeline: { push: (graph: Graph) => graphs.push(graph) },
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);

    const staged = await harness.writerFor('gmail');
    runId = staged.runId;
    for (const graph of graphs) {
      staged.writer.push(graph);
    }

    await staged.writer.settled();
  });

  afterAll(async () => {
    fs.rmSync(dir, { recursive: true, force: true });
    await teardown();
  });

  it('stages only the mail Google filed as Sent with the sent_label basis', async () => {
    const rows = await harness.dataSource.query<
      Array<{ subject: string; basis: string; direction: string; refused: string | null }>
    >(
      `SELECT metadata ->> 'Subject' AS subject, metadata ->> 'DirectionBasis' AS basis,
              metadata ->> 'Direction' AS direction, metadata ->> 'SentLabelRefused' AS refused
         FROM ci_import.staged_items
        WHERE run_id = $1::uuid`,
      [runId],
    );
    const bySubject = new Map(rows.map((row) => [row.subject, row]));

    expect(rows).toHaveLength(25);
    expect(
      rows
        .filter((row) => row.basis === 'sent_label')
        .map((row) => row.subject)
        .sort(),
    ).toEqual(['mail 1', 'mail 2']);
    expect(bySubject.get('mail 3')).toMatchObject({
      basis: 'delivery_trace',
      direction: 'inbound',
      refused: 'true',
    });
    expect(bySubject.get('mail 5')).toMatchObject({ refused: 'true' });
    expect(bySubject.get('mail 5')?.basis).not.toBe('sent_label');
    expect(rows.filter((row) => row.subject !== 'mail 5' && row.refused === 'true')).toHaveLength(21);
  });

  it("adds only the owner's own Sent addresses to the owner for the run", async () => {
    const sentFrom = await readSentLabelSenders(harness.dataSource, runId);

    expect([...sentFrom].sort()).toEqual(['owner.alias@example.org', 'owner.second@example.org']);

    // What PushStage then decides for each sender's contact card.
    const identity: SelfIdentity = {
      names: ['Owner Name'],
      email: 'owner@example.com',
      emails: sentFrom,
      phones: [],
    };
    const owns = (name: string, email: string) =>
      isOwnerContact(identity, { name, emails: [email], phones: [] }, 'balanced');

    expect(owns('Owner Name', 'owner.alias@example.org')).toBe(true);
    expect(owns('O. N.', 'owner.second@example.org')).toBe(true);
    expect(owns('Eve', 'eve@evil.example')).toBe(false);
    expect(owns('Owner Name', 'mallory@evil.example')).toBe(false);
    expect(owns('Spoof 3', 'spoof3@evil.example')).toBe(false);
  });
});
