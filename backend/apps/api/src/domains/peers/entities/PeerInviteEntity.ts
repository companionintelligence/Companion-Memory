import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

/** One invite an owner made. See `20261119183221_add_peer_invites.sql`. The secret itself is never stored. */
@Entity({ schema: 'ci', name: 'peer_invites' })
export class PeerInviteEntity {
  @PrimaryColumn({ type: 'uuid', name: 'id' })
  id!: string;

  @Column({ type: 'uuid', name: 'owner_user_id' })
  ownerUserId!: string;

  @Column({ type: 'text', name: 'secret_hash' })
  secretHash!: string;

  @Column({ type: 'text', name: 'inviter_did_key' })
  inviterDidKey!: string;

  @Column({ type: 'text', name: 'inviter_name' })
  inviterName!: string;

  @Column({ type: 'text', name: 'label', nullable: true })
  label!: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @Column({ type: 'timestamptz', name: 'expires_at' })
  expiresAt!: Date;

  @Column({ type: 'timestamptz', name: 'used_at', nullable: true })
  usedAt!: Date | null;

  @Column({ type: 'uuid', name: 'used_link_id', nullable: true })
  usedLinkId!: string | null;

  @Column({ type: 'timestamptz', name: 'revoked_at', nullable: true })
  revokedAt!: Date | null;
}

export type PeerInviteStatus = 'pending' | 'used' | 'expired' | 'revoked';

export function inviteStatus(invite: PeerInviteEntity, now: Date = new Date()): PeerInviteStatus {
  if (invite.usedAt != null) {
    return 'used';
  }

  if (invite.revokedAt != null) {
    return 'revoked';
  }

  return invite.expiresAt.getTime() <= now.getTime() ? 'expired' : 'pending';
}
