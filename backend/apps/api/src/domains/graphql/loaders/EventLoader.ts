import { Injectable } from '@nestjs/common';

import { type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { type Event, EventService } from '@ci/domains/memory';

import { Loader } from './Loader';

@Injectable()
export class EventLoader extends Loader<Event | null> {
  constructor(
    private readonly eventService: EventService,
    protected readonly logger: LoggerService,
  ) {
    super();
    this.logger.setContext(EventLoader.name);
  }

  protected async batchLoad(
    context: UserServiceContext,
    eventIds: readonly string[],
  ): Promise<readonly (Event | null)[]> {
    this.logger.log(`Loading a batch of ${eventIds.length} people`);

    return this.eventService.findByIds(context, [...eventIds]);
  }
}
