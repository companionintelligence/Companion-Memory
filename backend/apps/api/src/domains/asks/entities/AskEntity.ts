import { Entity, PrimaryColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

import type { AskDirection, AskQuery, AskStatus, DisclosureRung } from '../types';

/**
 * `ci.asks` — an interpersonal question directed at another user's memory.
 * Distinct from `ci.questions` (descriptive self-analytics): here the asker is
 * not the record owner, so asker and responder are tracked separately.
 */
@Entity({ schema: 'ci', name: 'asks' })
export class AskEntity {
  @PrimaryColumn({ type: 'uuid', name: 'id' })
  id!: string;

  /**
   * The local user asking. NULL for an inbound peer ask, where the asker is a
   * peer Companion identified by {@link peerLinkId} instead — minting a shadow
   * local user per peer would let anyone reachable on the Portal accumulate an
   * account on every box they can talk to.
   */
  @Column({ type: 'uuid', name: 'asker_user_id', nullable: true })
  askerUserId!: string | null;

  /**
   * Correlates asks the asker sent as ONE question to several people.
   *
   * Projected to the ASKER only. Who else was asked is a fact about the asker's
   * relationships, and telling a responder would be a third-party disclosure
   * nobody consented to — the same reasoning that keeps `consentBasis`
   * responder-only, pointed the other way.
   */
  @Column({ type: 'uuid', name: 'broadcast_id', nullable: true })
  broadcastId!: string | null;

  /** The peer this ask came from (inbound) or was sent to (outbound). */
  @Column({ type: 'uuid', name: 'peer_link_id', nullable: true })
  peerLinkId!: string | null;

  @Column({ type: 'text', name: 'direction', default: 'local' })
  direction!: AskDirection;

  /** NULL for an OUTBOUND ask — the responder is the peer, not a local user. */
  @Column({ type: 'uuid', name: 'responder_user_id', nullable: true })
  responderUserId!: string | null;

  @Column({ type: 'jsonb', name: 'query' })
  query!: AskQuery;

  @Column({ type: 'text', name: 'status' })
  status!: AskStatus;

  @Column({ type: 'text', name: 'consent_basis', nullable: true })
  consentBasis!: string | null;

  /**
   * The disclosure ceiling in force WHEN CONSENT WAS GIVEN — stamped at submit
   * on the auto path and at `approve()` on the review path, never re-derived.
   *
   * This exists because the answer path used to re-run the grant evaluation to
   * find the ceiling, and a revoked or lapsed grant is invisible to every SQL
   * read path — so withdrawing consent DELETED the cap instead of keeping it,
   * and the answer to an already-approved ask grew. See the migration
   * `20260821010000_add_ask_disclosure_ceiling.sql`.
   *
   * NULL means "no grant capped this ask when the owner consented", not
   * "unknown": the answer path falls back to the live evaluation for it. The
   * two sources are combined by taking the NARROWER, so a later revocation can
   * tighten the answer and can never widen it.
   */
  @Column({ type: 'text', name: 'disclosure_ceiling', nullable: true })
  disclosureCeiling!: DisclosureRung | null;

  /**
   * HOW this ask arrived — the channel facts, beside the consent facts above.
   *
   * NULL across all three means the ask came in over an UNSIGNED channel, which
   * is a real answer and not an absence: `peers.requireHttpSignature` ships off,
   * and a local ask never crosses a network boundary at all. The surfaces say
   * "unsigned" plainly rather than leaving a blank, because an owner who cannot
   * tell "unsigned" from "not recorded" cannot use the distinction.
   *
   * Denormalized AS OF ARRIVAL. Re-reading the peer link later would report the
   * key the peer uses NOW, and an audit that quietly updates itself when a key
   * is rotated cannot answer "what signed this at the time".
   */
  @Column({ type: 'text', name: 'channel_key_thumbprint', nullable: true })
  channelKeyThumbprint!: string | null;

  @Column({ type: 'timestamptz', name: 'channel_verified_at', nullable: true })
  channelVerifiedAt!: Date | null;

  /** The signature base's covered components, as actually presented. */
  @Column({ type: 'text', array: true, name: 'channel_covered', nullable: true })
  channelCovered!: string[] | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;

  @Column({ type: 'timestamptz', name: 'expires_at', nullable: true })
  expiresAt!: Date | null;

  static toEgressType(entity: AskEntity): Ask {
    return {
      id: entity.id,
      askerUserId: entity.askerUserId,
      broadcastId: entity.broadcastId ?? null,
      peerLinkId: entity.peerLinkId,
      direction: entity.direction,
      responderUserId: entity.responderUserId,
      query: entity.query,
      status: entity.status,
      consentBasis: entity.consentBasis,
      disclosureCeiling: entity.disclosureCeiling ?? null,
      channelKeyThumbprint: entity.channelKeyThumbprint ?? null,
      channelVerifiedAt: entity.channelVerifiedAt ?? null,
      channelCovered: entity.channelCovered ?? null,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
      expiresAt: entity.expiresAt,
    };
  }
}

export type Ask = Readonly<AskEntity>;
