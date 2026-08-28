import { describe, expect, it } from 'vitest';

import { describeCron } from './cronDescriptor';
import type { JobTypesResponse } from './useJobTypes';

const TAXONOMY: JobTypesResponse = {
  categories: ['ingest'],
  types: {
    'file.uploaded': {
      label: 'File uploaded',
      category: 'ingest',
      description: '',
      interactive: false,
    },
  },
};

describe('describeCron', () => {
  it('prefers the taxonomy when the cron key is a known event', () => {
    const d = describeCron('file.uploaded', TAXONOMY);

    // Same words the Jobs table uses — one vocabulary across both cards.
    expect(d.label).toBe('File uploaded');
    expect(d.category).toBe('ingest');
  });

  it('uses the CLASS when the method name says nothing', () => {
    // Eight schedules registered as `PythonFunctionCrons.run` all rendered as
    // "Run", which is why the class has to win for generic method names.
    expect(describeCron('SmartRotationInsightsCron.run', null).label).toBe('Smart rotation insights');
    expect(describeCron('PipelineControlService.tickOnSchedule', null).label).toBe('Pipeline control');
    expect(describeCron('DeadLetterReaperListener.reapOnSchedule', null).label).toBe('Dead letter reaper');
  });

  it('uses the METHOD when it carries the meaning', () => {
    expect(describeCron('FeedQueueCron.topUpFeedQueue', null).label).toBe('Top up feed queue');
    expect(describeCron('DailyMetricsCron.refreshRecent', null).label).toBe('Refresh recent');
  });

  it('drops the Cron/Service/Listener suffix so rows do not all end in noise', () => {
    expect(describeCron('ActivityRollupCron.run', null).label).toBe('Activity rollup');
    expect(describeCron('SyncOrchestrator.run', null).label).not.toMatch(/service$/i);
  });

  it('derives a real category from the registering class', () => {
    // Everything defaulted to `maintenance`, which made the column useless.
    expect(describeCron('SmartRotationInsightsCron.run', null).category).toBe('personalization');
    expect(describeCron('PipelineTickCron.tick', null).category).toBe('pipeline');
    expect(describeCron('PythonFunctionCrons.run', null).category).toBe('llm');
    expect(describeCron('EntityPromotionCron.run', null).category).toBe('graph');
    expect(describeCron('SyncOrchestrator.orchestrateSyncJobs', null).category).toBe('import');
  });

  it('categorises every planning schedule as planning, not maintenance', () => {
    // All five fell through to the `maintenance` default, so the plan automation
    // read as housekeeping — the one category an operator scrolls past.
    const planning = [
      'PlanningJobsCron.todoScan',
      'PlanningJobsCron.todoProcess',
      'PlanningJobsCron.inboxScan',
      'PlanningJobsCron.eventNow',
      'PlanningJobsCron.verifyDone',
    ];

    for (const name of planning) {
      const d = describeCron(name, null);

      expect(d.category).toBe('planning');
      expect(d.categoryLabel).toBe('Planning');
    }
  });

  it('categorises the import sweep and the account purge from their own classes', () => {
    // The import resume sweep is import work; the purge really is maintenance,
    // but by rule rather than by falling off the end of the table.
    expect(describeCron('ImportStageListener.sweepOnSchedule', null).category).toBe('import');
    expect(describeCron('AccountPurgeCron.purgeDueAccounts', null).category).toBe('maintenance');
  });

  it('labels two schedules on one class as that class doing two things', () => {
    // These read as "Job metrics" and "Purge on schedule": two unrelated-looking
    // rows for one collector, and the second never said what it purges.
    expect(describeCron('JobMetricsCollector.sampleOnSchedule', null).label).toBe('Job metrics sample');
    expect(describeCron('JobMetricsCollector.purgeOnSchedule', null).label).toBe('Job metrics purge');
    expect(describeCron('ImportStageListener.sweepOnSchedule', null).label).toBe('Import stage sweep');
  });

  it('drops an OnSchedule verb the class already says', () => {
    // "Dead letter reaper reap" is worse than either half of it.
    expect(describeCron('DeadLetterReaperListener.reapOnSchedule', null).label).toBe('Dead letter reaper');
    expect(describeCron('StagedUploadPurgeCron.runOnSchedule', null).label).toBe('Staged upload purge');
  });

  it('gives distinct labels to the smart-rotation family', () => {
    const names = [
      'SmartRotationInsightsCron.run',
      'SmartRotationSummariesCron.run',
      'SmartRotationGraphLinkCron.run',
      'SmartRotationQuestionFeedCron.run',
    ];
    const labels = names.map((n) => describeCron(n, null).label);

    expect(new Set(labels).size).toBe(labels.length);
  });

  it('flags a scheduler-minted key instead of rendering around it', () => {
    // A UUID key means the @Cron shipped without a `name`, so it is re-minted
    // every boot and its durable history can never be found. The descriptor used
    // to pass the UUID through as a label under a made-up `maintenance`
    // category, which made a backend bug look like a settled row.
    const uuid = '007c9ac0-fb23-4203-809b-c2d100b373e4';
    const d = describeCron(uuid, null);

    expect(d.unnamed).toBe(true);
    expect(d.category).toBe('unclassified');
    // The key itself stays: it is the only thing that identifies the row.
    expect(d.label).toBe(uuid);
  });

  it('leaves a properly named cron unflagged', () => {
    expect(describeCron('PipelineTickCron.runOnSchedule', null).unnamed).toBe(false);
    expect(describeCron('file.uploaded', TAXONOMY).unnamed).toBe(false);
  });

  it('falls back to maintenance for an unrecognised class', () => {
    expect(describeCron('SomethingNew.run', null).category).toBe('maintenance');
  });
});
