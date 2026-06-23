import {
  CreateDateColumn,
  UpdateDateColumn,
  Entity,
  PrimaryColumn,
  Column,
  ManyToOne,
  JoinColumn,
} from 'typeorm';

import { UserEntity } from '@ci/domains/user';

export interface Device {
  device_id: string;
}

@Entity({ schema: 'ci', name: 'browser_activity' })
export class BrowserActivityEntity {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ type: 'timestamptz' })
  time!: Date;

  @Column({ type: 'uuid' })
  user_id!: string;

  // Nullable since the departition migration dropped the NOT NULL constraint:
  // importer-ingested activity has no device.
  @Column({ type: 'uuid', nullable: true })
  device_id?: string | null;

  // URL and page data
  @Column({ type: 'text' })
  url!: string;

  @Column({ type: 'text', nullable: true })
  title?: string;

  // Interaction data
  @Column({ type: 'text', nullable: true })
  action_type?: string;

  @Column({ type: 'jsonb', default: {} })
  properties!: Record<string, unknown>;

  @Column({ type: 'integer', nullable: true })
  duration_seconds?: number;

  @Column({ type: 'double precision', nullable: true })
  scroll_depth_percent?: number;

  // AI-generated insights
  @Column({ type: 'text', nullable: true })
  page_summary?: string;

  @Column({ type: 'text', nullable: true })
  category?: string;

  @Column({ type: 'double precision', nullable: true })
  productivity_score?: number;

  // Privacy
  @Column({ type: 'boolean', default: false })
  is_incognito!: boolean;

  @Column({ type: 'boolean', default: false })
  contains_sensitive!: boolean;

  // Provenance triple — the stable key capture sources carry. Lets the importer
  // write browser activity and re-ingest idempotently (paired with the
  // browser_activity_source_triple_uniq partial unique index).
  @Column({ type: 'text', nullable: true })
  source_type?: string | null;

  @Column({ type: 'text', nullable: true })
  source_system?: string | null;

  @Column({ type: 'text', nullable: true })
  source_id?: string | null;

  @ManyToOne(() => UserEntity)
  @JoinColumn({ name: 'user_id' })
  user?: UserEntity | undefined;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;

  static toEgressType(entity: BrowserActivityEntity): BrowserActivity {
    return {
      id: entity.id,
      time: entity.time,
      user_id: entity.user_id,
      device_id: entity.device_id,
      url: entity.url,
      title: entity.title,
      action_type: entity.action_type,
      properties: entity.properties,
      duration_seconds: entity.duration_seconds,
      scroll_depth_percent: entity.scroll_depth_percent,
      page_summary: entity.page_summary,
      category: entity.category,
      productivity_score: entity.productivity_score,
      is_incognito: entity.is_incognito,
      contains_sensitive: entity.contains_sensitive,
      source_type: entity.source_type,
      source_system: entity.source_system,
      source_id: entity.source_id,
      user: entity.user == null ? undefined : entity.user,
      updatedAt: entity.updatedAt,
      createdAt: entity.createdAt,
    };
  }
}

export type BrowserActivity = Readonly<BrowserActivityEntity>;
