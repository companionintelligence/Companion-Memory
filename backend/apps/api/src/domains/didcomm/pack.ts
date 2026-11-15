import { type ContentEncryption } from './contentEncryption';
import { didOf, fragmentOf, isDidUrl } from './did';
import { type DidResolver, type DocumentKey, keyForKid, relationshipKeys } from './didDocument';
import { isRecord, parseJsonObject, utf8Decode, utf8Encode } from './encoding';
import { DidcommError } from './errors';
import { verifyFromPrior, type VerifiedFromPrior } from './fromPrior';
import { type GeneralJwe, decryptJwe, encryptJwe, isAuthcrypt, parseJwe } from './jwe';
import { KEY_AGREEMENT_CURVES, type KeyCurve, parsePrivateJwk, type PrivateJwk, type PublicJwk } from './jwk';
import {
  createJws,
  parseJws,
  signatureAlgorithmFor,
  type SignatureAlgorithm,
  verifyJwsSignature,
} from './jws';
import { type DidcommMessage, isExpired, nowSeconds, parseMessage } from './message';
import { type SecretsResolver } from './secrets';

/**
 * Packing and unpacking: turning a plaintext message into the envelope a transport carries, and
 * back, with every check DIDComm Messaging v2.1 requires on the way.
 *
 * The envelope combinations produced (and the only ones accepted, DIDComm Messaging "IANA Media
 * Types"):
 *
 * | layers                          | produced by                              |
 * | ------------------------------- | ---------------------------------------- |
 * | plaintext                       | {@link packPlaintext}                    |
 * | sign                            | {@link packSigned}                       |
 * | anoncrypt                       | {@link packEncrypted} (no `from`)        |
 * | authcrypt                       | {@link packEncrypted} with `from`        |
 * | anoncrypt(sign)                 | {@link packEncrypted} with `signFrom`    |
 * | anoncrypt(authcrypt)            | {@link packEncrypted} with `protectSender` |
 * | authcrypt(sign)                 | accepted by {@link unpack}, never produced |
 * | anoncrypt(authcrypt(sign))      | accepted by {@link unpack}, never produced |
 *
 * Unpacking fails closed. A message is only handed back after the envelope parsed strictly, a key
 * this agent holds was a recipient, the sender key was resolved from the sender's own DID document
 * and found under the right relationship, the signature or AEAD checked out, and the identities at
 * each layer agree with each other and with `from`. What it proved about the sender is reported in
 * {@link UnpackMetadata}; policy on top of that (who may send what) belongs to the caller.
 */

export interface PackContext {
  resolver: DidResolver;
  secrets: SecretsResolver;
}

export type EnvelopeLayer = 'anoncrypt' | 'authcrypt' | 'sign';

export interface PackMetadata {
  /** Outermost first. */
  layers: EnvelopeLayer[];
  /** The `enc` of the outermost encryption layer. */
  enc?: ContentEncryption;
  /** Recipient key ids encrypted to (outermost encryption layer). */
  recipientKids: string[];
  senderKid?: string;
  signerKid?: string;
  /** Recipient keys on other curves than the one chosen, which this envelope does not cover. */
  skippedKeys: number;
}

export interface PackedMessage {
  /** The envelope as JSON text, ready to send as `application/didcomm-encrypted+json` (or signed/plain). */
  packed: string;
  metadata: PackMetadata;
}

// ─── plaintext and signed ────────────────────────────────────────────────────────────────────

export function packPlaintext(message: DidcommMessage): string {
  return JSON.stringify(parseMessage(message));
}

