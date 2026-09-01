import { FEDERATED_SYSTEMS } from './registry';
import { asSourceId, asSourceSystem, type SourceIdentity } from './types';

/**
 * The `file` federated kind: raw bytes keyed on their SHA-256 — the same hash
 * the object store already dedupes uploads on, promoted to row identity so a
 * photo or document converges no matter which pipeline delivered the bytes.
 *
 * Only for records whose identity IS the bytes (a stored file, a photo). A
 * platform's *reference* to a file (a Drive listing row without the bytes in
 * hand) keys on the platform id instead; the pairing happens when both sides
 * have hashed the same bytes.
 */
export function fileIdentity(sha256Hex: string): SourceIdentity {
  return {
    system: asSourceSystem(FEDERATED_SYSTEMS.file),
    id: asSourceId(`sha256:${sha256Hex.toLowerCase()}`),
  };
}
