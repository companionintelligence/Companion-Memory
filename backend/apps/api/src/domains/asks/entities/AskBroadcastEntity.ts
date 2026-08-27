import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

import type { AskQuery } from '../types';

/**
 * `ci.ask_broadcasts` — one question the asker put to several people at once.
 *
 * ═══ A CORRELATION, NOT A COMPOUND ASK ═══
 *
 * A broadcast is N INDEPENDENT `ci.asks` rows that happen to share an id. Each
 * responder is evaluated against their own grants, capped by their own tier,
 * reviewed in their own inbox, redacted by their own hand, and audited in their
 * own history. Nothing about the group changes what any one of them discloses.
 *
 * The alternative — one ask row with several responders — would mean one
 * consent decision, one ceiling and one audit row spanning several people's
 * memories. The strictest person's posture would either be overridden by the
 * group's or would silently cap everyone else's, and there is no version of
 * that which is not somebody's consent being decided by somebody else.
 *
 * ═══ THIS TABLE HOLDS NO MEMBER LIST ═══
 *
 * Deliberately. Who else was asked is a fact about the ASKER's relationships,
 * and a responder learning it would be a third-party disclosure nobody
 * consented to. The asks ARE the list, and they are already scoped per party —
 * so there is nothing here for a responder-scoped read to accidentally return.
 */
@Entity({ schema: 'ci', name: 'ask_broadcasts' })
export class AskBroadcastEntity {
  @PrimaryColumn({ type: 'uuid', name: 'id' })
  id!: string;

  @Column({ type: 'uuid', name: 'asker_user_id' })
  askerUserId!: string;

  /**
   * The question as written once.
   *
   * Denormalized onto every child ask as well, and that duplication is on
   * purpose: an ask must stay answerable and auditable on its own, and
   * `ci.ask_audit` outlives both parties and cannot depend on a join to a table
   * the asker may have deleted.
   */
  @Column({ type: 'jsonb', name: 'query' })
  query!: AskQuery;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @Column({ type: 'timestamptz', name: 'expires_at', nullable: true })
  expiresAt!: Date | null;

  static toEgressType(entity: AskBroadcastEntity): AskBroadcast {
    return {
      id: entity.id,
      askerUserId: entity.askerUserId,
      query: entity.query,
      createdAt: entity.createdAt,
      expiresAt: entity.expiresAt,
    };
  }
}

export type AskBroadcast = Readonly<AskBroadcastEntity>;
