import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { EmailFileImporter } from '../email';
import {
  emailDirection,
  emailDirectionBasis,
  hasSentLabel,
  isDraft,
  keepTrustedGmailLabels,
  trustedGmailLabels,
} from '../email_direction';
import { GmailFileImporter } from '../gmail';
import type { DirEntry } from '../registry';
import type { Graph, ImportParams } from '../timeline';

import type { EmittedGraph, TestPipeline } from './support/emitted';

describe('email_direction helpers', () => {
  it('outbound when the Gmail Sent label is present', () => {
    expect(emailDirection({ 'X-Gmail-Labels': 'Category Personal,Sent' })).toBe('outbound');
  });

  it('inbound when any receiving-MTA delivery-trace header is present', () => {
    for (const h of [
      'Return-Path',
      'Delivered-To',
      'Authentication-Results',
      'Received-SPF',
      'X-Apparently-To',
    ]) {
      expect(emailDirection({ [h]: 'x', From: 'them@x.io' })).toBe('inbound');
    }

    // Header casing varies across providers; the lookup must be case-insensitive.
    expect(emailDirection({ 'RETURN-PATH': '<them@x.io>' })).toBe('inbound');
  });

  it('outbound when no delivery-trace headers exist (sent copies never pass final delivery)', () => {
    expect(emailDirection({ From: 'Me <me@x.io>', To: 'them@x.io', Subject: 'hi' })).toBe('outbound');
    // DKIM alone is NOT inbound evidence — providers sign outbound mail at submission.
    expect(emailDirection({ From: 'me@x.io', 'DKIM-Signature': 'v=1; d=x.io' })).toBe('outbound');
  });

  it('names what the direction was read from, so the push can tell a Sent label from missing headers', () => {
    expect(emailDirectionBasis({ 'X-Gmail-Labels': 'Sent', 'Return-Path': '<me@example.com>' })).toBe(
      'sent_label',
    );
    expect(emailDirectionBasis({ 'Return-Path': '<alice@example.com>' })).toBe('delivery_trace');
    expect(emailDirectionBasis({ From: 'Alice <alice@example.com>' })).toBe('no_delivery_trace');
  });

  it('hasSentLabel matches the Sent label among comma-separated labels', () => {
    expect(hasSentLabel('Inbox, Sent, Important')).toBe(true);
    expect(hasSentLabel('Inbox, Important')).toBe(false);
    expect(hasSentLabel(undefined)).toBe(false);
  });

  it('isDraft detects Thunderbird and Gmail draft markers', () => {
    expect(isDraft({ 'X-Mozilla-Draft-Info': 'internal/draft; vcard=0' })).toBe(true);
    expect(isDraft({ 'X-Gmail-Labels': 'Draft' })).toBe(true);
    expect(isDraft({ 'X-Gmail-Labels': 'Drafts, Important' })).toBe(true);
    expect(isDraft({ 'X-Gmail-Labels': 'Category Personal', 'Return-Path': '<a@x.io>' })).toBe(false);
    expect(isDraft({ Subject: 'hi' })).toBe(false);
  });
});

function tmp(name: string, content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-direction-'));
  const f = path.join(dir, name);
  fs.writeFileSync(f, content, 'utf8');

  return f;
}

