import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

export type ActorKind = 'user' | 'agent' | 'device' | 'household';

/**
 * An actor is the access unit (plan 10): a user, an agent, a device, or a
 * household. All writes carry `created_by_actor`; all reads filter by the
 * actor's relationship to the data's owning user.
 *
 * For an existing user the actor row shares the user's UUID (1:1 backfill in
 * migration 20260518171322_create_actors). New agents/devices get fresh UUIDs.
 */
@Entity({ schema: 'ci', name: 'actors' })
export class ActorEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ type: 'text' })
  kind!: ActorKind;

  @Column({ type: 'uuid', nullable: true })
  parent_user_id!: string | null;

  @Column({ type: 'text' })
  display_name!: string;

  @Column({ type: 'jsonb', default: () => `'{}'::jsonb` })
  metadata!: Record<string, unknown>;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;

  static toEgressType(entity: ActorEntity): Actor {
    return {
      id: entity.id,
      kind: entity.kind,
      parent_user_id: entity.parent_user_id,
      display_name: entity.display_name,
      metadata: entity.metadata,
      created_at: entity.created_at,
      updated_at: entity.updated_at,
    };
  }
}

export type Actor = Readonly<{
  id: string;
  kind: ActorKind;
  parent_user_id: string | null;
  display_name: string;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}>;
