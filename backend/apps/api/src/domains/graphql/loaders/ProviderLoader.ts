import { Injectable } from '@nestjs/common';

import type { UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { type Provider, ProviderService } from '@ci/domains/connections';

import { Loader } from './Loader';

@Injectable()
export class ProviderLoader extends Loader<Provider | null, string> {
  constructor(
    private readonly ProviderService: ProviderService,
    protected readonly logger: LoggerService,
  ) {
    super();
    this.logger.setContext(ProviderLoader.name);
  }

  protected async batchLoad(
    context: UserServiceContext,
    ProviderIds: readonly string[],
  ): Promise<readonly (Provider | null)[]> {
    return this.ProviderService.findByIds(context, [...ProviderIds]);
  }
}
