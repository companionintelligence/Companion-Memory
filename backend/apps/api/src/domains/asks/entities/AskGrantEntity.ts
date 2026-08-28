import { Entity, PrimaryColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

import type { AskGrantResourceType, AskGrantScope, GrantMode, GrantRevocationReason } from '../types';

/**
 * `ci.ask_grants` — standing consent for the ask path. Replaces reliance on the
 * single `saved_searches.is_public` boolean with a per-grantee, per-query-type
 * grant whose `mode` selects the Grant Manager's three-state posture
 * (auto / review / block).
 *
 * Rows are **append-only from the owner's point of view**: a grant is revoked
 * (`revokedAt`) or lapses (`expiresAt`), and CHANGING one writes a new row that
 * points back at its predecessor via `supersedesGrantId` rather than mutating in
 * place. Consent history is evidence — an UPDATE would erase what the owner
 * previously allowed and for how long, which is precisely what a disclosure
 * audit has to be able to reconstruct.
 */
@Entity({ schema: 'ci', name: 'ask_grants' })
export class AskGrantEntity {
  @PrimaryColumn({ type: 'uuid', name: 'id' })
  id!: string;

  @Column({ type: 'uuid', name: 'owner_user_id' })
  ownerUserId!: string;

  /**
   * The local user this grant is for. Exactly one of `granteeUserId` /
   * `granteePeerLinkId` is set — a grant addresses either a household member
   * or a linked peer Companion.
   */
  @Column({ type: 'uuid', name: 'grantee_user_id', nullable: true })
  granteeUserId!: string | null;

  /** The peer link this grant is for (federated asks). */
  @Column({ type: 'uuid', name: 'grantee_peer_link_id', nullable: true })
  granteePeerLinkId!: string | null;

  /**
   * The single object this grant covers, when it covers an object rather than a
   * class of question. Both columns are set together or neither is
   * (`ask_grants_resource_paired_chk`).
   *
   * A grant is normally addressed by (`queryType`, `dataClass`) — "photos, from
   * Dana". A SHARED SAVED SEARCH is not a class of question but one specific
   * row, and folding it into `dataClass` would have run a uuid through
   * `canonicalDataClass` (a normalizer for words like 'photos') and matched it
   * against the tier ceiling tables keyed on that same vocabulary.
   */
  @Column({ type: 'text', name: 'resource_type', nullable: true })
  resourceType!: AskGrantResourceType | null;

  @Column({ type: 'uuid', name: 'resource_id', nullable: true })
  resourceId!: string | null;

  @Column({ type: 'text', name: 'query_type' })
  queryType!: string;

  @Column({ type: 'text', name: 'data_class', nullable: true })
  dataClass!: string | null;

  @Column({ type: 'jsonb', name: 'scope', nullable: true })
  scope!: AskGrantScope | null;

  @Column({ type: 'text', name: 'mode', default: 'review' })
  mode!: GrantMode;

  @Column({ type: 'text', name: 'purpose', nullable: true })
  purpose!: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;

  /**
   * When the owner withdrew this grant. An EVENT, never a schedule — see
   * {@link expiresAt}, and `isGrantActive` in grantMatch.ts for why a future
   * value here must not be read as "still active".
   */
  @Column({ type: 'timestamptz', name: 'revoked_at', nullable: true })
  revokedAt!: Date | null;

  /**
   * Scheduled lapse — the Grant Manager's "Expires {date}". NULL means the grant
   * stands until revoked. Distinct from {@link revokedAt} so the audit can tell
   * "I withdrew this" from "this ran out".
   */
  @Column({ type: 'timestamptz', name: 'expires_at', nullable: true })
  expiresAt!: Date | null;

  /** Why the grant stopped being in force; only set alongside `revokedAt`. */
  @Column({ type: 'text', name: 'revocation_reason', nullable: true })
  revocationReason!: GrantRevocationReason | null;

  /** 1 for an original grant, incremented by each supersede. */
  @Column({ type: 'int', name: 'version', default: 1 })
  version!: number;

  /** The grant this row replaced, when it was written by a change (not a create). */
  @Column({ type: 'uuid', name: 'supersedes_grant_id', nullable: true })
  supersedesGrantId!: string | null;

  static toEgressType(entity: AskGrantEntity): AskGrant {
    return {
      id: entity.id,
      ownerUserId: entity.ownerUserId,
      granteeUserId: entity.granteeUserId,
      granteePeerLinkId: entity.granteePeerLinkId,
      resourceType: entity.resourceType,
      resourceId: entity.resourceId,
      queryType: entity.queryType,
      dataClass: entity.dataClass,
      scope: entity.scope,
      mode: entity.mode,
      purpose: entity.purpose,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
      revokedAt: entity.revokedAt,
      expiresAt: entity.expiresAt,
      revocationReason: entity.revocationReason,
      version: entity.version,
      supersedesGrantId: entity.supersedesGrantId,
    };
  }
}

export type AskGrant = Readonly<AskGrantEntity>;
