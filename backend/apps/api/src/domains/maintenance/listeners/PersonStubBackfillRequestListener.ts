import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import { OnEvent } from '@ci/domains/events';

import {
  PERSON_STUB_BACKFILL_QUEUE,
  PersonStubBackfillRequestEvent,
  type PersonStubBackfillRequestPayload,
} from '../events';
import { PersonStubBackfillService } from '../services/PersonStubBackfillService';

/**
 * Consumer of {@link PersonStubBackfillRequestEvent}: the post-push people
 * pass. One request walks the whole corpus the same way the operator route
 * does; the service is idempotent (entities and identifiers both dedupe on
 * unique indexes), so a duplicate request costs a scan and creates nothing.
 */
@Injectable()
export class PersonStubBackfillRequestListener {
  constructor(
    private readonly personStubBackfillService: PersonStubBackfillService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(PersonStubBackfillRequestListener.name);
  }

  @OnEvent(PersonStubBackfillRequestEvent, { queue: PERSON_STUB_BACKFILL_QUEUE })
  async handleRequest(payload: PersonStubBackfillRequestPayload): Promise<void> {
    const { userId, requestedBy } = payload;

    if (!userId) {
      this.logger.warn('People-stub backfill request has no userId; refusing', { requestedBy });

      return;
    }

    const result = await this.personStubBackfillService.backfill(userId);

    this.logger.log('People-stub backfill complete', {
      userId,
      requestedBy,
      examined: result.examined,
      identifiersSeen: result.identifiersSeen,
      peopleCreated: result.peopleCreated,
      identifiersIndexed: result.identifiersIndexed,
      errors: result.errors.length,
    });
  }
}
