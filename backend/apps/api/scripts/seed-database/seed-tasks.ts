import { type TestingModule } from '@nestjs/testing';
import { type MultiBar } from 'cli-progress';

import { PlannedBlockService, TaskService } from '@ci/domains/planning';

import { TASKS } from './data/tasks';
import { JOHN_SMITH } from './data/users';

export async function seedTasks(module: TestingModule, multibar: MultiBar) {
  const taskService = module.get(TaskService);
  const plannedBlockService = module.get(PlannedBlockService);

  const context = { userId: JOHN_SMITH.id };

  const bar = multibar.create(TASKS.length, 0, { task: 'Tasks' });

  for (const { block, complete, ...task } of TASKS) {
    const existingTask = await taskService.findById(context, task.id);

    // Unlike the other seeders there is no update arm: a re-seed must not undo
    // whatever the demo did to these four cards between runs.
    if (existingTask == null) {
      await taskService.create(context, task);

      if (block) {
        await plannedBlockService.scheduleTaskAt(context, task.id, block.start, block.end);
      }

      if (complete) {
        await taskService.complete(context, task.id);
      }
    }

    bar.increment();
  }

  bar.stop();
}
