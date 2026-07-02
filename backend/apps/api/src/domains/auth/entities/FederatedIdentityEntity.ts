import { Entity, Column, PrimaryColumn, CreateDateColumn } from 'typeorm';

/**
 * Binds an external OIDC identity (issuer + subject) to a local CI-Server user.
 *
 * CI-Portal is the OIDC IdP; its `sub` claim is the only stable, non-reassignable
 * per-user handle at that issuer. Keying the local-user binding on (issuer, subject)
 * — rather than on the email claim — closes the email-trust gap: a re-used email at
 * the IdP can no longer take over an existing appliance account.
 *
 * See ci.federated_identities migration and CI-Engineering
 * architecture/identity/unified-identity-plan.md (Track B, item B2).
 */
@Entity({ schema: 'ci', name: 'federated_identities' })
export class FederatedIdentityEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ type: 'text' })
  issuer!: string;

  @Column({ type: 'text' })
  subject!: string;

  @Column({ type: 'uuid' })
  user_id!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  static toEgressType(entity: FederatedIdentityEntity): FederatedIdentity {
    return {
      id: entity.id,
      issuer: entity.issuer,
      subject: entity.subject,
      user_id: entity.user_id,
      created_at: entity.created_at,
    };
  }
}

export type FederatedIdentity = Readonly<FederatedIdentityEntity>;