/** Finds a held signing secret for `signFrom` (a key id, or a DID to use the first usable key) and checks it is the published key. */
async function selectSigner(signFrom: string, from: string, context: PackContext): Promise<PrivateJwk> {
  if (didOf(signFrom) !== from) {
    throw new DidcommError(
      'inconsistent-layers',
      'the signing key does not belong to the message "from" DID',
    );
  }

  const document = await context.resolver.resolve(from);
  const wantsKey = fragmentOf(signFrom) !== undefined;
  const candidates = relationshipKeys(document, 'authentication').filter(
    (key) => signatureAlgorithmFor(key.jwk.crv) !== undefined && (!wantsKey || key.id === signFrom),
  );

  for (const candidate of candidates) {
    const secret = await context.secrets.getSecret(candidate.id);

    if (secret && secret.crv === candidate.jwk.crv && secret.x === candidate.jwk.x) {
      return secret;
    }
  }

  throw new DidcommError('secret-not-found', `no signing key of ${from} is held by this agent`);
}

export async function packSigned(
  message: DidcommMessage,
  options: PackContext & { signFrom: string },
): Promise<PackedMessage> {
  const plaintext = parseMessage(message);

  if (!plaintext.from) {
    throw new DidcommError('invalid-argument', 'a signed message needs "from"');
  }

  const signer = await selectSigner(options.signFrom, plaintext.from, options);
  const jws = createJws(utf8Encode(JSON.stringify(plaintext)), signer);

  return {
    packed: JSON.stringify(jws),
    metadata: { layers: ['sign'], recipientKids: [], signerKid: signer.kid, skippedKeys: 0 },
  };
}

// ─── encryption ──────────────────────────────────────────────────────────────────────────────

interface EncryptedEnvelope {
  jwe: GeneralJwe;
  recipientKids: string[];
  senderKid?: string;
  skippedKeys: number;
  enc: ContentEncryption;
}

/**
 * Encrypts `plaintext` to one recipient (a DID: every key-agreement key it lists on the chosen
 * curve; or a single key id) and, for authcrypt, from one of the sender's key-agreement keys.
 *
 * One envelope covers one curve: the ephemeral key must be on the recipients' curve. When the
 * recipient lists keys on several curves, the first curve in X25519, P-256, P-384, P-521 order that
 * both sides can use is chosen, and the rest are counted in `skippedKeys` (DIDComm Messaging calls
 * for a separate envelope per key type; callers that need more than one run this once per curve).
 */
export async function encryptEnvelope(
  plaintext: Uint8Array,
  options: PackContext & { to: string; from?: string; enc: ContentEncryption; curve?: KeyCurve },
): Promise<EncryptedEnvelope> {
  const recipientDid = didOf(options.to);
  const recipientDoc = await options.resolver.resolve(recipientDid);
  const wantsKey = fragmentOf(options.to) !== undefined;
  const recipientKeys = relationshipKeys(recipientDoc, 'keyAgreement').filter(
    (key) => KEY_AGREEMENT_CURVES.includes(key.jwk.crv) && (!wantsKey || key.id === options.to),
  );

  if (recipientKeys.length === 0) {
    throw new DidcommError('key-not-found', `${recipientDid} lists no usable key-agreement key`);
  }

  let sender: PrivateJwk | undefined;
  let curve: KeyCurve | undefined;
  const curves = options.curve ? [options.curve] : KEY_AGREEMENT_CURVES;

  if (options.from === undefined) {
    curve = curves.find((candidate) => recipientKeys.some((key) => key.jwk.crv === candidate));
  } else {
    const senderDid = didOf(options.from);
    const senderDoc = await options.resolver.resolve(senderDid);
    const senderWantsKey = fragmentOf(options.from) !== undefined;
    const senderKeys = relationshipKeys(senderDoc, 'keyAgreement').filter(
      (key) => !senderWantsKey || key.id === options.from,
    );

    search: for (const candidate of curves) {
      if (!recipientKeys.some((key) => key.jwk.crv === candidate)) {
        continue;
      }

      for (const key of senderKeys.filter((entry) => entry.jwk.crv === candidate)) {
        const secret = await options.secrets.getSecret(key.id);

        if (secret && secret.crv === key.jwk.crv && secret.x === key.jwk.x && secret.y === key.jwk.y) {
          sender = secret;
          curve = candidate;
          break search;
        }
      }
    }

    if (!sender) {
      throw new DidcommError(
        'secret-not-found',
        `no key-agreement key of ${senderDid} that is held by this agent shares a curve with ${recipientDid}`,
      );
    }
  }

  if (!curve) {
    throw new DidcommError(
      'key-not-found',
      `${recipientDid} lists no key-agreement key on a curve this agent can use`,
    );
  }

  const chosen = recipientKeys.filter((key) => key.jwk.crv === curve);
  const jwe = encryptJwe({
    plaintext,
    enc: options.enc,
    recipients: chosen.map((key) => ({ kid: key.id, publicJwk: key.jwk })),
    sender,
  });

  return {
    jwe,
    recipientKids: chosen.map((key) => key.id),
    senderKid: sender?.kid,
    skippedKeys: recipientKeys.length - chosen.length,
    enc: options.enc,
  };
}

