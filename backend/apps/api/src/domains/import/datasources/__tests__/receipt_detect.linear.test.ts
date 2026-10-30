import {
  extractReceiptFields,
  RECEIPT_SCAN_CHARS,
  receiptHeaderSignal,
  receiptSignals,
} from '../receipt_detect';

/**
 * The three body patterns as they stood before they were made linear, kept as
 * the reference the new ones must agree with. They backtrack quadratically (the
 * amount and order-id patterns) and cubically (the total), so they only ever see
 * short inputs here.
 */
const REFERENCE = {
  currencyAmount:
    /(?:[$€£¥₹]\s?\d[\d,]*(?:\.\d{2})?)|(?:\b\d[\d,]*\.\d{2}\s?(?:USD|EUR|GBP|CAD|AUD|JPY|INR)\b)/,
  orderId: /order\s*(?:#|no\.?|number|id)\s*[:\s]?\s*([A-Za-z0-9][A-Za-z0-9-]{4,})/i,
  total:
    /(?:order\s+total|grand\s+total|total\s+charged|amount\s+(?:paid|charged|due)|total)\s*[:-]?\s*([$€£¥₹])?\s*([\d,]+\.\d{2})(?:\s*([A-Za-z]{3})(?![A-Za-z]))?/i,
};

const CODES = new Set([
  'USD',
  'EUR',
  'GBP',
  'CAD',
  'AUD',
  'NZD',
  'JPY',
  'INR',
  'CHF',
  'SEK',
  'NOK',
  'DKK',
  'MXN',
  'BRL',
]);
const SYMBOLS: Record<string, string> = { $: 'USD', '€': 'EUR', '£': 'GBP', '¥': 'JPY', '₹': 'INR' };

/** What `extractReceiptFields` read out of a body with the reference patterns. */
function referenceFields(body: string): { orderId?: string; total?: number; currency?: string } {
  const out: { orderId?: string; total?: number; currency?: string } = {};
  const order = REFERENCE.orderId.exec(body);

  if (order) {
    out.orderId = order[1];
  }

  const total = REFERENCE.total.exec(body);

  if (total) {
    const amount = Number(total[2].replace(/,/g, ''));

    if (Number.isFinite(amount)) {
      out.total = amount;
    }

    const code = total[3]?.toUpperCase();
    const currency =
      (code && CODES.has(code) ? code : undefined) ?? (total[1] ? SYMBOLS[total[1]] : undefined);

    if (currency) {
      out.currency = currency;
    }
  }

  return out;
}

function prng(seed: number): () => number {
  let state = seed >>> 0;

  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;

    return state / 2 ** 32;
  };
}

const PIECES = [
  '1',
  '7',
  '0',
  ',',
  ',',
  '.',
  '.5',
  '00',
  ' ',
  '\n',
  '\t',
  '$',
  '€',
  '£',
  ' USD',
  'USD',
  'EUR',
  'usd',
  'a',
  'X',
  '_',
  'total',
  'Total',
  'TOTAL',
  'order',
  'Order',
  'grand',
  'charged',
  'amount',
  'paid',
  'due',
  ':',
  '-',
  '#',
  'no.',
  'number',
  'id',
  'ID',
  'ABC12',
  'ord',
];

function randomBody(next: () => number, pieces: number): string {
  return Array.from({ length: pieces }, () => PIECES[Math.floor(next() * PIECES.length)]).join('');
}

function elapsedMs(run: () => unknown): number {
  const started = process.hrtime.bigint();
  run();

  return Number(process.hrtime.bigint() - started) / 1e6;
}

/**
 * `receiptSignals(...).body` is `amount && structure word`. A leading
 * "Subtotal " always satisfies the structure word and, ending in a space,
 * cannot join a number run, so the flag reports the amount pattern alone.
 */
function amountFound(body: string): boolean {
  return receiptSignals({}, '', `Subtotal ${body}`).body;
}

