import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { EventsModule } from '@ci/domains/events';
import { UserModule } from '@ci/domains/user';

import { InsightsController } from './controllers/InsightsController';
import { DailyMetricsCron } from './cron/DailyMetricsCron';
import { DailyMetricEntity } from './entities/DailyMetricEntity';
import { DailyMetricsComputeListener } from './listeners/DailyMetricsComputeListener';
import { DescriptiveQuestionService } from './narrate/DescriptiveQuestionService';
import { NARRATOR, TemplateNarrator } from './narrate/Narrator';
import { DailyMetricsBackfillService } from './services/DailyMetricsBackfillService';
import { DailyMetricsService } from './services/DailyMetricsService';

/**
 * The insights domain: the Daily Feature Store (DailyMetricsService over
 * ci_derived.daily_metrics) plus the descriptive compute-then-narrate question
 * engine (DescriptiveQuestionService). NARRATOR is bound to the dependency-free
 * TemplateNarrator by default; a deployment can rebind it to an Ollama-backed
 * OllamaNarrator without touching the compute path.
 *
 * Compute is queue-driven: DailyMetricsCron (nightly + hourly rolling, feature
 * flag 'insights.daily_metrics') and the POST /api/insights/daily-metrics/backfill
 * endpoint both enqueue (user, window) jobs on the daily-metrics PGBoss queue,
 * consumed by DailyMetricsComputeListener.
 */
@Module({
  imports: [TypeOrmModule.forFeature([DailyMetricEntity]), EventsModule, UserModule],
  controllers: [InsightsController],
  providers: [
    DailyMetricsService,
    DailyMetricsBackfillService,
    DailyMetricsComputeListener,
    DailyMetricsCron,
    DescriptiveQuestionService,
    { provide: NARRATOR, useClass: TemplateNarrator },
  ],
  exports: [DailyMetricsService, DailyMetricsBackfillService, DescriptiveQuestionService],
})
export class InsightsModule {}

export { DailyMetricsService } from './services/DailyMetricsService';
export { DailyMetricsBackfillService } from './services/DailyMetricsBackfillService';
export type { BackfillOptions, BackfillResult } from './services/DailyMetricsBackfillService';
export {
  DAILY_METRICS_QUEUE,
  DailyMetricsComputeRequestEvent,
  type DailyMetricsComputeRequestPayload,
} from './events';
export { DescriptiveQuestionService } from './narrate/DescriptiveQuestionService';
export type { DescriptiveAnswer, AnswerOptions } from './narrate/DescriptiveQuestionService';
export { DailyMetricEntity } from './entities/DailyMetricEntity';
export { NARRATOR, TemplateNarrator, OllamaNarrator, interpolateTemplate } from './narrate/Narrator';
export type { Narrator, TextGenerator, NarrationInput, AnswerProvenance } from './narrate/Narrator';
export { QUESTION_CATALOG } from './narrate/questionCatalog';
export type { QuestionSpec, Category } from './narrate/questionCatalog';
export { METRIC_KEYS, METRIC_SOURCES } from './types';
export type { DailyMetrics, MetricKey, MetricValues, MetricCoverage } from './types';