export interface PackEncryptedOptions extends PackContext {
  /** Recipient DID, or one of its key-agreement key ids to encrypt to that key only. */
  to: string;
  /** Authcrypt: the sender's DID, or one of its key-agreement key ids. Without it the message is anoncrypt. */
  from?: string;
  /** Sign first (anoncrypt(sign)): a signing key id of `message.from`, or the DID. Not combinable with `from`. */
  signFrom?: string;
  /** With `from`: wrap the authcrypt envelope in anoncrypt, so the outer hop cannot read the sender key id. */
  protectSender?: boolean;
  /** Content encryption. Authcrypt is always `A256CBC-HS512`. Defaults to `A256CBC-HS512`. */
  enc?: ContentEncryption;
  /** Prefer this curve when both sides offer several. */
  curve?: KeyCurve;
}

export async function packEncrypted(
  message: DidcommMessage,
  options: PackEncryptedOptions,
): Promise<PackedMessage> {
  let plaintext = parseMessage(message);
  const recipientDid = didOf(options.to);
  const enc = options.enc ?? 'A256CBC-HS512';

  if (options.from !== undefined && options.signFrom !== undefined) {
    // authcrypt(sign(plaintext)) "adds no useful guarantees" and SHOULD NOT be emitted.
    throw new DidcommError(
      'policy-violation',
      'use either authcrypt (from) or sign-then-anoncrypt (signFrom), not both',
    );
  }

  if (options.protectSender && options.from === undefined) {
    throw new DidcommError('invalid-argument', 'protectSender needs an authcrypt sender (from)');
  }

  if (plaintext.to !== undefined && !plaintext.to.includes(recipientDid)) {
    throw new DidcommError('inconsistent-layers', `message "to" does not list ${recipientDid}`);
  }

  if (options.from !== undefined) {
    const senderDid = didOf(options.from);

    if (plaintext.from !== undefined && plaintext.from !== senderDid) {
      throw new DidcommError('inconsistent-layers', 'message "from" differs from the authcrypt sender');
    }

    plaintext = parseMessage({ ...plaintext, from: senderDid });

    if (enc !== 'A256CBC-HS512') {
      throw new DidcommError('invalid-argument', 'authcrypt (ECDH-1PU) requires A256CBC-HS512');
    }
  }

  let payload: Uint8Array = utf8Encode(JSON.stringify(plaintext));
  const layers: EnvelopeLayer[] = [];
  let signerKid: string | undefined;

  if (options.signFrom !== undefined) {
    if (plaintext.to === undefined) {
      // A signature without an audience can be replayed to anyone (DIDComm Messaging v2.1, "Message Signing").
      throw new DidcommError(
        'invalid-argument',
        'a message that is signed and encrypted must name its recipients in "to"',
      );
    }

    const signed = await packSigned(plaintext, { ...options, signFrom: options.signFrom });

    payload = utf8Encode(signed.packed);
    signerKid = signed.metadata.signerKid;
  }

  const inner = await encryptEnvelope(payload, { ...options, enc });

  let outer = inner;

  if (options.protectSender) {
    outer = await encryptEnvelope(utf8Encode(JSON.stringify(inner.jwe)), {
      ...options,
      from: undefined,
      enc,
    });
  }

  if (options.protectSender) {
    layers.push('anoncrypt', 'authcrypt');
  } else {
    layers.push(options.from !== undefined ? 'authcrypt' : 'anoncrypt');
  }

  if (signerKid) {
    layers.push('sign');
  }

  return {
    packed: JSON.stringify(outer.jwe),
    metadata: {
      layers,
      enc: outer.enc,
      recipientKids: outer.recipientKids,
      senderKid: inner.senderKid,
      signerKid,
      skippedKeys: outer.skippedKeys,
    },
  };
}

