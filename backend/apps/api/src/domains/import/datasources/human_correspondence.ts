/*
 * Shared "is this real human mail?" gate for the Gmail Takeout importer and
 * the live Gmail/Outlook ETL transforms.
 *
 * The archive path used to own this; live OAuth sync did not, so newsletters
 * and junk kept landing in ci.communications and then in hourly summaries.
 * One function, one drop slug (`bulk_filtered`), both paths.
 */

import { isDraft } from './email_direction';
import { isLikelyReceipt, receiptHeaderSignal, receiptImportEnabled } from './receipt_detect';

// Gmail category / user labels that mark non-human mail (bulk, automated, spam).
// Google Takeout writes these in `X-Gmail-Labels`. The Gmail API writes the
// same names as labelIds with underscores (`CATEGORY_PROMOTIONS`); callers
// normalise those to this spelling before this function sees them.
export const BULK_GMAIL_LABELS = new Set([
  'spam',
  'trash',
  'junk',
  'category promotions',
  'category social',
  'category forums',
  'category updates',
  'newsletters',
  'notifications',
  'google voice',
  'chat',
]);

// Labels that affirmatively mark human correspondence and override the heuristics
// below: Gmail's own Primary-tab classification, and the user's own Sent mail.
export const HUMAN_GMAIL_LABELS = new Set(['category personal', 'sent']);

// Engagement/importance signals that rescue a message filed ONLY under Gmail's
// "Updates" category. Updates swallows transactional mail users consider real —
// receipts, bills, bookings. Important/Starred are Gmail's own significance
// verdicts, Opened is the user's engagement, and the Purchases/Travel/Bills
// co-categories mark transactional records worth keeping.
export const UPDATES_OVERRIDE_LABELS = new Set([
  'important',
  'opened',
  'starred',
  'category purchases',
  'category travel',
  'category bills',
]);

/** Case-insensitive header lookup (Gmail API / Graph casing is not stable). */
export function headerValue(headers: Record<string, string> | undefined, name: string): string {
  if (!headers) {
    return '';
  }

  const want = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === want && value) {
      return value;
    }
  }

  return '';
}

/** Remove every spelling of header `name` from a parsed header map. */
function dropHeader(map: Record<string, string>, name: string): void {
  for (const k of Object.keys(map)) {
    if (k.toLowerCase() === name.toLowerCase()) {
      delete map[k];
    }
  }
}

/**
 * Gmail API `labelIds` (`CATEGORY_PROMOTIONS`, `SPAM`) → Takeout
 * `X-Gmail-Labels` spelling (`Category Promotions`, `Spam`) so the same
 * label sets apply to both paths.
 */
export function gmailApiLabelsToTakeout(labelIds: string[] | undefined): string {
  return (labelIds ?? [])
    .map((id) => id.replace(/_/g, ' ').trim())
    .filter(Boolean)
    .join(',');
}

/**
 * Build the header map the gate expects from a Gmail API message: payload
 * headers plus labelIds rewritten as `X-Gmail-Labels`.
 */
export function headersFromGmailApi(args: {
  headers?: Array<{ name?: string; value?: string }>;
  labelIds?: string[];
}): Record<string, string> {
  const map: Record<string, string> = {};
  for (const header of args.headers ?? []) {
    if (!header.name || header.value == null) {
      continue;
    }

    if (!map[header.name]) {
      map[header.name] = header.value;
    } else {
      map[header.name] += `, ${header.value}`;
    }
  }

  // labelIds are Google's; an `X-Gmail-Labels` among the payload headers is
  // whatever the sender wrote (email_direction.ts#trustedGmailLabels), and
  // keeping it let a stranger's `X-Gmail-Labels: Sent` file their mail as the
  // owner's sent mail.
  dropHeader(map, 'X-Gmail-Labels');
  const labels = gmailApiLabelsToTakeout(args.labelIds);
  if (labels) {
    map['X-Gmail-Labels'] = labels;
  }

  return map;
}

/**
 * Outlook equivalent of Gmail labels + RFC bulk headers.
 *
 * Graph's `inferenceClassification` is Focused Inbox: `junk` is junk,
 * `other` is the Promotions/Updates leftover. `other` is mapped to
 * Category Updates so a high-importance flag can still rescue a bill;
 * a read-but-unimportant newsletter stays dropped.
 */
