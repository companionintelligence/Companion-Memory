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

import type { Message, MessageRole } from '../types';

import { ThreadEntity } from './ThreadEntity';

@Entity({ name: 'messages' })
export class MessageEntity {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  model!: string | null;

  @Column({ type: 'varchar', length: 20, nullable: true })
  role!: MessageRole | null;

  @Column({ type: 'text', nullable: true })
  text!: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  mimetype!: string | null;

  @Column({ type: 'jsonb', nullable: true })
  tool_calls!: Record<string, unknown>[] | null;

  @Column({ type: 'boolean', default: false })
  prompt!: boolean;

  @Column({ type: 'boolean', default: false })
  canceled!: boolean;

  @ManyToOne(() => UserEntity, { nullable: false })
  @JoinColumn({ name: 'user_id' })
  user!: UserEntity;

  @ManyToOne(() => ThreadEntity, { nullable: false })
  @JoinColumn({ name: 'thread_id' })
  thread!: ThreadEntity;

  @ManyToOne(() => MessageEntity, { nullable: true })
  @JoinColumn({ name: 'prompt_message_id' })
  promptMessage?: MessageEntity;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;

  @DeleteDateColumn({ type: 'timestamptz' })
  deleted_at?: Date;

  toMessage(): Message {
    let role: MessageRole;

    if (this.role) {
      role = this.role;
    } else if (this.prompt === true) {
      role = 'user';
    } else if (this.prompt === false) {
      role = 'assistant';
    } else {
      role = 'assistant'; // default fallback
    }

    return {
      id: this.id,
      model: this.model,
      role,
      content: this.text ?? '',
      mimetype: this.mimetype,
      toolCalls: this.tool_calls,
      canceled: this.canceled,

      user: this.user.toUser(),
      thread: this.thread.toThread(),
      promptMessage: this.promptMessage?.toMessage() ?? null,
    };
  }
}