// ─── unpacking ───────────────────────────────────────────────────────────────────────────────

export interface UnpackMetadata {
  /** Envelope layers, outermost first. Empty for a plaintext message. */
  layers: EnvelopeLayer[];
  encrypted: boolean;
  /**
   * The sender is proven to this recipient: an authcrypt layer (only the holder of the sender's key
   * could have produced it) or a verified signature. Says nothing a third party can check; see
   * `nonRepudiation`.
   */
  authenticated: boolean;
  /** A signature by the sender verified: provable to anyone who sees the signed message. Authcrypt alone is repudiable. */
  nonRepudiation: boolean;
  /** Encrypted, but nothing proves who sent it. */
  anonymousSender: boolean;
  /** anoncrypt(authcrypt): the outer hop could not read the sender key id. */
  protectedSender: boolean;
  /** The authenticated sender's DID. */
  senderDid?: string;
  /** The sender's key-agreement key (authcrypt). */
  senderKid?: string;
  /** The sender's signing key (signed messages). */
  signerKid?: string;
  /** The recipient key this agent decrypted with, at the innermost encryption layer. */
  recipientKid?: string;
  recipientDid?: string;
  encAlgs: { anoncrypt?: ContentEncryption; authcrypt?: ContentEncryption };
  signAlg?: SignatureAlgorithm;
  /** A verified DID rotation carried by the message. Evidence only; see `fromPrior.ts`. */
  fromPrior?: VerifiedFromPrior;
}

export interface UnpackResult {
  message: DidcommMessage;
  metadata: UnpackMetadata;
}

export interface UnpackOptions extends PackContext {
  /** Epoch seconds, for expiry. Defaults to the clock. */
  now?: number;
  /** Tolerated clock difference when checking `expires_time`. Default 60. */
  clockSkewSeconds?: number;
  /** Longest envelope accepted, in bytes. Default 1 MiB. */
  maxBytes?: number;
  /** Policy on what the envelope must have proven. `encrypted` defaults to `true`. */
  require?: { encrypted?: boolean; authenticated?: boolean; nonRepudiation?: boolean };
  /** Accept a message whose `to` does not list the DID it was decrypted for. Default `false`. */
  allowMisaddressed?: boolean;
  /** Accept a message past its `expires_time`. Default `false`. */
  allowExpired?: boolean;
}

const DEFAULT_MAX_BYTES = 1024 * 1024;
const DEFAULT_SKEW_SECONDS = 60;

type EnvelopeKind = 'jwe' | 'jws' | 'plaintext';

function classify(value: Record<string, unknown>): EnvelopeKind {
  if ('ciphertext' in value && 'protected' in value && 'recipients' in value) {
    return 'jwe';
  }

  if ('payload' in value && ('signatures' in value || 'signature' in value)) {
    return 'jws';
  }

  if ('id' in value || 'type' in value) {
    return 'plaintext';
  }

  throw new DidcommError('malformed-envelope', 'not a DIDComm envelope or message');
}

/**
 * The envelope combinations accepted for one hop; anything else is refused.
 *
 * `anoncrypt>authcrypt>sign` is accepted although DIDComm Messaging says it "makes no sense" to
 * emit it: the specification's own Appendix C.3 vector for a protected sender is exactly that, and
 * receiving it costs nothing (the signer must still be the authcrypt sender). This module never
 * produces it.
 */