describe('email datasource surfaces Direction + From/To in metadata', () => {
  it('email.ts marks a delivered message inbound and records From/To', async () => {
    const eml = tmp(
      'in.eml',
      'Return-Path: <alice@example.com>\nAuthentication-Results: mx.example.com; spf=pass\nSubject: Hi\nDate: Fri, 02 Jan 2025 10:00:00 -0000\nFrom: Alice <alice@example.com>\nTo: Bob <bob@example.com>\n\nbody',
    );
    const fi = new EmailFileImporter();
    const pipeline: EmittedGraph[] = [];
    await fi.fileImport({}, { filename: path.basename(eml), fullPath: eml }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);
    const item = pipeline.find((p) => p.item)!.item;
    expect(item.metadata.Direction).toBe('inbound');
    expect(item.metadata.DirectionBasis).toBe('delivery_trace');
    expect(item.metadata.From).toContain('alice@example.com');
    expect(item.metadata.To).toContain('bob@example.com');
  });

  it('email.ts marks a submission-filed copy (no delivery-trace headers) outbound', async () => {
    const eml = tmp(
      'out.eml',
      'Subject: Hi\nDate: Fri, 02 Jan 2025 10:00:00 -0000\nFrom: Me <me@example.com>\nTo: Bob <bob@example.com>\nX-Mailer: Thunderbird\n\nbody',
    );
    const fi = new EmailFileImporter();
    const pipeline: EmittedGraph[] = [];
    await fi.fileImport({}, { filename: path.basename(eml), fullPath: eml }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);
    const item = pipeline.find((p) => p.item)!.item;
    expect(item.metadata.Direction).toBe('outbound');
    expect(item.metadata.DirectionBasis).toBe('no_delivery_trace');
  });

  it('email.ts skips Thunderbird drafts entirely', async () => {
    const eml = tmp(
      'draft.eml',
      'X-Mozilla-Draft-Info: internal/draft; vcard=0\nSubject: Unsent thoughts\nDate: Fri, 02 Jan 2025 10:00:00 -0000\nFrom: Me <me@example.com>\nTo: Bob <bob@example.com>\n\nbody',
    );
    const fi = new EmailFileImporter();
    const pipeline: EmittedGraph[] = [];
    const drops: string[] = [];
    (pipeline as TestPipeline).drop = (r: string) => drops.push(r);
    await fi.fileImport({}, { filename: path.basename(eml), fullPath: eml }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);
    expect(pipeline.filter((p) => p.item).length).toBe(0);
    expect(drops).toContain('draft');
  });

  it('gmail.ts derives outbound from the X-Gmail-Labels Sent label', async () => {
    const mbox = tmp(
      'sent.mbox',
      'From me@example.com Sat Jan 01 00:00:00 2024\nDate: Sat, 01 Jan 2024 00:00:00 +0000\nFrom: Me <me@example.com>\nTo: Friend <friend@example.com>\nX-Gmail-Labels: Sent\nMessage-ID: <s1@mx.example.com>\nSubject: Outgoing\n\nhello\n',
    );
    const imp = new GmailFileImporter();
    const collected: EmittedGraph[] = [];
    await imp.fileImport(
      undefined,
      { fullPath: mbox } as DirEntry,
      {
        timeframe: undefined,
        pipeline: { push: (g: Graph) => collected.push(g as EmittedGraph) },
      } as unknown as ImportParams,
    );
    const item = collected.find((c) => c.item)!.item;
    expect(item.metadata.Direction).toBe('outbound');
    expect(item.metadata.To).toContain('friend@example.com');
  });

  it('gmail.ts derives inbound for delivered mail (Category Personal + delivery trace)', async () => {
    const mbox = tmp(
      'recv.mbox',
      'From friend@example.com Sat Jan 01 00:00:00 2024\nReturn-Path: <friend@example.com>\nDelivered-To: me@example.com\nDate: Sat, 01 Jan 2024 00:00:00 +0000\nFrom: Friend <friend@example.com>\nTo: Me <me@example.com>\nX-Gmail-Labels: Category Personal\nMessage-ID: <r1@mx.example.com>\nSubject: Incoming\n\nhello\n',
    );
    const imp = new GmailFileImporter();
    const collected: EmittedGraph[] = [];
    await imp.fileImport(
      undefined,
      { fullPath: mbox } as DirEntry,
      {
        timeframe: undefined,
        pipeline: { push: (g: Graph) => collected.push(g as EmittedGraph) },
      } as unknown as ImportParams,
    );
    const item = collected.find((c) => c.item)!.item;
    expect(item.metadata.Direction).toBe('inbound');
  });

  it('gmail.ts skips messages labeled Draft', async () => {
    const mbox = tmp(
      'draft.mbox',
      'From me@example.com Sat Jan 01 00:00:00 2024\nDate: Sat, 01 Jan 2024 00:00:00 +0000\nFrom: Me <me@example.com>\nTo: Friend <friend@example.com>\nX-Gmail-Labels: Draft\nMessage-ID: <d1@mx.example.com>\nSubject: Never sent\n\nhello\n',
    );
    const imp = new GmailFileImporter();
    const collected: EmittedGraph[] = [];
    const drops: string[] = [];
    await imp.fileImport(
      undefined,
      { fullPath: mbox } as DirEntry,
      {
        timeframe: undefined,
        pipeline: {
          push: (g: Graph) => collected.push(g as EmittedGraph),
          drop: (r: string) => drops.push(r),
        },
      } as unknown as ImportParams,
    );
    expect(collected.filter((c) => c.item).length).toBe(0);
    expect(drops).toContain('draft');
  });
});

