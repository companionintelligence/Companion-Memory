/** Human labels for smart.rotation.work payload workType values. */
export const SMART_ROTATION_WORK_LABELS: Record<string, string> = {
  question_feed: 'Feed questions',
  answer_infer: 'Infer answers',
  schedule_sync: 'Schedule sync',
  insights: 'Generate insights',
  summaries: 'Summaries / dossier',
  graph_link: 'Graph linking',
  graph_enrich: 'Graph enrichment',
  context_prompt: 'Context prompt',
  hydrate_answers: 'Hydrate answers',
  hydrate_inventory: 'Hydrate inventory',
};

export function formatJobHandlerLabel(handler: string): string {
  const prefix = 'smart.rotation.work · ';

  if (!handler.startsWith(prefix)) {
    return handler;
  }

  const workType = handler.slice(prefix.length);

  return SMART_ROTATION_WORK_LABELS[workType] ?? workType;
}

export function formatSmartRotationJobTitle(data: Record<string, unknown> | null): string | null {
  if (!data || data.name !== 'smart.rotation.work') {
    return null;
  }

  const workType = typeof data.workType === 'string' ? data.workType : 'unknown';

  return SMART_ROTATION_WORK_LABELS[workType] ?? workType;
}

/** Split a lumped smart.rotation.work slice using smartRotationDistribution when the API has not. */
export function expandActiveJobDistribution(
  activeDistribution: ReadonlyArray<{ readonly jobName: string; readonly count: number }>,
  smartRotationDistribution: ReadonlyArray<{ readonly workType: string; readonly count: number }>,
): Array<{ jobName: string; count: number }> {
  const alreadySplit = activeDistribution.some((segment) =>
    segment.jobName.startsWith('smart.rotation.work · '),
  );

  if (alreadySplit) {
    return activeDistribution.map((segment) => ({
      jobName: formatJobHandlerLabel(segment.jobName),
      count: segment.count,
    }));
  }

  const withoutLumpedRotation = activeDistribution.filter(
    (segment) => segment.jobName !== 'smart.rotation.work',
  );
  const rotationSlices =
    smartRotationDistribution.length > 0
      ? smartRotationDistribution.map((item) => ({
          jobName: formatJobHandlerLabel(`smart.rotation.work · ${item.workType}`),
          count: item.count,
        }))
      : [];

  const lumped = activeDistribution.find((segment) => segment.jobName === 'smart.rotation.work');
  if (rotationSlices.length === 0 && lumped) {
    return activeDistribution.map((segment) => ({
      jobName: formatJobHandlerLabel(segment.jobName),
      count: segment.count,
    }));
  }

  return [...withoutLumpedRotation, ...rotationSlices].map((segment) => ({
    jobName: formatJobHandlerLabel(segment.jobName),
    count: segment.count,
  }));
}
