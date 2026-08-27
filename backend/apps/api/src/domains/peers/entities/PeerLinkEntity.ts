import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

import type { TrustTier } from '@ci/domains/asks';

/**
 * The trust tiers a PEER link may carry — every {@link TrustTier} except
 * `household`.
 *
 * ═══ WHICH OF THE TWO WAS WRONG, AND WHY IT IS THE TYPE ═══
 *
 * `ci.peer_links.trust_tier` CHECKs four values; `TrustTier` in `domains/asks`
 * has five. The extra one is `household`, and it is not an oversight in the
 * CHECK: `household` means "a member of the owner's OWN box"
 * (`AskResolver.resolveTier` returns it for a LOCAL ask, where there is no peer
 * link at all), and it carries the widest ceiling in `TIER_CEILINGS` —
 * `{'*': 'full'}`, the only tier exempt from the sensitive-class floor. A
 * household member across a box boundary is not merely unusual; it is a
 * contradiction that would hand a REMOTE box the tier reserved for people who
 * share the appliance. Widening the CHECK to five would have made that
 * writable.
 *
 * So the type narrows, and it now narrows BY CONSTRUCTION rather than by
 * coincidence. `PeerTrustTier` used to be a second hand-maintained list that
 * happened to agree with the CHECK; `Exclude<TrustTier, 'household'>` cannot
 * silently drift when a sixth tier is added — a new tier is admitted here
 * automatically and the CHECK will then reject it loudly at the first write,
 * which is the failure you want, in a migration you are already writing.
 *
 * The runtime half is {@link isPeerTrustTier}. A type alone stops nothing at a
 * boundary where the value arrives as JSON from a directory descriptor: without
 * it the CHECK fires as a `23514` — an unhandled driver error surfaced as
 * `500 Internal server error` — instead of a validation failure.
 */
export const PEER_TRUST_TIERS = ['family', 'trusted', 'peer', 'stranger'] as const;

export type PeerTrustTier = (typeof PEER_TRUST_TIERS)[number];

/**
 * Compile-time proof that the two lists above agree with `TrustTier`, in both
 * directions. Either half failing is a type error at build time rather than a
 * `23514` at runtime, which is the entire point:
 *
 *   - the first says every peer tier is a real trust tier (no invented value);
 *   - the second says every trust tier except `household` is a peer tier (a
 *     sixth tier cannot be quietly excluded from federation);
 *   - the third says `household` is not one of them. Without it the other two
 *     both still hold when `household` is added back, because it IS a
 *     `TrustTier` — so the direction that actually matters, widening this list
 *     until the CHECK rejects it, would compile.
 */
type _PeerTiersAreTrustTiers = PeerTrustTier extends TrustTier ? true : never;
type _PeerTiersCoverAllButHousehold = Exclude<TrustTier, 'household'> extends PeerTrustTier ? true : never;
type _HouseholdIsNotAPeerTier = 'household' extends PeerTrustTier ? never : true;
const _tierAgreement: [_PeerTiersAreTrustTiers, _PeerTiersCoverAllButHousehold, _HouseholdIsNotAPeerTier] = [
  true,
  true,
  true,
];
void _tierAgreement;

/** Runtime guard, for values that arrive as JSON rather than as a type. */
export function isPeerTrustTier(value: unknown): value is PeerTrustTier {
  return typeof value === 'string' && (PEER_TRUST_TIERS as readonly string[]).includes(value);
}

export type PeerLinkStatus = 'pending' | 'active' | 'revoked';

/**
 * `ci.peer_links` — a peer Companion this box exchanges asks with. Each box
 * holds its own links; CI-Portal provides discovery (handle → endpoint +
 * issuer) but never the relationships themselves.
 */
@Entity({ schema: 'ci', name: 'peer_links' })
export class PeerLinkEntity {
  @PrimaryColumn({ type: 'uuid', name: 'id' })
  id!: string;

  @Column({ type: 'uuid', name: 'owner_user_id' })
  ownerUserId!: string;

  @Column({ type: 'text', name: 'peer_handle' })
  peerHandle!: string;

  @Column({ type: 'text', name: 'display_name', nullable: true })
  displayName!: string | null;

  @Column({ type: 'text', name: 'memory_endpoint' })
  memoryEndpoint!: string;

  @Column({ type: 'text', name: 'peer_issuer', nullable: true })
  peerIssuer!: string | null;

  @Column({ type: 'text', name: 'peer_subject', nullable: true })
  peerSubject!: string | null;

  /**
   * The peer's Ed25519 PUBLIC key as a JWK, and its RFC 7638 thumbprint.
   *
   * The thumbprint is the identity an RFC 9421 signature names in `keyid`, and
   * it is denormalized rather than derived per request because it is the LOOKUP
   * key -- resolving an inbound signature must be one index hit, not a scan
   * that hashes every peer's key.
   *
   * Nullable, and null for every link that predates signing. A link with no key
   * authenticates exactly as it always did (Portal OIDC bearer), which is what
   * keeps `peers.requireHttpSignature` a rollout switch rather than a breaking
   * change. `publicKeyFromJwk` refuses a JWK carrying `d`, so a private key
   * cannot be stored here and then used to verify its own signatures.
   */
  @Column({ type: 'jsonb', name: 'peer_key_jwk', nullable: true })
  peerKeyJwk!: Record<string, unknown> | null;

  @Column({ type: 'text', name: 'peer_key_thumbprint', nullable: true })
  peerKeyThumbprint!: string | null;

  /** The person in the owner's memory graph this peer corresponds to. */
  @Column({ type: 'uuid', name: 'person_entity_id', nullable: true })
  personEntityId!: string | null;

  @Column({ type: 'text', name: 'trust_tier', default: 'peer' })
  trustTier!: PeerTrustTier;

  @Column({ type: 'text', name: 'status', default: 'active' })
  status!: PeerLinkStatus;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;

  @Column({ type: 'timestamptz', name: 'revoked_at', nullable: true })
  revokedAt!: Date | null;

  static toEgressType(entity: PeerLinkEntity): PeerLink {
    return {
      id: entity.id,
      ownerUserId: entity.ownerUserId,
      peerHandle: entity.peerHandle,
      displayName: entity.displayName,
      memoryEndpoint: entity.memoryEndpoint,
      peerIssuer: entity.peerIssuer,
      peerSubject: entity.peerSubject,
      peerKeyJwk: entity.peerKeyJwk,
      peerKeyThumbprint: entity.peerKeyThumbprint,
      personEntityId: entity.personEntityId,
      trustTier: entity.trustTier,
      status: entity.status,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
      revokedAt: entity.revokedAt,
    };
  }
}

export type PeerLink = Readonly<PeerLinkEntity>;
