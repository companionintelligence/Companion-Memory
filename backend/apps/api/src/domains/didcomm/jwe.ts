import { createHash } from 'node:crypto';

import {
  type ContentEncryption,
  contentEncryptionSpec,
  decryptContent,
  encryptContent,
  generateCek,
  isContentEncryption,
} from './contentEncryption';
import {
  base64urlDecode,
  base64urlEncode,
  isRecord,
  parseJsonObject,
  utf8Decode,
  utf8Encode,
} from './encoding';
import { DidcommError } from './errors';
import { isDidUrl } from './did';
import {
  generateKeyPair,
  isKeyAgreementCurve,
  type PrivateJwk,
  parsePublicJwk,
  privateKeyObject,
  type PublicJwk,
  publicKeyObject,
} from './jwk';
import {
  aesKeyUnwrap,
  aesKeyWrap,
  deriveKeyEncryptionKey,
  ecdh,
  type KeyWrapAlgorithm,
} from './keyAgreement';
import { MEDIA_TYPE, mediaTypeMatches } from './message';

/**
 * JWE in General JSON serialization for DIDComm encrypted messages (DIDComm Messaging v2.1,
 * "Message Encryption"), in both of its forms:
 *
 *   - **anoncrypt**: `ECDH-ES+A256KW`. Anyone can produce it; it proves nothing about the sender.
 *   - **authcrypt**: `ECDH-1PU+A256KW` with `A256CBC-HS512`. Only the holder of the sender's static
 *     key can produce it, and only the recipient can check it, which is what makes authcrypt
 *     repudiable: the recipient could have forged it too.
 *
 * One ephemeral key serves every recipient, so all recipient keys (and the sender's, for authcrypt)
 * must be on the same curve. `apv` commits to the sorted list of recipient key ids, so removing or
 * swapping a recipient breaks decryption for everyone. The protected header is the AEAD's AAD.
 *
 * Narrower than JOSE on purpose: only the two key-wrap algorithms and three `enc` values DIDComm
 * defines, one `epk` on a curve DIDComm names (validated on the curve), and none of `zip`, `crit`,
 * `unprotected`, `aad` or flattened serialization. Every decryption failure is the same error.
 */

export interface JweRecipient {
  header: { kid: string };
  encrypted_key: string;
}

export interface GeneralJwe {
  protected: string;
  recipients: JweRecipient[];
  iv: string;
  ciphertext: string;
  tag: string;
}

export interface ParsedJwe {
  /** The protected header exactly as received (base64url text): this string, not a re-encoding, is the AAD. */
  protectedText: string;
  alg: KeyWrapAlgorithm;
  enc: ContentEncryption;
  epk: PublicJwk;
  apu: Buffer;
  apv: Buffer;
  /** Authcrypt only: the sender's key-agreement key id. */
  skid?: string;
  recipients: Array<{ kid: string; encryptedKey: Buffer }>;
  iv: Buffer;
  ciphertext: Buffer;
  tag: Buffer;
}

const KEY_WRAP_ALGORITHMS: readonly KeyWrapAlgorithm[] = ['ECDH-ES+A256KW', 'ECDH-1PU+A256KW'];
const MAX_RECIPIENTS = 100;

export function isAuthcrypt(jwe: Pick<ParsedJwe, 'alg'>): boolean {
  return jwe.alg === 'ECDH-1PU+A256KW';
}

/** `apv`: base64url(SHA-256(recipient kids, sorted, joined with "."))). */
export function computeApv(kids: string[]): string {
  return base64urlEncode(
    createHash('sha256')
      .update([...kids].sort().join('.'))
      .digest(),
  );
}

function malformed(detail: string): DidcommError {
  return new DidcommError('malformed-envelope', `invalid DIDComm encrypted message: ${detail}`);
}

