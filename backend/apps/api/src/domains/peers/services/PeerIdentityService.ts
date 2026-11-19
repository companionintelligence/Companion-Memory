import { createPrivateKey, generateKeyPairSync, type KeyObject } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { LoggerService } from '@ci/common/logging';

import { didKeyIdFor } from '../didKeyId';
import { PeerIdentityKeyEntity } from '../entities/PeerIdentityKeyEntity';

/** What signs a peer request on one person's behalf. `keyid` is their `did:key`. */
export interface PeerSigner {
  key: KeyObject;
  keyid: string;
}

/** One person's peer identity: their `did:key` and a signer for it. */
export interface PeerIdentity {
  userId: string;
  didKey: string;
  publicJwk: Record<string, unknown>;
  signer: PeerSigner;
}

/** The unique index that keeps one live key per person. */
const ACTIVE_CONSTRAINT = 'peer_identity_keys_user_active_uniq';

/**
 * Each person's own peer signing key, made the first time it is needed.
 *
 * ═══ WHY PER PERSON, NOT PER BOX ═══
 *
 * The box key (`peers.signingKeyJwk`) speaks for the whole box, so a peer that
 * verified it learnt only "someone on that box", and `OutboundAskService` had to
 * restrict sending with it to the administrator. A key per person makes the
 * signature say WHO asked: the other side links that person's `did:key`, and
 * every household member can link and ask as themselves.
 *
 * The box key is left alone. It still signs Trust Task responses, which are the
 * box's own statements.
 *
 * The private half is stored encrypted (`encryptedColumnTransformer`) and never
 * leaves this service as anything but a `KeyObject`.
 */
@Injectable()
export class PeerIdentityService {
  constructor(
    @InjectRepository(PeerIdentityKeyEntity)
    private readonly repository: Repository<PeerIdentityKeyEntity>,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(PeerIdentityService.name);
  }

  /** This person's live identity, made now if they have none yet. */
  async identityFor(userId: string): Promise<PeerIdentity> {
    const existing = await this.repository.findOne({ where: { userId, status: 'active' } });
    if (existing != null) {
      return toIdentity(existing);
    }

    try {
      return toIdentity(await this.repository.save(newKeyRow(userId)));
    } catch (error) {
      // Two first uses at once (two tabs, an ask and an invite): the index lets
      // one key through and the other reads it, so the person ends up with one.
      if (constraintOf(error) === ACTIVE_CONSTRAINT) {
        const winner = await this.repository.findOne({ where: { userId, status: 'active' } });
        if (winner != null) {
          return toIdentity(winner);
        }
      }

      throw error;
    }
  }

  /**
   * The person a LIVE `did:key` belongs to on this box, or null. A retired key
   * answers null: it is nobody's identity any more.
   */
  async findActiveByDidKey(didKey: string): Promise<PeerIdentity | null> {
    if (!didKey.startsWith('did:key:')) {
      return null;
    }

    const row = await this.repository.findOne({ where: { didKey, status: 'active' } });

    return row == null ? null : toIdentity(row);
  }

  /** This person's live `did:key`, or null when they have never needed one. Makes nothing. */
  async existingDidKeyFor(userId: string): Promise<string | null> {
    const row = await this.repository.findOne({ where: { userId, status: 'active' } });

    return row?.didKey ?? null;
  }
}

/** A fresh key row for `userId`. Loops only in the astronomically unlikely case the key has no did:key. */
export function newKeyRow(userId: string): PeerIdentityKeyEntity {
  for (;;) {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const publicJwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
    const didKey = didKeyIdFor(publicJwk);
    if (didKey == null) {
      continue;
    }

    const row = new PeerIdentityKeyEntity();
    row.id = uuidv7();
    row.userId = userId;
    row.didKey = didKey;
    row.publicJwk = { crv: publicJwk.crv, kty: publicJwk.kty, x: publicJwk.x };
    row.privateJwk = JSON.stringify(privateKey.export({ format: 'jwk' }));
    row.status = 'active';
    row.retiredAt = null;

    return row;
  }
}

export function toIdentity(row: PeerIdentityKeyEntity): PeerIdentity {
  const key = createPrivateKey({ key: JSON.parse(row.privateJwk) as never, format: 'jwk' });

  return {
    userId: row.userId,
    didKey: row.didKey,
    publicJwk: row.publicJwk,
    signer: { key, keyid: row.didKey },
  };
}

function constraintOf(error: unknown): unknown {
  const candidate = error as { code?: unknown; constraint?: unknown; driverError?: { code?: unknown; constraint?: unknown } };

  if ((candidate?.driverError?.code ?? candidate?.code) !== '23505') {
    return null;
  }

  return candidate?.driverError?.constraint ?? candidate?.constraint;
}
