import { Column, CreateDateColumn, Entity, PrimaryColumn, Unique } from 'typeorm';

@Entity({ schema: 'ci', name: 'user_skill_installs' })
@Unique(['actor_id', 'skill_version_id'])
export class UserSkillInstallEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  actor_id!: string;

  @Column({ type: 'uuid' })
  skill_version_id!: string;

  @Column({ type: 'jsonb', default: () => `'{}'::jsonb` })
  config!: Record<string, unknown>;

  @Column({ type: 'boolean', default: true })
  enabled!: boolean;

  @CreateDateColumn({ type: 'timestamptz', name: 'installed_at' })
  installed_at!: Date;
}
