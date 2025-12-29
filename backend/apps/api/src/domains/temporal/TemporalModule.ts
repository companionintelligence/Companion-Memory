import { Module } from '@nestjs/common';

import { TemporalService } from './services/TemporalService';

/**
 * Temporal module for coordinating with Temporal workflows.
 *
 * Provides services to manage LLM resource priority by pausing/resuming
 * background summarization workflows when high-priority user-facing operations
 * need immediate access.
 *
 * @module TemporalModule
 */
@Module({
  providers: [TemporalService],
  exports: [TemporalService],
})
export class TemporalModule {}