/**
 * `X-Gmail-Labels` is a header like any other, so a sender can write one. Only
 * the one Takeout prepends is Google's: the first, above every transport
 * header. A forged `Sent` used to file a stranger's mail as the owner's, and
 * the push then took the stranger's address for one of the owner's.
 */
describe('only the X-Gmail-Labels Google wrote is trusted', () => {
  const RECEIVED =
    'Received: from mail.evil.example (mail.evil.example [203.0.113.5]) by mx.google.com with ESMTPS; Tue, 01 Sep 2026 10:00:01 +0000';

  it('trusts the label Takeout prepends above the message, Sent included', () => {
    expect(
      trustedGmailLabels(
        [
          'X-GM-THRID: 1',
          'X-Gmail-Labels: Sent',
          'From: Me <me.alias@example.org>',
          'To: f@example.net',
        ].join('\n'),
      ),
    ).toEqual({ labels: 'Sent', sentLabelRefused: false });
    // Mail the owner sent to themself: Sent and Inbox, then the delivery headers.
    expect(
      trustedGmailLabels(
        ['X-GM-THRID: 2', 'X-Gmail-Labels: Inbox,Sent', 'Delivered-To: me@example.com', RECEIVED].join('\n'),
      ),
    ).toEqual({ labels: 'Inbox,Sent', sentLabelRefused: false });
  });

  it("refuses a Sent label after Google's own header (a Takeout of a forged mail)", () => {
    const raw = [
      'X-GM-THRID: 3',
      'X-Gmail-Labels: Inbox,Unread',
      'Delivered-To: me@example.com',
      RECEIVED,
      'From: "Eve" <eve@evil.example>',
      'X-Gmail-Labels: Sent',
    ].join('\n');

    expect(trustedGmailLabels(raw)).toEqual({ labels: 'Inbox,Unread', sentLabelRefused: true });
  });

  it('refuses a lone Sent label written below a Received header', () => {
    const raw = [RECEIVED, 'From: "Mallory" <mallory@evil.example>', 'X-Gmail-Labels: Sent'].join('\n');

    expect(trustedGmailLabels(raw)).toEqual({ labels: undefined, sentLabelRefused: true });
  });

  it('decodes the value the way the importer parses it', () => {
    expect(
      trustedGmailLabels('X-Gmail-Labels: =?UTF-8?Q?Sent?=', (v) => v.replace('=?UTF-8?Q?Sent?=', 'Sent')),
    ).toEqual({
      labels: 'Sent',
      sentLabelRefused: false,
    });
  });

  it('leaves the parsed map with the trusted value only, whatever casing the duplicates used', () => {
    const map: Record<string, string> = {
      'X-Gmail-Labels': 'Inbox,Unread, Sent',
      'x-gmail-labels': 'Sent',
      From: 'Eve <eve@evil.example>',
    };
    const raw = [
      'X-Gmail-Labels: Inbox,Unread',
      RECEIVED,
      'X-Gmail-Labels: Sent',
      'x-gmail-labels: Sent',
    ].join('\n');

    expect(keepTrustedGmailLabels(map, raw).sentLabelRefused).toBe(true);
    expect(map).toEqual({ 'X-Gmail-Labels': 'Inbox,Unread', From: 'Eve <eve@evil.example>' });
    expect(emailDirectionBasis(map)).toBe('no_delivery_trace');
  });
});

