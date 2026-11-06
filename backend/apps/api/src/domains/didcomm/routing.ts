import { randomUUID } from 'node:crypto';

import { type ContentEncryption } from './contentEncryption';
import { didOf, isDid, isDidUrl } from './did';
import { type DidcommEndpoint, didcommEndpoints, type DidResolver } from './didDocument';
import { isRecord, parseJsonObject, utf8Decode, utf8Encode } from './encoding';
import { DidcommError } from './errors';
import { attachmentBytes, createMessage, type DidcommMessage, MEDIA_TYPE, nowSeconds } from './message';
import { type PackContext, encryptEnvelope } from './pack';

/**
 * Routing Protocol 2.0 (https://didcomm.org/routing/2.0): delivering a message through mediators
 * that can move it but not read it.
 *
 * A recipient behind a mediator publishes a `DIDCommMessaging` service whose `uri` is the
 * mediator's DID, or one whose `routingKeys` name the keys of mediators, outermost first. The
 * sender encrypts the message to the recipient as usual, then wraps that envelope in one `forward`
 * message per hop, innermost hop first, each anoncrypted to its hop. A mediator can open only its
 * own layer; what it sees is `next` (where to send the attached envelope) and an opaque blob.
 *
 * Nested wrapping grows an envelope by about 1.6 to 1.8 times per hop (base64 inside base64), which
 * is why a realistic route has one or two. This module builds exactly the route the recipient's
 * document describes and does not invent hops.
 */

export const FORWARD_TYPE = 'https://didcomm.org/routing/2.0/forward';

export interface ForwardInput {
  /** The hop the forward is addressed to (a DID). */
  to: string;
  /** Where that hop should send the payload: the next hop's key id or DID, or the final recipient's DID. */
  next: string;
  /** The envelope to carry, as parsed JSON. */
  payload: Record<string, unknown>;
  expiresTime?: number;
}

export function buildForwardMessage(input: ForwardInput, now: number = nowSeconds()): DidcommMessage {
  return createMessage(
    {
      type: FORWARD_TYPE,
      to: [input.to],
      body: { next: input.next },
      ...(input.expiresTime !== undefined ? { expires_time: input.expiresTime } : {}),
      attachments: [{ id: randomUUID(), media_type: MEDIA_TYPE.encrypted, data: { json: input.payload } }],
    },
    now,
  );
}

export interface ParsedForward {
  next: string;
  /** Each attached envelope, ready to deliver to `next`. */
  payloads: Array<Record<string, unknown>>;
}

/** Reads a `forward` message a mediator received: where to send, and what. */
export function parseForward(message: DidcommMessage): ParsedForward {
  if (message.type !== FORWARD_TYPE) {
    throw new DidcommError('routing-failed', 'not a routing/2.0 forward message');
  }

  const next = message.body?.next;

  if (typeof next !== 'string' || !isDidUrl(next)) {
    throw new DidcommError('routing-failed', 'forward body needs "next", a DID or key id');
  }

  if (!message.attachments || message.attachments.length === 0) {
    throw new DidcommError('routing-failed', 'forward needs at least one attachment');
  }

  const payloads = message.attachments.map((attachment) => {
    if (isRecord(attachment.data.json)) {
      return attachment.data.json;
    }

    const bytes = attachmentBytes(attachment);

    if (!bytes) {
      throw new DidcommError(
        'routing-failed',
        'a forward attachment must carry its envelope as json or base64',
      );
    }

    return parseJsonObject(
      utf8Decode(bytes, 'forward payload', 'routing-failed'),
      'forward payload',
      'routing-failed',
    );
  });

  return { next, payloads };
}

export interface Delivery {
  /** Where to POST the envelope: the first hop's endpoint. The caller's egress policy applies to it. */
  uri: string;
  /** The envelope to send, forward-wrapped when the route has hops. */
  packed: string;
  /** `Content-Type` for the HTTP binding. */
  contentType: typeof MEDIA_TYPE.encrypted;
  /** The hops wrapped, outermost first (empty for direct delivery). */
  hops: string[];
  /** Id of the recipient's service entry that was used. */
  endpointId: string;
}

