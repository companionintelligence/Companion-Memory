import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

/**
 * `ci.peer_ask_correlations` — the asker-minted `askId` that identifies one
 * federated ask, bound to the local `ci.asks` row it produced.
 *
 * ═══ WHY A TABLE AND NOT A COLUMN ON `ci.asks` ═══
 *
 * The correlation is a property of the RELATIONSHIP, not of the ask: it is only
 * unique per peer link (two peers may independently mint the same uuid, and one
 * must never be able to collect the other's answer), and it exists only for the
 * federated direction. `ci.asks` is the local ask vocabulary that
 * `domains/asks` owns; a peer's opaque correlation string is federation state
 * and lives with the peer links it is scoped by.
 *
 * ═══ THE DIGEST IS WHAT STOPS A KEY ANSWERING THE WRONG QUESTION ═══
 *
 * An idempotency key that only mapped `askId → ask` would let a peer reuse one
 * key for a DIFFERENT question and be handed the first question's answer. That
 * discloses nothing new — it is a replay of something already sent to that same
 * peer — but it is still an answer to a question nobody asked. The digest binds
 * the key to the request that created it: a repeat carrying different bytes is
 * refused as malformed rather than answered.
 *
 * Both directions use this table. On the RESPONDER it records the ask a peer's
 * correlation id created, so a repeat can be replayed and a poll can be
 * answered. On the ASKER it records the id this box minted, which is the only
 * way a later poll can name the ask again after the send returned.
 *
 * ═══ WHAT AN INTERLEAVED FAILURE LEAVES BEHIND, ON PURPOSE ═══
 *
 * The inbound row is written immediately AFTER `AskService.create`, not inside
 * a transaction with it: the FK points at `ci.asks`, so the correlation cannot
 * be written first, and `AskService.create` takes no `EntityManager` — the
 * alternative would be a second copy of the ask-creation rules in this domain,
 * which is exactly what `PeerAskService.persistDisclosure` refuses to do for
 * the lifecycle.
 *
 * So a crash between the two leaves an inbound ask at `delivered` that no
 * repeat and no poll can name. That is the SAFE direction: the ask was never
 * evaluated, nothing was executed against the owner's memory, no audit row
 * claims a disclosure, and `AskExpiryService` retires it. The peer's retry
 * creates a fresh ask and gets a real answer. The failure costs one orphan row;
 * the reverse ordering would cost a correlation pointing at an ask that does
 * not exist.
 */
@Entity({ schema: 'ci', name: 'peer_ask_correlations' })
export class PeerAskCorrelationEntity {
  @PrimaryColumn({ type: 'uuid', name: 'id' })
  id!: string;

  @Column({ type: 'uuid', name: 'peer_link_id' })
  peerLinkId!: string;

  /** The asker-minted correlation id, opaque to the responder. */
  @Column({ type: 'text', name: 'correlation_id' })
  correlationId!: string;

  @Column({ type: 'uuid', name: 'ask_id' })
  askId!: string;

  /** sha256 of the canonical request, so one key can only ever mean one question. */
  @Column({ type: 'text', name: 'request_digest' })
  requestDigest!: string;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  static toEgressType(entity: PeerAskCorrelationEntity): PeerAskCorrelation {
    return {
      id: entity.id,
      peerLinkId: entity.peerLinkId,
      correlationId: entity.correlationId,
      askId: entity.askId,
      requestDigest: entity.requestDigest,
      createdAt: entity.createdAt,
    };
  }
}

export type PeerAskCorrelation = Readonly<PeerAskCorrelationEntity>;
