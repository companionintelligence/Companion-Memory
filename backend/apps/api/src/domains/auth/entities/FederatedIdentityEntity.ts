import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

export type FederatedBindMethod = 'sub' | 'email_link';

/**
 * `ci.federated_identities` — binds an external OIDC identity (issuer +
 * subject) to a local user. The (issuer, subject) pair is the binding key;
 * email is recorded for audit and used only for the one-time link of a
 * pre-existing local account. See the migration for the threat model.
 */
@Entity({ schema: 'ci', name: 'federated_identities' })
export class FederatedIdentityEntity {
  @PrimaryColumn({ type: 'uuid', name: 'id' })
  id!: string;

  @Column({ type: 'uuid', name: 'user_id' })
  userId!: string;

  @Column({ type: 'text', name: 'issuer' })
  issuer!: string;

  @Column({ type: 'text', name: 'subject' })
  subject!: string;

  @Column({ type: 'text', name: 'email', nullable: true })
  email!: string | null;

  @Column({ type: 'text', name: 'bind_method', default: 'sub' })
  bindMethod!: FederatedBindMethod;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @Column({ type: 'timestamptz', name: 'last_seen_at' })
  lastSeenAt!: Date;

  static toEgressType(entity: FederatedIdentityEntity): FederatedIdentity {
    return {
      id: entity.id,
      userId: entity.userId,
      issuer: entity.issuer,
      subject: entity.subject,
      email: entity.email,
      bindMethod: entity.bindMethod,
      createdAt: entity.createdAt,
      lastSeenAt: entity.lastSeenAt,
    };
  }
}

export type FederatedIdentity = Readonly<FederatedIdentityEntity>;
