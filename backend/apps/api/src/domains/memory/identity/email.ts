import * as crypto from 'crypto';

import { FEDERATED_SYSTEMS, fallbackId } from './registry';
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
 * guaranteed to agree; see design doc §3.3).
 */
export function emailAttachmentIdentity(parent: SourceIdentity, bytesSha256Hex: string): SourceIdentity {
  return { system: parent.system, id: asSourceId(`attachment:${parent.id}:${bytesSha256Hex}`) };
}
