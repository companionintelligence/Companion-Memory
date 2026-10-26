import type { RequestContext } from '@ci/common/context';
import type { SummaryService } from '@ci/domains/summaries';

import { GlobalUID } from '../../types/GlobalUID';
import { SummaryResolver } from '../SummaryResolver';

/**
 * `/brief/summaries/<id>` builds the GlobalUID straight from the address, so
 * whatever is typed there reaches the resolver. `summary_id` is a uuid column:
 * a non-uuid used to reach Postgres, fail with 22P02 and show the page as
 * "Internal server error". It must read as "no such summary", the same as an
 * unknown uuid.
 */

const context = { userId: 'user-1' } as unknown as RequestContext;
const RAW_ID = '019a1f6c-2b3d-7e4f-8a5b-6c7d8e9f0a1b';

function makeResolver() {
  const summaryService = {
    findById: jest.fn().mockResolvedValue(null),
    update: jest.fn().mockResolvedValue(null),
  };

  return {
    resolver: new SummaryResolver(summaryService as unknown as SummaryService),
    summaryService,
  };
}

describe('SummaryResolver ids that are not uuids', () => {
  it('answers null for summary(id) without querying the database', async () => {
    const { resolver, summaryService } = makeResolver();

    await expect(resolver.summary(context, GlobalUID.encode('summary', 'abc'))).resolves.toBeNull();
    expect(summaryService.findById).not.toHaveBeenCalled();
  });

  it('answers null for the seen and dismissed mutations without querying the database', async () => {
    const { resolver, summaryService } = makeResolver();
    const gid = GlobalUID.encode('summary', 'abc');

    await expect(resolver.markSummaryAsSeen(context, gid)).resolves.toBeNull();
    await expect(resolver.markSummaryAsDismissed(context, gid)).resolves.toBeNull();
    expect(summaryService.update).not.toHaveBeenCalled();
  });

  it('still looks up a uuid', async () => {
    const { resolver, summaryService } = makeResolver();

    await expect(resolver.summary(context, GlobalUID.encode('summary', RAW_ID))).resolves.toBeNull();
    expect(summaryService.findById).toHaveBeenCalledWith(expect.anything(), RAW_ID);
  });

  it('still refuses a GlobalUID for another resource type', async () => {
    const { resolver } = makeResolver();

    await expect(resolver.summary(context, GlobalUID.encode('event', RAW_ID))).rejects.toThrow(
      'Unexpected global id type',
    );
  });
});