function nestingAllowed(layers: EnvelopeLayer[], next: EnvelopeLayer): boolean {
  const key = [...layers, next].join('>');

  return [
    'anoncrypt',
    'authcrypt',
    'sign',
    'anoncrypt>authcrypt',
    'anoncrypt>sign',
    'authcrypt>sign',
    'anoncrypt>authcrypt>sign',
  ].includes(key);
}

async function decryptLayer(
  envelope: Record<string, unknown>,
  context: PackContext,
): Promise<{
  plaintext: Buffer;
  layer: 'anoncrypt' | 'authcrypt';
  enc: ContentEncryption;
  recipientKid: string;
  senderKid?: string;
}> {
  const jwe = parseJwe(envelope);
  const authcrypt = isAuthcrypt(jwe);
  let senderPublic: PublicJwk | undefined;

  if (authcrypt) {
    const skid = jwe.skid as string;
    const senderDoc = await context.resolver.resolve(didOf(skid));

    // The sender key must be one the sender's DID lists for key agreement, not merely any key.
    senderPublic = keyForKid(senderDoc, skid, 'keyAgreement').jwk;
  }

  let held = false;

  for (const recipient of jwe.recipients) {
    const secret = await context.secrets.getSecret(recipient.kid);

    if (!secret || secret.kid !== recipient.kid) {
      continue;
    }

    held = true;

    try {
      return {
        plaintext: decryptJwe(jwe, parsePrivateJwk(secret), senderPublic),
        layer: authcrypt ? 'authcrypt' : 'anoncrypt',
        enc: jwe.enc,
        recipientKid: recipient.kid,
        senderKid: jwe.skid,
      };
    } catch {
      // Try the next held key; if none works the error below is the same for every cause.
    }
  }

  if (!held) {
    throw new DidcommError('secret-not-found', 'no key held by this agent is a recipient of the message');
  }

  throw new DidcommError('decryption-failed', 'the message could not be decrypted');
}

