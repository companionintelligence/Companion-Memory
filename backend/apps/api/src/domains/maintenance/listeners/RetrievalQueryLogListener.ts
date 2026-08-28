import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { LoggerService } from '@ci/common/logging';
import { OnEvent } from '@ci/domains/events';
import { RetrievalQueryEvent, type RetrievalQueryPayload } from '@ci/domains/search-next';

import { RetrievalQueryLogEntity } from '../entities/RetrievalQueryLogEntity';

/**
 * Persist one `retrieval.query` row.
 *
 * This class existing is what makes the emit real: `EventService.send(..., {
 * queue: 'telemetry' })` checks the queue against the REGISTERED listener
 * queues and drops the event with a warn when nobody consumes it, so a sender
 * without a listener is a silent no-op (see the SEARCH_EMBED_ENTITY bug). The
 * `@OnEvent` below is the registration.
 *
 * It runs off the queue rather than on the retrieval path on purpose: the one
 * thing a query log must never do is add a synchronous INSERT to every search.
 */
@Injectable()
export class RetrievalQueryLogListener {
  constructor(
    @InjectRepository(RetrievalQueryLogEntity)
    private readonly repository: Repository<RetrievalQueryLogEntity>,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(RetrievalQueryLogListener.name);
  }

  @OnEvent(RetrievalQueryEvent, { queue: 'telemetry' })
  async handleRetrievalQuery(payload: RetrievalQueryPayload): Promise<void> {
    if (!payload.userId) {
      // `user_id` is NOT NULL with an FK. A payload without one can never be
      // stored, so failing the job would retry it to the dead-letter queue for
      // nothing; drop it loudly instead.
      this.logger.warn('retrieval.query without a userId; dropping', { caller: payload.caller });

      return;
    }

    await this.repository.insert({
      id: uuidv7(),
      // Stamped at INSERT, not at emit: the queue can lag, and a `ts` from the
      // producer would let a slow drain rewrite history into the past. The
      // rollup windows are days wide, so queue lag is immaterial to them.
      ts: new Date(),
      userId: payload.userId,
      caller: payload.caller,
      modeTaken: payload.modeTaken,
      queryTokenCount: payload.queryTokenCount,
      includeTypes: payload.includeTypes,
      excludeTypes: payload.excludeTypes,
      resultCount: payload.resultCount,
      topScore: payload.topScore,
      latencyMs: payload.latencyMs,
    });
  }
}
