import { Injectable } from '@nestjs/common';

import type { UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { MessageService, type ThreadMessagesPage } from '@ci/domains/conversations';

import { Loader } from './Loader';

const EMPTY: ThreadMessagesPage = { messages: [], hasNextPage: false, hasPreviousPage: false, totalCount: 0 };

/**
 * Batches the first page of `Thread.messages` across a page of threads into
 * one ranked read per page size. The key is `(limit, threadId)`;
 * {@link loadFor} spells it. A cursor page is one thread's own and goes
 * straight to the service.
 */
@Injectable()
export class ThreadMessagesLoader extends Loader<ThreadMessagesPage> {
  constructor(
    private readonly messageService: MessageService,
    protected readonly logger: LoggerService,
  ) {
    super();
    this.logger.setContext(ThreadMessagesLoader.name);
  }

  loadFor(context: UserServiceContext, threadId: string, limit: number): Promise<ThreadMessagesPage> {
    return this.load(context, `${limit}:${threadId}`);
  }

  protected async batchLoad(
    context: UserServiceContext,
    keys: readonly string[],
  ): Promise<readonly ThreadMessagesPage[]> {
    const parsed = keys.map((key) => {
      const separator = key.indexOf(':');

      return { limit: Number(key.slice(0, separator)), threadId: key.slice(separator + 1) };
    });
    const threadIdsByLimit = new Map<number, string[]>();

    for (const { limit, threadId } of parsed) {
      const threadIds = threadIdsByLimit.get(limit) ?? [];

      if (!threadIds.includes(threadId)) {
        threadIds.push(threadId);
      }

      threadIdsByLimit.set(limit, threadIds);
    }

    this.logger.log(`Loading the first page of messages for a batch of ${keys.length} threads`);

    const pages = new Map<number, Map<string, ThreadMessagesPage>>();

    await Promise.all(
      [...threadIdsByLimit.entries()].map(async ([limit, threadIds]) => {
        pages.set(limit, await this.messageService.findFirstPageByThreadIds(context, threadIds, limit));
      }),
    );

    return parsed.map(({ limit, threadId }) => pages.get(limit)?.get(threadId) ?? EMPTY);
  }
}
