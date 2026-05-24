import { Injectable } from '@nestjs/common';

import type { UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { MessageService, type Message } from '@ci/domains/conversations';

import { Loader } from './Loader';

@Injectable()
export class ThreadMessagesLoader extends Loader<Message[]> {
  constructor(
    private readonly messageService: MessageService,
    protected readonly logger: LoggerService,
  ) {
    super();
    this.logger.setContext(ThreadMessagesLoader.name);
  }

  protected async batchLoad(
    context: UserServiceContext,
    threadIds: readonly string[],
  ): Promise<readonly Message[][]> {
    const messagesMap = await this.messageService.findByThreadIds(context, [...threadIds]);

    return threadIds.map((threadId) => messagesMap.get(threadId) ?? []);
  }
}
