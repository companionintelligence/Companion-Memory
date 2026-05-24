import { Injectable } from '@nestjs/common';

import type { UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { type ProviderKey, ProviderKeyService } from '@ci/domains/connections';

import { Loader } from './Loader';

@Injectable()
export class ProviderKeyLoader extends Loader<ProviderKey | null, string> {
  constructor(
    private readonly providerKeyService: ProviderKeyService,
    protected readonly logger: LoggerService,
  ) {
    super();
    this.logger.setContext(ProviderKeyLoader.name);
  }

  protected async batchLoad(
    context: UserServiceContext,
    providerKeyIds: readonly string[],
  ): Promise<readonly (ProviderKey | null)[]> {
    return this.providerKeyService.findByIds(context, [...providerKeyIds]);
  }
}
