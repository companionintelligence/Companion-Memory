import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  ManyToMany,
  JoinTable,
} from 'typeorm';

import { FileEntity, type File } from '@ci/domains/files';
import { UserEntity, type User } from '@ci/domains/user';

import { ThreadEntity, type Thread } from './ThreadEntity';

@Entity({ schema: 'ci', name: 'messages' })
export class MessageEntity {
  @PrimaryColumn({ type: 'uuid', name: 'message_id' })
  id!: string;

  @Column({ type: 'text', nullable: true, name: 'model_name' })
  model!: string | null;

  @Column({ type: 'text', nullable: false })
  role!: string;

  @Column({ type: 'text', nullable: false, name: 'content' })
  content!: string;

  @Column({ type: 'text', nullable: true, name: 'content_type' })
  mimetype!: string | null;

  @Column({ type: 'jsonb', nullable: true, name: 'tool_calls', default: '[]' })
  toolCalls!: Record<string, unknown>[] | null;

  // Direct boolean field for canceled - maps to is_deleted in database
  @Column({ type: 'boolean', default: false, name: 'is_deleted' })
  canceled!: boolean;

  @ManyToOne(() => UserEntity)
  @JoinColumn({ name: 'user_id' })
  user?: UserEntity;

  @Column({ type: 'text', nullable: true, name: 'thread_id' })
  threadId?: string;

  @ManyToOne(() => ThreadEntity)
  @JoinColumn({ name: 'thread_id' })
  thread?: ThreadEntity;

  @ManyToOne(() => MessageEntity, { nullable: true })
  @JoinColumn({ name: 'parent_message_id' })
  promptMessage?: MessageEntity;

  @ManyToMany(() => FileEntity, { nullable: true })
  @JoinTable({
    name: 'message_files',
    joinColumn: { name: 'message_id', referencedColumnName: 'id' },
    inverseJoinColumn: { name: 'file_id', referencedColumnName: 'id' },
  })
  files?: FileEntity[];

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;

  static toEgressType(entity: MessageEntity): Message {
    return {
      id: entity.id,
      model: entity.model ?? null,
      role: entity.role,
      content: entity.content ?? '',
      mimetype: entity.mimetype ?? null,
      toolCalls: entity.toolCalls ?? null,
      canceled: entity.canceled ?? null,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,

      threadId: entity.threadId,

      user: entity.user ? UserEntity.toEgressType(entity.user) : undefined,
      thread: entity.thread ? ThreadEntity.toEgressType(entity.thread) : undefined,
      promptMessage: entity.promptMessage ? MessageEntity.toEgressType(entity.promptMessage) : undefined,
      files: entity.files?.map((file) => FileEntity.toEgressType(file)),
    };
  }
}

export type Message = Readonly<Omit<MessageEntity, 'user' | 'thread' | 'files' | 'promptMessage'>> & {
  user?: User;
  thread?: Thread;
  promptMessage?: Message;
  files?: File[];
};