export function parseJwe(value: Record<string, unknown>): ParsedJwe {
  for (const unsupported of ['unprotected', 'aad', 'header', 'encrypted_key']) {
    if (unsupported in value) {
      throw malformed(`"${unsupported}" is not used by DIDComm (general JSON serialization only)`);
    }
  }

  const protectedText = value.protected;
  const header = parseJsonObject(
    utf8Decode(base64urlDecode(protectedText, 'protected header'), 'protected header', 'malformed-envelope'),
    'protected header',
    'malformed-envelope',
  );

  if (!KEY_WRAP_ALGORITHMS.includes(header.alg as KeyWrapAlgorithm)) {
    throw new DidcommError(
      'unsupported-algorithm',
      `key wrapping algorithm ${String(header.alg)} is not one DIDComm uses`,
    );
  }

  const alg = header.alg as KeyWrapAlgorithm;

  if (!isContentEncryption(header.enc)) {
    throw new DidcommError(
      'unsupported-algorithm',
      `content encryption ${String(header.enc)} is not one DIDComm uses`,
    );
  }

  const enc = header.enc;

  // ECDH-1PU puts the content tag in the key derivation, which is only sound over a key-committing
  // AEAD. A GCM or Poly1305 tag is not one, so authcrypt over them is refused rather than weakened.
  if (alg === 'ECDH-1PU+A256KW' && enc !== 'A256CBC-HS512') {
    throw new DidcommError('unsupported-algorithm', 'authcrypt (ECDH-1PU) requires A256CBC-HS512');
  }

  if ('zip' in header || 'crit' in header) {
    throw new DidcommError(
      'unsupported-algorithm',
      'JWE header extensions ("zip", "crit") are not supported',
    );
  }

  if (header.typ !== undefined && !mediaTypeMatches(header.typ, MEDIA_TYPE.encrypted)) {
    throw malformed(`"typ" must be ${MEDIA_TYPE.encrypted}`);
  }

  const epk = parsePublicJwk(header.epk);

  if (!isKeyAgreementCurve(epk.crv)) {
    throw new DidcommError('unsupported-algorithm', `${epk.crv} is not a key agreement curve`);
  }

  const apv = base64urlDecode(header.apv, '"apv"');

  if (apv.length !== 32) {
    throw malformed('"apv" must be a SHA-256 digest');
  }

  // An anoncrypt header from some producers carries "apu": null for "no party info"; that is the
  // same bytes as absent in the key derivation, so it is read as absent. Authcrypt requires a real one.
  const apuAbsent = header.apu === undefined || (header.apu === null && alg === 'ECDH-ES+A256KW');
  const apu = apuAbsent ? Buffer.alloc(0) : base64urlDecode(header.apu, '"apu"');
  let skid: string | undefined;

  if (alg === 'ECDH-1PU+A256KW') {
    if (apu.length === 0) {
      throw malformed('authcrypt needs "apu" (the sender key id)');
    }

    const fromApu = utf8Decode(apu, '"apu"', 'malformed-envelope');

    if (header.skid !== undefined && header.skid !== fromApu) {
      throw new DidcommError('inconsistent-layers', '"skid" and "apu" name different sender keys');
    }

    // "skid" is optional in the 1PU draft; "apu" is what the key derivation commits to.
    skid = fromApu;

    if (!isDidUrl(skid) || !skid.includes('#')) {
      throw malformed('"skid" must be a DID URL naming a key');
    }
  } else if (header.skid !== undefined) {
    throw malformed('anoncrypt must not name a sender key ("skid")');
  }

  if (
    !Array.isArray(value.recipients) ||
    value.recipients.length === 0 ||
    value.recipients.length > MAX_RECIPIENTS
  ) {
    throw malformed(`"recipients" must hold between 1 and ${MAX_RECIPIENTS} entries`);
  }

  const seen = new Set<string>();
  const wrappedLength = contentEncryptionSpec(enc).cekBytes + 8;
  const recipients = value.recipients.map((entry: unknown) => {
    const kid = isRecord(entry) && isRecord(entry.header) ? entry.header.kid : undefined;

    if (!isRecord(entry) || typeof kid !== 'string' || !isDidUrl(kid) || !kid.includes('#')) {
      throw malformed('each recipient needs header.kid, a DID URL naming a key');
    }

    if (seen.has(kid)) {
      throw malformed('duplicate recipient key id');
    }

    seen.add(kid);

    const encryptedKey = base64urlDecode(entry.encrypted_key, 'recipient "encrypted_key"');

    if (encryptedKey.length !== wrappedLength) {
      throw malformed('"encrypted_key" has the wrong length for the content encryption');
    }

    return { kid, encryptedKey };
  });

  // The recipient list is bound into the key derivation through apv, so a list that does not match
  // it is not a list anyone encrypted to.
  if (computeApv(recipients.map((recipient) => recipient.kid)) !== header.apv) {
    throw malformed('"apv" does not match the recipient list');
  }

  const spec = contentEncryptionSpec(enc);
  const iv = base64urlDecode(value.iv, '"iv"');
  const tag = base64urlDecode(value.tag, '"tag"');

  if (iv.length !== spec.ivBytes || tag.length !== spec.tagBytes) {
    throw malformed('"iv" or "tag" has the wrong length for the content encryption');
  }

  return {
    protectedText: protectedText as string,
    alg,
    enc,
    epk,
    apu,
    apv,
    skid,
    recipients,
    iv,
    ciphertext: base64urlDecode(value.ciphertext, '"ciphertext"'),
    tag,
  };
}

export interface EncryptJweInput {
  plaintext: Uint8Array;
  enc: ContentEncryption;
  /** Every recipient key, all on one key-agreement curve. */
  recipients: Array<{ kid: string; publicJwk: PublicJwk }>;
  /** Present for authcrypt: the sender's static key-agreement key, on the same curve. */
  sender?: PrivateJwk;
}

