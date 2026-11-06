import { DidcommError } from './errors';
import { createMessage, type DidcommMessage, threadIdOf } from './message';

/**
 * Trust Ping 2.0 (https://didcomm.org/trust-ping/2.0): the DIDComm `ping`. A ping and its response
 * show both parties that the keys, the DID documents and the route all work, with the same
 * encryption any other message gets, which a TCP or HTTP ping cannot show.
 */

export const TRUST_PING_PROTOCOL = 'https://didcomm.org/trust-ping/2.0';
export const PING_TYPE = `${TRUST_PING_PROTOCOL}/ping`;
export const PING_RESPONSE_TYPE = `${TRUST_PING_PROTOCOL}/ping-response`;

export function buildPing(
  input: { from?: string; to: string[]; responseRequested?: boolean },
  now?: number,
): DidcommMessage {
  return createMessage(
    {
      type: PING_TYPE,
      ...(input.from !== undefined ? { from: input.from } : {}),
      to: input.to,
      body: { response_requested: input.responseRequested ?? true },
    },
    now,
  );
}

/** `response_requested` defaults to `true` when absent. */
export function wantsResponse(ping: DidcommMessage): boolean {
  if (ping.type !== PING_TYPE) {
    throw new DidcommError('invalid-argument', 'not a trust-ping ping');
  }

  return ping.body?.response_requested !== false;
}

/** The reply to a ping, in the ping's thread, addressed to its sender. */
export function buildPingResponse(
  ping: DidcommMessage,
  input: { from?: string } = {},
  now?: number,
): DidcommMessage {
  if (ping.from === undefined) {
    throw new DidcommError('invalid-argument', 'cannot answer a ping that names no sender');
  }

  return createMessage(
    {
      type: PING_RESPONSE_TYPE,
      ...(input.from !== undefined ? { from: input.from } : {}),
      to: [ping.from],
      thid: threadIdOf(ping),
      body: {},
    },
    now,
  );
}
