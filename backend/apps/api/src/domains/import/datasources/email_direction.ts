/*
 * Shared email direction / draft derivation for the mbox/eml importers
 * (gmail.ts, email.ts). Works from each message's OWN headers — never the
 * containing file's name (a Thunderbird export called "Sent" is just a file
 * name) and never user configuration.
 *
 * An email is INBOUND when it was delivered TO the user's mailbox, and final
 * delivery leaves receiving-MTA evidence in the headers:
 *   - Return-Path             — stamped at final delivery (RFC 5321 §4.4)
 *   - Delivered-To            — Gmail/qmail/postfix final-delivery stamp
 *   - Authentication-Results  — receiver's SPF/DKIM/DMARC verdict (RFC 8601)
 *   - Received-SPF            — older receiving-side SPF verdict
 *   - X-Apparently-To         — Yahoo's delivery stamp
 * A sent copy is filed at submission (by the client or provider) and never
 * passes final delivery to the user's own mailbox, so it carries NONE of
 * these. Measured on a real Yahoo/Thunderbird IMAP export: 0 of 2,293 Sent
 * messages had any of them vs 4,610 of 4,610 messages in delivered folders.
 * DKIM-Signature is deliberately NOT an inbound signal — providers sign
 * outbound mail at submission too.
 *
 * Gmail Takeout additionally tags the user's own sent mail with a `Sent`
 * label in `X-Gmail-Labels`; that self-contained signal is trusted first.
 *
 * Returns 'outbound' | 'inbound'. The canonical mapping
 * (mapping.ts#directionFor) normalises these to CI-Server's inbound/outbound,
 * so emitting them in the item metadata `Direction` field is enough to carry
 * direction through the push.
 */

/** Headers only a receiving MTA writes; any one present ⇒ delivered ⇒ inbound. */
const DELIVERY_TRACE_HEADERS = [
  'return-path',
  'delivered-to',
  'authentication-results',
  'received-spf',
  'x-apparently-to',
];

/** Case-insensitive header lookup (parseHeaders preserves original casing). */
function headerValue(headers: Record<string, string>, name: string): string | undefined {
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === name) {
      return headers[k];
    }
  }

  return undefined;
}

/** True when the X-Gmail-Labels header contains the `Sent` label. */
export function hasSentLabel(labelsHeader: string | undefined): boolean {
  if (!labelsHeader) {
    return false;
  }

  return labelsHeader
    .toLowerCase()
    .split(',')
    .map((l) => l.trim())
    .includes('sent');
}

/**
 * True for saved drafts — messages that were never sent, which the importers
 * skip entirely (an unsent message is not correspondence worth tracking).
 * Thunderbird stamps drafts with `X-Mozilla-Draft-Info`; Gmail Takeout labels
 * them `Draft` in `X-Gmail-Labels`.
 */
export function isDraft(headers: Record<string, string>): boolean {
  if (headerValue(headers, 'x-mozilla-draft-info') !== undefined) {
    return true;
  }

  const labels = headerValue(headers, 'x-gmail-labels');
  if (!labels) {
    return false;
  }

  return labels
    .toLowerCase()
    .split(',')
    .some((l) => l.trim() === 'draft' || l.trim() === 'drafts');
}

/**
 * What a message's direction was read from, carried to the push as item
 * metadata `DirectionBasis`:
 *  - `sent_label` — Gmail filed it as Sent: the owner's own mail, final;
 *  - `delivery_trace` — a receiving MTA stamped it: delivered, so inbound;
 *  - `no_delivery_trace` — neither. Read as outbound (a sent copy), but it is
 *    only an absence, and the push may overrule it once it knows the sender
 *    is somebody else writing to the owner (PushStage, `directionAfterSender`).
 */
export type EmailDirectionBasis = 'sent_label' | 'delivery_trace' | 'no_delivery_trace';

/** Which of the {@link EmailDirectionBasis} signals a message's parsed headers carry. */
export function emailDirectionBasis(headers: Record<string, string>): EmailDirectionBasis {
  if (hasSentLabel(headerValue(headers, 'x-gmail-labels'))) {
    return 'sent_label';
  }

  const keys = new Set(Object.keys(headers).map((k) => k.toLowerCase()));
  if (DELIVERY_TRACE_HEADERS.some((h) => keys.has(h))) {
    return 'delivery_trace';
  }

  return 'no_delivery_trace';
}

/** Derive 'outbound' | 'inbound' from a message's parsed headers. */
export function emailDirection(headers: Record<string, string>): 'outbound' | 'inbound' {
  return emailDirectionBasis(headers) === 'delivery_trace' ? 'inbound' : 'outbound';
}
