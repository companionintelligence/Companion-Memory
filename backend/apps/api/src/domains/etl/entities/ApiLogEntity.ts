import { Entity, PrimaryColumn, Column, ManyToOne, CreateDateColumn, JoinColumn } from 'typeorm';

import { UserEntity } from '@ci/domains/user';

import { ConnectionEntity } from '../../connections/entities/ConnectionEntity';
import { ApiLog } from '../../etl/types';

@Entity('api_logs')
export class ApiLogEntity {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ type: 'uuid', nullable: true })
  user_id?: string;

  @Column({ type: 'uuid', nullable: true })
  connection_id?: string;

  @Column({ type: 'text', nullable: true })
  scope?: string;

  @Column({ type: 'jsonb', nullable: true })
  content?: unknown;

  // Vector embedding for semantic search
  @Column({ type: 'text', nullable: true })
  embedding?: string; // Store as JSON string, parse when needed

  // Geospatial location (latitude, longitude) - store as JSON
  @Column({ type: 'jsonb', nullable: true })
  location?: { type: 'Point'; coordinates: [number, number] };

  @Column({ type: 'boolean', default: false })
  processed?: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @ManyToOne(() => UserEntity)
  @JoinColumn({ name: 'user_id' })
  user?: UserEntity | null;

  @ManyToOne(() => ConnectionEntity)
  @JoinColumn({ name: 'connection_id' })
  connection?: ConnectionEntity | null;

  toApiLog(): ApiLog {
    return {
      id: this.id,
      user_id: this.user_id,
      connection_id: this.connection_id,
      scope: this.scope,
      content: this.content,
      embedding: this.embedding ? JSON.parse(this.embedding) : undefined,
      location: this.location,
      processed: this.processed,
      user: this.user?.toUser(),
      connection: this.connection?.toConnection(),
      created_at: this.created_at,
    };
  }
}
