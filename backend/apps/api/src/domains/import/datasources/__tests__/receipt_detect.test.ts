import { htmlToText, readableBody } from '../email_mime';
import {
  extractReceiptFields,
  isLikelyReceipt,
  merchantFromSender,
  receiptHeaderSignal,
  receiptImportEnabled,
  receiptSignals,
} from '../receipt_detect';

/**
 * Receipt discovery, and the false-positive wall it has to stay behind.
 *
 * The rule exists because order confirmations arrive in exactly the shape
 * `gmail.ts#isHumanCorrespondence` rejects — Category Promotions/Updates,
 * `List-Unsubscribe`, `no-reply@` — so the richest commerce source in a mailbox
 * was landing in the drop ledger.
 *
 * The hazard is the opposite one, and it is worse: this rule OVERRIDES the bulk
 * gate, so anything it admits by mistake is a Promotions tab imported wholesale.
 * The first version let `weak subject + sender` through with no body evidence
 * and admitted 6 of the 8 marketing samples below. Every one of them stays in
 * this file as a negative case.
 */

const MARKETING: Array<{ subject: string; from: string; body: string }> = [
  {
    subject: 'Shop the sale: order by Friday',
    from: 'shop@retailer.example',
    body: 'Up to 50% off. Shop now.',
  },
  {
    subject: 'New arrivals you can purchase today',
    from: 'news@apple.com',
    body: 'See what is new this season.',
  },
  { subject: 'Ordering made easy', from: 'hello@retailer.example', body: 'One tap and it is on the way.' },
  { subject: 'Your purchases, rewarded', from: 'rewards@target.com', body: 'Earn points on everything.' },
  { subject: 'Free shipping this weekend', from: 'store@bestbuy.com', body: 'No minimum. Ends Sunday.' },
  { subject: 'Get tracking on every order', from: 'orders@retailer.example', body: 'Download the app.' },
  { subject: 'No chargeback hassles', from: 'billing@retailer.example', body: 'Switch to our card.' },
  {
    subject: 'Subscription renewals made simple',
    from: 'shop@retailer.example',
    body: 'Manage everything in one place.',
  },
];

/** A real order confirmation, in the shape a merchant actually sends one. */
const RECEIPT_BODY = [
  'Thanks for shopping with us.',
  'Order #114-2233445-6677889',
  'Item ordered: Wireless Mouse',
  'Order Total: $42.50',
].join('\n');

describe('isLikelyReceipt', () => {
  it('admits an unambiguous subject with no body at all', () => {
    // The ONLY route that skips the body: no marketing campaign is titled
    // "Your receipt from …".
    expect(isLikelyReceipt({ From: 'no-reply@apple.com', Subject: 'Your receipt from Apple' })).toBe(true);
    expect(isLikelyReceipt({ From: 'x@y.example', Subject: 'Invoice #4417' })).toBe(true);
    expect(isLikelyReceipt({ From: 'x@y.example', Subject: 'Order Confirmation' })).toBe(true);
  });

  it('admits a weak subject once the body corroborates it', () => {
    expect(
      isLikelyReceipt({ From: 'auto-confirm@amazon.com', Subject: 'Your order' }, undefined, RECEIPT_BODY),
    ).toBe(true);
  });

  it('admits a transactional sender once the body corroborates it', () => {
    expect(
      isLikelyReceipt(
        { From: 'orders@retailer.example', Subject: 'A note from us' },
        undefined,
        RECEIPT_BODY,
      ),
    ).toBe(true);
  });

  it.each(MARKETING)('refuses marketing mail: $subject', ({ subject, from, body }) => {
    expect(isLikelyReceipt({ From: from, Subject: subject }, undefined, body)).toBe(false);
  });

  it('refuses a weak subject plus a transactional sender with no body evidence', () => {
    // This exact combination is what the first version admitted. A message with
    // no total, no order number and no amount is not a receipt no matter who
    // sent it.
    expect(
      isLikelyReceipt(
        { From: 'shop@retailer.example', Subject: 'Your order is waiting!' },
        undefined,
        'Come back and finish checking out.',
      ),
    ).toBe(false);
  });

  it('refuses a body with only a price, or only a structure word', () => {
    // Every promotion quotes a price, and "total" appears in ordinary prose.
    const headers = { From: 'orders@retailer.example', Subject: 'Your order' };

    expect(isLikelyReceipt(headers, undefined, 'Just $19.99 today only!')).toBe(false);
    expect(isLikelyReceipt(headers, undefined, 'Check your order status online.')).toBe(false);
  });

  it('anchors the weak subject pattern on both sides', () => {
    // With only a leading \b these fired on the Promotions tab's own
    // vocabulary.
    const s = (subject: string) => receiptSignals({ From: 'a@b.example', Subject: subject }).weakSubject;

    expect(s('Ordering made easy')).toBe(false);
    expect(s('Your purchases, rewarded')).toBe(false);
    expect(s('No chargeback hassles')).toBe(false);
    // …while the real inflections still match.
    expect(s('Your order')).toBe(true);
    expect(s('Subscription renewal')).toBe(true);
  });

  it('reads headers case-insensitively', () => {
    expect(isLikelyReceipt({ subject: 'Your receipt from Apple', from: 'x@y.example' })).toBe(true);
  });
});

