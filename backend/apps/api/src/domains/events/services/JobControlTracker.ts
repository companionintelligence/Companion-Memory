import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { JobControlStore } from '@ci/common/job-controls';

/**
 * Wires {@link JobControlStore} to the app DataSource on module boot, and flushes
 * its pending skip counters on the way out.
 *
 * Same shape as {@link CronRunTracker} next door, and for the same reason: both
 * stores are process-wide singletons because their most important readers — a
 * decorator and a hot enqueue path — cannot be injected into, so something with
 * a lifecycle has to hand them the connection.
 *
 * `onModuleInit` awaits the first read. The alternative is a boot window in
 * which every queue runs at its shipped ceiling regardless of what the operator
 * set, which is exactly the window after a restart — the moment someone who just
 * capped an overheating box is watching it.
 */
@Injectable()
export class JobControlTracker implements OnModuleInit, OnModuleDestroy {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async onModuleInit(): Promise<void> {
    await JobControlStore.configure(this.dataSource);
  }

  async onModuleDestroy(): Promise<void> {
    // Stops the poll and lands the last batch of skip counts. Without the flush,
    // everything a disabled queue dropped in the final half-minute before a
    // restart is missing from a tally whose whole job is to say how much was
    // dropped.
    await JobControlStore.stop();
  }
}
