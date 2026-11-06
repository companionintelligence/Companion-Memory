import { didOf } from './did';
import {
  answerQueries,
  buildDisclose,
  DISCOVER_FEATURES_PROTOCOL,
  type FeatureDisclosure,
} from './discoverFeatures';
import { DidcommError } from './errors';
import { createMessage, type DidcommMessage, nowSeconds, parseMessage, threadIdOf } from './message';
import { type Delivery, prepareDelivery } from './routing';
import {
  type PackContext,
  packEncrypted,
  type PackMetadata,
  unpack,
  type UnpackMetadata,
  type UnpackOptions,
} from './pack';
import { belongsToProtocol, messageName } from './piuri';
import { type ReplayGuard } from './replayGuard';
import { buildPingResponse, TRUST_PING_PROTOCOL, wantsResponse } from './trustPing';

/**
 * A small agent: one DID, one set of keys, a table of protocol handlers, and the plumbing between
 * a received envelope and the replies it provokes.
 *
 * It owns no sockets. `receive` takes the bytes a transport delivered and returns the envelopes to
 * send in answer; `send` returns the envelope and endpoint to POST. Putting those on a wire (and
 * choosing an egress policy for the URL) is the caller's job; see `docs/didcomm.md` for the HTTP
 * binding and the reasons nothing here makes a network request.
 *
 * Rules the agent applies on top of `unpack`:
 *
 *   - Only messages encrypted *to this agent's DID* are processed.
 *   - Authenticated messages are checked against a replay guard (sender DID + message id).
 *   - Replies go only to an authenticated sender. A message from an anonymous sender can be handled
 *     but not answered: there is nobody to answer.
 *   - `trust-ping` and `discover-features` are built in. Discover-features discloses only the
 *     protocols registered here, and only to an authenticated asker.
 */

export interface HandlerContext {
  message: DidcommMessage;
  metadata: UnpackMetadata;
  agent: DidcommAgent;
}

/** Returns replies to send (each defaults to `from` this agent, `to` the sender, in the message's thread), or nothing. */
export type MessageHandler = (
  context: HandlerContext,
) => Promise<DidcommMessage[] | void> | DidcommMessage[] | void;

export interface DidcommAgentOptions extends PackContext {
  /** The DID this agent acts as. */
  did: string;
  replayGuard?: ReplayGuard;
  /** Epoch seconds. Defaults to the system clock. */
  clock?: () => number;
  maxBytes?: number;
  clockSkewSeconds?: number;
  /** How long to remember an authenticated message id that has no `expires_time`. Default one day. */
  replayWindowSeconds?: number;
  /** URI schemes endpoints may use. Default `https:` and `wss:`. */
  allowedSchemes?: string[];
}

/** A reply, already packed. `delivery` is absent when the recipient publishes no endpoint to POST to. */
export interface OutboundReply {
  /** The DID the reply is addressed to. */
  to: string;
  message: DidcommMessage;
  packed: string;
  /**
   * Where and how to send `packed`. Absent for a recipient such as a bare `did:key` that lists no
   * `DIDCommMessaging` service: such a reply can only travel back over a connection the sender
   * holds open (a WebSocket, DIDComm's `return_route`), which is the transport's business.
   */
  delivery?: Delivery;
}

export interface ReceiveResult {
  message: DidcommMessage;
  metadata: UnpackMetadata;
  /** A handler took the message. */
  handled: boolean;
  replies: OutboundReply[];
  /** Replies a handler produced that could not be sent because the sender is anonymous. */
  skippedReplies: number;
}

interface Registration {
  protocol: string;
  handler: MessageHandler;
  roles?: string[];
}

export class DidcommAgent {
  readonly did: string;
  private readonly context: PackContext;
  private readonly registrations: Registration[] = [];

  constructor(private readonly options: DidcommAgentOptions) {
    this.did = options.did;
    this.context = { resolver: options.resolver, secrets: options.secrets };

    this.register(TRUST_PING_PROTOCOL, ({ message, metadata }) => {
      // Only a ping *request* gets an answer, and only when someone proven can be answered.
      if (messageName(message.type) !== 'ping' || !metadata.senderDid || !wantsResponse(message)) {
        return;
      }

      return [buildPingResponse({ ...message, from: metadata.senderDid }, { from: this.did }, this.now())];
    });

    this.register(DISCOVER_FEATURES_PROTOCOL, ({ message, metadata }) => {
      if (messageName(message.type) !== 'queries' || !metadata.senderDid) {
        return;
      }

      return [
        buildDisclose(
          { ...message, from: metadata.senderDid },
          answerQueries(message, this.disclosures()),
          { from: this.did },
          this.now(),
        ),
      ];
    });
  }

