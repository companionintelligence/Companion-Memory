import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { GmailFileImporter } from '../gmail';
import type { DirEntry } from '../registry';
import type { Graph, ImportParams } from '../timeline';

/*
 * Receipt discovery inside the Gmail importer, and the two things it must not
 * break.
 *
 * The rule runs BEFORE `isHumanCorrespondence` and overrides it, because that
 * gate rejects Category Promotions/Updates, `List-Unsubscribe` and `no-reply@`
 * senders — a precise description of how a merchant sends a receipt. So:
 *
 *  1. an order confirmation the gate would have dropped is KEPT, classified
 *     'receipt', and counted in the KEEP ledger — never the drop ledger, which
 *     the run UI renders as the loss report;
 *  2. marketing mail is still dropped, because the override is only as safe as
 *     its false-positive rate;
 *  3. a receipt the gate would have kept ANYWAY keeps its communications home —
 *     the receipt lane only ever adds.
 */

const RECEIPT_BODY = [
  'Thanks for your order.',
  '',
  'Order #114-2233445-6677889',
  'Item ordered: Wireless Mouse',
  'Order Total: $42.50',
].join('\n');

const MBOX =
  // 1) an order confirmation the bulk gate rejects (Promotions + no-reply)
  'From auto-confirm@amazon.com Mon Jan 06 12:00:00 +0000 2025\n' +
  'Date: Mon, 06 Jan 2025 12:00:00 +0000\n' +
  'From: Amazon.com <auto-confirm@amazon.com>\n' +
  'To: Bob <bob@example.com>\n' +
  'Subject: Your Amazon.com order of "Wireless Mouse"\n' +
  'X-Gmail-Labels: Category Promotions\n' +
  'List-Unsubscribe: <mailto:unsub@amazon.com>\n' +
  'Message-ID: <receipt-1@amazon.com>\n' +
  '\n' +
  RECEIPT_BODY +
  '\n' +
  '\n' +
  // 2) pure marketing, same shop-shaped sender and weak subject vocabulary
  'From shop@retailer.example Mon Jan 06 12:01:00 +0000 2025\n' +
  'Date: Mon, 06 Jan 2025 12:01:00 +0000\n' +
  'From: Retailer <shop@retailer.example>\n' +
  'To: Bob <bob@example.com>\n' +
  'Subject: Shop the sale: order by Friday\n' +
  'X-Gmail-Labels: Category Promotions\n' +
  'List-Unsubscribe: <mailto:unsub@retailer.example>\n' +
  'Message-ID: <promo-1@retailer.example>\n' +
  '\n' +
  'Up to 50% off. Shop now.\n' +
  '\n' +
  // 3) a receipt Gmail filed under Category Personal — kept as mail on its own
  //    merits, so it must ALSO stay a communication
  'From receipts@apple.com Mon Jan 06 12:02:00 +0000 2025\n' +
  'Date: Mon, 06 Jan 2025 12:02:00 +0000\n' +
  'From: Apple <receipts@apple.com>\n' +
  'To: Bob <bob@example.com>\n' +
  'Subject: Your receipt from Apple\n' +
  'X-Gmail-Labels: Category Personal\n' +
  'Message-ID: <receipt-2@apple.com>\n' +
  '\n' +
  'Order ID: MXPQ1234RS\nTotal: $9.99\n';

interface Captured {
  graphs: Graph[];
  drops: Record<string, number>;
  keeps: Record<string, number>;
  params: ImportParams;
}

function makeParams(): Captured {
  const graphs: Graph[] = [];
  const drops: Record<string, number> = {};
  const keeps: Record<string, number> = {};
  const params = {
    options: {},
    pipeline: {
      push: (g: Graph) => {
        graphs.push(g);
      },
      drop: (reason: string) => {
        drops[reason] = (drops[reason] ?? 0) + 1;
      },
      keep: (reason: string) => {
        keeps[reason] = (keeps[reason] ?? 0) + 1;
      },
    },
    log: () => {},
  } as unknown as ImportParams;

  return { graphs, drops, keeps, params };
}

function writeMbox(body = MBOX): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-receipts-'));
  const file = path.join(dir, 'takeout.mbox');
  fs.writeFileSync(file, body, 'utf8');

  return { dir, file };
}

