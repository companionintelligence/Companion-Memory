import { type TestingModule } from '@nestjs/testing';
import { type MultiBar } from 'cli-progress';

import { SummaryService } from '@ci/domains/summaries';

import { SUMMARIES } from './data/summaries';
import { JOHN_SMITH } from './data/users';

export async function seedSummaries(module: TestingModule, multibar: MultiBar) {
  const summaryService = module.get(SummaryService);

  const bar = multibar.create(SUMMARIES.length, 0, { task: 'Summaries' });

  for (const summary of SUMMARIES) {
    const existingSummary = await summaryService.findById(
      {
        userId: JOHN_SMITH.id,
      },
      summary.summaryId,
    );

    if (existingSummary == null) {
      await summaryService.create(
        {
          userId: JOHN_SMITH.id,
        },
        {
          summaryId: summary.summaryId,
          userId: summary.userId,
          periodStart: summary.periodStart,
          periodEnd: summary.periodEnd,
          periodType: summary.periodType,
          timezone: summary.timezone,
          sourceTypes: summary.sourceTypes,
          title: summary.title,
          content: summary.content,
          confidenceScore: summary.confidenceScore,
        },
      );
    }

    bar.increment();
  }

  bar.stop();
}
