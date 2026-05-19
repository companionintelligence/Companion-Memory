import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { LoggerService } from '@ci/common/logging';

import {
  ALL_DATA_CATEGORIES,
  CategoryConsent,
  ConsentPreferenceEntity,
  DataCategory,
  DataCategoryPreferences,
  DEFAULT_CATEGORY_CONSENT,
} from '../entities/ConsentPreferenceEntity';

export interface ConsentPreferences {
  userId: string;
  dataCategories: DataCategoryPreferences;
  erasureRequestedAt: Date | null;
  erasureCompletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface UpdateCategoryPreferencesDto {
  /** Partial map — only supplied categories are updated; others are kept. */
  dataCategories: Partial<Record<DataCategory, Partial<CategoryConsent>>>;
}

/**
 * Plan 09 §2 — manages user consent and data-retention preferences.
 *
 * Design decisions:
 * - One row per user (upsert semantics). Missing rows return defaults (all
 *   categories enabled, no retention limit).
 * - `requestErasure()` is idempotent: calling it twice doesn't reset the
 *   timestamp. Actual data deletion is performed by a scheduled background
 *   job (out-of-scope for this PR) that reads rows where `erasure_requested_at
 *   IS NOT NULL AND erasure_completed_at IS NULL`.
 * - Errors are never swallowed — the caller decides how to handle them.
 */
@Injectable()
export class ConsentService {
  constructor(
    @InjectRepository(ConsentPreferenceEntity)
    private readonly repo: Repository<ConsentPreferenceEntity>,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(ConsentService.name);
  }

  /**
   * Returns the user's consent preferences, falling back to defaults for any
   * category not yet explicitly configured.
   */
  async findByUserId(userId: string): Promise<ConsentPreferences> {
    const entity = await this.repo.findOne({ where: { userId } });

    if (!entity) {
      return this.defaults(userId);
    }

    return this.toDto(entity);
  }

  /**
   * Upserts category preferences for the given user.
   * Only supplied categories are modified; others are preserved.
   */
  async updateCategories(userId: string, dto: UpdateCategoryPreferencesDto): Promise<ConsentPreferences> {
    const existing = await this.repo.findOne({ where: { userId } });
    const current: DataCategoryPreferences = existing ? existing.dataCategories : this.defaultCategories();

    // Merge: spread current defaults per category, then override with supplied fields.
    const merged: DataCategoryPreferences = { ...current };

    for (const [rawCategory, patch] of Object.entries(dto.dataCategories)) {
      const category = rawCategory as DataCategory;
      const base: CategoryConsent = current[category] ?? { ...DEFAULT_CATEGORY_CONSENT };

      merged[category] = { ...base, ...(patch ?? {}) };
    }

    const entity = this.repo.create({
      userId,
      dataCategories: merged,
      erasureRequestedAt: existing?.erasureRequestedAt ?? null,
      erasureCompletedAt: existing?.erasureCompletedAt ?? null,
    });

    const saved = await this.repo.save(entity);

    this.logger.log('Consent preferences updated', {
      userId,
      categories: Object.keys(dto.dataCategories),
    });

    return this.toDto(saved);
  }

  /**
   * Marks an erasure request for the user. Idempotent — calling this when
   * erasure has already been requested returns the existing record unchanged.
   *
   * Returns the updated preferences including the `erasureRequestedAt` stamp.
   */
  async requestErasure(userId: string): Promise<ConsentPreferences> {
    const existing = await this.repo.findOne({ where: { userId } });

    if (existing?.erasureRequestedAt) {
      this.logger.log('Erasure already requested — returning existing record', { userId });

      return this.toDto(existing);
    }

    const entity = this.repo.create({
      userId,
      dataCategories: existing?.dataCategories ?? this.defaultCategories(),
      erasureRequestedAt: new Date(),
      erasureCompletedAt: null,
    });

    const saved = await this.repo.save(entity);

    this.logger.log('Right-to-erasure request recorded', { userId });

    return this.toDto(saved);
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private defaults(userId: string): ConsentPreferences {
    const now = new Date();

    return {
      userId,
      dataCategories: this.defaultCategories(),
      erasureRequestedAt: null,
      erasureCompletedAt: null,
      createdAt: now,
      updatedAt: now,
    };
  }

  private defaultCategories(): DataCategoryPreferences {
    return Object.fromEntries(
      ALL_DATA_CATEGORIES.map((c) => [c, { ...DEFAULT_CATEGORY_CONSENT }]),
    ) as DataCategoryPreferences;
  }

  private toDto(entity: ConsentPreferenceEntity): ConsentPreferences {
    return {
      userId: entity.userId,
      dataCategories: {
        ...this.defaultCategories(),
        ...entity.dataCategories,
      },
      erasureRequestedAt: entity.erasureRequestedAt,
      erasureCompletedAt: entity.erasureCompletedAt,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
    };
  }
}
