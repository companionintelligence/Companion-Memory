import { base64urlDecode, base64urlEncode, parseJsonObject, utf8Decode, utf8Encode } from './encoding';
import { DidcommError } from './errors';
import { type Attachment, createMessage, type DidcommMessage, parseMessage } from './message';

/**
 * Out-of-Band 2.0 invitations (https://identity.foundation/didcomm-messaging/spec/#out-of-band-messages):
 * a plaintext message packed into a URL or QR code so two parties with no prior channel can start
 * one. The invitation carries the inviter's DID in `from`; the invitee answers to that DID, and
 * puts the invitation's `id` in `pthid` of its first reply so the inviter can tie the two together.
 *
 *     https://example.com/invite?_oob=<base64url(JSON invitation)>
 *
 * ═══ NOTHING IN AN INVITATION IS PRIVATE ═══
 *
 * A URL or QR code is read by whoever sees it, so an invitation carries no secrets, and any
 * identifier in it must be treated as public from then on: rotate to a private DID (`from_prior`,
 * `fromPrior.ts`) over the first encrypted exchange. Decoding an invitation does not authenticate
 * its sender; it is a claim by whoever made the URL. A caller turns it into a relationship only
 * after the owner confirms it.
 */

export const OOB_PROTOCOL = 'https://didcomm.org/out-of-band/2.0';
export const OOB_INVITATION_TYPE = `${OOB_PROTOCOL}/invitation`;

/** Longest `_oob` parameter decoded. A QR code holds under 3 KB; this leaves room for a long link-style attachment. */
const MAX_INVITATION_BYTES = 64 * 1024;

export interface InvitationInput {
  /** The inviter's DID, which the invitee will address replies to. */
  from: string;
  goalCode?: string;
  goal?: string;
  /** Profiles the inviter accepts, in preference order, e.g. `["didcomm/v2"]`. */
  accept?: string[];
  /** Messages the invitee may act on directly; the invitee picks one. */
  attachments?: Attachment[];
  id?: string;
  expiresTime?: number;
}

export function buildInvitation(input: InvitationInput, now?: number): DidcommMessage {
  return createMessage(
    {
      type: OOB_INVITATION_TYPE,
      id: input.id,
      from: input.from,
      expires_time: input.expiresTime,
      body: {
        ...(input.goalCode !== undefined ? { goal_code: input.goalCode } : {}),
        ...(input.goal !== undefined ? { goal: input.goal } : {}),
        ...(input.accept !== undefined ? { accept: input.accept } : {}),
      },
      attachments: input.attachments,
    },
    now,
  );
}

/** Adds `_oob` to a URL (keeping its other parameters). The JSON is written without whitespace, as the protocol asks. */
export function encodeInvitationUrl(baseUrl: string, invitation: DidcommMessage): string {
  if (invitation.type !== OOB_INVITATION_TYPE) {
    throw new DidcommError('invalid-argument', 'not an out-of-band invitation');
  }

  const url = new URL(baseUrl);

  if (url.protocol !== 'https:' || url.searchParams.has('_oob') || url.searchParams.has('_oobid')) {
    throw new DidcommError(
      'invalid-argument',
      'the base URL must be https: and must not already carry an invitation',
    );
  }

  const encoded = base64urlEncode(utf8Encode(JSON.stringify(parseMessage(invitation))));

  if (encoded.length > MAX_INVITATION_BYTES) {
    throw new DidcommError('too-large', 'the invitation is too large for a URL');
  }

  url.searchParams.set('_oob', encoded);

  return url.href;
}

/**
 * Reads an invitation out of a URL. The `_oob` parameter must appear exactly once and decode to a
 * message of the invitation type with a `from`. The short form `?_oobid=` (a reference the inviter
 * serves) is recognised and refused: fetching it is a network request this module does not make.
 */
export function decodeInvitationUrl(link: string): DidcommMessage {
  let url: URL;

  try {
    url = new URL(link);
  } catch {
    throw new DidcommError('malformed-message', 'not a URL');
  }

  if (url.searchParams.has('_oobid')) {
    throw new DidcommError('unsupported-algorithm', 'short-URL invitations (_oobid) are not fetched here');
  }

  const values = url.searchParams.getAll('_oob');

  if (values.length !== 1) {
    throw new DidcommError('malformed-message', 'the URL must carry exactly one _oob parameter');
  }

  if (values[0].length > MAX_INVITATION_BYTES) {
    throw new DidcommError('too-large', 'the invitation is too large');
  }

  const invitation = parseMessage(
    parseJsonObject(
      utf8Decode(base64urlDecode(values[0], '_oob parameter', 'malformed-message'), '_oob parameter'),
      'invitation',
    ),
  );

  if (invitation.type !== OOB_INVITATION_TYPE) {
    throw new DidcommError('malformed-message', 'the _oob parameter is not an out-of-band invitation');
  }

  if (invitation.from === undefined) {
    throw new DidcommError('malformed-message', 'an invitation must name its sender in "from"');
  }

  return invitation;
}

/** The `pthid` the invitee must use in its first reply. */
export function replyParentThread(invitation: DidcommMessage): string {
  return invitation.id;
}
