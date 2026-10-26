import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { EmailFileImporter } from '../email';
import { emailDirection, emailDirectionBasis, hasSentLabel, isDraft } from '../email_direction';
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
