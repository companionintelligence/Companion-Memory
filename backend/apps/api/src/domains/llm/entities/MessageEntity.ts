import {
  Entity,
  DeleteDateColumn,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';

import { UserEntity } from '@ci/domains/user';

import type { Message } from '../types';

import { ThreadEntity } from './ThreadEntity';

@Entity({ name: 'messages' })
export class MessageEntity {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ type: 'text', nullable: true })
  model!: string | null;

  @Column({ type: 'text', nullable: true })
  role!: string | null;

  @Column({ type: 'text', nullable: true })
  text!: string | null;

  @Column({ type: 'text', nullable: true })
  mimetype!: string | null;

  @Column({ type: 'jsonb', nullable: true })
  tool_calls!: Record<string, unknown>[] | null;

  @Column({ type: 'boolean' })
  prompt!: boolean;

  @Column({ type: 'boolean' })
  canceled!: boolean;

  @ManyToOne(() => UserEntity)
  @JoinColumn({ name: 'user_id' })
  user?: UserEntity;

  @ManyToOne(() => ThreadEntity)
  @JoinColumn({ name: 'thread_id' })
  thread?: ThreadEntity;

  @ManyToOne(() => MessageEntity, { nullable: true })
  @JoinColumn({ name: 'prompt_message_id' })
  promptMessage?: MessageEntity;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;

  @DeleteDateColumn({ type: 'timestamptz' })
  deleted_at!: Date;

  toMessage(): Message {
    let role: string | undefined;

    if (this.role) {
      role = this.role;
    } else if (this.prompt === true) {
      role = 'user';
    } else if (this.prompt === false) {
      role = 'assistant';
    }

    return {
      id: this.id,
      model: this.model ?? null,
      // TODO: This is a little janky and is symptomatic of lax nullability in the DB, fix this later.
      role: role ?? 'assistant',
      content: this.text ?? '',
      mimetype: this.mimetype ?? null,
      toolCalls: this.tool_calls ?? null,
      canceled: this.canceled ?? null,

      user: this.user?.toUser(),
      thread: this.thread?.toThread(),
      promptMessage: this.promptMessage?.toMessage() ?? null,
    } satisfies Message;
  }
}
