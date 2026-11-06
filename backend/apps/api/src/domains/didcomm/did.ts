import { DidcommError } from './errors';

/**
 * DID and DID URL syntax (DID Core §3.1–3.2), only as far as DIDComm needs it: telling a DID from
 * a DID URL, taking the DID out of a key id, and refusing anything else before it reaches a
 * resolver, a log line or a URL.
 */

/** `did:` method-name `:` method-specific-id, where the id allows `:` between its parts. */
const DID = /^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/;
const DID_URL = /^(did:[a-z0-9]+:[A-Za-z0-9._:%-]+)([/?#][^\s]*)?$/;

/** Longest DID or DID URL accepted. A long-form `did:peer:2` with a service is the longest legitimate one. */
export const MAX_DID_LENGTH = 4096;

export function isDid(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_DID_LENGTH && DID.test(value);
}

/** A DID, optionally followed by a path, query and/or fragment. */
export function isDidUrl(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_DID_LENGTH && DID_URL.test(value);
}

/** The DID part of a DID URL (everything before the first `/`, `?` or `#`). */
export function didOf(didUrl: string): string {
  const match = DID_URL.exec(didUrl);

  if (!match) {
    throw new DidcommError('invalid-argument', 'not a DID URL');
  }

  return match[1];
}

/** The fragment of a DID URL, without the `#`, or `undefined`. */
export function fragmentOf(didUrl: string): string | undefined {
  const index = didUrl.indexOf('#');

  return index === -1 ? undefined : didUrl.slice(index + 1);
}

/** True for a DID URL that adds a path, query or fragment to its DID. */
export function hasDidUrlParts(didUrl: string): boolean {
  return didUrl !== didOf(didUrl);
}

export function didMethod(did: string): string {
  return didOf(did).split(':', 3)[1];
}

/**
 * `from` and `to` entries are a DID or a DID URL *without* a fragment (DIDComm Messaging v2.1,
 * "Message Headers"): they name a party, not a key.
 */
export function isPartyIdentifier(value: unknown): value is string {
  return isDidUrl(value) && fragmentOf(value) === undefined;
}
