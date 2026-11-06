/**
 * Protocol and message type URIs (DIDComm Messaging v2.1, "Protocols"):
 *
 *     message-type-uri  = doc-uri delim protocol-name "/" semver "/" message-type-name
 *     protocol-id (PIURI) = doc-uri delim protocol-name "/" semver
 *
 * `type` is matched to a handler by protocol, not by string equality: the doc-uri must be the same,
 * the protocol and message names are compared ignoring case and punctuation, and the major version
 * must be equal. A handler written for `2.0` therefore also takes a `2.1` message (minor versions
 * only add optional fields), and not a `3.0` one.
 */

export interface ParsedMessageType {
  docUri: string;
  protocol: string;
  version: string;
  major: number;
  minor: number;
  name: string;
}

const MESSAGE_TYPE = /^(.*?)([a-z0-9._-]+)\/(\d[^/]*)\/([a-z0-9._-]+)$/i;
const PROTOCOL = /^(.*?)([a-z0-9._-]+)\/(\d[^/]*)\/?$/i;

function parseVersion(version: string): { major: number; minor: number } | undefined {
  const match = /^(\d+)(?:\.(\d+))?/.exec(version);

  return match ? { major: Number(match[1]), minor: Number(match[2] ?? 0) } : undefined;
}

/** Splits a message type URI, or returns `undefined` if it does not have the protocol shape. */
export function parseMessageType(type: string): ParsedMessageType | undefined {
  const match = MESSAGE_TYPE.exec(type);
  const version = match ? parseVersion(match[3]) : undefined;

  if (!match || !version) {
    return undefined;
  }

  return { docUri: match[1], protocol: match[2], version: match[3], ...version, name: match[4] };
}

/** Splits a protocol identifier URI (the message type without its last segment). */
export function parseProtocolId(piuri: string): Omit<ParsedMessageType, 'name'> | undefined {
  const match = PROTOCOL.exec(piuri);
  const version = match ? parseVersion(match[3]) : undefined;

  if (!match || !version) {
    return undefined;
  }

  return { docUri: match[1], protocol: match[2], version: match[3], ...version };
}

/** Case and punctuation do not distinguish names. */
export function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[._-]/g, '');
}

/** True when a message of type `type` belongs to protocol `piuri` at a compatible (same major) version. */
export function belongsToProtocol(type: string, piuri: string): boolean {
  const message = parseMessageType(type);
  const protocol = parseProtocolId(piuri);

  return (
    message !== undefined &&
    protocol !== undefined &&
    message.docUri === protocol.docUri &&
    normalizeName(message.protocol) === normalizeName(protocol.protocol) &&
    message.major === protocol.major
  );
}

/** The message-type name (`ping`, `ping-response`, `forward`…) with case and punctuation folded. */
export function messageName(type: string): string | undefined {
  const parsed = parseMessageType(type);

  return parsed ? normalizeName(parsed.name) : undefined;
}