async function runImport(file: string, params: ImportParams): Promise<void> {
  await new GmailFileImporter().fileImport(
    {},
    { filename: path.basename(file), fullPath: file } as DirEntry,
    params,
  );
}

describe('Gmail receipt discovery', () => {
  let dir: string;
  let file: string;
  const savedBulk = process.env.CI_GMAIL_INCLUDE_BULK;
  const savedReceipts = process.env.CI_IMPORT_RECEIPTS;

  beforeEach(() => {
    delete process.env.CI_GMAIL_INCLUDE_BULK;
    delete process.env.CI_IMPORT_RECEIPTS;
    ({ dir, file } = writeMbox());
  });

  afterEach(() => {
    for (const [key, saved] of [
      ['CI_GMAIL_INCLUDE_BULK', savedBulk],
      ['CI_IMPORT_RECEIPTS', savedReceipts],
    ] as const) {
      if (saved === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved;
      }
    }

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('rescues an order confirmation the bulk gate would have dropped', async () => {
    const { graphs, params } = makeParams();
    await runImport(file, params);

    const receipts = graphs.filter((g) => g.item?.classification === 'receipt');

    expect(receipts.map((g) => g.item!.metadata?.Subject)).toEqual([
      'Your Amazon.com order of "Wireless Mouse"',
      'Your receipt from Apple',
    ]);
  });

  it('counts the rescue as KEPT, never as a drop', async () => {
    // The drop ledger is the run's loss report. Counting a rescued record there
    // reports a save as a loss — which is exactly what the first version did.
    const { drops, keeps, params } = makeParams();
    await runImport(file, params);

    expect(keeps).toEqual({ receipt_kept_from_bulk: 1 });
    expect(drops).toEqual({ bulk_filtered: 1 });
    expect(drops.receipt_kept_from_bulk).toBeUndefined();
  });

  it('still drops the marketing mail the override could have let in', async () => {
    const { graphs, params } = makeParams();
    await runImport(file, params);

    expect(graphs.some((g) => g.item?.metadata?.Subject === 'Shop the sale: order by Friday')).toBe(false);
  });

  it('writes the receipt facts under the canonical commerce keys', async () => {
    const { graphs, params } = makeParams();
    await runImport(file, params);

    const amazon = graphs.find((g) => g.item?.metadata?.MessageID === 'receipt-1@amazon.com');

    expect(amazon!.item!.metadata).toMatchObject({
      Merchant: 'Amazon.com',
      'Order ID': '114-2233445-6677889',
      Total: 42.5,
      Currency: 'USD',
    });
  });

  it('marks a rescued receipt as NOT correspondence, and a kept one as correspondence', async () => {
    // `HumanCorrespondence` is what stops the receipt lane from REMOVING a
    // message from ci.communications, and from adding tens of thousands of
    // no-reply notifications to it.
    const { graphs, params } = makeParams();
    await runImport(file, params);

    const rescued = graphs.find((g) => g.item?.metadata?.MessageID === 'receipt-1@amazon.com');
    const kept = graphs.find((g) => g.item?.metadata?.MessageID === 'receipt-2@apple.com');

    expect(rescued!.item!.metadata?.HumanCorrespondence).toBeUndefined();
    expect(kept!.item!.metadata?.HumanCorrespondence).toBe(true);
    expect(kept!.item!.metadata?.CommunicationType).toBe('email');
  });

  it('is turned off by CI_IMPORT_RECEIPTS=0, restoring the old behaviour', async () => {
    process.env.CI_IMPORT_RECEIPTS = '0';

    const { graphs, drops, keeps, params } = makeParams();
    await runImport(file, params);

    expect(graphs.some((g) => g.item?.classification === 'receipt')).toBe(false);
    // The Apple one is Category Personal, so it survives as ordinary mail.
    expect(graphs.map((g) => g.item?.classification)).toEqual(['email']);
    expect(drops).toEqual({ bulk_filtered: 2 });
    expect(keeps).toEqual({});
  });

  it('raises the body cap for a receipt so the line items survive the clip', async () => {
    // An itemised order confirmation IS its body; a 4k clip cuts the items and
    // the total off the end of every multi-item order.
    const filler = 'x'.repeat(6000);
    const long =
      'From auto-confirm@amazon.com Mon Jan 06 12:00:00 +0000 2025\n' +
      'Date: Mon, 06 Jan 2025 12:00:00 +0000\n' +
      'From: Amazon.com <auto-confirm@amazon.com>\n' +
      'Subject: Order Confirmation\n' +
      'X-Gmail-Labels: Category Promotions\n' +
      'Message-ID: <long-1@amazon.com>\n' +
      '\n' +
      `${filler}\nOrder Total: $42.50\n`;
    const written = writeMbox(long);

    try {
      const { graphs, params } = makeParams();
      await runImport(written.file, params);

      const text = graphs[0].item!.metadata?.Text as string;

      expect(text.length).toBeGreaterThan(4000);
      expect(text).toContain('Order Total: $42.50');
    } finally {
      fs.rmSync(written.dir, { recursive: true, force: true });
    }
  });

  it('catalogues a receipt PDF as the receipt document, not an anonymous file', async () => {
    const mime = [
      'From auto-confirm@shop.example Mon Jan 06 12:00:00 +0000 2025',
      'Date: Mon, 06 Jan 2025 12:00:00 +0000',
      'From: Shop <auto-confirm@shop.example>',
      'Subject: Order Confirmation',
      'X-Gmail-Labels: Category Promotions',
      'Message-ID: <pdf-1@shop.example>',
      'Content-Type: multipart/mixed; boundary="b1"',
      '',
      '--b1',
      'Content-Type: text/plain',
      '',
      'Order Total: $42.50',
      '--b1',
      'Content-Type: application/pdf; name="invoice.pdf"',
      'Content-Disposition: attachment; filename="invoice.pdf"',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from('%PDF-1.4 fake').toString('base64'),
      '--b1--',
      '',
    ].join('\n');
    const written = writeMbox(mime);

    try {
      const { graphs, params } = makeParams();
      await runImport(written.file, params);

      const attachments = graphs[0].item!.metadata?.MediaAttachments as Array<{ type: string }>;

      expect(attachments).toHaveLength(1);
      expect(attachments[0].type).toBe('receipt_document');
    } finally {
      fs.rmSync(written.dir, { recursive: true, force: true });
    }
  });

  it('keeps a Message-ID-less id stable across the readableBody change', async () => {
    // IDEMPOTENCY, not formatting. A message with no Message-ID falls back to
    // sha1 over `headersRaw + '\0' + body`, and `body` used to be
    // `mime.textBody || mime.htmlBody` — RAW markup for an HTML-only message.
    // Reading the body through `readableBody` (which flattens that markup)
    // changed what a reader SEES; hashing the flattened form would also change
    // the record's IDENTITY, so every such message re-imports as a duplicate of
    // the one a previous import already staged. There is no migration behind
    // that, so the id must keep hashing the pre-flattening source.
    const headers = [
      'From no-reply@shop.example Mon Jan 06 12:03:00 +0000 2025',
      'Date: Mon, 06 Jan 2025 12:03:00 +0000',
      'From: Shop <no-reply@shop.example>',
      'To: Bob <bob@example.com>',
      'Subject: Your receipt from Shop',
      'Content-Type: text/html; charset=utf-8',
    ];
    const html = '<html><body><table><tr><td>Order Total:</td><td>$42.50</td></tr></table></body></html>';
    const written = writeMbox([...headers, '', html, ''].join('\n'));

    try {
      const { graphs, params } = makeParams();
      await runImport(written.file, params);

      // The id the PREVIOUS importer produced, recomputed here from the same
      // inputs it used: the raw header block and the UNFLATTENED html body,
      // exactly as `parseMime` hands it back.
      const legacy = `gmail:nomid:${crypto
        .createHash('sha1')
        .update(`${headers.join('\n')}\0${html}\n`)
        .digest('hex')}`;

      expect(graphs).toHaveLength(1);
      expect(graphs[0].item!.id).toBe(legacy);
      // …and the body a reader gets IS flattened, which is the whole point of
      // the change the id had to survive.
      expect(graphs[0].item!.metadata?.Text).toBe('Order Total:\t$42.50');
    } finally {
      fs.rmSync(written.dir, { recursive: true, force: true });
    }
  });
});
