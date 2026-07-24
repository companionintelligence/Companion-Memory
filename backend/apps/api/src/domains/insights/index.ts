import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { UserModule } from '@ci/domains/user';

import { DailyMetricsCron } from './cron/DailyMetricsCron';
import { DailyMetricEntity } from './entities/DailyMetricEntity';
import { DescriptiveQuestionService } from './narrate/DescriptiveQuestionService';
import { NARRATOR, TemplateNarrator } from './narrate/Narrator';
import { DailyMetricsService } from './services/DailyMetricsService';

/**
 * The insights domain: the Daily Feature Store (DailyMetricsService over
 * ci.daily_metrics) plus the descriptive compute-then-narrate question
 * engine (DescriptiveQuestionService). NARRATOR is bound to the dependency-free
 * TemplateNarrator by default; a deployment can rebind it to an Ollama-backed
 * OllamaNarrator without touching the compute path.
 */
@Module({
  imports: [TypeOrmModule.forFeature([DailyMetricEntity]), UserModule],
  providers: [
    DailyMetricsService,
    DailyMetricsCron,
    DescriptiveQuestionService,
    { provide: NARRATOR, useClass: TemplateNarrator },
  ],
  exports: [DailyMetricsService, DescriptiveQuestionService],
})
export class InsightsModule {}

export { DailyMetricsService, DEFAULT_REFRESH_WINDOW_DAYS } from './services/DailyMetricsService';
export { DescriptiveQuestionService } from './narrate/DescriptiveQuestionService';
export type { DescriptiveAnswer, AnswerOptions } from './narrate/DescriptiveQuestionService';
export { DailyMetricEntity } from './entities/DailyMetricEntity';
export { NARRATOR, TemplateNarrator, OllamaNarrator, interpolateTemplate } from './narrate/Narrator';
export type { Narrator, TextGenerator, NarrationInput, AnswerProvenance } from './narrate/Narrator';
export { QUESTION_CATALOG } from './narrate/questionCatalog';
export type { QuestionSpec, Category } from './narrate/questionCatalog';
export { METRIC_KEYS, METRIC_SOURCES } from './types';
export type { DailyMetrics, MetricKey, MetricValues, MetricCoverage } from './types';
