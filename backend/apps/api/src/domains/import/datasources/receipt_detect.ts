/*
 * Receipt discovery for mail archives.
 *
 * THE PROBLEM. Order confirmations, receipts and invoices arrive in exactly the
 * shape the mail importers reject. `gmail.ts#isHumanCorrespondence` drops
 * Gmail's "Category Promotions"/"Category Updates", anything carrying
 * `List-Unsubscribe` or `Precedence: bulk`, and every `no-reply@` sender —
 * which is a precise description of how a merchant sends a receipt. So the
 * single richest commerce source in a personal archive lands in the drop ledger,
 * and the purchase never reaches `ci.*` at all.
 *
 * THE RULE. A message must show POSITIVE receipt evidence, not merely be
 * bulk-ish. Three independent signal families:
 *
 *   subject   the strongest single signal, split in two: an UNAMBIGUOUS phrase
 *             ("order confirmation", "your receipt", "invoice #1234") is enough
 *             on its own; a WEAK one ("your order", "shipped", "purchase") is
 *             the vocabulary of marketing mail too, and needs the BODY to
 *             corroborate it — a transactional-looking sender does not, since
 *             marketing goes out from shop@/store@/news@ as readily as a
 *             receipt does.
 *   sender    a transactional mailbox (orders@, receipts@, billing@,
 *             auto-confirm@) or a known commerce domain.
 *   body      a currency amount AND a receipt structure word (total, subtotal,
 *             order #). Either alone is worthless — every promotion quotes a
 *             price, and "total" appears in ordinary prose.
 *
 * Requiring corroboration for the weak forms is what keeps this from admitting
 * a mailbox's entire Promotions tab: the volume this adds is bounded by
 * messages that both LOOK like a receipt and CONTAIN one. The first version of
 * this rule let `weak subject + sender` through with no body evidence and
 * admitted 6 of 8 pure-marketing samples; see {@link isLikelyReceipt}.
 *
 * Dependency-free by design — it runs inside the mbox parse loop, once per
 * message, over strings the parser already holds.
 */

/** How strong the header-only (cheap) evidence is. */
export type ReceiptHeaderSignal = 'strong' | 'weak' | 'none';

/**
 * Subject phrases that only a real transactional message uses. A match here is
 * sufficient on its own — no marketing campaign is titled "Your receipt from …"
 * or "Invoice #4417".
 */
const STRONG_SUBJECT_RE = new RegExp(
  [
    'order\\s+confirmation',
    'confirmation\\s+of\\s+your\\s+order',
    'your\\s+receipt',
    'receipt\\s+(?:for|from)\\b',
    'payment\\s+receipt',
    'invoice\\s*#',
    'invoice\\s+(?:for|from)\\b',
    'purchase\\s+confirmation',
    'thanks?\\s+(?:you\\s+)?for\\s+your\\s+(?:order|purchase|payment)',
    'order\\s*#\\s*\\w',
    'your\\s+order\\s+(?:has\\s+)?(?:is\\s+)?(?:been\\s+)?(?:confirmed|shipped|delivered|on\\s+its\\s+way)',
  ].join('|'),
  'i',
);

/**
 * Subject vocabulary that a receipt shares with marketing mail ("Your order is
 * waiting!"). Needs BODY evidence to count — see {@link isLikelyReceipt}.
 *
 * Anchored on BOTH sides. With only a leading `\b` it fired on "Ordering made
 * easy", "purchases", and "chargeback" — the vocabulary of the Promotions tab,
 * which is exactly the mail this rule must not admit. `subscription renew`
 * keeps its own suffix group because the phrase is nearly always inflected
 * ("subscription renewal", "subscription renews").
 */
const WEAK_SUBJECT_RE =
  /\b(order|receipt|invoice|purchase|shipped|shipping\s+confirmation|has\s+shipped|tracking|billed|charged|subscription\s+renew(?:al|als|ed|s)?)\b/i;

