import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import { Cron } from '@ci/common/schedule';

import { AgentDispatchService } from '../services/AgentDispatchService';

/**
 * Off-grid second 43 — see cronSecondOffsets.test.ts. Every minute is enough:
 * queued jobs go stale at two minutes, running jobs at fifteen.
 */
export const AGENT_DISPATCH_STALE_CRON = '43 * * * * *';

@Injectable()
export class AgentDispatchStaleCron {
  constructor(
    private readonly dispatch: AgentDispatchService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(AgentDispatchStaleCron.name);
  }

  // `exclusive`: a per-minute tick with no guard of its own, so a `failStale`
  // that outruns its cadence would otherwise stack copies of itself.
  @Cron(AGENT_DISPATCH_STALE_CRON, { name: 'AgentDispatchStaleCron.failStale', exclusive: true })
  async failStale(): Promise<void> {
    const closed = await this.dispatch.failStale();

    if (closed > 0) {
      this.logger.warn('Closed stale OpenClaw dispatch jobs', { closed });
    }
  }
}
