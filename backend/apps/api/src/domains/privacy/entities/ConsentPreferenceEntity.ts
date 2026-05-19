import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * Categories of personal data that users can control.
 * Each category maps to a set of tables / services in the platform.
 */
export type DataCategory =
  | 'graph' // persons, places, concepts, relationships
  | 'communications' // messages, threads, email
  | 'files' // uploaded files & Drive content
  | 'browser_activity' // browser capture events
  | 'etl_data' // raw ETL sync snapshots
  | 'llm_invocations'; // LLM call traces

/** Per-category preference stored in the JSONB column. */
export interface CategoryConsent {
  /** Whether data in this category is allowed to be ingested/stored. */
  enabled: boolean;
  /**
   * How long (in days) to retain data in this category.
   * `null` means retain indefinitely until the user deletes their account.
   */
  retentionDays: number | null;
}

/** Default consent for a category — enabled, retained indefinitely. */
export const DEFAULT_CATEGORY_CONSENT: CategoryConsent = {
  enabled: true,
  retentionDays: null,
};

export const ALL_DATA_CATEGORIES: readonly DataCategory[] = [
  'graph',
  'communications',
  'files',
  'browser_activity',
  'etl_data',
  'llm_invocations',
];

/** Full consent preferences for a user. */
export type DataCategoryPreferences = Record<DataCategory, CategoryConsent>;

/**
 * Persistence entity for `ci.user_consent_preferences`.
 * One row per user; upserted on every write.
 */
@Entity({ schema: 'ci', name: 'user_consent_preferences' })
export class ConsentPreferenceEntity {
  @PrimaryColumn({ type: 'uuid', name: 'user_id' })
  userId!: string;

  @Column({ type: 'jsonb', name: 'data_categories', default: {} })
  dataCategories!: DataCategoryPreferences;

  @Column({ type: 'timestamptz', name: 'erasure_requested_at', nullable: true })
  erasureRequestedAt!: Date | null;

  @Column({ type: 'timestamptz', name: 'erasure_completed_at', nullable: true })
  erasureCompletedAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;
}