export function headersFromOutlookMessage(args: {
  subject?: string;
  from?: { emailAddress?: { name?: string; address?: string } };
  inferenceClassification?: string;
  importance?: string;
  categories?: string[];
  internetMessageHeaders?: Array<{ name?: string; value?: string }>;
}): Record<string, string> {
  const map: Record<string, string> = {};
  for (const header of args.internetMessageHeaders ?? []) {
    if (!header.name || header.value == null) {
      continue;
    }

    if (!map[header.name]) {
      map[header.name] = header.value;
    } else {
      map[header.name] += `, ${header.value}`;
    }
  }

  if (!headerValue(map, 'Subject') && args.subject) {
    map.Subject = args.subject;
  }

  if (!headerValue(map, 'From') && args.from?.emailAddress) {
    const { name, address } = args.from.emailAddress;
    map.From = name && address ? `${name} <${address}>` : address || name || '';
  }

  const labels = [...(args.categories ?? [])];
  const inference = (args.inferenceClassification ?? '').toLowerCase();
  if (inference === 'junk') {
    labels.push('Junk');
  } else if (inference === 'other') {
    labels.push('Category Updates');
  }

  if ((args.importance ?? '').toLowerCase() === 'high') {
    labels.push('Important');
  }

  // Outlook writes no X-Gmail-Labels, so one in the message is the sender's.
  dropHeader(map, 'X-Gmail-Labels');
  if (labels.length) {
    map['X-Gmail-Labels'] = labels.join(',');
  }

  return map;
}

/**
 * Decide whether a parsed email is real human correspondence (vs spam, a
 * newsletter, a promotion, or an automated notification). Order of evidence:
 *   1. X-Gmail-Labels — trust Gmail's own classification. Personal/Sent → keep;
 *      a bulk category/Spam/Junk → drop — EXCEPT a message filed only under
 *      "Category Updates" that also carries an engagement/importance label
 *      (Important, Starred, Opened, or a Purchases/Travel/Bills co-category),
 *      which is kept (see UPDATES_OVERRIDE_LABELS).
 *   2. Bulk headers — List-Unsubscribe / List-Id / Precedence: bulk|list|auto /
 *      Auto-Submitted mark mailing-list and machine-generated mail.
 *   3. Sender shape — no-reply@, notifications@, marketing@, mailer-daemon, etc.
 * Defaults to KEEP when there is no bulk signal, so ambiguous/older mail (which
 * predates Gmail categories) is preserved rather than silently dropped.
 */
export function isHumanCorrespondence(h: Record<string, string>): boolean {
  const labels = headerValue(h, 'X-Gmail-Labels')
    .toLowerCase()
    .split(',')
    .map((l) => l.replace(/^imap_\$?/, '').trim())
    .filter(Boolean);

  const from = headerValue(h, 'From').toLowerCase();
  const subject = headerValue(h, 'Subject');
  if (
    from.includes('voice.google.com') ||
    /^(New (text|picture|group) message|New voicemail|New missed call) from /i.test(subject)
  ) {
    return false;
  }

  if (labels.some((l) => HUMAN_GMAIL_LABELS.has(l))) {
    return true;
  }

  const bulk = labels.filter((l) => BULK_GMAIL_LABELS.has(l));
  if (bulk.length) {
    if (bulk.every((l) => l === 'category updates') && labels.some((l) => UPDATES_OVERRIDE_LABELS.has(l))) {
      return true;
    }

    return false;
  }

  if (headerValue(h, 'List-Unsubscribe') || headerValue(h, 'List-Id') || headerValue(h, 'List-ID')) {
    return false;
  }

  if (/\b(bulk|list|junk|auto_reply|auto-reply)\b/i.test(headerValue(h, 'Precedence'))) {
    return false;
  }

  const autoSubmitted = headerValue(h, 'Auto-Submitted').toLowerCase();
  if (autoSubmitted && autoSubmitted !== 'no') {
    return false;
  }

  if (
    /(?:^|[<\s."'])(?:no-?reply|do-?not-?reply|donotreply|notifications?|newsletter|news|mailer-daemon|postmaster|bounce[sd]?|marketing|noreply)[._-]?@/.test(
      from,
    )
  ) {
    return false;
  }

  return true;
}

export type LiveMailDropSlug = 'draft' | 'bulk_filtered';

/**
 * Live-sync drop decision. Same slugs the archive importer records
 * (`draft`, `bulk_filtered`). Receipts that the bulk gate would drop are
 * kept as communications — ETL has no commerce.receipt destination, so
 * dropping them here would lose the order entirely.
 */
export function liveMailDropReason(args: {
  headers: Record<string, string>;
  bodyText?: string;
  isExplicitDraft?: boolean;
  includeBulk?: boolean;
}): LiveMailDropSlug | null {
  if (args.isExplicitDraft || isDraft(args.headers)) {
    return 'draft';
  }

  if (args.includeBulk) {
    return null;
  }

  if (isHumanCorrespondence(args.headers)) {
    return null;
  }

  if (
    receiptImportEnabled() &&
    receiptHeaderSignal(args.headers) !== 'none' &&
    isLikelyReceipt(args.headers, undefined, args.bodyText)
  ) {
    return null;
  }

  return 'bulk_filtered';
}

export function mailIncludeBulkEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CI_MAIL_INCLUDE_BULK === '1' || env.CI_GMAIL_INCLUDE_BULK === '1';
}