export async function unpack(
  input: string | Uint8Array | Record<string, unknown>,
  options: UnpackOptions,
): Promise<UnpackResult> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const now = options.now ?? nowSeconds();
  let current: Record<string, unknown>;

  if (typeof input === 'string' || input instanceof Uint8Array) {
    const size = typeof input === 'string' ? Buffer.byteLength(input) : input.byteLength;

    if (size > maxBytes) {
      throw new DidcommError('too-large', `envelope is ${size} bytes; the limit is ${maxBytes}`);
    }

    current = parseJsonObject(
      typeof input === 'string' ? input : utf8Decode(input, 'envelope', 'malformed-envelope'),
      'envelope',
      'malformed-envelope',
    );
  } else if (isRecord(input)) {
    current = input;
  } else {
    throw new DidcommError('malformed-envelope', 'an envelope is JSON text, bytes, or a parsed object');
  }

  const layers: EnvelopeLayer[] = [];
  const encAlgs: UnpackMetadata['encAlgs'] = {};
  let senderKid: string | undefined;
  let signerKid: string | undefined;
  let signAlg: SignatureAlgorithm | undefined;
  let recipientKid: string | undefined;
  let message: DidcommMessage | undefined;

  for (let depth = 0; depth < 4 && !message; depth += 1) {
    const kind = classify(current);

    if (kind === 'plaintext') {
      message = parseMessage(current);
      break;
    }

    if (kind === 'jwe') {
      const peek = parseJwe(current);
      const layer: EnvelopeLayer = isAuthcrypt(peek) ? 'authcrypt' : 'anoncrypt';

      if (!nestingAllowed(layers, layer)) {
        throw new DidcommError(
          'inconsistent-layers',
          `a ${layer} layer may not sit inside ${layers.join(' > ') || 'nothing'}`,
        );
      }

      const opened = await decryptLayer(current, options);

      layers.push(opened.layer);
      encAlgs[opened.layer] = opened.enc;
      recipientKid = opened.recipientKid;
      senderKid = opened.senderKid ?? senderKid;
      current = parseJsonObject(
        utf8Decode(opened.plaintext, 'decrypted payload', 'malformed-message'),
        'decrypted payload',
        'malformed-message',
      );
      continue;
    }

    if (!nestingAllowed(layers, 'sign')) {
      throw new DidcommError('inconsistent-layers', `a signature may not sit inside ${layers.join(' > ')}`);
    }

    const jws = parseJws(current);

    if (!isDidUrl(jws.kid) || fragmentOf(jws.kid) === undefined) {
      throw new DidcommError('malformed-envelope', 'the signature "kid" must be a DID URL naming a key');
    }

    const signerDoc = await options.resolver.resolve(didOf(jws.kid));
    // Authorization comes first: a valid signature from a key the DID does not list under
    // authentication is not a signature by that DID, however well it verifies.
    const key: DocumentKey = keyForKid(signerDoc, jws.kid, 'authentication');

    if (!verifyJwsSignature(jws, key.jwk)) {
      throw new DidcommError('signature-invalid', 'the signature does not verify');
    }

    layers.push('sign');
    signerKid = jws.kid;
    signAlg = jws.alg;
    current = parseJsonObject(
      utf8Decode(jws.payload, 'signed payload', 'malformed-message'),
      'signed payload',
      'malformed-message',
    );
  }

  if (!message) {
    throw new DidcommError('malformed-envelope', 'too many nested envelopes');
  }

  // Layer addressing consistency (DIDComm Messaging v2.1, "Message Layer Addressing Consistency").
  const senderDid = senderKid ? didOf(senderKid) : undefined;
  const signerDid = signerKid ? didOf(signerKid) : undefined;

  if (senderDid && message.from !== senderDid) {
    throw new DidcommError('inconsistent-layers', 'message "from" does not match the authcrypt sender key');
  }

  if (signerDid && message.from !== signerDid) {
    throw new DidcommError('inconsistent-layers', 'message "from" does not match the signing key');
  }

  const recipientDid = recipientKid ? didOf(recipientKid) : undefined;

  if (
    recipientDid &&
    message.to !== undefined &&
    !message.to.includes(recipientDid) &&
    !options.allowMisaddressed
  ) {
    // The specification says an implementation MUST NOT fail here, but also that signatures need
    // a `to` precisely so a recipient cannot be handed a message meant for someone else. Failing
    // closed is the safe default; `allowMisaddressed` restores the permissive reading.
    throw new DidcommError('inconsistent-layers', 'message "to" does not list the DID it was decrypted for');
  }

  if (!options.allowExpired && isExpired(message, now, options.clockSkewSeconds ?? DEFAULT_SKEW_SECONDS)) {
    throw new DidcommError('expired', 'the message has expired');
  }

  let fromPrior: VerifiedFromPrior | undefined;

  if (message.from_prior !== undefined) {
    fromPrior = await verifyFromPrior(message.from_prior, options);

    if (fromPrior.subject !== undefined ? message.from !== fromPrior.subject : message.from !== undefined) {
      throw new DidcommError('inconsistent-layers', 'message "from" does not match the from_prior subject');
    }
  }

  const authenticated = layers.includes('authcrypt') || layers.includes('sign');
  const encrypted = layers.includes('anoncrypt') || layers.includes('authcrypt');
  const metadata: UnpackMetadata = {
    layers,
    encrypted,
    authenticated,
    nonRepudiation: layers.includes('sign'),
    anonymousSender: encrypted && !authenticated,
    protectedSender: layers[0] === 'anoncrypt' && layers[1] === 'authcrypt',
    senderDid: senderDid ?? signerDid,
    senderKid,
    signerKid,
    recipientKid,
    recipientDid,
    encAlgs,
    signAlg,
    fromPrior,
  };

  const require = options.require ?? {};

  if ((require.encrypted ?? true) && !encrypted) {
    throw new DidcommError('policy-violation', 'an encrypted message is required');
  }

  if (require.authenticated && !authenticated) {
    throw new DidcommError('policy-violation', 'an authenticated sender is required');
  }

  if (require.nonRepudiation && !metadata.nonRepudiation) {
    throw new DidcommError('policy-violation', 'a signed message is required');
  }

  return { message, metadata };
}
