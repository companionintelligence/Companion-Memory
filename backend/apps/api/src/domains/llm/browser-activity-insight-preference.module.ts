import { Module } from '@nestjs/common';

import { MemoryModule } from '@ci/domains/memory';

import { BrowserActivityInsightPreferenceService } from './services/BrowserActivityInsightPreferenceService';

/**
 * Tiny module so the insight listener and Settings can share the
 * categorize-browsing preference without LLMModule ↔ PersonalizationModule
 * circular imports — same shape as ImageDescriptionPreferenceModule.
 */
@Module({
  imports: [MemoryModule],
  providers: [BrowserActivityInsightPreferenceService],
  exports: [BrowserActivityInsightPreferenceService],
})
export class BrowserActivityInsightPreferenceModule {}

export { BrowserActivityInsightPreferenceService } from './services/BrowserActivityInsightPreferenceService';
