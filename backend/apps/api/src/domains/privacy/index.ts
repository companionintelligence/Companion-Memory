/**
 * Privacy and consent module (plan 09).
 *
 * Provides:
 * - `ConsentService` — read and write per-user data-retention preferences.
 * - `ConsentController` — REST endpoints at `GET/PUT /me/consent` and
 *   `POST /me/erase` for right-to-erasure requests.
 *
 * HTTP endpoints:
 *   GET  /me/consent   — retrieve current preferences (scope: privacy:read)
 *   PUT  /me/consent   — update category preferences  (scope: privacy:write)
 *   POST /me/erase     — request account erasure      (scope: privacy:write)
 *
 * The actual data-purge is performed out-of-band by a background job that
 * reads rows where `erasure_requested_at IS NOT NULL AND erasure_completed_at
 * IS NULL` — that job is out of scope for this PR.
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ConsentController } from './controllers/ConsentController';
import { ConsentPreferenceEntity } from './entities/ConsentPreferenceEntity';
import { ConsentService } from './services/ConsentService';

@Module({
  imports: [TypeOrmModule.forFeature([ConsentPreferenceEntity])],
  providers: [ConsentService],
  controllers: [ConsentController],
  exports: [ConsentService],
})
export class PrivacyModule {}

// Entity
export { ConsentPreferenceEntity };
export type {
  CategoryConsent,
  DataCategory,
  DataCategoryPreferences,
} from './entities/ConsentPreferenceEntity';

// Service
export { ConsentService };
export type { ConsentPreferences, UpdateCategoryPreferencesDto } from './services/ConsentService';
