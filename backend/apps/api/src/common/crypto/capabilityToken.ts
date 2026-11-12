import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';

import { canonicalizeJcs } from './jcs';

/**
 * Offline-attenuable Ed25519 Capability Token (Biscuit-style chained block delegation).
 *
 * Block 0 is signed by the root authority. Each subsequent block is signed by the ephemeral
 * private key whose public key (`nextKey`) was committed in the preceding block, and commits
 * its own `nextKey` for further attenuation. Verification checks every block signature and
 * enforces monotonic narrowing: scopes, resourcePrefix, and expiresAt can only restrict.
 */

export interface CapabilityCaveat {
  scopes?: string[];
  resourcePrefix?: string;
  expiresAt?: string;
  note?: string;
}

export interface CapabilityBlock {
  subject: string;
  scopes: string[];
  resourcePrefix: string;
  expiresAt: string;
  nextPublicKeyDerB64: string;
  signatureB64: string;
  note?: string;
}

export interface CapabilityToken {
  version: 'ci-cap-v1';
  blocks: CapabilityBlock[];
  /** Ephemeral private key (PKCS8 DER base64url) for the holder to attenuate further. */
  holderPrivateKeyDerB64?: string;
}

export interface MintCapabilityOptions {
  subject: string;
  scopes: string[];
  resourcePrefix?: string;
  expiresAt: string;
  note?: string;
}

export interface VerifyCapabilityRequirement {
  scope?: string;
  resource?: string;
  nowMs?: number;
}

export type VerifyCapabilityResult =
  | {
      valid: true;
      subject: string;
      scopes: string[];
      resourcePrefix: string;
      expiresAt: string;
      depth: number;
    }
  | {
      valid: false;
      reason: string;
    };

function exportPublicDerB64(pub: KeyObject): string {
  return Buffer.from(pub.export({ type: 'spki', format: 'der' })).toString('base64url');
}

function exportPrivateDerB64(priv: KeyObject): string {
  return Buffer.from(priv.export({ type: 'pkcs8', format: 'der' })).toString('base64url');
}

function importPublicDerB64(b64: string): KeyObject {
  return createPublicKey({ key: Buffer.from(b64, 'base64url'), format: 'der', type: 'spki' });
}

function importPrivateDerB64(b64: string): KeyObject {
  return createPrivateKey({ key: Buffer.from(b64, 'base64url'), format: 'der', type: 'pkcs8' });
}

function blockSigningBytes(
  block: Omit<CapabilityBlock, 'signatureB64'>,
  prevSignatureB64: string | null,
): Buffer {
  const payload = canonicalizeJcs({
    prevSignatureB64,
    subject: block.subject,
    scopes: block.scopes,
    resourcePrefix: block.resourcePrefix,
    expiresAt: block.expiresAt,
    nextPublicKeyDerB64: block.nextPublicKeyDerB64,
    ...(block.note !== undefined ? { note: block.note } : {}),
  });

  return Buffer.from(payload, 'utf8');
}

/** Mints a root capability token signed by the root Ed25519 private key. */
export function mintRootCapabilityToken(
  authorityPrivateKey: KeyObject,
  options: MintCapabilityOptions,
): CapabilityToken {
  const { publicKey: nextPub, privateKey: nextPriv } = generateKeyPairSync('ed25519');
  const unsigned: Omit<CapabilityBlock, 'signatureB64'> = {
    subject: options.subject,
    scopes: [...new Set(options.scopes)].sort(),
    resourcePrefix: options.resourcePrefix ?? '/',
    expiresAt: options.expiresAt,
    nextPublicKeyDerB64: exportPublicDerB64(nextPub),
    ...(options.note !== undefined ? { note: options.note } : {}),
  };
  const sig = sign(null, blockSigningBytes(unsigned, null), authorityPrivateKey).toString('base64url');

  return {
    version: 'ci-cap-v1',
    blocks: [{ ...unsigned, signatureB64: sig }],
    holderPrivateKeyDerB64: exportPrivateDerB64(nextPriv),
  };
}

/**
 * Offline attenuation: narrows an existing capability token without contacting the authority.
 * Strips the holder key from the returned token if `seal` is true (cannot be attenuated further).
 */
