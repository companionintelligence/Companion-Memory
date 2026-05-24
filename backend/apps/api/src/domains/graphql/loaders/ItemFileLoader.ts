import { Injectable } from '@nestjs/common';

import type { UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { FileService, type SignedFile } from '@ci/domains/files';

import { Loader } from './Loader';

@Injectable()
export class ItemFileLoader extends Loader<SignedFile | null, string> {
  constructor(
    private readonly fileService: FileService,
    protected readonly logger: LoggerService,
  ) {
    super();
    this.logger.setContext(ItemFileLoader.name);
  }

  protected async batchLoad(
    context: UserServiceContext,
    fileIds: readonly string[],
  ): Promise<readonly (SignedFile | null)[]> {
    return this.fileService.findByIds(context, [...fileIds]);
  }
}