export interface DeliveryOptions extends PackContext {
  /** The final recipient's DID. */
  to: string;
  enc?: ContentEncryption;
  /** Expiry stamped on every forward. Omit for none. */
  expiresTime?: number;
  /** URI schemes this deployment will send to. Default `https:` and `wss:`. */
  allowedSchemes?: string[];
  now?: number;
}

const PROFILE = 'didcomm/v2';

function usable(endpoint: DidcommEndpoint): boolean {
  // `accept` lists the profiles the endpoint takes; empty means "whatever the sender prefers".
  return endpoint.accept.length === 0 || endpoint.accept.includes(PROFILE);
}

/**
 * Works out how to reach a recipient and wraps an already-encrypted envelope for the trip.
 *
 * Endpoint choice follows the recipient's document: the first `DIDCommMessaging` entry that takes
 * the `didcomm/v2` profile. If its `uri` is a DID, that DID is a mediator: its own first
 * `https:`/`wss:` endpoint is where the envelope goes, and its key-agreement keys are the first hop
 * (the specification's "implicitly prepended" routing keys). The recipient's `routingKeys` follow.
 */
export async function prepareDelivery(packed: string, options: DeliveryOptions): Promise<Delivery> {
  const recipientDoc = await options.resolver.resolve(didOf(options.to));
  const endpoint = didcommEndpoints(recipientDoc).find(usable);

  if (!endpoint) {
    throw new DidcommError(
      'routing-failed',
      `${options.to} publishes no DIDCommMessaging endpoint for ${PROFILE}`,
    );
  }

  const schemes = options.allowedSchemes ?? ['https:', 'wss:'];
  let uri = endpoint.uri;
  let hops = [...endpoint.routingKeys];

  if (isDid(endpoint.uri)) {
    const mediatorDoc = await options.resolver.resolve(endpoint.uri);
    // A mediator's own endpoint must be a plain URL: no mediator behind a mediator behind a DID,
    // which would make resolution recursive.
    const mediatorEndpoint = didcommEndpoints(mediatorDoc).find(
      (candidate) => usable(candidate) && !isDid(candidate.uri),
    );

    if (!mediatorEndpoint) {
      throw new DidcommError('routing-failed', `mediator ${endpoint.uri} publishes no URL endpoint`);
    }

    uri = mediatorEndpoint.uri;
    hops = [...mediatorEndpoint.routingKeys, endpoint.uri, ...endpoint.routingKeys];
  }

  let url: URL;

  try {
    url = new URL(uri);
  } catch {
    throw new DidcommError('routing-failed', 'the endpoint is not a URL');
  }

  if (!schemes.includes(url.protocol) || url.username !== '' || url.password !== '') {
    throw new DidcommError(
      'routing-failed',
      `endpoint scheme ${url.protocol} is not allowed (or it carries credentials)`,
    );
  }

  let current: Record<string, unknown> = parseJsonObject(packed, 'envelope', 'routing-failed');
  const now = options.now ?? nowSeconds();

  // Innermost hop first: the last hop receives the message for the recipient, the first hop is the
  // one the sender actually talks to.
  for (let index = hops.length - 1; index >= 0; index -= 1) {
    const next = index === hops.length - 1 ? options.to : hops[index + 1];
    const forward = buildForwardMessage(
      { to: didOf(hops[index]), next, payload: current, expiresTime: options.expiresTime },
      now,
    );
    const sealed = await encryptEnvelope(utf8Encode(JSON.stringify(forward)), {
      resolver: options.resolver,
      secrets: options.secrets,
      to: hops[index],
      enc: options.enc ?? 'A256CBC-HS512',
    });

    current = sealed.jwe as unknown as Record<string, unknown>;
  }

  return {
    uri: url.href,
    packed: JSON.stringify(current),
    contentType: MEDIA_TYPE.encrypted,
    hops,
    endpointId: endpoint.id,
  };
}