  /** Handles messages of `protocol` (a PIURI such as `https://example.com/protocols/lunch/1.0`) at its major version. */
  register(protocol: string, handler: MessageHandler, options: { roles?: string[] } = {}): this {
    this.registrations.push({ protocol, handler, roles: options.roles });

    return this;
  }

  /** The protocols this agent handles, as discover-features disclosures. */
  disclosures(): FeatureDisclosure[] {
    return this.registrations.map(({ protocol, roles }) => ({
      'feature-type': 'protocol',
      id: protocol,
      ...(roles ? { roles } : {}),
    }));
  }

  private now(): number {
    return this.options.clock?.() ?? nowSeconds();
  }

  /** Packs `message` for `to`: authcrypt from this agent, optionally with the sender hidden from the outer hop. */
  async pack(
    message: DidcommMessage,
    options: { to: string; protectSender?: boolean },
  ): Promise<{ packed: string; metadata: PackMetadata }> {
    if (message.from !== undefined && message.from !== this.did) {
      throw new DidcommError('invalid-argument', 'this agent only sends as its own DID');
    }

    return packEncrypted(parseMessage({ ...message, from: this.did }), {
      ...this.context,
      to: options.to,
      from: this.did,
      protectSender: options.protectSender,
    });
  }

  private route(packed: string, to: string, expiresTime?: number): Promise<Delivery> {
    return prepareDelivery(packed, {
      ...this.context,
      to: didOf(to),
      expiresTime,
      allowedSchemes: this.options.allowedSchemes,
      now: this.now(),
    });
  }

  /** Packs `message` and works out where and how to deliver it (endpoint, mediators). */
  async send(
    message: DidcommMessage,
    options: { to: string; protectSender?: boolean; expiresTime?: number },
  ): Promise<Delivery> {
    const { packed } = await this.pack(message, options);

    return this.route(packed, options.to, options.expiresTime);
  }

  async receive(
    packed: string | Uint8Array | Record<string, unknown>,
    options: { require?: UnpackOptions['require'] } = {},
  ): Promise<ReceiveResult> {
    const now = this.now();
    const { message, metadata } = await unpack(packed, {
      ...this.context,
      now,
      maxBytes: this.options.maxBytes,
      clockSkewSeconds: this.options.clockSkewSeconds,
      require: options.require,
    });

    if (metadata.recipientDid !== undefined && metadata.recipientDid !== this.did) {
      throw new DidcommError(
        'not-authorized',
        'the message was encrypted to a DID this agent does not act as',
      );
    }

    if (this.options.replayGuard && metadata.authenticated && metadata.senderDid) {
      const skew = this.options.clockSkewSeconds ?? 60;
      const notAfter = (message.expires_time ?? now + (this.options.replayWindowSeconds ?? 86_400)) + skew;

      if (!this.options.replayGuard.firstSighting(`${metadata.senderDid}\n${message.id}`, notAfter, now)) {
        throw new DidcommError('replayed', 'this message was already received');
      }
    }

    const registration = this.registrations.find((candidate) =>
      belongsToProtocol(message.type, candidate.protocol),
    );

    if (!registration) {
      return { message, metadata, handled: false, replies: [], skippedReplies: 0 };
    }

    const produced = (await registration.handler({ message, metadata, agent: this })) ?? [];
    const replies: OutboundReply[] = [];
    let skippedReplies = 0;

    for (const reply of produced) {
      if (!metadata.senderDid) {
        skippedReplies += 1;
        continue;
      }

      const addressed = parseMessage({
        ...reply,
        from: reply.from ?? this.did,
        to: reply.to ?? [metadata.senderDid],
        thid: reply.thid ?? threadIdOf(message),
      });

      for (const recipient of addressed.to ?? []) {
        const outbound = parseMessage({ ...addressed, to: [recipient] });
        const { packed } = await this.pack(outbound, { to: recipient });
        const delivery = await this.route(packed, recipient).catch((error: unknown) => {
          // No endpoint is an ordinary outcome for a reply; a bad endpoint or a mediator failure is not.
          if (
            error instanceof DidcommError &&
            error.code === 'routing-failed' &&
            /publishes no DIDCommMessaging endpoint/.test(error.message)
          ) {
            return undefined;
          }

          throw error;
        });

        replies.push({ to: recipient, message: outbound, packed, delivery });
      }
    }

    return { message, metadata, handled: true, replies, skippedReplies };
  }
}

/** Builds a message the way an agent does, for protocol code that has no agent in hand. */
export function newMessageFor(
  agent: DidcommAgent,
  init: Parameters<typeof createMessage>[0],
  now?: number,
): DidcommMessage {
  return createMessage({ ...init, from: init.from ?? agent.did }, now);
}