describe('receiptHeaderSignal', () => {
  it('is the cheap gate: none means the body is not worth parsing', () => {
    expect(receiptHeaderSignal({ From: 'a@b.example', Subject: 'Lunch tomorrow?' })).toBe('none');
    expect(receiptHeaderSignal({ From: 'a@b.example', Subject: 'Your order' })).toBe('weak');
    expect(receiptHeaderSignal({ From: 'orders@shop.example', Subject: 'Hello' })).toBe('weak');
    expect(receiptHeaderSignal({ From: 'a@b.example', Subject: 'Order Confirmation' })).toBe('strong');
  });

  it('never returns none for anything isLikelyReceipt could admit', () => {
    // The two are used together (gmail.ts): the header verdict gates the body
    // parse, so a message the full rule would keep must never be short-circuited
    // here.
    const admitted = [
      { From: 'auto-confirm@amazon.com', Subject: 'Your order' },
      { From: 'orders@retailer.example', Subject: 'A note from us' },
      { From: 'x@y.example', Subject: 'Invoice #4417' },
    ];

    for (const headers of admitted) {
      expect(receiptHeaderSignal(headers)).not.toBe('none');
    }
  });
});

describe('receiptImportEnabled', () => {
  it('defaults ON', () => {
    expect(receiptImportEnabled({})).toBe(true);
    expect(receiptImportEnabled({ CI_IMPORT_RECEIPTS: '' })).toBe(true);
  });

  it('is turned off by the falsey spellings', () => {
    for (const raw of ['0', 'false', 'no', 'off', 'OFF']) {
      expect(receiptImportEnabled({ CI_IMPORT_RECEIPTS: raw })).toBe(false);
    }
  });
});

describe('extractReceiptFields', () => {
  it('reads merchant, order id, total and currency', () => {
    expect(extractReceiptFields({ From: 'Amazon.com <auto-confirm@amazon.com>' }, RECEIPT_BODY)).toEqual({
      merchant: 'Amazon.com',
      orderId: '114-2233445-6677889',
      total: 42.5,
      currency: 'USD',
    });
  });

  it('never mistakes a following word for a currency code', () => {
    // Without the whole-word + real-code check, "$1,234.56\n\nOrder #…" hands
    // back "ORD" as the currency.
    const fields = extractReceiptFields({ From: 'x@y.example' }, 'Total: $1,234.56\n\nOrder #ABC12345');

    expect(fields.total).toBe(1234.56);
    expect(fields.currency).toBe('USD');
  });

  it('falls back to the subject for an order id the body does not carry', () => {
    expect(
      extractReceiptFields({ From: 'x@y.example', Subject: 'Order #114-2233445-6677889 shipped' }, 'Hello'),
    ).toMatchObject({ orderId: '114-2233445-6677889' });
  });

  it('states nothing it cannot read', () => {
    expect(extractReceiptFields({ From: 'x@y.example' }, 'Hello')).toEqual({ merchant: 'y' });
  });
});

describe('merchantFromSender', () => {
  it('prefers the display name', () => {
    expect(merchantFromSender('"Amazon.com" <auto-confirm@amazon.com>')).toBe('Amazon.com');
  });

  it('falls back to the registrable domain label', () => {
    expect(merchantFromSender('orders@store.example.com')).toBe('example');
    // Stepping back over a generic second level: `store.co.uk` → store, not co,
    // and certainly not uk.
    expect(merchantFromSender('orders@store.co.uk')).toBe('store');
  });

  it('answers undefined for nothing at all', () => {
    expect(merchantFromSender('')).toBeUndefined();
  });
});

describe('htmlToText (the body an HTML-only receipt actually has)', () => {
  it('keeps a label next to its amount across table cells', () => {
    const text = htmlToText('<table><tr><td>Order Total</td><td>$42.50</td></tr></table>');

    expect(text).toBe('Order Total\t$42.50');
    // …and that is what makes the body signal see the receipt at all.
    expect(
      isLikelyReceipt(
        { From: 'orders@x.example', Subject: 'Your order' },
        undefined,
        `Order #123456\n${text}`,
      ),
    ).toBe(true);
  });

  it('drops script and style WITH their contents', () => {
    expect(htmlToText('<style>.a{color:red}</style><p>Hi</p><script>x=1</script>')).toBe('Hi');
  });

  it('decodes the entities real mail uses', () => {
    expect(htmlToText('<p>Tom &amp; Jerry&#39;s&nbsp;bill &#x2014; paid</p>')).toBe(
      "Tom & Jerry's bill — paid",
    );
  });

  it('survives an out-of-range numeric entity instead of throwing', () => {
    // Per the HTML5 spec, a numeric character reference beyond the last valid
    // code point (0x10FFFF) is replaced with U+FFFD, not silently dropped.
    expect(htmlToText('<p>a&#1114112;b</p>')).toBe('a�b');
  });

  it('decodes the full HTML5 named-entity table, not a hand-picked few', () => {
    // &fnof; (florin, U+0192) is a real HTML5 entity outside the six the old
    // hand-rolled decoder here recognized (amp/lt/gt/quot/apos/nbsp).
    expect(htmlToText('<p>&fnof;</p>')).toBe('ƒ');
  });

  it('is empty for empty input', () => {
    expect(htmlToText(undefined)).toBe('');
    expect(htmlToText('')).toBe('');
  });
});

describe('readableBody', () => {
  it('prefers the text/plain part the sender provided', () => {
    expect(readableBody({ textBody: 'plain', htmlBody: '<p>html</p>', attachments: [] })).toBe('plain');
  });

  it('flattens an HTML-only body rather than handing back markup', () => {
    expect(readableBody({ htmlBody: '<p>Order Total: $9.00</p>', attachments: [] })).toBe(
      'Order Total: $9.00',
    );
  });
});
