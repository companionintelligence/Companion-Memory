import * as crypto from 'crypto';

import { FEDERATED_SYSTEMS, attachmentIdentity, fallbackId } from './registry';
import { asSourceId, asSourceSystem, type SourceIdentity } from './types';

/**
 * The `email` federated kind: RFC 5322 mail keyed on its Message-ID, which is
 * globally unique by the standard — so the same message converges whether it
 * arrived via the Gmail API, the Graph API, a Takeout mbox, or an .eml file.
 * See docs/design/cross-pipeline-identity.md §3.2.
 */

/**
 * Normalize a Message-ID header value to the canonical id form: strip the
 * angle brackets and surrounding whitespace, preserve case (the local part is
 * case-sensitive per RFC 5322; every producer of the same message emits the
 * same bytes, so case-folding could only create false merges).
 *
 * Subsumes the mbox importer's `cleanMsgID` — this is now the one copy.
 */
export function normalizeMessageId(raw: string): string {
  return raw.replace(/[<>]/g, '').trim();
}

/**
 * Case-insensitive Message-ID lookup over a parsed header map — producers
 * spell it 'Message-ID', 'Message-Id', or 'message-id' depending on origin
 * (Gmail API, Graph API, raw MIME), and identity must not depend on which.
 */
export function messageIdFromHeaders(headers: Record<string, string>): string | undefined {
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === 'message-id') {
      return value;
    }
  }

  return undefined;
}

/**
 * Identity for one email message. Returns null when the Message-ID header is
 * absent or empty — the caller uses {@link emailFallbackIdentity} (never an
 * ad-hoc string), keeping id-less mail out of the federated namespace.
 */
export function emailIdentity(messageIdHeader: string | null | undefined): SourceIdentity | null {
  const normalized = messageIdHeader ? normalizeMessageId(messageIdHeader) : '';
  if (!normalized) {
    return null;
  }

  return { system: asSourceSystem(FEDERATED_SYSTEMS.email), id: asSourceId(normalized) };
}

/**
 * Fallback identity for Message-ID-less mail, scoped to the delivering
 * platform (`gmail`, `outlook_mail`, …) because fallback hashes are computed
 * over pipeline-local material and are NOT expected to converge across
 * pipelines (design doc §3.5). `material` is whatever stable per-pipeline
 * bytes the caller has (raw headers + body for mbox, API payload fields for
 * ETL) — same pipeline, same bytes, same id, so re-ingest stays idempotent.
 */
export function emailFallbackIdentity(platformSystem: string, material: string): SourceIdentity {
  const hash = crypto.createHash('sha256').update(material).digest('hex');

  return { system: asSourceSystem(platformSystem), id: fallbackId(hash) };
}

/**
 * Identity for one attachment of an identified email. Keyed on the parent
 * message's id plus the attachment bytes' hash — NOT the attachment index,
 * which does not converge (Gmail API part order and MIME part order are not
 * guaranteed to agree; see design doc §3.3). The generic form is
 * {@link attachmentIdentity}; this one exists so a mail call site reads as
 * what it is.
 */
export function emailAttachmentIdentity(parent: SourceIdentity, bytesSha256Hex: string): SourceIdentity {
  return attachmentIdentity(parent, bytesSha256Hex);
}

// ---------------------------------------------------------------------------
// Conversation keys
//
// `thread_id` names the CONVERSATION a message belongs to, not the message.
// It is not part of the identity pair, but it has the same convergence
// problem: the Gmail API reports `threadId` as HEX while a Takeout mbox
// carries the same 64-bit value as DECIMAL in `X-GM-THRID`, so two pipelines
// that agree on the message still disagreed on its thread. One normal form
// here — lowercase hex, no leading zeros — is what makes them agree (design
// doc §4, "converge messages first, threads second").
// ---------------------------------------------------------------------------

/** The IMAP extension header Google stamps on every Takeout mbox message. */
export const GMAIL_THREAD_HEADER = 'X-GM-THRID';

/** Lowercase hex without leading zeros: the one spelling of a Gmail thread id. */
function normalizeHex(value: bigint): string {
  return value.toString(16);
}

/**
 * The conversation key for a Gmail API `threadId` (hex). Returns undefined
 * for a value that is not hex, rather than passing garbage through as a key.
 */
export function gmailThreadKeyFromApi(threadId: string | null | undefined): string | undefined {
  const hex = threadId?.trim().toLowerCase();
  if (!hex || !/^[0-9a-f]+$/.test(hex)) {
    return undefined;
  }

  return normalizeHex(BigInt(`0x${hex}`));
}

/**
 * The conversation key for an IMAP `X-GM-THRID` value (decimal) — the SAME
 * number the API spells in hex, so this and {@link gmailThreadKeyFromApi}
 * yield byte-identical keys for one thread. The two are separate functions
 * because a digits-only string is valid in both bases; the caller knows which
 * it holds and must say so.
 */
export function gmailThreadKeyFromImap(thrid: string | null | undefined): string | undefined {
  const decimal = thrid?.trim();
  if (!decimal || !/^[0-9]+$/.test(decimal)) {
    return undefined;
  }

  return normalizeHex(BigInt(decimal));
}

function headerValue(headers: Record<string, string> | undefined, name: string): string {
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

/** Strip angle brackets and collapse whitespace; empty → undefined. */
export function cleanMessageId(raw: string | undefined): string | undefined {
  if (!raw) {
    return undefined;
  }

  const cleaned = raw.replace(/[<>]/g, '').replace(/\s+/g, ' ').trim();

  return cleaned || undefined;
}

/**
 * Message-IDs in a References / In-Reply-To value, in listed order.
 * Prefers bracketed ids (`<a@x> <b@x>`) and falls back to whitespace split.
 */
export function parseMessageIds(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }

  const bracketed = raw.match(/<[^>]+>/g);
  if (bracketed?.length) {
    return bracketed.map((id) => id.replace(/[<>]/g, '').trim()).filter(Boolean);
  }

  return raw
    .split(/\s+/)
    .map((id) => id.replace(/[<>]/g, '').trim())
    .filter(Boolean);
}

/**
 * Conversation key for one message from its MIME headers — the importer's
 * side of the thread pair.
 *
 * Gmail's own thread id wins when the mbox carries it (`X-GM-THRID`, every
 * Takeout export does), normalized to the API's spelling so the row the
 * Gmail connection wrote for the same message carries the same `thread_id`.
 *
 * Otherwise RFC 5322: References lists ancestors oldest-first, so the first
 * msg-id is the thread root; In-Reply-To is the immediate parent when
 * References is absent; the message's own Message-ID is the last resort — a
 * new conversation root. This chain does NOT converge with a Gmail/Outlook
 * connection's native thread id (there is no Gmail number to recover from a
 * non-Gmail mailbox); it is the honest fallback, not a second key format.
 */
export function emailThreadKey(headers: Record<string, string> | undefined): string | undefined {
  const gmail = gmailThreadKeyFromImap(headerValue(headers, GMAIL_THREAD_HEADER));
  if (gmail) {
    return gmail;
  }

  const references = parseMessageIds(headerValue(headers, 'References'));
  if (references[0]) {
    return references[0];
  }

  const inReplyTo = parseMessageIds(headerValue(headers, 'In-Reply-To'));
  if (inReplyTo[0]) {
    return inReplyTo[0];
  }

  return cleanMessageId(headerValue(headers, 'Message-ID'));
}