describe('the importers never read a forged Sent label', () => {
  async function gmailItems(mbox: string) {
    const collected: EmittedGraph[] = [];
    await new GmailFileImporter().fileImport(
      undefined,
      { fullPath: tmp('takeout.mbox', mbox) } as DirEntry,
      {
        timeframe: undefined,
        pipeline: { push: (g: Graph) => collected.push(g as EmittedGraph) },
      } as unknown as ImportParams,
    );

    return collected.filter((c) => c.item).map((c) => c.item.metadata);
  }

  const takeoutMail = (n: number, labels: string, from: string, extra = '') =>
    `From 1700000000${n}@xxx Tue Sep 01 10:00:00 +0000 2026\n` +
    `X-GM-THRID: 17000000${n}\n` +
    `X-Gmail-Labels: ${labels}\n` +
    `Delivered-To: me@example.com\n` +
    `Received: by 2002:a05:1234 with SMTP id ${n}; Tue, 01 Sep 2026 10:00:01 +0000\n` +
    `Return-Path: <${from.replace(/.*<|>.*/g, '')}>\n` +
    `Date: Tue, 01 Sep 2026 10:00:00 +0000\n` +
    `From: ${from}\n` +
    `To: Me <me@example.com>\n` +
    `Message-ID: <spoof-${n}@example.test>\n` +
    `Subject: mail ${n}\n` +
    extra +
    `\nbody ${n}\n\n`;

  it("gmail.ts: Google's Inbox label wins over a forged Sent header later in the mail", async () => {
    const [meta] = await gmailItems(
      takeoutMail(1, 'Inbox,Unread', '"Eve" <eve@evil.example>', 'X-Gmail-Labels: Sent\n'),
    );

    expect(meta.DirectionBasis).toBe('delivery_trace');
    expect(meta.Direction).toBe('inbound');
    expect(meta.SentLabelRefused).toBe(true);
  });

  it('gmail.ts: many forged mails in one Takeout are all inbound, none filed as Sent', async () => {
    const mbox = Array.from({ length: 25 }, (_, i) =>
      takeoutMail(
        i + 10,
        'Inbox',
        `"Spoof ${i}" <spoof${i}@evil.example>`,
        'X-Gmail-Labels: Sent,Important\n',
      ),
    ).join('');
    const metas = await gmailItems(mbox);

    expect(metas).toHaveLength(25);
    expect(metas.filter((m) => m.DirectionBasis === 'sent_label')).toHaveLength(0);
    expect(metas.every((m) => m.Direction === 'inbound' && m.SentLabelRefused === true)).toBe(true);
  });

  it("gmail.ts: the owner's own Sent mail from an alias keeps its Sent label", async () => {
    const mbox =
      'From 1@xxx Tue Sep 01 10:00:00 +0000 2026\nX-GM-THRID: 1\nX-Gmail-Labels: Sent\n' +
      'Date: Tue, 01 Sep 2026 10:00:00 +0000\nFrom: "Me" <me.alias@example.org>\nTo: Fran <fran@example.net>\n' +
      'Message-ID: <own-1@example.test>\nSubject: from my alias\n\nhello\n';
    const [meta] = await gmailItems(mbox);

    expect(meta.DirectionBasis).toBe('sent_label');
    expect(meta.Direction).toBe('outbound');
    expect(meta.SentLabelRefused).toBeUndefined();
  });

  it('email.ts: a lone Sent label below the Received headers of a delivered mail is refused', async () => {
    const eml = tmp(
      'forged.eml',
      'Received: from mail.evil.example by mx.example.com with ESMTP; Tue, 01 Sep 2026 10:00:01 +0000\n' +
        'Date: Tue, 01 Sep 2026 10:00:00 +0000\nFrom: "Mallory" <mallory@evil.example>\nTo: Me <me@example.com>\n' +
        'Message-ID: <forged-1@example.test>\nSubject: forged\nX-Gmail-Labels: Sent\n\nbody',
    );
    const pipeline: EmittedGraph[] = [];
    await new EmailFileImporter().fileImport({}, { filename: path.basename(eml), fullPath: eml }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);
    const item = pipeline.find((p) => p.item)!.item;

    expect(item.metadata.DirectionBasis).not.toBe('sent_label');
    expect(item.metadata.SentLabelRefused).toBe(true);
  });
});
