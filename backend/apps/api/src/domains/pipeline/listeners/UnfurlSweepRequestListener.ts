import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import {
  UNFURL_SWEEP_QUEUE,
  UnfurlSweepRequestEvent,
  type UnfurlSweepRequestPayload,
} from '@ci/domains/embed/events';
import { OnEvent } from '@ci/domains/events';

import { STAGE_IDS } from '../constants';
import { stageSchedule } from '../schedule';
import { PipelineDispatchService } from '../services/PipelineDispatchService';

/**
 * Turns the importer's "content landed" kick into an `enrich.unfurl` sweep, so
 * link previews for a fresh import start within minutes of the Sync step
 * finishing rather than at the next weekly window. Same shape as the
 * search-index and graph-edge request listeners next door, for the same
 * reason: the importer must not import the pipeline's module.
 */
@Injectable()
export class UnfurlSweepRequestListener {
  constructor(
    private readonly dispatchService: PipelineDispatchService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(UnfurlSweepRequestListener.name);
  }

  // `short` is what makes the sender's singletonKey actually collapse
  // duplicates (pg-boss stores but never enforces it on a `standard` queue);
  // safe here because every send on this queue carries a key.
  @OnEvent(UnfurlSweepRequestEvent, { queue: UNFURL_SWEEP_QUEUE, queueOptions: { policy: 'short' } })
  async handleRequest(payload: UnfurlSweepRequestPayload): Promise<void> {
    const { userId, requestedBy } = payload;

    if (userId == null || userId.length === 0) {
      this.logger.warn('Unfurl sweep request carries no userId; ignoring', { requestedBy });

      return;
    }

    // The same cap the scheduled tick applies: an import is not a licence to
    // crawl the whole corpus in one go, and the weekly sweep gets the rest.
    const maxIds = stageSchedule(STAGE_IDS.ENRICH_UNFURL).perRunCap;
    await this.dispatchService.startSweep({ stage: STAGE_IDS.ENRICH_UNFURL, userId, maxIds });

    this.logger.log('Unfurl sweep started', { requestedBy, userId, stage: STAGE_IDS.ENRICH_UNFURL, maxIds });
  }
}
