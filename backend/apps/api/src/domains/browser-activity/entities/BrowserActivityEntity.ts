import { Entity, PrimaryColumn, Column, ManyToOne, JoinColumn } from 'typeorm';

import { UserEntity } from '@ci/domains/user';

export interface Device {
  device_id: string;
}

@Entity('browser_activity')
export class BrowserActivityEntity {
  @Column({ type: 'uuid' })
  id!: string;

  @PrimaryColumn({ type: 'timestamptz' })
  time!: Date;

  @PrimaryColumn({ type: 'uuid' })
  user_id!: string;

  @PrimaryColumn({ type: 'uuid' })
  device_id!: string;

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

  @Column({
    type: 'text',
    nullable: true,
    transformer: {
      to: (v: number[]) => (v ? `[${v.join(',')}]` : null),
      from: (v: string) => (v ? v.slice(1, -1).split(',').map(Number) : null),
    },
  })
  page_embedding?: number[];

  @Column({ type: 'text', nullable: true })
  category?: string;

  @Column({ type: 'double precision', nullable: true })
  productivity_score?: number;

  // Privacy
  @Column({ type: 'boolean', default: false })
  is_incognito!: boolean;

  @Column({ type: 'boolean', default: false })
  contains_sensitive!: boolean;

  @ManyToOne(() => UserEntity)
  @JoinColumn({ name: 'user_id' })
  user?: UserEntity | undefined;

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
      page_embedding: entity.page_embedding,
      category: entity.category,
      productivity_score: entity.productivity_score,
      is_incognito: entity.is_incognito,
      contains_sensitive: entity.contains_sensitive,
      user: entity.user == null ? undefined : entity.user,
    };
  }
}

export type BrowserActivity = Readonly<BrowserActivityEntity>;
