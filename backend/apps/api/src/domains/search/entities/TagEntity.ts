import {
  BeforeInsert,
  BeforeUpdate,
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';

import { UserEntity } from '@ci/domains/user';

@Entity({ name: 'tags' })
export class TagEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ type: 'text', nullable: true })
  label!: string | null;

  @ManyToOne(() => UserEntity, { nullable: true })
  @JoinColumn({ name: 'user_id' })
  user?: UserEntity;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @BeforeInsert()
  @BeforeUpdate()
  private lowercaseLabel() {
    if (this.label) {
      this.label = this.label.toLowerCase();
    }
  }

  toTag(): string | null {
    return this.label;
  }
}
