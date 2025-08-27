import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToMany,
  ManyToOne,
  JoinColumn,
  JoinTable,
  OneToOne,
} from 'typeorm';

import { ThreadEntity } from '@ci/domains/conversations';
import { TagEntity } from '@ci/domains/search';
import { UserEntity } from '@ci/domains/user';

import { Action } from '../types';

@Entity({ name: 'actions' })
export class ActionEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ type: 'text', nullable: true })
  title!: string | null;

  @Column({ type: 'text', nullable: true })
  text!: string | null;

  @Column({ type: 'text', name: 'image_url', nullable: true })
  imageUrl!: string | null;

  @Column({ type: 'text', name: 'thread_id', nullable: true })
  threadId!: string;

  @OneToOne(() => ThreadEntity, { nullable: true })
  @JoinColumn({ name: 'thread_id' })
  thread?: ThreadEntity;

  @ManyToOne(() => UserEntity, { nullable: true })
  @JoinColumn({ name: 'user_id' })
  user?: UserEntity;

  @ManyToMany(() => TagEntity, { nullable: true })
  @JoinTable({
    name: 'action_tag',
    joinColumn: { name: 'action_id', referencedColumnName: 'id' },
    inverseJoinColumn: { name: 'tag_id', referencedColumnName: 'id' },
  })
  tags?: TagEntity[];

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;

  toAction(): Action {
    return {
      id: this.id,
      title: this.title,
      text: this.text,
      imageUrl: this.imageUrl,
      threadId: this.threadId,
      thread: this.thread?.toThread(),
      user: this.user?.toUser(),
      tags: this.tags?.map((tag) => tag.toTag()).filter((tag) => !!tag) as string[],
    } satisfies Action;
  }
}
