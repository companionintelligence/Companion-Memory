import { Injectable } from '@nestjs/common';

import { type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { TaskService } from '@ci/domains/planning';

import { Loader } from './Loader';

type Task = Awaited<ReturnType<TaskService['findChildren']>>[number];

/** Batches `Task.children` across a page of tasks into one query. */
@Injectable()
export class TaskChildrenLoader extends Loader<Task[]> {
  constructor(
    private readonly taskService: TaskService,
    protected readonly logger: LoggerService,
  ) {
    super();
    this.logger.setContext(TaskChildrenLoader.name);
  }

  protected async batchLoad(
    context: UserServiceContext,
    parentIds: readonly string[],
  ): Promise<readonly Task[][]> {
    this.logger.log(`Loading children for a batch of ${parentIds.length} tasks`);

    const byParent = await this.taskService.findChildrenOf(context, [...parentIds]);

    return parentIds.map((id) => byParent.get(id) ?? []);
  }
}
