import { Injectable } from '@nestjs/common';

import { type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { type Place, PlaceService } from '@ci/domains/memory';

import { Loader } from './Loader';

@Injectable()
export class PlaceLoader extends Loader<Place | null> {
  constructor(
    private readonly placeService: PlaceService,
    protected readonly logger: LoggerService,
  ) {
    super();
    this.logger.setContext(PlaceLoader.name);
  }

  protected async batchLoad(
    context: UserServiceContext,
    placeIds: readonly string[],
  ): Promise<readonly (Place | null)[]> {
    this.logger.log(`Loading a batch of ${placeIds.length} places`);

    return this.placeService.findByIds(context, [...placeIds]);
  }
}