/** Transactional mailbox local-parts — what a merchant actually sends receipts from. */
const RECEIPT_SENDER_LOCAL_RE =
  /(?:^|[<\s"'])(?:orders?|order-?update|order-?confirm(?:ation)?|auto-?confirm|receipts?|invoices?|billing|payments?|store|shop|purchase|ship-?confirm)[._+-]?[^@\s]*@/i;

/**
 * Domains whose mail is transactional often enough that the sender alone counts
 * as one signal (never as proof — it still needs a subject or body signal).
 * Deliberately a short list of commerce platforms rather than an attempt at a
 * merchant directory: the subject/body signals do the real work.
 */
const RECEIPT_SENDER_DOMAIN_RE =
  /@(?:[a-z0-9-]+\.)*(?:amazon\.[a-z.]+|apple\.com|paypal\.[a-z.]+|ebay\.[a-z.]+|etsy\.com|shopify\.com|squareup\.com|stripe\.com|uber\.com|ubereats\.com|lyft\.com|doordash\.com|grubhub\.com|instacart\.com|target\.com|walmart\.com|bestbuy\.com|newegg\.com|steampowered\.com|gog\.com|humblebundle\.com|bandcamp\.com|google\.com|itunes\.com|booking\.com|airbnb\.com)\b/i;

/** A money amount: a symbol-prefixed or code-suffixed decimal. */
const CURRENCY_AMOUNT_RE =
  /(?:[$€£¥₹]\s?\d[\d,]*(?:\.\d{2})?)|(?:\b\d[\d,]*\.\d{2}\s?(?:USD|EUR|GBP|CAD|AUD|JPY|INR)\b)/;

/** Structure words that make a page of numbers a receipt. */
const RECEIPT_BODY_WORD_RE =
  /\b(?:order\s*(?:#|no\.?|number|id)|order\s+total|grand\s+total|sub-?total|total\s+charged|amount\s+(?:paid|charged|due)|items?\s+ordered|billing\s+address|payment\s+method)\b/i;

/** The signals a message shows, for logging and for tests that need the reason. */
export interface ReceiptSignals {
  strongSubject: boolean;
  weakSubject: boolean;
  sender: boolean;
  body: boolean;
}

/** Case-insensitive header read (mail header names are not case-stable). */
function header(headers: Record<string, string> | undefined, name: string): string {
  if (!headers) {
    return '';
  }

  const direct = headers[name];

  if (direct) {
    return direct;
  }

  const lower = name.toLowerCase();

  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) {
      return headers[key] ?? '';
    }
  }

  return '';
}

/**
 * The cheap, header-only verdict. Called BEFORE the MIME body is parsed so a
 * multi-GB mbox does not pay a body parse per message just to ask the question:
 * 'none' means no body check is worth doing.
 */
export function receiptHeaderSignal(
  headers: Record<string, string> | undefined,
  subject?: string,
): ReceiptHeaderSignal {
  const subj = subject ?? header(headers, 'Subject');

  if (STRONG_SUBJECT_RE.test(subj)) {
    return 'strong';
  }

  const from = header(headers, 'From');
  const senderSignal = RECEIPT_SENDER_LOCAL_RE.test(from) || RECEIPT_SENDER_DOMAIN_RE.test(from);

  if (WEAK_SUBJECT_RE.test(subj) || senderSignal) {
    return 'weak';
  }

  return 'none';
}

/** Every signal a message shows (subject / sender / body). */
export function receiptSignals(
  headers: Record<string, string> | undefined,
  subject?: string,
  bodyText?: string,
): ReceiptSignals {
  const subj = subject ?? header(headers, 'Subject');
  const from = header(headers, 'From');
  const body = bodyText ?? '';

  return {
    strongSubject: STRONG_SUBJECT_RE.test(subj),
    weakSubject: WEAK_SUBJECT_RE.test(subj),
    sender: RECEIPT_SENDER_LOCAL_RE.test(from) || RECEIPT_SENDER_DOMAIN_RE.test(from),
    body: CURRENCY_AMOUNT_RE.test(body) && RECEIPT_BODY_WORD_RE.test(body),
  };
}

/**
 * Is this message a receipt / order confirmation / invoice?
 *
 *   strong subject                      → yes   (the ONLY route with no body)
 *   body + (weak subject OR sender)     → yes
 *   anything less                       → no
 *
 * THE BODY IS NOT OPTIONAL for the weak forms. `weak subject + sender` used to
 * be enough, and it admits pure marketing mail wholesale: "Shop the sale: order
 * by Friday" from `shop@retailer.example`, "New arrivals you can purchase
 * today" from `news@apple.com` — a weak subject word plus a shop-shaped sender
 * is the shape of an entire Promotions tab, and neither message contains a
 * receipt at all. A message with no total, no order number and no amount is not
 * a receipt no matter who sent it; only an UNAMBIGUOUS subject ("Your receipt
 * from Apple", "Invoice #4417") is self-evidencing enough to skip the body.
 *
 * `bodyText` should be PLAIN text: an HTML-only receipt must be run through
 * {@link import('./email_mime').htmlToText} first, or the body signal is
 * looking at markup.
 */
export function isLikelyReceipt(
  headers: Record<string, string> | undefined,
  subject?: string,
  bodyText?: string,
): boolean {
  const s = receiptSignals(headers, subject, bodyText);

  if (s.strongSubject) {
    return true;
  }

  return s.body && (s.weakSubject || s.sender);
}

/**
 * Is receipt discovery enabled? `CI_IMPORT_RECEIPTS=0` (or false/no/off) turns
 * it off.
 *
 * DEFAULT ON. The flag exists so an appliance that finds the rule too generous
 * can turn it off without a deploy, not because the feature is provisional —
 * with it off, order confirmations go back to the drop ledger.
 */
export function receiptImportEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.CI_IMPORT_RECEIPTS ?? '').trim().toLowerCase();

  if (!raw) {
    return true;
  }

  return !/^(0|false|no|off)$/.test(raw);
}

