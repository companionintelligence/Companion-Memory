import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

import { encryptedColumnTransformer } from '@ci/common/crypto/field-encryption';

export type PeerIdentityKeyStatus = 'active' | 'retired';

/**
 * One person's peer signing key: an Ed25519 key whose `did:key` is who they
 * are to other boxes. See `20261119181248_add_peer_identity_keys.sql`.
 *
 * Never leaves the peers domain as an entity: `PeerIdentityService` hands out a
 * signer (the `KeyObject`) or the public half, never the stored private JWK.
 */
@Entity({ schema: 'ci', name: 'peer_identity_keys' })
export class PeerIdentityKeyEntity {
  @PrimaryColumn({ type: 'uuid', name: 'id' })
  id!: string;

  @Column({ type: 'uuid', name: 'user_id' })
  userId!: string;

  @Column({ type: 'text', name: 'did_key' })
  didKey!: string;

  @Column({ type: 'jsonb', name: 'public_jwk' })
  publicJwk!: Record<string, unknown>;

  /** The private JWK as JSON. Encrypted at rest by the transformer. */
  @Column({ type: 'text', name: 'private_jwk', transformer: encryptedColumnTransformer })
  privateJwk!: string;

  @Column({ type: 'text', name: 'status', default: 'active' })
  status!: PeerIdentityKeyStatus;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @Column({ type: 'timestamptz', name: 'retired_at', nullable: true })
  retiredAt!: Date | null;
}
