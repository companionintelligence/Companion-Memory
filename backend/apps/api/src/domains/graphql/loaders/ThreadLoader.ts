import { Injectable } from '@nestjs/common';

import type { UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { type Thread, ThreadService } from '@ci/domains/conversations';

import { Loader } from './Loader';

@Injectable()
export class ThreadLoader extends Loader<Thread | null, string> {
  constructor(
    private readonly threadService: ThreadService,
    protected readonly logger: LoggerService,
  ) {
    super();
    this.logger.setContext(ThreadLoader.name);
  }

  protected async batchLoad(
    context: UserServiceContext,
    threadIds: readonly string[],
  ): Promise<readonly (Thread | null)[]> {
    return this.threadService.findByIds(context, [...threadIds]);
  }
}