/* -------------------------------------------------------------------------- *
 * Field extraction.
 *
 * Enough to make the receipt row worth having: who was paid, under what order
 * id, for how much. Deliberately conservative — a wrong total is worse than no
 * total, so each pattern requires the label next to the number.
 * -------------------------------------------------------------------------- */

/** What a receipt email states about itself. Every field optional. */
export interface ReceiptFields {
  merchant?: string;
  orderId?: string;
  total?: number;
  currency?: string;
}

const SYMBOL_CURRENCY: Record<string, string> = {
  $: 'USD',
  '€': 'EUR',
  '£': 'GBP',
  '¥': 'JPY',
  '₹': 'INR',
};

// Apple writes "Order ID: MXPQ1234RS", Amazon "Order #111-2233445-6677889".
const ORDER_ID_RE = /order\s*(?:#|no\.?|number|id)\s*[:\s]?\s*([A-Za-z0-9][A-Za-z0-9-]{4,})/i;

/**
 * ISO-4217 codes the total parser accepts as a trailing currency.
 *
 * The trailing code must be a WHOLE word AND a real code: without both checks,
 * "$1,234.56\n\nOrder #…" hands back "ORD" as the currency.
 */
const CURRENCY_CODES = new Set([
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

const TOTAL_RE =
  /(?:order\s+total|grand\s+total|total\s+charged|amount\s+(?:paid|charged|due)|total)\s*[:-]?\s*([$€£¥₹])?\s*([\d,]+\.\d{2})(?:\s*([A-Za-z]{3})(?![A-Za-z]))?/i;

/**
 * The merchant a message came from: the From display name when it has one, else
 * the sending domain's most significant label (`store.example.co.uk` →
 * `example`). Names like "Amazon.com" keep their own spelling.
 */
export function merchantFromSender(from: string): string | undefined {
  const raw = (from ?? '').trim();

  if (!raw) {
    return undefined;
  }

  const lt = raw.indexOf('<');
  const display = (lt === -1 ? '' : raw.slice(0, lt)).trim().replace(/^"|"$/g, '').trim();

  if (display) {
    return display;
  }

  const at = raw.lastIndexOf('@');

  if (at === -1) {
    return undefined;
  }

  const domain = raw
    .slice(at + 1)
    .replace(/[>\s].*$/, '')
    .toLowerCase();
  const labels = domain.split('.').filter(Boolean);

  if (labels.length === 0) {
    return undefined;
  }

  if (labels.length === 1) {
    return labels[0];
  }

  // The registrable label: the one immediately before the TLD, stepping back
  // once more over a generic second level (`store.co.uk` → store, not co).
  // Walking from the right for "the first non-generic label" would answer 'uk'.
  const SECOND_LEVEL = new Set(['co', 'com', 'net', 'org', 'ac', 'gov', 'edu']);
  const i = labels.length - 2;

  if (i > 0 && SECOND_LEVEL.has(labels[i])) {
    return labels[i - 1];
  }

  return labels[i];
}

/** Best-effort merchant / order id / total from a receipt message. */
export function extractReceiptFields(
  headers: Record<string, string> | undefined,
  bodyText?: string,
): ReceiptFields {
  const out: ReceiptFields = {};
  const merchant = merchantFromSender(header(headers, 'From'));

  if (merchant) {
    out.merchant = merchant;
  }

  const body = bodyText ?? '';
  const order = ORDER_ID_RE.exec(body) ?? ORDER_ID_RE.exec(header(headers, 'Subject'));

  if (order) {
    out.orderId = order[1];
  }

  const total = TOTAL_RE.exec(body);

  if (total) {
    const amount = Number(total[2].replace(/,/g, ''));

    if (Number.isFinite(amount)) {
      out.total = amount;
    }

    const code = total[3]?.toUpperCase();
    const currency =
      (code && CURRENCY_CODES.has(code) ? code : undefined) ??
      (total[1] ? SYMBOL_CURRENCY[total[1]] : undefined);

    if (currency) {
      out.currency = currency;
    }
  }

  return out;
}