export function encryptJwe(input: EncryptJweInput): GeneralJwe {
  const { recipients, sender } = input;

  if (recipients.length === 0 || recipients.length > MAX_RECIPIENTS) {
    throw new DidcommError('invalid-argument', `encrypt to between 1 and ${MAX_RECIPIENTS} keys`);
  }

  const curve = recipients[0].publicJwk.crv;

  if (!isKeyAgreementCurve(curve) || recipients.some((recipient) => recipient.publicJwk.crv !== curve)) {
    throw new DidcommError('invalid-argument', 'all recipient keys must be on one key-agreement curve');
  }

  if (new Set(recipients.map((recipient) => recipient.kid)).size !== recipients.length) {
    throw new DidcommError('invalid-argument', 'duplicate recipient key id');
  }

  const alg: KeyWrapAlgorithm = sender ? 'ECDH-1PU+A256KW' : 'ECDH-ES+A256KW';

  if (sender && (sender.crv !== curve || !sender.kid)) {
    throw new DidcommError(
      'invalid-argument',
      "the sender key must have a kid and share the recipients' curve",
    );
  }

  if (alg === 'ECDH-1PU+A256KW' && input.enc !== 'A256CBC-HS512') {
    throw new DidcommError('invalid-argument', 'authcrypt (ECDH-1PU) requires A256CBC-HS512');
  }

  const ephemeral = generateKeyPair(curve);
  const ephemeralPrivate = privateKeyObject(ephemeral.privateJwk);
  const senderPrivate = sender ? privateKeyObject(sender) : undefined;

  const apv = computeApv(recipients.map((recipient) => recipient.kid));
  const protectedText = base64urlEncode(
    utf8Encode(
      JSON.stringify({
        typ: MEDIA_TYPE.encrypted,
        alg,
        enc: input.enc,
        ...(sender ? { apu: base64urlEncode(utf8Encode(sender.kid as string)), skid: sender.kid } : {}),
        apv,
        epk: {
          kty: ephemeral.publicJwk.kty,
          crv: ephemeral.publicJwk.crv,
          x: ephemeral.publicJwk.x,
          ...(ephemeral.publicJwk.y ? { y: ephemeral.publicJwk.y } : {}),
        },
      }),
    ),
  );

  // Content first: ECDH-1PU feeds the authentication tag into the derivation of every key-wrap key.
  const cek = generateCek(input.enc);
  const sealed = encryptContent(input.enc, cek, input.plaintext, Buffer.from(protectedText, 'ascii'));
  const apu = sender ? utf8Encode(sender.kid as string) : Buffer.alloc(0);

  return {
    protected: protectedText,
    recipients: recipients.map((recipient) => {
      const recipientPublic = publicKeyObject(recipient.publicJwk);
      const kek = deriveKeyEncryptionKey({
        alg,
        ze: ecdh(ephemeralPrivate, recipientPublic),
        zs: senderPrivate ? ecdh(senderPrivate, recipientPublic) : undefined,
        apu,
        apv: Buffer.from(apv, 'base64url'),
        tag: sender ? sealed.tag : undefined,
      });

      return {
        header: { kid: recipient.kid },
        encrypted_key: base64urlEncode(aesKeyWrap(kek, cek)),
      };
    }),
    iv: base64urlEncode(sealed.iv),
    ciphertext: base64urlEncode(sealed.ciphertext),
    tag: base64urlEncode(sealed.tag),
  };
}

/**
 * Decrypts with one recipient key. `senderPublic` is the key `skid` names, resolved by the caller
 * from the sender's DID document; it is required exactly for authcrypt. Everything that can go
 * wrong, from a point on the wrong curve to a flipped bit, is one `decryption-failed`.
 */
export function decryptJwe(jwe: ParsedJwe, recipient: PrivateJwk, senderPublic?: PublicJwk): Buffer {
  const failed = () => new DidcommError('decryption-failed', 'the message could not be decrypted');
  const entry = jwe.recipients.find((candidate) => candidate.kid === recipient.kid);

  if (!entry || recipient.crv !== jwe.epk.crv) {
    throw failed();
  }

  try {
    const recipientPrivate = privateKeyObject(recipient);
    const onePu = isAuthcrypt(jwe);

    if (onePu && (!senderPublic || senderPublic.crv !== jwe.epk.crv)) {
      throw failed();
    }

    const kek = deriveKeyEncryptionKey({
      alg: jwe.alg,
      ze: ecdh(recipientPrivate, publicKeyObject(jwe.epk)),
      zs: onePu && senderPublic ? ecdh(recipientPrivate, publicKeyObject(senderPublic)) : undefined,
      apu: jwe.apu,
      apv: jwe.apv,
      tag: onePu ? jwe.tag : undefined,
    });

    return decryptContent(
      jwe.enc,
      aesKeyUnwrap(kek, entry.encryptedKey),
      { ciphertext: jwe.ciphertext, iv: jwe.iv, tag: jwe.tag },
      Buffer.from(jwe.protectedText, 'ascii'),
    );
  } catch {
    throw failed();
  }
}