export function attenuateCapabilityToken(
  token: CapabilityToken,
  caveat: CapabilityCaveat,
  options: { seal?: boolean } = {},
): CapabilityToken {
  if (!token.holderPrivateKeyDerB64) {
    throw new Error('Capability token is sealed and carries no holder attenuation key');
  }

  if (token.blocks.length === 0) {
    throw new Error('Capability token has no root block');
  }

  const prev = token.blocks[token.blocks.length - 1]!;
  const signingKey = importPrivateDerB64(token.holderPrivateKeyDerB64);
  const { publicKey: nextPub, privateKey: nextPriv } = generateKeyPairSync('ed25519');

  const narrowedScopes = caveat.scopes
    ? [...new Set(caveat.scopes)].filter((s) => prev.scopes.includes(s)).sort()
    : [...prev.scopes];

  const narrowedResourcePrefix =
    caveat.resourcePrefix && caveat.resourcePrefix.startsWith(prev.resourcePrefix)
      ? caveat.resourcePrefix
      : prev.resourcePrefix;

  const prevExpMs = Date.parse(prev.expiresAt);
  const caveatExpMs = caveat.expiresAt ? Date.parse(caveat.expiresAt) : prevExpMs;
  const effectiveExpMs = Number.isFinite(caveatExpMs) && caveatExpMs < prevExpMs ? caveatExpMs : prevExpMs;

  const unsigned: Omit<CapabilityBlock, 'signatureB64'> = {
    subject: prev.subject,
    scopes: narrowedScopes,
    resourcePrefix: narrowedResourcePrefix,
    expiresAt: new Date(effectiveExpMs).toISOString(),
    nextPublicKeyDerB64: exportPublicDerB64(nextPub),
    ...(caveat.note !== undefined ? { note: caveat.note } : {}),
  };
  const sig = sign(null, blockSigningBytes(unsigned, prev.signatureB64), signingKey).toString('base64url');

  return {
    version: 'ci-cap-v1',
    blocks: [...token.blocks, { ...unsigned, signatureB64: sig }],
    ...(options.seal ? {} : { holderPrivateKeyDerB64: exportPrivateDerB64(nextPriv) }),
  };
}

/**
 * Verifies the full cryptographic block chain and monotonic attenuation invariants of a capability token.
 */
export function verifyCapabilityToken(
  token: CapabilityToken,
  rootPublicKey: KeyObject,
  required: VerifyCapabilityRequirement = {},
): VerifyCapabilityResult {
  if (!token || token.version !== 'ci-cap-v1' || !Array.isArray(token.blocks) || token.blocks.length === 0) {
    return { valid: false, reason: 'malformed capability token' };
  }

  let currentKey = rootPublicKey;
  let prevSig: string | null = null;
  let effectiveScopes: string[] = [];
  let effectivePrefix = '/';
  let effectiveExpMs = Number.POSITIVE_INFINITY;
  let subject = '';

  for (let i = 0; i < token.blocks.length; i += 1) {
    const block = token.blocks[i]!;
    const { signatureB64, ...unsigned } = block;
    let ok: boolean;
    try {
      ok = verify(
        null,
        blockSigningBytes(unsigned, prevSig),
        currentKey,
        Buffer.from(signatureB64, 'base64url'),
      );
    } catch {
      ok = false;
    }

    if (!ok) {
      return { valid: false, reason: `invalid signature on block ${i}` };
    }

    const expMs = Date.parse(block.expiresAt);
    if (!Number.isFinite(expMs)) {
      return { valid: false, reason: `invalid expiresAt on block ${i}` };
    }

    if (i === 0) {
      subject = block.subject;
      effectiveScopes = [...block.scopes];
      effectivePrefix = block.resourcePrefix;
      effectiveExpMs = expMs;
    } else {
      if (block.subject !== subject) {
        return { valid: false, reason: `block ${i} attempted to change subject` };
      }

      if (!block.scopes.every((s) => effectiveScopes.includes(s))) {
        return { valid: false, reason: `block ${i} attempted to widen scopes` };
      }

      if (!block.resourcePrefix.startsWith(effectivePrefix)) {
        return { valid: false, reason: `block ${i} attempted to widen resourcePrefix` };
      }

      if (expMs > effectiveExpMs) {
        return { valid: false, reason: `block ${i} attempted to extend expiresAt` };
      }

      effectiveScopes = [...block.scopes];
      effectivePrefix = block.resourcePrefix;
      effectiveExpMs = expMs;
    }

    try {
      currentKey = importPublicDerB64(block.nextPublicKeyDerB64);
    } catch {
      return { valid: false, reason: `invalid nextPublicKey on block ${i}` };
    }

    prevSig = signatureB64;
  }

  const nowMs = required.nowMs ?? Date.now();
  if (nowMs >= effectiveExpMs) {
    return { valid: false, reason: 'capability token expired' };
  }

  if (required.scope && !effectiveScopes.includes(required.scope)) {
    return { valid: false, reason: `missing required scope: ${required.scope}` };
  }

  if (required.resource && !required.resource.startsWith(effectivePrefix)) {
    return {
      valid: false,
      reason: `resource ${required.resource} outside allowed prefix ${effectivePrefix}`,
    };
  }

  return {
    valid: true,
    subject,
    scopes: effectiveScopes,
    resourcePrefix: effectivePrefix,
    expiresAt: new Date(effectiveExpMs).toISOString(),
    depth: token.blocks.length,
  };
}