describe('receipt body patterns', () => {
  it('match exactly what the backtracking versions matched, on generated bodies', () => {
    const next = prng(611_460_223);

    for (let i = 0; i < 20_000; i++) {
      const body = randomBody(next, 1 + Math.floor(next() * 24));

      expect({ body, amount: amountFound(body) }).toEqual({
        body,
        amount: REFERENCE.currencyAmount.test(`Subtotal ${body}`),
      });
      expect({ body, fields: extractReceiptFields({}, body) }).toEqual({
        body,
        fields: referenceFields(body),
      });
    }
  });

  it('still read the receipts the importers see', () => {
    const amazon = [
      'Hello, thanks for your order.',
      'Order #111-2233445-6677889',
      'Items: 2',
      'Order Total: $1,234.56',
      'Billing address: 1 Main St',
    ].join('\n');

    expect(extractReceiptFields({ From: 'Amazon.com <auto-confirm@amazon.com>' }, amazon)).toEqual({
      merchant: 'Amazon.com',
      orderId: '111-2233445-6677889',
      total: 1234.56,
      currency: 'USD',
    });
    expect(extractReceiptFields({}, 'Order ID: MXPQ1234RS\nTotal charged - 49.99 EUR')).toEqual({
      orderId: 'MXPQ1234RS',
      total: 49.99,
      currency: 'EUR',
    });
    expect(amountFound('Coffee,5.00 USD')).toBe(true);
    expect(amountFound('Coffee 1,000,000.00 GBP')).toBe(true);
    expect(amountFound('ref A12,34.50 USD')).toBe(true);
    expect(amountFound('ref A1234.50 USD')).toBe(false);
  });

  it('stay linear on bodies built to make the old patterns backtrack', () => {
    const size = 200_000;
    const hostile = [
      // Digits and commas with no decimal point: quadratic in the amount pattern.
      '1,'.repeat(size / 2),
      Array.from({ length: size / 6 }, (_, i) => String(1000 + (i % 9000))).join(','),
      // A label and then nothing but blank space: cubic in the total, quadratic in the order id.
      `Total${' '.repeat(size)}`,
      `Order total:${'\n '.repeat(size / 2)}`,
      `Order number${' '.repeat(size)}`,
      `order #${'\t'.repeat(size)}:`,
    ];

    for (const body of hostile) {
      // The old patterns took 19 s on 160 KB of the first shape and 3 s on 2,000
      // spaces after "Total". These are bounded by the scan cap and linear, so a
      // few milliseconds; the bound only has to separate the two.
      expect(elapsedMs(() => receiptSignals({ Subject: 'Your receipt' }, undefined, body))).toBeLessThan(500);
      expect(elapsedMs(() => extractReceiptFields({}, body))).toBeLessThan(500);
    }
  });

  it('read only the start of a very long body', () => {
    const late = `${'x'.repeat(RECEIPT_SCAN_CHARS)}\nOrder #ABC12345\nTotal: $9.99`;

    expect(extractReceiptFields({}, late)).toEqual({});
    expect(
      extractReceiptFields({}, `Order #ABC12345\nTotal: $9.99\n${'x'.repeat(RECEIPT_SCAN_CHARS)}`),
    ).toEqual({
      orderId: 'ABC12345',
      total: 9.99,
      currency: 'USD',
    });
  });

  it('read only the start of a very long From or Subject header', () => {
    // RECEIPT_SENDER_LOCAL_RE rescans to the next `@` from every `<shop`: 0.7 s
    // on 40,000 characters of this before the header was capped.
    const from = '<shop'.repeat(40_000);

    expect(elapsedMs(() => receiptHeaderSignal({ From: from, Subject: 'hi' }))).toBeLessThan(500);
    expect(elapsedMs(() => receiptSignals({ From: from }, 'hi', 'Total: $9.99'))).toBeLessThan(500);
    expect(receiptSignals({ From: 'Orders <orders@shop.example>' }, 'hi').sender).toBe(true);
  });
});
