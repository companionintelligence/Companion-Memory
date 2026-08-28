import { Entity, PrimaryColumn, Column, CreateDateColumn } from 'typeorm';

import type { AskAuditOutcome, AskQuery } from '../types';

/**
 * `ci.ask_audit` — one row per terminal ask outcome. Records who asked what of
 * whom, the consent basis, the outcome, and which of the owner's entities were
 * disclosed. Declines are logged too (the gate working is the point). Feeds the
 * Disclosure History surface and, later, ISO 27560 consent receipts.
 */
@Entity({ schema: 'ci', name: 'ask_audit' })
export class AskAuditEntity {
  @PrimaryColumn({ type: 'uuid', name: 'id' })
  id!: string;

  // Soft reference: nulled (not cascade-deleted) if the ask is ever removed, so
  // the audit row outlives the ask it records.
  @Column({ type: 'uuid', name: 'ask_id', nullable: true })
  askId!: string | null;

  /** NULL when the asker was a peer Companion (see {@link peerLinkId}). */
  @Column({ type: 'uuid', name: 'asker_user_id', nullable: true })
  askerUserId!: string | null;

  /** The peer that asked, for an inbound federated ask. FK-less by design. */
  @Column({ type: 'uuid', name: 'peer_link_id', nullable: true })
  peerLinkId!: string | null;

  /** The peer's handle at disclosure time, denormalized for the audit view. */
  @Column({ type: 'text', name: 'peer_handle', nullable: true })
  peerHandle!: string | null;

  /** NULL for an OUTBOUND ask — the responder is the peer, not a local user. */
  @Column({ type: 'uuid', name: 'responder_user_id', nullable: true })
  responderUserId!: string | null;

  @Column({ type: 'jsonb', name: 'query' })
  query!: AskQuery;

  @Column({ type: 'text', name: 'consent_basis', nullable: true })
  consentBasis!: string | null;

  @Column({ type: 'text', name: 'outcome' })
  outcome!: AskAuditOutcome;

  /**
   * The entity references that ACTUALLY crossed to the asker. Empty for every
   * form that does not itemize — which is most of them — because those answers
   * disclose a count or a yes/no and no references at all.
   */
  @Column({ type: 'jsonb', name: 'disclosed_entities', default: () => "'[]'::jsonb" })
  disclosedEntities!: string[];

  /**
   * HOW MANY items the asker actually received, post-ceiling.
   *
   * Not derivable from {@link disclosedEntities}, and that is the whole point:
   * only the `retrieval` form itemizes, so a `count` answer that handed over a
   * real magnitude audited as an empty list — an owner reading their disclosure
   * history saw "nothing was shared" for a disclosure that happened. The
   * magnitude lives on `ci.ask_answers` too, but that row is the answer payload
   * and is CASCADE-deleted with the ask; the audit outlives both and needs its
   * own copy.
   *
   * Zero for `declined` and `expired`, where nothing crossed at all.
   */
  @Column({ type: 'int', name: 'disclosed_count', default: 0 })
  disclosedCount!: number;

  /**
   * The entity ids the answer was computed over: post-redaction, PRE-ceiling.
   * Never disclosed to the asker — this is the owner's own record of what their
   * box read on the asker's behalf. Kept separate from
   * {@link disclosedEntities} because conflating the two made the audit
   * over-report every non-retrieval disclosure.
   */
  @Column({ type: 'jsonb', name: 'backing_entities', default: () => "'[]'::jsonb" })
  backingEntities!: string[];

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  static toEgressType(entity: AskAuditEntity): AskAudit {
    return {
      id: entity.id,
      askId: entity.askId,
      askerUserId: entity.askerUserId,
      peerLinkId: entity.peerLinkId,
      peerHandle: entity.peerHandle,
      responderUserId: entity.responderUserId,
      query: entity.query,
      consentBasis: entity.consentBasis,
      outcome: entity.outcome,
      disclosedEntities: entity.disclosedEntities,
      disclosedCount: entity.disclosedCount,
      backingEntities: entity.backingEntities,
      createdAt: entity.createdAt,
    };
  }
}

export type AskAudit = Readonly<AskAuditEntity>;
