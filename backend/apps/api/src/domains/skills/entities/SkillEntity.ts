import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

export type SkillSource = 'builtin' | 'user' | 'marketplace';

@Entity({ schema: 'ci', name: 'skills' })
export class SkillEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ type: 'text', unique: true })
  name!: string;

  @Column({ type: 'text' })
  source!: SkillSource;

  @Column({ type: 'uuid', nullable: true })
  owner_actor_id!: string | null;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}

export type Skill = Readonly<{
  id: string;
  name: string;
  source: SkillSource;
  owner_actor_id: string | null;
  description: string | null;
  created_at: Date;
  updated_at: Date;
}>;
